-- R75: Hard free-tier spend control and ratio seat cap.
--
-- Free tier seats scale as N free accounts per M paid accounts (10 free per 1 paid by default, capped at `seats = 1000`).
-- Clyde itself counts as the first paid account so 10 free seats open at launch; each paid subscriber adds 10 more seats
-- up to 1,000 total. When taken seats reach the effective cap, sign-ins connect without a free seat and get the paid plan
-- link on use.
--
-- Free spend has two hard ceilings: each free account is capped at 250,000 LLM tokens/month (`openai_tokens_month`), and all
-- free accounts share a monthly global spend ceiling (`pool_spend_cap_micro_usd_month = 5000000`, $5.00 USD) tracked on
-- memory.usage under kind `free_pool_micro_usd_month`. Free accounts also have `quests = false`. Idempotent: safe to rerun.
set search_path = memory, extensions, public;

do $$ begin
  lock table memory.plan, memory.entitlement, memory.account, memory.usage in access exclusive mode;
end $$;

alter table memory.plan
  add column if not exists quests boolean not null default true,
  add column if not exists free_per_paid_n integer check (free_per_paid_n >= 0),
  add column if not exists free_per_paid_m integer check (free_per_paid_m > 0),
  add column if not exists pool_spend_cap_micro_usd_month bigint check (pool_spend_cap_micro_usd_month >= 0);

update memory.plan
set quests = false,
    openai_tokens_month = 250000,
    free_per_paid_n = 10,
    free_per_paid_m = 1,
    pool_spend_cap_micro_usd_month = 5000000
where id = 'free';

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
    check (kind in ('recalls_month', 'remembers_month', 'openai_tokens_month', 'blob_bytes_total',
      'overage_micro_usd_month', 'overage_reported_micro_usd_month', 'free_pool_micro_usd_month'));
end $$;

-- When an account gains an active paid or comp entitlement, return its free seat (if any) back to the free pool.
create or replace function memory.release_free_seat() returns trigger language plpgsql security definer
  set search_path = memory, pg_temp as $$
begin
  if new.state in ('comp', 'paid') then
    update memory.account set free_slot = false where owner_id = new.owner_id and free_slot;
  end if;
  return null;
end $$;

drop trigger if exists entitlement_release_free_seat on memory.entitlement;
create trigger entitlement_release_free_seat after insert or update of state on memory.entitlement
  for each row execute function memory.release_free_seat();

update memory.account a
set free_slot = false
from memory.entitlement e
where e.owner_id = a.owner_id and e.state in ('comp', 'paid') and a.free_slot;

-- Claim a free seat under the free plan row lock: respects free_open, monthly free-pool spend cap, N-per-M paid ratio
-- (counting Clyde as the 1st paid account), and the hard `seats` ceiling.
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
  if exists (select 1 from memory.entitlement where owner_id = o and state in ('comp', 'paid')) then return false; end if;

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

create or replace function memory.cost_reading() returns jsonb language plpgsql stable security definer
  set search_path = memory, pg_temp as $$
declare
  month timestamptz := date_trunc('month', now());
  month_utc date := date_trunc('month', now() at time zone 'utc')::date;
  storage bigint := 0;
  mau bigint := 0;
  calls bigint;
  egress bigint;
  pool_spent bigint := 0;
  seats_taken integer := 0;
  seats_cap integer;
  ratio_n integer;
  ratio_m integer;
  paid_subs integer;
begin
  if to_regclass('storage.objects') is not null then
    execute $q$select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects$q$ into storage;
  end if;
  if to_regclass('auth.users') is not null and exists (select 1 from information_schema.columns
      where table_schema = 'auth' and table_name = 'users' and column_name = 'last_sign_in_at') then
    execute $q$select count(*) from auth.users where last_sign_in_at >= $1$q$ into mau using month;
  end if;
  select (select count(*) from memory.event where received_at >= month)
    + (select count(*) from memory.retrieval where created_at >= month)
    + (select count(*) from memory.entry where created_at >= month)
    + (select count(*) from memory.mcp_client where created_at >= month) into calls;
  select coalesce(sum(b.size), 0) from memory.event e
    join memory.blob b on b.owner_id = e.owner_id and b.sha256 = e.payload->>'sha256'
    where e.event = 'get_blob' and e.received_at >= month into egress;
  select coalesce((select amount from memory.usage
    where owner_id = '00000000-0000-0000-0000-00000000f4ee'::uuid
      and period = month_utc and kind = 'free_pool_micro_usd_month'), 0) into pool_spent;
  select count(*)::int into seats_taken from memory.account where free_slot;
  select seats, free_per_paid_n, free_per_paid_m into seats_cap, ratio_n, ratio_m from memory.plan where id = 'free';
  if ratio_n is not null and ratio_m is not null then
    select count(*)::int into paid_subs
    from memory.entitlement
    where state = 'paid'
      and (not cancel_at_period_end or current_period_end is null or current_period_end > now());
    seats_cap := case when seats_cap is null then ((1 + paid_subs) * ratio_n) / ratio_m
      else least(seats_cap, ((1 + paid_subs) * ratio_n) / ratio_m) end;
  end if;
  return jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'storage_bytes', storage,
    'mau', mau,
    'invocations', calls,
    'egress_bytes', egress,
    'free_pool_micro_usd', pool_spent,
    'free_seats_taken', seats_taken,
    'free_seats_cap', seats_cap,
    'month_fraction', extract(epoch from now() - month) / extract(epoch from (month + interval '1 month') - month)
  );
end $$;
