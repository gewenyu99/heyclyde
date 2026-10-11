-- Runtime schema. Applied after seed/out/seed.sql, which creates source, entry, link, question, qrel and entry_current.
-- Idempotent: safe to rerun on every deploy.

-- pgvector and pg_jieba ship in db/Dockerfile. Locally either may be missing, so hybrid search degrades instead of failing.
do $$ begin
  create extension if not exists vector;
exception when others then raise notice 'pgvector unavailable: hybrid runs keyword-only';
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

-- search_text is what keyword search and embeddings read: the entry plus its project's title, so "the course" finds
-- "Module 3 is next". Postgres can't reference another row in a generated column, so a trigger keeps it current.
alter table entry add column if not exists search_text text;
create or replace function entry_search_text() returns trigger language plpgsql as $$
begin
  new.search_text := concat_ws(' ', new.title, new.body, new.evidence,
    (select p.title from entry p where p.id = new.project and p.id <> new.id));
  return new;
end $$;
drop trigger if exists entry_search_text on entry;
create trigger entry_search_text before insert or update of title, body, evidence, project on entry
  for each row execute function entry_search_text();
update entry set title = title where search_text is distinct from concat_ws(' ', title, body, evidence,
  (select p.title from entry p where p.id = entry.project and p.id <> entry.id));

-- Earlier deploys generated the tsvectors from title, body and evidence. Rebuild them from search_text once.
do $$ begin
  if exists (select 1 from information_schema.columns where table_name = 'entry' and column_name = 'tsv_en'
             and generation_expression not like '%search_text%') then
    drop view if exists entry_current;
    alter table entry drop column tsv_en, drop column tsv_zh;
  end if;
end $$;
alter table entry add column if not exists tsv_en tsvector generated always as (
  to_tsvector('english'::regconfig, coalesce(search_text, ''))) stored;
alter table entry add column if not exists tsv_zh tsvector generated always as (
  to_tsvector('kb_zh'::regconfig, coalesce(search_text, ''))) stored;
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
  rejected jsonb not null default '[]',    -- ids the filter cut (spreading)
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
-- The agent kb-hook names, claude or codex, so their hooks can be told apart. Older rows and get_entry rows have none.
alter table event add column if not exists agent text;
-- The packet text the agent read under the retrieval id, so the console shows exactly that. Older rows have none.
alter table retrieval add column if not exists packet text;

create table if not exists feedback (
  id bigserial primary key,
  retrieval_id uuid references retrieval(id),
  source text not null,   -- 'agent' (feedback tool) or 'wen' (/kb-good, /kb-bad)
  verdict text not null check (verdict in ('helpful', 'irrelevant', 'wrong')),
  entry_id text,
  note text,
  created_at timestamptz not null default now()
);

-- The message board. Agents leave each other notes by name: claude, codex, or all.
create table if not exists message (
  id bigserial primary key,
  sender text not null,
  recipient text not null,
  body text not null,
  read_by text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists message_recipient on message (recipient, created_at);

-- Every write made through the management API (/api/v1), with what it changed. target is entry:<id>, message:<id>,
-- retrieval:<id> or embeddings.
create table if not exists admin_audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  action text not null,
  target text not null,
  before jsonb,
  after jsonb
);
create index if not exists admin_audit_target on admin_audit (target, at);

-- The spreading arm's learnable parameters, one per (source pattern, link type, target pattern), starting at 1.0.
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

-- The arms were called A0 and A1 before they had names.
update kb_session set arm = case arm when 'A0' then 'index' else 'hybrid' end where arm in ('A0', 'A1');
update retrieval set arm = case arm when 'A0' then 'index' else 'hybrid' end where arm in ('A0', 'A1');
