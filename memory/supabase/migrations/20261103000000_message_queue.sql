-- R39: the message board is a queue. Every message gets one delivery per recipient. A delivery is claimed with a
-- visibility timeout, acknowledged, dropped after three tries, or dismissed, and a daily purge keeps the board from
-- piling up. This is the expand half: it adds what the new function needs and converts the rows, and it leaves
-- message.read_by alone, so the old function keeps working until the new one deploys. The contract half, which gives a
-- delivery to what the old function posted in between and drops read_by, waits in supabase/contract. It joins the
-- migrations once the new function is live.
-- Idempotent: safe to rerun.
set search_path = memory, extensions, public;

alter table memory.message add column if not exists expires_at timestamptz not null default now() + interval '14 days';
create index if not exists message_expires on memory.message (expires_at);
-- agent_names() reads these by date on every broadcast. Not concurrent: a migration runs in a transaction, and both tables
-- are small.
create index if not exists message_created on memory.message (created_at);
create index if not exists event_received on memory.event (received_at) where agent is not null;

-- One row per message and recipient. visible_after is when a claimed delivery may come back, acked_at is set by an ack,
-- a dismiss or the hook inbox, and dropped_at by three deliveries with no ack, or by the 100 a recipient may hold.
create table if not exists memory.message_delivery (
  id bigserial primary key,
  message_id bigint not null references memory.message(id) on delete cascade,
  recipient text not null,
  delivered_count integer not null default 0,
  visible_after timestamptz not null default now(),
  acked_at timestamptz,
  dropped_at timestamptz,
  unique (message_id, recipient));
-- A recipient's waiting deliveries, oldest first, are all check_messages reads.
create index if not exists message_delivery_live on memory.message_delivery (recipient, id)
  where acked_at is null and dropped_at is null;
create index if not exists message_delivery_acked on memory.message_delivery (acked_at) where acked_at is not null;
create index if not exists message_delivery_dropped on memory.message_delivery (dropped_at) where dropped_at is not null;

-- An agent's name from its MCP client name, the rule service.ts agentName also applies: claude or codex when the client says
-- so, else the lowercased name with anything outside a-z, 0-9, _ and - turned into -, at most 40 characters, or agent.
create or replace function memory.agent_name(client text) returns text language sql immutable as $$
  select case when lower(coalesce(client, '')) like '%claude%' then 'claude'
    when lower(coalesce(client, '')) like '%codex%' then 'codex'
    else coalesce(nullif(left(btrim(regexp_replace(lower(coalesce(client, '')), '[^a-z0-9_-]+', '-', 'g'), '-'), 40), ''), 'agent') end $$;

-- Every agent name seen in the last 30 days: hook events, message senders, MCP clients and, once R19 lands, the agent
-- registry. 'all' fans out to these. The registry may not exist yet, or may not have a name column.
create or replace function memory.agent_names() returns setof text language plpgsql stable as $$
declare registered text[] := '{}';
begin
  if to_regclass('memory.agent') is not null then
    begin
      execute 'select coalesce(array_agg(name::text), ''{}'') from memory.agent' into registered;
    exception when undefined_column then
      registered := '{}';
    end;
  end if;
  return query
    select distinct s.n from (
      select e.agent as n from memory.event e where e.agent is not null and e.received_at > now() - interval '30 days'
      union all select m.sender from memory.message m where m.created_at > now() - interval '30 days'
      union all select memory.agent_name(c.client) from memory.mcp_client c where c.created_at > now() - interval '30 days'
      union all select unnest(registered)
    ) s where s.n ~ '^[a-z0-9_-]{1,40}$' and s.n not in ('wen', 'memory', 'all');
end $$;

-- Drops the deliveries that went out three times with no ack and whose last 30 minutes have passed, for one recipient or,
-- with null, for everyone. Each one sends its sender a note, unless the sender is Wen or memory itself. Returns how many.
create or replace function memory.drop_exhausted(who text default null) returns integer language plpgsql as $$
declare n integer;
begin
  with gone as (
    update memory.message_delivery d set dropped_at = now()
    where d.acked_at is null and d.dropped_at is null and d.delivered_count >= 3 and d.visible_after <= now()
      and (who is null or d.recipient = who)
    returning d.message_id, d.recipient),
  notes as (
    insert into memory.message (sender, recipient, body)
    select 'memory', m.sender, 'Message #' || m.id || ' to ' || g.recipient ||
      ' was not acknowledged after 3 deliveries, so memory dropped it: ' || left(m.body, 80)
    from gone g join memory.message m on m.id = g.message_id
    where m.sender not in ('wen', 'memory')
    returning id, recipient),
  note_deliveries as (
    insert into memory.message_delivery (message_id, recipient) select id, recipient from notes)
  select count(*) into n from gone;
  return n;
end $$;

-- The daily purge. It drops what ran out of tries, deletes messages past expires_at or whose deliveries are all done, then
-- deletes deliveries acked or dropped over 7 days ago, and caps each recipient at the newest 100 live deliveries, with one
-- note to the recipient naming the messages it dropped. A message with no delivery at all stays until it expires: the old
-- function posts those before the contract migration gives them one. Notes themselves don't count toward the cap. Returns
-- the counts.
create or replace function memory.purge_messages() returns jsonb language plpgsql as $$
declare exhausted integer; aged integer; removed integer; capped integer;
begin
  exhausted := memory.drop_exhausted(null);
  delete from memory.message m where m.expires_at <= now() or (
    exists (select 1 from memory.message_delivery d where d.message_id = m.id) and not exists (
      select 1 from memory.message_delivery d where d.message_id = m.id and d.acked_at is null and d.dropped_at is null));
  get diagnostics removed = row_count;
  delete from memory.message_delivery where acked_at < now() - interval '7 days' or dropped_at < now() - interval '7 days';
  get diagnostics aged = row_count;
  with ranked as (
    select d.id, d.message_id, d.recipient, row_number() over (partition by d.recipient order by d.id desc) as rn
    from memory.message_delivery d join memory.message m on m.id = d.message_id
    where d.acked_at is null and d.dropped_at is null and m.sender <> 'memory'),
  over_cap as (
    update memory.message_delivery d set dropped_at = now() from ranked r where d.id = r.id and r.rn > 100
    returning r.recipient, r.message_id),
  notes as (
    insert into memory.message (sender, recipient, body)
    select 'memory', recipient, 'Dropped ' || count(*) || ' of your oldest unread messages to keep your queue at 100: ' ||
      string_agg('#' || message_id, ', ' order by message_id)
    from over_cap group by recipient
    returning id, recipient),
  note_deliveries as (
    insert into memory.message_delivery (message_id, recipient) select id, recipient from notes)
  select count(*) into capped from over_cap;
  return jsonb_build_object('exhausted', exhausted, 'aged_deliveries', aged, 'removed_messages', removed, 'capped', capped);
end $$;

-- Gives a message from before the queue its deliveries, if it has none: one per name in readers (who read it), plus its
-- recipient, or for 'all' every agent seen lately, minus its sender. Names in readers are acked, the rest are waiting.
-- The migration and /import both use it.
create or replace function memory.deliver_legacy(mid bigint, readers text[]) returns void language sql as $$
  insert into memory.message_delivery (message_id, recipient, delivered_count, acked_at)
  select m.id, r.name, case when r.name = any(readers) then 1 else 0 end, case when r.name = any(readers) then now() end
  from memory.message m
  cross join lateral (
    select x.name from (
      select unnest(readers) as name
      union select m.recipient where m.recipient <> 'all'
      union select a from memory.agent_names() a where m.recipient = 'all') x
    where x.name <> m.sender) r
  where m.id = mid and not exists (select 1 from memory.message_delivery d where d.message_id = m.id)
  on conflict do nothing $$;

-- Moves read_by into deliveries. Then anyone the old function marked read since is acked. It does nothing once read_by is
-- gone.
create or replace function memory.convert_legacy_messages() returns void language plpgsql as $$
begin
  if not exists (select 1 from information_schema.columns
      where table_schema = 'memory' and table_name = 'message' and column_name = 'read_by') then
    return;
  end if;
  execute 'select memory.deliver_legacy(m.id, m.read_by) from memory.message m';
  execute $q$
    update memory.message_delivery d set acked_at = now(), delivered_count = greatest(d.delivered_count, 1)
    from memory.message m where m.id = d.message_id and d.acked_at is null and d.recipient = any(m.read_by)$q$;
end $$;

select memory.convert_legacy_messages();

-- Daily at 04:17 UTC, in plain SQL, so it needs no route and no secret.
select cron.unschedule('memory-message-purge') where exists (select 1 from cron.job where jobname = 'memory-message-purge');
select cron.schedule('memory-message-purge', '17 4 * * *', $$select memory.purge_messages()$$);
