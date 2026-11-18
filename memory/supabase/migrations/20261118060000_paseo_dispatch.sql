alter table memory.quest drop constraint if exists quest_priority_check;
alter table memory.quest add constraint quest_priority_check check (priority in ('urgent','high','normal','low'));
alter table memory.quest add column if not exists dispatch_id uuid;
alter table memory.quest add column if not exists dispatch_run text;
create unique index if not exists quest_dispatch_assignment on memory.quest(dispatch_id) where dispatch_id is not null;
create unique index if not exists quest_one_active_dispatch on memory.quest(owner_id, claimed_by, claimed_device)
  where state = 'claimed' and dispatch_id is not null;

-- Once delivery is acknowledged the host may still be working through an outage.
-- Recover the same assignment until the host confirms completion or release.
create or replace function memory.reopen_expired_quests() returns integer language sql as $$
  with gone as (
    update memory.quest q set state = 'open', claimed_by = null, claimed_device = null, claimed_session = null, claimed_at = null,
      lease_until = null, updated_at = now()
    where q.id in (select id from memory.quest where state = 'claimed' and dispatch_run is null and lease_until < now() for update skip locked)
    returning q.owner_id, q.id),
  noted as (
    insert into memory.quest_note (owner_id, quest_id, author, kind, body)
    select owner_id, id, 'memory', 'reopen', 'The lease ran out, so the quest is open again.' from gone returning 1)
  select count(*)::integer from gone $$;
