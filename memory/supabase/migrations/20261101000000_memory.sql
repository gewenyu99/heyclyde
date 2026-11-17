-- memory on Supabase. Everything lives in schema memory, which PostgREST doesn't expose, so the project's anon and service keys
-- reach none of it. Only the memory Edge Function reads it, as postgres over SUPABASE_DB_URL.
-- Idempotent: safe to rerun.

create extension if not exists vector with schema extensions;
create extension if not exists pg_cron;
create extension if not exists pgroonga with schema extensions;
create extension if not exists pg_net with schema extensions;

create schema if not exists memory;
revoke all on schema memory from public, anon, authenticated, service_role;

set search_path = memory, extensions, public;

-- ---------------------------------------------------------------- the store, as seed/build.py creates it
create table if not exists source (id text primary key, kind text, title text, uri text, date date);
create table if not exists entry (
  id text primary key, pattern text, title text, body text,
  authority text check (authority in ('approved', 'observed', 'draft')),
  scope text, sensitivity text, lang text, valid_from date, source_id text references source(id),
  evidence_kind text, evidence text, evidence_sha256 text, project text,
  origin text not null default 'seed',  -- 'seed' or 'runtime'
  created_at timestamptz not null default now(),
  -- sha256 of the payload remember was sent, so a resend finds its own entry and a different payload under that id is refused.
  payload_sha256 text,
  search_text text);
create table if not exists link (src text references entry(id), dst text references entry(id), type text,
  weight real default 1.0, primary key (src, dst, type));
create table if not exists question (id text primary key, text text, lang text, qtype text, split text, origin text);
create table if not exists qrel (question_id text references question(id), entry_id text references entry(id),
  grade smallint, primary key (question_id, entry_id));  -- grade 2 = gold, -1 = must_not

-- search_text is what keyword search and embeddings read: the entry plus its project's title, so "the course" finds
-- "Module 3 is next". Postgres can't reference another row in a generated column, so a trigger keeps it current.
create or replace function entry_search_text() returns trigger language plpgsql as $$
begin
  new.search_text := concat_ws(' ', new.title, new.body, new.evidence,
    (select p.title from memory.entry p where p.id = new.project and p.id <> new.id));
  return new;
end $$;
drop trigger if exists entry_search_text on entry;
create trigger entry_search_text before insert or update of title, body, evidence, project on entry
  for each row execute function entry_search_text();

alter table entry add column if not exists tsv_en tsvector generated always as (
  to_tsvector('english'::regconfig, coalesce(search_text, ''))) stored;
create index if not exists entry_tsv_en on entry using gin (tsv_en);
-- 中文 keyword search. Supabase has no pg_jieba, so PGroonga indexes search_text as overlapping bigrams with NFKC
-- normalization, the standard CJK approach. search.ts queries it with the 中文 query's bigrams OR'ed.
create index if not exists entry_search_zh on entry using pgroonga (search_text)
  with (tokenizer = 'TokenBigram', normalizers = 'NormalizerNFKC150');

-- A blob is stored once per sha256 of its bytes, however many entries attach it.
create table if not exists blob (sha256 text primary key, media_type text not null, size integer not null,
  content bytea not null, created_at timestamptz not null default now());
create table if not exists entry_blob (entry_id text references entry(id) on delete cascade,
  name text not null, sha256 text not null references blob(sha256), primary key (entry_id, name));
create index if not exists entry_blob_sha256 on entry_blob (sha256);

create or replace view entry_current as select e.* from entry e
  where not exists (select 1 from link l where l.dst = e.id and l.type = 'supersedes');

-- text-embedding-3-large, cut to 1024 dimensions. model and content_sha256 say which model and text each row came from,
-- so a model change re-embeds everything on the next sync.
create table if not exists entry_embedding (
  entry_id text primary key references entry(id) on delete cascade,
  model text not null,
  content_sha256 text not null,
  embedding extensions.vector(1024) not null,
  updated_at timestamptz not null default now());
create index if not exists entry_embedding_hnsw on entry_embedding using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------- sessions, recalls, hooks
-- One row per MCP session. The arm is drawn here and never sent to the agent.
create table if not exists mcp_session (
  id text primary key, arm text not null, client text, claude_session_id text,
  created_at timestamptz not null default now(),
  cwd text, repo text, machine text, cwd_from text);
create index if not exists mcp_session_repo on mcp_session (repo, created_at);

-- The client name each MCP session gave at initialize. The function is stateless, so later calls look it up here.
create table if not exists mcp_client (
  session_id text primary key, client text, created_at timestamptz not null default now());

create table if not exists retrieval (
  id uuid primary key,
  mcp_session text references mcp_session(id),
  arm text not null,
  query text not null,
  task text,
  candidates jsonb not null default '[]',  -- [{id, score}] before packing
  delivered jsonb not null default '[]',   -- ids in the packet, in order
  rejected jsonb not null default '[]',    -- ids the filter cut (spreading)
  latency_ms integer,
  degraded text,                           -- why a ranker was skipped, e.g. 'no-vector'
  created_at timestamptz not null default now(),
  packet text,                             -- the text the agent read under the retrieval id
  scope text,                              -- a scoped recall sees a run's entries too
  context jsonb);
create index if not exists retrieval_session on retrieval (mcp_session, created_at);

create table if not exists event (
  id bigserial primary key, session_id text, event text not null, payload jsonb not null,
  received_at timestamptz not null default now(),
  agent text);  -- claude or codex, as memory-hook names it
create index if not exists event_session on event (session_id, received_at);

create table if not exists feedback (
  id bigserial primary key,
  retrieval_id uuid references retrieval(id),
  source text not null,   -- 'agent' (feedback tool) or 'wen' (console)
  verdict text not null check (verdict in ('helpful', 'irrelevant', 'wrong')),
  entry_id text, note text,
  created_at timestamptz not null default now());

-- The message board. Agents leave each other notes by name: claude, codex, or all.
create table if not exists message (
  id bigserial primary key, sender text not null, recipient text not null, body text not null,
  read_by text[] not null default '{}', created_at timestamptz not null default now());
create index if not exists message_recipient on message (recipient, created_at);

-- Every write made through the management API (/api/v1), with what it changed.
create table if not exists admin_audit (
  id bigserial primary key, at timestamptz not null default now(), action text not null, target text not null,
  before jsonb, after jsonb);
create index if not exists admin_audit_target on admin_audit (target, at);

-- The spreading arm's learnable parameters, one per (source pattern, link type, target pattern), starting at 1.0.
create table if not exists link_type_weight (
  src_pattern text not null, link_type text not null, dst_pattern text not null, n_links integer not null,
  weight real not null default 1.0 check (weight between 0.2 and 5),
  primary key (src_pattern, link_type, dst_pattern));

-- A repo name from a path alone: a .claude or .codex worktree counts as the checkout it hangs off.
create or replace function repo_of(cwd text) returns text language sql immutable as $$
  select nullif(regexp_replace(regexp_replace(rtrim(cwd, '/\'), '/\.(claude|codex)/worktrees/[^/]+(/.*)?$', ''),
                               '^.*[/\\]', ''), '')
$$;

-- ---------------------------------------------------------------- auth
-- Wrong tokens per (credential, client address). Isolates come and go, so the count lives here, not in memory.
create table if not exists auth_miss (
  kind text not null, client text not null, misses integer not null, last_miss timestamptz not null,
  locked_until timestamptz, primary key (kind, client));

-- One row per computer. An agent request resolves to a device by its token's SHA-256, so revoking one computer leaves
-- the rest alone. The seed of a principal, if memory ever serves more than Wen.
create table if not exists device (
  id bigserial primary key, name text not null unique, token_sha256 text not null unique,
  created_at timestamptz not null default now(), last_seen timestamptz, revoked_at timestamptz);

-- The function's settings: the runtime, admin and backup tokens' SHA-256 and the embedding budget. The OpenAI key and
-- the cron secret sit in Vault.
create table if not exists setting (name text primary key, value text not null);

-- OpenAI tokens spent on embeddings per month, so the budget cap holds across isolates.
create table if not exists embed_usage (month date primary key, tokens bigint not null default 0);
