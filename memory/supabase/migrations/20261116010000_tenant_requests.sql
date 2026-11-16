-- R49 (#54), Clyde slice C2: every request runs as its tenant, and recall scans only the owner's vectors.
--
-- The function now opens each request as role memory_tenant with memory.owner set (db.ts asTenant). Wen's console runs as
-- memory_console: row-level security holds it to Wen's rows like any tenant, and it may also manage the global tables
-- (settings, the allowlist, parameter sets, allocation, the eval's questions). Embeddings become halfvec(1024), half the
-- bytes, and recall scans the owner's rows exactly through entry_embedding's (owner_id, entry_id) key instead of one HNSW
-- index across every owner. Idempotent: safe to rerun.
set search_path = memory, extensions, public;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'memory_console') then
    create role memory_console nologin nobypassrls noinherit;
  end if;
end $$;
alter role memory_console nobypassrls;
grant memory_console to postgres;
grant usage on schema memory, extensions to memory_console;
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'pgroonga') then execute 'grant usage on schema pgroonga to memory_console'; end if;
end $$;
grant select, insert, update, delete on all tables in schema memory to memory_console;
grant usage, select, update on all sequences in schema memory to memory_console;

-- Each owned table's one policy now names both roles. Entitlements stay read-only to both: billing writes them as postgres.
do $$
declare
  t text;
  owned text[] := array['account', 'admin_audit', 'agent', 'agent_binding', 'blob', 'board_seen', 'burst', 'co_use',
    'confidence_log', 'device', 'entitlement', 'entry', 'entry_blob', 'entry_embedding', 'entry_provenance', 'event', 'feedback',
    'judge_cache', 'link', 'mcp_client', 'mcp_session', 'message', 'message_delivery', 'quest', 'quest_blob', 'quest_note',
    'retrieval', 'shadow_retrieval', 'source', 'upload', 'usage'];
begin
  foreach t in array owned loop
    execute format('drop policy if exists tenant on memory.%I', t);
    if t = 'entitlement' then
      execute format('create policy tenant on memory.%I for select to memory_tenant, memory_console using (owner_id = (select memory.tenant()))', t);
      execute format('revoke insert, update, delete on memory.%I from memory_console', t);
    else
      execute format('create policy tenant on memory.%I for all to memory_tenant, memory_console using (owner_id = (select memory.tenant())) '
        'with check (owner_id = (select memory.tenant()))', t);
    end if;
  end loop;
end $$;

-- The salt allocation.ts hashes units with. A tenant reads it through this function and nothing else of the settings.
create or replace function memory.allocation_salt() returns text language sql stable security definer set search_path = memory, pg_temp as $$
  select value from memory.setting where name = 'allocation_salt'
$$;

-- ---------------------------------------------------------------- vectors
-- An exact scan of one owner's rows needs no HNSW index, and one global index would rank every owner's vectors together.
drop index if exists memory.entry_embedding_hnsw;
do $$
begin
  if (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
      where a.attrelid = 'memory.entry_embedding'::regclass and a.attname = 'embedding') not like '%halfvec(1024)' then
    lock table memory.entry_embedding in access exclusive mode;
    -- Inline and uncompressed: a halfvec(1024) is 2 KB, which TOAST would otherwise move out of the row, and an exact scan
    -- would then fetch every one of them apart.
    alter table memory.entry_embedding alter column embedding set storage plain;
    alter table memory.entry_embedding alter column embedding type extensions.halfvec(1024) using embedding::extensions.halfvec(1024);
  end if;
end $$;
alter table memory.entry_embedding alter column embedding set storage plain;
