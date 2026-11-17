-- R50 (#55), Clyde slice C3: every limit comes from memory.plan, Wen has none, and the allowlist becomes entitlement.
--
-- memory.plan gains entries_total: how many memories a plan holds (100 on free, none on clyde and owner). A confirmed
-- account whose email is on memory.allowed_email holds an entitlement with state comp, on the allowlist's plan (owner for
-- Wen, clyde with hard caps for anyone else he adds). Triggers keep the two in step: adding an address grants comp to its
-- account, removing it takes comp away, and an account that is created or confirmed later picks it up. entitled() reads
-- entitlements alone. A comp account holds no free seat. Idempotent: safe to rerun.
set search_path = memory, extensions, public;

-- The tables this changes, locked first in one statement, so live requests wait rather than deadlock (as R48's first push did).
do $$ begin
  lock table memory.plan, memory.entitlement, memory.account, memory.allowed_email in access exclusive mode;
end $$;

alter table memory.plan add column if not exists entries_total integer check (entries_total >= 0);
update memory.plan set entries_total = 100 where id = 'free' and entries_total is null;

alter table memory.entitlement drop constraint if exists entitlement_state_check;
alter table memory.entitlement add constraint entitlement_state_check
  check (state in ('pending', 'paid', 'lapsed', 'refunded', 'blocked', 'comp'));

-- Brings the comp entitlements of the accounts with these emails in line with the allowlist. Never touches a subscription.
create or replace function memory.sync_comp(emails text[]) returns void language plpgsql security definer
  set search_path = memory, pg_temp as $$
begin
  delete from memory.entitlement e using memory.account a
  where e.owner_id = a.owner_id and e.state = 'comp' and a.email = any(emails)
    and not (a.email_confirmed and exists (select 1 from memory.allowed_email al where al.email = a.email));
  insert into memory.entitlement (owner_id, provider, plan, state, event_at)
  select a.owner_id, 'comp', al.plan, 'comp', now()
  from memory.account a join memory.allowed_email al on al.email = a.email
  where a.email = any(emails) and a.email_confirmed
  on conflict (owner_id) do update set plan = excluded.plan, updated_at = now()
    where memory.entitlement.state = 'comp' and memory.entitlement.plan is distinct from excluded.plan;
  update memory.account a set free_slot = false
  from memory.entitlement e where e.owner_id = a.owner_id and e.state = 'comp' and a.email = any(emails) and a.free_slot;
end $$;

create or replace function memory.allowlist_comp() returns trigger language plpgsql security definer
  set search_path = memory, pg_temp as $$
begin
  perform memory.sync_comp(array_remove(array[
    case when tg_op <> 'INSERT' then old.email end, case when tg_op <> 'DELETE' then new.email end], null));
  return null;
end $$;
drop trigger if exists allowlist_comp on memory.allowed_email;
create trigger allowlist_comp after insert or update or delete on memory.allowed_email
  for each row execute function memory.allowlist_comp();

drop trigger if exists account_comp on memory.account;
create trigger account_comp after insert or update of email, email_confirmed on memory.account
  for each row execute function memory.allowlist_comp();

select memory.sync_comp(array(select email from memory.allowed_email));
