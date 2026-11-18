-- R62 (#67), Clyde slice C15: quest routing target (types, harness, device_id/device, repo, context).
-- Idempotent: safe to rerun.
set search_path = memory, extensions, public;

alter table memory.quest add column if not exists target jsonb not null default '{}'::jsonb;
alter table memory.quest drop constraint if exists quest_target_check;
alter table memory.quest add constraint quest_target_check check (jsonb_typeof(target) = 'object');

update memory.quest
set target = jsonb_strip_nulls(jsonb_build_object(
  'types', case when agent_type is not null then jsonb_build_array(agent_type) end,
  'repo', project,
  'device', computer
))
where target = '{}'::jsonb
  and (agent_type is not null or project is not null or computer is not null);
