-- R39, the contract half. It waits here, outside migrations, until the new function is live: the old function reads
-- message.read_by, so dropping the column any sooner breaks its inbox. Once the new function serves traffic, move this
-- file into migrations with a fresh timestamp and `supabase db push`. It gives a delivery to anything the old function
-- posted while the expand migration waited for the new function, then drops read_by. memory.deliver_legacy stays, since
-- /import uses it to restore a backup from before the queue. Idempotent: safe to rerun.
set search_path = memory, extensions, public;

select memory.convert_legacy_messages();
drop function if exists memory.convert_legacy_messages();
alter table memory.message drop column if exists read_by;
