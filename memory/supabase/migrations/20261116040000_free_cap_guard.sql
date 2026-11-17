-- R74 (#79): Clyde's free tier has a hard cap, and a cost guard closes it before Supabase usage outruns revenue.
--
-- The cap is memory.plan.seats on the free row. memory.claim_free_seat(owner) gives an account a seat under a row lock on
-- that plan row, so concurrent sign-ins take turns and none passes the cap; with setting free_open = off it gives none.
-- memory.cost_reading() is what the guard (billing/guard.ts, POST /billing/guard) measures, and pg_cron runs the guard
-- hourly. Idempotent: safe to rerun.
set search_path = memory, extensions, public;

-- A seat for this account, if it has none, holds no comp or paid entitlement, free is open and a seat is left. True when the
-- account holds one after the call.
create or replace function memory.claim_free_seat(o uuid) returns boolean language plpgsql security definer
  set search_path = memory, pg_temp as $$
declare cap integer; taken integer;
begin
  if exists (select 1 from memory.account where owner_id = o and free_slot) then return true; end if;
  if coalesce((select value from memory.setting where name = 'free_open'), 'on') = 'off' then return false; end if;
  if exists (select 1 from memory.entitlement where owner_id = o and state in ('comp', 'paid')) then return false; end if;
  -- The lock that makes the count and the claim one step for every sign-in at once.
  select seats into cap from memory.plan where id = 'free' for update;
  select count(*) into taken from memory.account where free_slot;
  if cap is not null and taken >= cap then return false; end if;
  update memory.account set free_slot = true where owner_id = o and not free_slot;
  return found;
end $$;

-- What Supabase Pro bills on, as far as the database can see: its own size, Storage's bytes, the month's active users, and
-- this month's function invocations and blob egress as Clyde counts them (a hook event, a recall, a remember, an MCP
-- session each is at least one invocation; a blob read moves its bytes). Read as postgres.
create or replace function memory.cost_reading() returns jsonb language plpgsql stable security definer
  set search_path = memory, pg_temp as $$
declare month timestamptz := date_trunc('month', now()); storage bigint := 0; mau bigint := 0; calls bigint; egress bigint;
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
  return jsonb_build_object('db_bytes', pg_database_size(current_database()), 'storage_bytes', storage, 'mau', mau,
    'invocations', calls, 'egress_bytes', egress, 'month_fraction',
    extract(epoch from now() - month) / extract(epoch from (month + interval '1 month') - month));
end $$;

-- Hourly, at minute 41, with the cron secret from Vault.
select cron.unschedule('memory-cost-guard') where exists (select 1 from cron.job where jobname = 'memory-cost-guard');
select cron.schedule('memory-cost-guard', '41 * * * *', $$
  select net.http_post(
    url := 'https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory/billing/guard',
    headers := jsonb_build_object('Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 60000)
$$);
