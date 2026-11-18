-- R66 (#71), Clyde slice C19: expire raw hook events after 180 days so Wen's event log stays bounded.
--
-- Drops any duplicate index if previously applied (20261103000000_message_queue already indexes memory.event(received_at)),
-- defines memory.purge_events(retention), locks execution to postgres, and schedules a daily pg_cron job
-- (memory-event-retention at 04:29 UTC). Idempotent: safe to rerun.
set search_path = memory, extensions, public;

drop index if exists memory.event_received_at;

create or replace function memory.purge_events(retention interval default interval '180 days')
returns jsonb language plpgsql security definer set search_path = memory, pg_temp as $$
declare
  removed bigint := 0;
begin
  delete from memory.event where received_at < now() - retention;
  get diagnostics removed = row_count;
  return jsonb_build_object('removed', removed);
end $$;

do $$
begin
  revoke all on function memory.purge_events(interval) from public;
  if exists (select 1 from pg_roles where rolname = 'memory_tenant') then
    revoke all on function memory.purge_events(interval) from memory_tenant;
  end if;
  if exists (select 1 from pg_roles where rolname = 'memory_console') then
    revoke all on function memory.purge_events(interval) from memory_console;
  end if;
  grant execute on function memory.purge_events(interval) to postgres;
end $$;

select cron.unschedule('memory-event-retention') where exists (select 1 from cron.job where jobname = 'memory-event-retention');
select cron.schedule('memory-event-retention', '29 4 * * *', $$select memory.purge_events()$$);
