-- R48 (#53), Clyde slice C1: every table a user's agents write gains an owner, and Wen's notes become tenant one.
--
-- 31 tables are owned. Each gets owner_id uuid not null, row-level security that is forced, and one policy for role
-- memory_tenant: a row is visible and writable only while memory.owner names its owner. Keys that were free text (an entry's
-- id, a blob's sha256, an agent's name) become (owner_id, ...), so two owners can both hold proj-pkg, and every foreign key
-- between owned tables carries owner_id, so no row can point into another owner's. The 16 global tables keep no owner:
-- setting, link_type_weight, param_set, allocation, auth_miss, question, qrel, allowed_email, plan, billing_event,
-- billing_action, signup_attempt, oauth_consent, install_claim, openai_usage and embed_usage.
--
-- Every row from before belongs to Wen: the Supabase Auth user whose email is the allowlist's owner-plan address, kept as
-- setting owner_id. A row written as postgres with no memory.owner set belongs to him too (owner_default()), so cron, the
-- console and the function keep working unchanged until R49 opens every request as memory_tenant. postgres has BYPASSRLS, so
-- forced RLS binds only memory_tenant. owner_id has no foreign key to auth.users: the store exports and restores without
-- Auth, and deleting an account deletes its rows by owner (CLYDE-DESIGN.md, L2: tenancy).
--
-- A one-way door: the keys change shape. The way back is restoring memory-backup.yml's export into a branch.
-- Idempotent: safe to rerun.
set search_path = memory, extensions, public;

-- ---------------------------------------------------------------- who owns a row
-- Wen's owner id. security definer, so the column default works for a role that can't read memory.setting.
create or replace function memory.wen() returns uuid language sql stable security definer set search_path = memory, pg_temp as $$
  select nullif(value, '')::uuid from memory.setting where name = 'owner_id'
$$;

-- The owner a request runs as: memory.owner, set for the transaction, or null. Every policy compares with this alone.
create or replace function memory.tenant() returns uuid language sql stable as $$
  select nullif(current_setting('memory.owner', true), '')::uuid
$$;

-- What owner_id defaults to: the request's owner, else Wen. memory_tenant with no owner set gets Wen's id here and is then
-- refused by its policy's with check, so a missing owner never writes into anyone's tenant.
create or replace function memory.owner_default() returns uuid language sql stable as $$
  select coalesce(memory.tenant(), memory.wen())
$$;

do $$
declare wen uuid := memory.wen();
begin
  if wen is null and to_regclass('auth.users') is not null then
    select u.id into wen from auth.users u join memory.allowed_email a on a.email = lower(u.email)
    where a.plan = 'owner' order by u.created_at, u.id limit 1;
  end if;
  if wen is not null then
    insert into memory.setting (name, value) values ('owner_id', wen::text) on conflict (name) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------- the role
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'memory_tenant') then
    create role memory_tenant nologin nobypassrls noinherit;
  end if;
end $$;
alter role memory_tenant nobypassrls;
grant memory_tenant to postgres;
grant usage on schema memory to memory_tenant;
grant usage on schema extensions to memory_tenant;
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'pgroonga') then execute 'grant usage on schema pgroonga to memory_tenant'; end if;
end $$;

-- ---------------------------------------------------------------- owner_id on the 31 owned tables
do $$
declare
  wen uuid := memory.wen();
  t text;
  owned text[] := array['account', 'admin_audit', 'agent', 'agent_binding', 'blob', 'board_seen', 'burst', 'co_use',
    'confidence_log', 'device', 'entitlement', 'entry', 'entry_blob', 'entry_embedding', 'entry_provenance', 'event', 'feedback',
    'judge_cache', 'link', 'mcp_client', 'mcp_session', 'message', 'message_delivery', 'quest', 'quest_blob', 'quest_note',
    'retrieval', 'shadow_retrieval', 'source', 'upload', 'usage'];
  orphans boolean;
begin
  foreach t in array owned loop
    execute format('alter table memory.%I add column if not exists owner_id uuid', t);
    if wen is not null then
      execute format('update memory.%I set owner_id = $1 where owner_id is null', t) using wen;
    end if;
    execute format('select exists (select 1 from memory.%I where owner_id is null)', t) into orphans;
    if orphans then
      raise exception 'memory.% has rows and no owner to give them: Wen''s Supabase Auth user (the allowlist''s owner-plan email) is missing', t;
    end if;
    execute format('alter table memory.%I alter column owner_id set default memory.owner_default()', t);
    execute format('alter table memory.%I alter column owner_id set not null', t);
    execute format('alter table memory.%I enable row level security', t);
    execute format('alter table memory.%I force row level security', t);
    execute format('drop policy if exists tenant on memory.%I', t);
    if t = 'entitlement' then
      -- Billing writes entitlements as postgres. A tenant only reads its own.
      execute format('create policy tenant on memory.%I for select to memory_tenant using (owner_id = (select memory.tenant()))', t);
      execute format('grant select on memory.%I to memory_tenant', t);
    else
      execute format('create policy tenant on memory.%I for all to memory_tenant using (owner_id = (select memory.tenant())) '
        'with check (owner_id = (select memory.tenant()))', t);
      execute format('grant select, insert, update, delete on memory.%I to memory_tenant', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- keys
-- Every foreign key between owned tables goes first, then the keys change, then the foreign keys come back with owner_id.
alter table memory.agent_binding drop constraint if exists agent_binding_agent_fkey;
alter table memory.co_use drop constraint if exists co_use_src_dst_type_fkey;
alter table memory.entry drop constraint if exists entry_source_id_fkey;
alter table memory.entry_blob drop constraint if exists entry_blob_sha256_fkey;
alter table memory.entry_blob drop constraint if exists entry_blob_entry_id_fkey;
alter table memory.entry_embedding drop constraint if exists entry_embedding_entry_id_fkey;
alter table memory.entry_provenance drop constraint if exists entry_provenance_entry_id_fkey;
alter table memory.feedback drop constraint if exists feedback_retrieval_id_fkey;
alter table memory.link drop constraint if exists link_src_fkey;
alter table memory.link drop constraint if exists link_dst_fkey;
alter table memory.mcp_client drop constraint if exists mcp_client_agent_fkey;
alter table memory.message_delivery drop constraint if exists message_delivery_message_id_fkey;
alter table memory.quest drop constraint if exists quest_history_entry_fkey;
alter table memory.quest drop constraint if exists quest_result_entry_fkey;
alter table memory.quest_blob drop constraint if exists quest_blob_quest_id_fkey;
alter table memory.quest_blob drop constraint if exists quest_blob_sha256_fkey;
alter table memory.quest_note drop constraint if exists quest_note_quest_id_fkey;
alter table memory.retrieval drop constraint if exists retrieval_parent_id_fkey;
alter table memory.retrieval drop constraint if exists retrieval_mcp_session_fkey;
alter table memory.shadow_retrieval drop constraint if exists shadow_retrieval_retrieval_id_fkey;
-- Wen's labeled questions name his entries by id alone. The eval reads them as Wen.
alter table memory.qrel drop constraint if exists qrel_entry_id_fkey;

alter table memory.agent drop constraint if exists agent_pkey, add constraint agent_pkey primary key (owner_id, name);
alter table memory.agent_binding drop constraint if exists agent_binding_pkey, add constraint agent_binding_pkey primary key (owner_id, principal, client);
alter table memory.blob drop constraint if exists blob_pkey, add constraint blob_pkey primary key (owner_id, sha256);
alter table memory.board_seen drop constraint if exists board_seen_pkey, add constraint board_seen_pkey primary key (owner_id, principal, agent);
alter table memory.co_use drop constraint if exists co_use_pkey, add constraint co_use_pkey primary key (owner_id, src, dst);
alter table memory.entry drop constraint if exists entry_pkey, add constraint entry_pkey primary key (owner_id, id);
alter table memory.entry_blob drop constraint if exists entry_blob_pkey, add constraint entry_blob_pkey primary key (owner_id, entry_id, name);
alter table memory.entry_embedding drop constraint if exists entry_embedding_pkey, add constraint entry_embedding_pkey primary key (owner_id, entry_id);
alter table memory.entry_provenance drop constraint if exists entry_provenance_pkey, add constraint entry_provenance_pkey primary key (owner_id, entry_id);
alter table memory.judge_cache drop constraint if exists judge_cache_pkey,
  add constraint judge_cache_pkey primary key (owner_id, query_sha, entry_id, content_sha, judge_version);
alter table memory.link drop constraint if exists link_pkey, add constraint link_pkey primary key (owner_id, src, dst, type);
alter table memory.mcp_client drop constraint if exists mcp_client_pkey, add constraint mcp_client_pkey primary key (owner_id, session_id);
alter table memory.mcp_session drop constraint if exists mcp_session_pkey, add constraint mcp_session_pkey primary key (owner_id, id);
alter table memory.source drop constraint if exists source_pkey, add constraint source_pkey primary key (owner_id, id);
alter table memory.upload drop constraint if exists upload_pkey, add constraint upload_pkey primary key (owner_id, principal, sha256);
-- A computer's name is unique per owner. Its token stays unique everywhere, since a request finds its device by it.
alter table memory.device drop constraint if exists device_name_key;
alter table memory.device drop constraint if exists device_owner_name_key, add constraint device_owner_name_key unique (owner_id, name);
-- Rows keyed by a serial or a uuid keep it, and gain (owner_id, id) for the foreign keys that point at them.
alter table memory.retrieval drop constraint if exists retrieval_owner_id_key, add constraint retrieval_owner_id_key unique (owner_id, id);
alter table memory.message drop constraint if exists message_owner_id_key, add constraint message_owner_id_key unique (owner_id, id);
alter table memory.quest drop constraint if exists quest_owner_id_key, add constraint quest_owner_id_key unique (owner_id, id);

alter table memory.agent_binding add constraint agent_binding_agent_fkey foreign key (owner_id, agent)
  references memory.agent (owner_id, name) on delete cascade;
alter table memory.co_use add constraint co_use_src_dst_type_fkey foreign key (owner_id, src, dst, type)
  references memory.link (owner_id, src, dst, type) on delete cascade;
alter table memory.entry add constraint entry_source_id_fkey foreign key (owner_id, source_id) references memory.source (owner_id, id);
alter table memory.entry_blob add constraint entry_blob_entry_id_fkey foreign key (owner_id, entry_id)
  references memory.entry (owner_id, id) on delete cascade;
alter table memory.entry_blob add constraint entry_blob_sha256_fkey foreign key (owner_id, sha256) references memory.blob (owner_id, sha256);
alter table memory.entry_embedding add constraint entry_embedding_entry_id_fkey foreign key (owner_id, entry_id)
  references memory.entry (owner_id, id) on delete cascade;
alter table memory.entry_provenance add constraint entry_provenance_entry_id_fkey foreign key (owner_id, entry_id)
  references memory.entry (owner_id, id) on delete cascade;
alter table memory.feedback add constraint feedback_retrieval_id_fkey foreign key (owner_id, retrieval_id)
  references memory.retrieval (owner_id, id);
alter table memory.link add constraint link_src_fkey foreign key (owner_id, src) references memory.entry (owner_id, id);
alter table memory.link add constraint link_dst_fkey foreign key (owner_id, dst) references memory.entry (owner_id, id);
alter table memory.mcp_client add constraint mcp_client_agent_fkey foreign key (owner_id, agent)
  references memory.agent (owner_id, name) on delete set null (agent);
alter table memory.message_delivery add constraint message_delivery_message_id_fkey foreign key (owner_id, message_id)
  references memory.message (owner_id, id) on delete cascade;
alter table memory.quest add constraint quest_history_entry_fkey foreign key (owner_id, history_entry)
  references memory.entry (owner_id, id) on delete set null (history_entry);
alter table memory.quest add constraint quest_result_entry_fkey foreign key (owner_id, result_entry)
  references memory.entry (owner_id, id) on delete set null (result_entry);
alter table memory.quest_blob add constraint quest_blob_quest_id_fkey foreign key (owner_id, quest_id)
  references memory.quest (owner_id, id) on delete cascade;
alter table memory.quest_blob add constraint quest_blob_sha256_fkey foreign key (owner_id, sha256) references memory.blob (owner_id, sha256);
alter table memory.quest_note add constraint quest_note_quest_id_fkey foreign key (owner_id, quest_id)
  references memory.quest (owner_id, id) on delete cascade;
alter table memory.retrieval add constraint retrieval_parent_id_fkey foreign key (owner_id, parent_id)
  references memory.retrieval (owner_id, id) on delete cascade;
alter table memory.retrieval add constraint retrieval_mcp_session_fkey foreign key (owner_id, mcp_session)
  references memory.mcp_session (owner_id, id);
alter table memory.shadow_retrieval add constraint shadow_retrieval_retrieval_id_fkey foreign key (owner_id, retrieval_id)
  references memory.retrieval (owner_id, id) on delete cascade;

-- ---------------------------------------------------------------- what else memory_tenant may use
-- The global tables a request reads (rankings, plans) or adds to (the shared OpenAI budget), and the sequences behind serial
-- ids and the recall clock. Nothing on the allowlist or the settings: memory reads those as postgres.
grant select on memory.param_set, memory.allocation, memory.link_type_weight, memory.plan to memory_tenant;
grant select, insert, update on memory.openai_usage, memory.embed_usage to memory_tenant;
grant usage, select on all sequences in schema memory to memory_tenant;
revoke all on memory.allowed_email, memory.setting from memory_tenant;

-- ---------------------------------------------------------------- functions that join or write owned rows
-- An entry's search text carries its project's title: the project of the same owner.
create or replace function memory.entry_search_text() returns trigger language plpgsql as $$
begin
  new.search_text := concat_ws(' ', new.title, new.body, new.evidence,
    (select p.title from memory.entry p where p.owner_id = new.owner_id and p.id = new.project and p.id <> new.id));
  return new;
end $$;

-- The agents seen lately, of the owner a request runs as (Wen's for cron and the console).
create or replace function memory.agent_names() returns setof text language sql stable as $$
  select distinct s.n from (
    select e.agent as n from memory.event e
      where e.owner_id = memory.owner_default() and e.agent is not null and e.received_at > now() - interval '30 days'
    union all select m.sender from memory.message m
      where m.owner_id = memory.owner_default() and m.created_at > now() - interval '30 days'
    union all select memory.agent_name(c.client) from memory.mcp_client c
      where c.owner_id = memory.owner_default() and c.created_at > now() - interval '30 days'
    union all select a.name from memory.agent a where a.owner_id = memory.owner_default()
  ) s where s.n ~ '^[a-z0-9_-]{1,40}$' and s.n not in ('wen', 'memory', 'all')
$$;

create or replace function memory.board_agents() returns setof text language sql stable as $$
  select s.n from (
    select a.name as n from memory.agent a where a.owner_id = memory.owner_default() and a.last_seen > now() - interval '30 days'
    union
    select f.n from (values ('claude'), ('codex')) f(n) where
      exists (select 1 from memory.event e where e.owner_id = memory.owner_default() and e.agent = f.n
              and e.received_at > now() - interval '30 days')
      or exists (select 1 from memory.message m where m.owner_id = memory.owner_default() and m.sender = f.n
                 and m.created_at > now() - interval '30 days')
      or exists (select 1 from memory.mcp_client c where c.owner_id = memory.owner_default() and c.created_at > now() - interval '30 days'
                 and memory.agent_name(c.client) = f.n)
  ) s where s.n not in ('wen', 'memory', 'all') $$;

-- Each note and delivery goes to the owner of the message it is about.
create or replace function memory.drop_exhausted(who text default null) returns integer language plpgsql as $$
declare n integer;
begin
  with gone as (
    update memory.message_delivery d set dropped_at = now()
    where d.acked_at is null and d.dropped_at is null and d.delivered_count >= 3 and d.visible_after <= now()
      and (who is null or d.recipient = who)
    returning d.owner_id, d.message_id, d.recipient),
  notes as (
    insert into memory.message (owner_id, sender, recipient, body)
    select m.owner_id, 'memory', m.sender, 'Message #' || m.id || ' to ' || g.recipient ||
      ' was not acknowledged after 3 deliveries, so memory dropped it: ' || left(m.body, 80)
    from gone g join memory.message m on m.owner_id = g.owner_id and m.id = g.message_id
    where m.sender not in ('wen', 'memory')
    returning owner_id, id, recipient),
  note_deliveries as (
    insert into memory.message_delivery (owner_id, message_id, recipient) select owner_id, id, recipient from notes)
  select count(*) into n from gone;
  return n;
end $$;

create or replace function memory.purge_messages() returns jsonb language plpgsql as $$
declare exhausted integer; aged integer; removed integer; capped integer;
begin
  exhausted := memory.drop_exhausted(null);
  delete from memory.message m where m.expires_at <= now() or (
    exists (select 1 from memory.message_delivery d where d.owner_id = m.owner_id and d.message_id = m.id) and not exists (
      select 1 from memory.message_delivery d where d.owner_id = m.owner_id and d.message_id = m.id
        and d.acked_at is null and d.dropped_at is null));
  get diagnostics removed = row_count;
  delete from memory.message_delivery where acked_at < now() - interval '7 days' or dropped_at < now() - interval '7 days';
  get diagnostics aged = row_count;
  with ranked as (
    select d.id, d.owner_id, d.message_id, d.recipient,
      row_number() over (partition by d.owner_id, d.recipient order by d.id desc) as rn
    from memory.message_delivery d join memory.message m on m.owner_id = d.owner_id and m.id = d.message_id
    where d.acked_at is null and d.dropped_at is null and m.sender <> 'memory'),
  over_cap as (
    update memory.message_delivery d set dropped_at = now() from ranked r where d.id = r.id and r.rn > 100
    returning r.owner_id, r.recipient, r.message_id),
  notes as (
    insert into memory.message (owner_id, sender, recipient, body)
    select owner_id, 'memory', recipient, 'Dropped ' || count(*) || ' of your oldest unread messages to keep your queue at 100: ' ||
      string_agg('#' || message_id, ', ' order by message_id)
    from over_cap group by owner_id, recipient
    returning owner_id, id, recipient),
  note_deliveries as (
    insert into memory.message_delivery (owner_id, message_id, recipient) select owner_id, id, recipient from notes)
  select count(*) into capped from over_cap;
  return jsonb_build_object('exhausted', exhausted, 'aged_deliveries', aged, 'removed_messages', removed, 'capped', capped);
end $$;

create or replace function memory.deliver_legacy(mid bigint, readers text[]) returns void language sql as $$
  insert into memory.message_delivery (owner_id, message_id, recipient, delivered_count, acked_at)
  select m.owner_id, m.id, r.name, case when r.name = any(readers) then 1 else 0 end, case when r.name = any(readers) then now() end
  from memory.message m
  cross join lateral (
    select x.name from (
      select unnest(readers) as name
      union select m.recipient where m.recipient <> 'all'
      union select a from memory.board_agents() a where m.recipient = 'all') x
    where x.name <> m.sender) r
  where m.owner_id = memory.owner_default() and m.id = mid
    and not exists (select 1 from memory.message_delivery d where d.owner_id = m.owner_id and d.message_id = m.id)
  on conflict do nothing $$;

create or replace function memory.post_to_all(note text) returns bigint language sql as $$
  with r as (select a as name from memory.board_agents() a),
  m as (insert into memory.message (sender, recipient, body) select 'memory', 'all', note where exists (select 1 from r)
        returning owner_id, id),
  d as (insert into memory.message_delivery (owner_id, message_id, recipient) select m.owner_id, m.id, r.name from m, r returning 1)
  select id from m
$$;

create or replace function memory.reopen_expired_quests() returns integer language sql as $$
  with gone as (
    update memory.quest q set state = 'open', claimed_by = null, claimed_device = null, claimed_session = null, claimed_at = null,
      lease_until = null, updated_at = now()
    where q.id in (select id from memory.quest where state = 'claimed' and lease_until < now() for update skip locked)
    returning q.owner_id, q.id),
  noted as (
    insert into memory.quest_note (owner_id, quest_id, author, kind, body)
    select owner_id, id, 'memory', 'reopen', 'The lease ran out, so the quest is open again.' from gone returning 1)
  select count(*)::integer from gone $$;

-- Temperature and age read the owner's own feedback, opens and entries.
create or replace function memory.temperature(ids text[], as_of bigint, decay double precision, lo double precision, win integer,
    w_agent double precision, w_wen double precision, w_open double precision)
  returns table (id text, base double precision, temperature double precision) language sql stable as $$
  with heard as (
    select distinct on (f.retrieval_id, f.entry_id, f.source) f.entry_id as eid, f.seq,
      case when f.source = 'wen' then w_wen else w_agent end as w
    from memory.feedback f
    where f.owner_id = memory.owner_default() and f.entry_id = any(ids) and f.verdict in ('helpful', 'used')
      and f.source in ('agent', 'wen') and f.seq <= as_of and f.seq > as_of - win
    order by f.retrieval_id, f.entry_id, f.source, f.seq
  ), opened as (
    select distinct on (e.session_id, e.payload->>'entry_id', e.seq) e.payload->>'entry_id' as eid, e.seq, w_open as w
    from memory.event e
    where e.owner_id = memory.owner_default() and e.event = 'get_entry' and e.payload->>'entry_id' = any(ids)
      and e.seq <= as_of and e.seq > as_of - win
  ), total as (
    select x.eid, sum(x.w * power((as_of - x.seq + 1)::double precision, -decay)) as s
    from (select * from heard union all select * from opened) x group by x.eid
  )
  select i.eid, greatest(coalesce(ln(nullif(t.s, 0)), lo), lo), greatest(coalesce(ln(nullif(t.s, 0)), lo), lo) - lo
  from unnest(ids) as i(eid) left join total t on t.eid = i.eid
$$;

create or replace function memory.ranking_features(ids text[], as_of bigint, decay double precision, lo double precision,
    win integer, w_agent double precision, w_wen double precision, w_open double precision)
  returns table (id text, age bigint, temperature double precision) language sql stable as $$
  select e.id, greatest(as_of - e.written_seq, 0), t.temperature
  from memory.entry e join memory.temperature(ids, as_of, decay, lo, win, w_agent, w_wen, w_open) t on t.id = e.id
  where e.owner_id = memory.owner_default()
$$;

-- ---------------------------------------------------------------- views
-- Each view runs as whoever reads it, so memory_tenant sees through one only its own rows, and every join stays inside one owner.
create or replace view memory.entry_current with (security_invoker = true) as select e.* from memory.entry e
  where not exists (select 1 from memory.link l where l.owner_id = e.owner_id and l.dst = e.id and l.type = 'supersedes');

create or replace view memory.entries_overview with (security_invoker = true) as
select e.id, e.title, e.pattern, e.authority, e.scope, e.sensitivity, e.lang, e.valid_from, p.title as project,
  (select count(*) from memory.link l where l.owner_id = e.owner_id and (l.src = e.id or l.dst = e.id)) as links,
  (select count(*) from memory.retrieval r where r.owner_id = e.owner_id and r.delivered ? e.id) as times_delivered,
  (select string_agg(l.src, ', ') from memory.link l where l.owner_id = e.owner_id and l.dst = e.id and l.type = 'supersedes') as replaced_by,
  e.body, e.created_at, e.confidence, e.origin, e.owner_id
from memory.entry e left join memory.entry p on p.owner_id = e.owner_id and p.id = e.project;

create or replace view memory.links_readable with (security_invoker = true) as
select l.src, s.title as src_title, l.type, l.dst, d.title as dst_title, s.pattern as src_pattern, d.pattern as dst_pattern, l.owner_id
from memory.link l join memory.entry s on s.owner_id = l.owner_id and s.id = l.src join memory.entry d on d.owner_id = l.owner_id and d.id = l.dst;

create or replace view memory.recalls_recent with (security_invoker = true) as
select r.created_at, r.arm, s.client, r.query, r.task, r.latency_ms, r.degraded,
  (select string_agg(coalesce(e.title, x.id), ' | ' order by x.n)
   from jsonb_array_elements_text(r.delivered) with ordinality as x(id, n)
   left join memory.entry e on e.owner_id = r.owner_id and e.id = x.id) as delivered,
  r.id, r.owner_id
from memory.retrieval r left join memory.mcp_session s on s.owner_id = r.owner_id and s.id = r.mcp_session
order by r.created_at desc;

create or replace view memory.events_recent with (security_invoker = true) as
select v.received_at, v.agent, v.event, v.session_id,
  case v.event when 'UserPromptSubmit' then left(v.payload->>'prompt', 200) when 'PostToolUse' then v.payload->>'tool_name' end as summary,
  v.payload->>'cwd' as cwd, v.id, v.owner_id
from memory.event v order by v.received_at desc;

create or replace view memory.unanswered_recall with (security_invoker = true) as
  select r.id as retrieval_id, r.mcp_session, r.created_at
  from memory.retrieval r join memory.mcp_session s on s.owner_id = r.owner_id and s.id = r.mcp_session
  where s.client is distinct from 'http'
    and not (r.parent_id is not null and r.delivered = '[]'::jsonb)
    and not exists (select 1 from memory.feedback f where f.owner_id = r.owner_id and f.retrieval_id = r.id and f.source = 'agent');

grant select on memory.entry_current, memory.entries_overview, memory.links_readable, memory.recalls_recent,
  memory.events_recent, memory.unanswered_recall to memory_tenant;
