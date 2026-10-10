-- Runtime schema. Applied after seed/out/seed.sql, which creates source, entry, link, question, qrel and entry_current.
-- Idempotent: safe to rerun on every deploy.

-- pgvector and pg_jieba ship in db/Dockerfile. Locally either may be missing, so A1 degrades instead of failing.
do $$ begin
  create extension if not exists vector;
exception when others then raise notice 'pgvector unavailable: A1 runs keyword-only';
end $$;
do $$ begin
  create extension if not exists pg_jieba;
exception when others then raise notice 'pg_jieba unavailable: kb_zh falls back to simple';
end $$;
do $$ begin
  if not exists (select 1 from pg_ts_config where cfgname = 'kb_zh') then
    if exists (select 1 from pg_ts_config where cfgname = 'jiebacfg') then
      create text search configuration kb_zh (copy = jiebacfg);
    else
      create text search configuration kb_zh (copy = simple);
    end if;
  end if;
end $$;

alter table entry add column if not exists tsv_en tsvector generated always as (
  to_tsvector('english'::regconfig, coalesce(title, '') || ' ' || coalesce(body, '') || ' ' || coalesce(evidence, ''))) stored;
alter table entry add column if not exists tsv_zh tsvector generated always as (
  to_tsvector('kb_zh'::regconfig, coalesce(title, '') || ' ' || coalesce(body, '') || ' ' || coalesce(evidence, ''))) stored;
create index if not exists entry_tsv_en on entry using gin (tsv_en);
create index if not exists entry_tsv_zh on entry using gin (tsv_zh);

-- entry_current was created before the tsv columns existed, so recreate it to carry them.
drop view if exists entry_current;
create view entry_current as select e.* from entry e
  where not exists (select 1 from link l where l.dst = e.id and l.type = 'supersedes');

do $$ begin
  if exists (select 1 from pg_extension where extname = 'vector') then
    execute 'create table if not exists entry_embedding (
      entry_id text primary key references entry(id) on delete cascade,
      model text not null,
      content_sha256 text not null,
      embedding vector(1024) not null,
      updated_at timestamptz not null default now())';
    execute 'create index if not exists entry_embedding_hnsw on entry_embedding using hnsw (embedding vector_cosine_ops)';
  end if;
end $$;

-- One row per MCP session. The arm is drawn here and never sent to the agent.
create table if not exists kb_session (
  id text primary key,
  arm text not null,
  client text,
  claude_session_id text,
  created_at timestamptz not null default now()
);

create table if not exists retrieval (
  id uuid primary key,
  kb_session text references kb_session(id),
  arm text not null,
  query text not null,
  task text,
  candidates jsonb not null default '[]',  -- [{id, score}] before packing
  delivered jsonb not null default '[]',   -- ids in the packet, in order
  rejected jsonb not null default '[]',    -- ids the filter cut (A2)
  latency_ms integer,
  degraded text,                           -- why a ranker was skipped, e.g. 'no-vector'
  created_at timestamptz not null default now()
);
create index if not exists retrieval_session on retrieval (kb_session, created_at);

create table if not exists event (
  id bigserial primary key,
  session_id text,
  event text not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);
create index if not exists event_session on event (session_id, received_at);

create table if not exists feedback (
  id bigserial primary key,
  retrieval_id uuid references retrieval(id),
  source text not null,   -- 'agent' (feedback tool) or 'wen' (/kb-good, /kb-bad)
  verdict text not null check (verdict in ('helpful', 'irrelevant', 'wrong')),
  entry_id text,
  note text,
  created_at timestamptz not null default now()
);

-- A2's learnable parameters, one per (source pattern, link type, target pattern), starting at 1.0.
create table if not exists link_type_weight (
  src_pattern text not null,
  link_type text not null,
  dst_pattern text not null,
  n_links integer not null,
  weight real not null default 1.0 check (weight between 0.2 and 5),
  primary key (src_pattern, link_type, dst_pattern)
);
insert into link_type_weight (src_pattern, link_type, dst_pattern, n_links)
  select s.pattern, l.type, d.pattern, count(*)
  from link l join entry s on s.id = l.src join entry d on d.id = l.dst
  where l.type <> 'part_of'
  group by 1, 2, 3
on conflict (src_pattern, link_type, dst_pattern) do update set n_links = excluded.n_links;
