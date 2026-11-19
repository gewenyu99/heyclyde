-- Reopen expired unacked leases and stale acked leases (>24h past lease_until), clearing dispatch_id/dispatch_run cleanly.
-- Acked leases within the 24h outage grace window keep their assignment so the host recovers without duplicate delivery.
create or replace function memory.reopen_expired_quests() returns integer language sql as $$
  with gone as (
    update memory.quest q set state = 'open', claimed_by = null, claimed_device = null, claimed_session = null, claimed_at = null,
      dispatch_id = null, dispatch_run = null, lease_until = null, updated_at = now()
    where q.id in (
      select id from memory.quest
      where state = 'claimed'
        and ((dispatch_run is null and lease_until < now())
          or (dispatch_run is not null and lease_until < now() - interval '24 hours'))
      for update skip locked
    )
    returning q.owner_id, q.id),
  noted as (
    insert into memory.quest_note (owner_id, quest_id, author, kind, body)
    select owner_id, id, 'memory', 'reopen', 'The lease ran out, so the quest is open again.' from gone returning 1)
  select count(*)::integer from gone $$;
