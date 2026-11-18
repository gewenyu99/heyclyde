-- R59 (#64), Clyde slice C12: per-owner metering, 2.3x Polar overage ingest, spend limit, and past_due cutoff.
--
-- Extends memory.usage with quantity, cost_micro_usd, and reported_cost_micro_usd across the five metered kinds
-- ('ai', 'storage_gb_hours', 'egress_bytes', 'requests', 'db_bytes'), adds spend_limit_cents (0..50000, default 2000) and
-- state 'past_due' to memory.entitlement, allows 'usage' idempotency keys in memory.billing_action, and schedules
-- memory.sample_usage() hourly to sample Storage GB-hours and database bytes per owner. Idempotent: safe to rerun.
set search_path = memory, extensions, public;

do $$ begin
  lock table memory.plan, memory.entitlement, memory.account, memory.usage, memory.billing_action in access exclusive mode;
end $$;

alter table memory.entitlement
  add column if not exists spend_limit_cents integer not null default 2000 check (spend_limit_cents between 0 and 50000);

alter table memory.entitlement drop constraint if exists entitlement_state_check;
alter table memory.entitlement add constraint entitlement_state_check
  check (state in ('pending', 'paid', 'past_due', 'lapsed', 'refunded', 'blocked', 'comp'));

alter table memory.usage
  add column if not exists quantity bigint not null default 0,
  add column if not exists cost_micro_usd bigint not null default 0,
  add column if not exists reported_cost_micro_usd bigint not null default 0;

do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'memory.usage'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%kind%'
  loop
    execute format('alter table memory.usage drop constraint if exists %I', c);
  end loop;
  alter table memory.usage add constraint usage_kind_check
    check (kind in (
      'recalls_month', 'remembers_month', 'openai_tokens_month', 'blob_bytes_total',
      'overage_micro_usd_month', 'overage_reported_micro_usd_month', 'free_pool_micro_usd_month',
      'ai', 'storage_gb_hours', 'egress_bytes', 'requests', 'db_bytes'
    ));
end $$;

do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'memory.billing_action'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%action%'
  loop
    execute format('alter table memory.billing_action drop constraint if exists %I', c);
  end loop;
  alter table memory.billing_action add constraint billing_action_action_check
    check (action in ('cancel', 'refund', 'usage'));
end $$;

-- Releasing and claiming free seats keeps R75 logic while also excluding past_due subscriptions from free seats.
create or replace function memory.release_free_seat() returns trigger language plpgsql security definer
  set search_path = memory, pg_temp as $$
begin
  if new.state in ('comp', 'paid', 'past_due') then
    update memory.account set free_slot = false where owner_id = new.owner_id and free_slot;
  end if;
  return null;
end $$;

create or replace function memory.claim_free_seat(o uuid) returns boolean language plpgsql security definer
  set search_path = memory, pg_temp as $$
declare
  cap integer;
  ratio_n integer;
  ratio_m integer;
  pool_cap bigint;
  pool_spent bigint;
  paid_subs integer;
  paid_total bigint;
  ratio_cap integer;
  effective_cap integer;
  taken integer;
begin
  if exists (select 1 from memory.account where owner_id = o and free_slot) then return true; end if;
  if coalesce((select value from memory.setting where name = 'free_open'), 'on') = 'off' then return false; end if;
  if exists (select 1 from memory.entitlement where owner_id = o and state in ('comp', 'paid', 'past_due')) then return false; end if;

  select seats, free_per_paid_n, free_per_paid_m, pool_spend_cap_micro_usd_month
  into cap, ratio_n, ratio_m, pool_cap
  from memory.plan where id = 'free' for update;

  if pool_cap is not null then
    select coalesce(amount, 0) into pool_spent
    from memory.usage
    where owner_id = '00000000-0000-0000-0000-00000000f4ee'::uuid
      and period = date_trunc('month', now() at time zone 'utc')::date
      and kind = 'free_pool_micro_usd_month';
    if coalesce(pool_spent, 0) >= pool_cap then return false; end if;
  end if;

  if ratio_n is not null and ratio_m is not null then
    select count(*)::int into paid_subs
    from memory.entitlement
    where state = 'paid'
      and (not cancel_at_period_end or current_period_end is null or current_period_end > now());
    -- Clyde counts as the 1st paid user.
    paid_total := 1 + paid_subs;
    ratio_cap := least(2147483647, (paid_total * ratio_n) / ratio_m)::int;
    effective_cap := case when cap is null then ratio_cap else least(cap, ratio_cap) end;
  else
    effective_cap := cap;
  end if;

  select count(*)::int into taken from memory.account where free_slot;
  if effective_cap is not null and taken >= effective_cap then return false; end if;

  update memory.account set free_slot = true where owner_id = o and not free_slot;
  return found;
end $$;

-- Sample per-owner Storage byte-hours -> storage_gb_hours and per-owner database footprint -> db_bytes.
create or replace function memory.sample_usage() returns jsonb language plpgsql security definer
  set search_path = memory, pg_temp as $$
declare
  month_utc date := date_trunc('month', now() at time zone 'utc')::date;
  storage_owners integer := 0;
  db_owners integer := 0;
begin
  create temp table if not exists _clyde_storage_sample (
    owner_id uuid primary key,
    bytes bigint not null
  ) on commit drop;
  truncate _clyde_storage_sample;

  if to_regclass('storage.objects') is not null then
    execute $q$
      insert into _clyde_storage_sample (owner_id, bytes)
      select owner_id, sum(bytes)::bigint
      from (
        select
          case
            when split_part(name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(name, '/', 1)::uuid
            else memory.wen()
          end as owner_id,
          coalesce((metadata->>'size')::bigint, 0) as bytes
        from storage.objects
        where bucket_id = 'memory-blobs' and name not like 'incoming/%'
      ) s
      where owner_id is not null and bytes > 0
      group by owner_id
    $q$;
  end if;

  insert into _clyde_storage_sample (owner_id, bytes)
  select owner_id, sum(size)::bigint
  from memory.blob
  where stored = 'storage' and size > 0
  group by owner_id
  on conflict (owner_id) do nothing;

  insert into memory.usage as u (owner_id, period, kind, amount, quantity, cost_micro_usd)
  select
    s.owner_id,
    month_utc,
    'storage_gb_hours',
    s.bytes,
    ceil(s.bytes::numeric / 1000000000.0)::bigint,
    ceil((s.bytes::numeric / 1000000000.0) * (21300.0 / 730.0))::bigint
  from _clyde_storage_sample s
  where s.bytes > 0
  on conflict (owner_id, period, kind) do update set
    amount = u.amount + excluded.amount,
    quantity = ceil(((u.amount + excluded.amount)::numeric) / 1000000000.0)::bigint,
    cost_micro_usd = ceil((((u.amount + excluded.amount)::numeric) / 1000000000.0) * (21300.0 / 730.0))::bigint;
  get diagnostics storage_owners = row_count;

  insert into memory.usage as u (owner_id, period, kind, amount, quantity, cost_micro_usd)
  select
    d.owner_id,
    month_utc,
    'db_bytes',
    sum(d.bytes)::bigint,
    sum(d.bytes)::bigint,
    ceil((sum(d.bytes)::numeric / 1000000000.0) * 125000.0)::bigint
  from (
    select owner_id, coalesce(sum(pg_column_size(t.*)), 0)::bigint as bytes from memory.entry t group by owner_id
    union all
    select owner_id, coalesce(sum(pg_column_size(t.*)), 0)::bigint as bytes from memory.entry_embedding t group by owner_id
    union all
    select owner_id, coalesce(sum(pg_column_size(t.*)), 0)::bigint as bytes from memory.blob t where stored = 'db' group by owner_id
    union all
    select owner_id, coalesce(sum(pg_column_size(t.*)), 0)::bigint as bytes from memory.retrieval t group by owner_id
    union all
    select owner_id, coalesce(sum(pg_column_size(t.*)), 0)::bigint as bytes from memory.message t group by owner_id
    union all
    select owner_id, coalesce(sum(pg_column_size(t.*)), 0)::bigint as bytes from memory.quest t group by owner_id
  ) d
  where d.bytes > 0
  group by d.owner_id
  on conflict (owner_id, period, kind) do update set
    amount = excluded.amount,
    quantity = excluded.quantity,
    cost_micro_usd = excluded.cost_micro_usd;
  get diagnostics db_owners = row_count;

  return jsonb_build_object('ok', true, 'storage_owners', storage_owners, 'db_owners', db_owners);
end $$;

select cron.unschedule('memory-usage-sample') where exists (select 1 from cron.job where jobname = 'memory-usage-sample');
select cron.schedule('memory-usage-sample', '3 * * * *', $$ select memory.sample_usage() $$);
