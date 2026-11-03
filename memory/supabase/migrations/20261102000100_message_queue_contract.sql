-- R39, the contract half. The new function no longer reads message.read_by. This catches anything the old function wrote
-- while this migration waited for the new one, then drops the column. Idempotent: safe to rerun.
set search_path = memory, extensions, public;

select memory.convert_legacy_messages();
drop function if exists memory.convert_legacy_messages();
alter table memory.message drop column if exists read_by;
