-- Quest #41: release free seats when an account is geo-blocked, refuse free seats for blocked entitlements,
-- and lock down EXECUTE grants on privileged SECURITY DEFINER functions in schema memory.

create or replace function memory.release_free_seat() returns trigger language plpgsql security definer
  set search_path = memory, pg_temp as $$
begin
  if new.state in ('comp', 'paid', 'past_due', 'blocked') then
    update memory.account set free_slot = false where owner_id = new.owner_id and free_slot;
  end if;
  return null;
end $$;

update memory.account a
set free_slot = false
from memory.entitlement e
where e.owner_id = a.owner_id and e.state = 'blocked' and a.free_slot;

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
  if exists (select 1 from memory.entitlement where owner_id = o and state in ('comp', 'paid', 'past_due', 'blocked')) then
    return false;
  end if;
  if exists (select 1 from memory.account where owner_id = o and free_slot) then return true; end if;
  if coalesce((select value from memory.setting where name = 'free_open'), 'on') = 'off' then return false; end if;

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

-- Least-privilege EXECUTE grants on privileged SECURITY DEFINER functions.
do $$
declare
  fn text;
  r text;
begin
  foreach fn in array array[
    'memory.reseed_reviewer()',
    'memory.sync_comp(text[])',
    'memory.allowlist_comp()',
    'memory.release_free_seat()',
    'memory.claim_free_seat(uuid)',
    'memory.cost_reading()',
    'memory.sample_usage()',
    'memory.purge_events(interval)'
  ] loop
    if to_regprocedure(fn) is not null then
      execute format('revoke all on function %s from public', fn);
      foreach r in array array['memory_tenant', 'anon', 'authenticated'] loop
        if exists (select 1 from pg_roles where rolname = r) then
          execute format('revoke all on function %s from %I', fn, r);
        end if;
      end loop;
      execute format('grant execute on function %s to postgres', fn);
    end if;
  end loop;
end $$;
