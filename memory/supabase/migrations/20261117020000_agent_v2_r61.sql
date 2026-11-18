-- R61 (#66), Clyde slice C14: agent identity v2 (nickname, type, harness, device_id, repos) and synced legacy columns.
-- Keeps R70 agent_type and projects columns in sync with type and repos via trigger so old and new callers agree.
-- Idempotent: safe to rerun.
set search_path = memory, extensions, public;

alter table memory.device drop constraint if exists device_owner_id_key;
alter table memory.device add constraint device_owner_id_key unique (owner_id, id);

alter table memory.agent add column if not exists nickname text;
alter table memory.agent drop constraint if exists agent_nickname_check;
alter table memory.agent add constraint agent_nickname_check
  check (nickname is null or nickname ~ '^[a-z0-9][a-z0-9_-]{0,39}$');

alter table memory.agent add column if not exists type text not null default 'other';
alter table memory.agent drop constraint if exists agent_v2_type_check;
alter table memory.agent add constraint agent_v2_type_check
  check (type in ('coding', 'exploration', 'research', 'review', 'ops', 'assistant', 'other'));

alter table memory.agent add column if not exists harness text;
alter table memory.agent drop constraint if exists agent_harness_check;
alter table memory.agent add constraint agent_harness_check
  check (harness is null or char_length(harness) between 1 and 64);

alter table memory.agent add column if not exists device_id bigint;
alter table memory.agent drop constraint if exists agent_device_id_fkey;
alter table memory.agent add constraint agent_device_id_fkey
  foreign key (owner_id, device_id) references memory.device (owner_id, id) on delete set null (device_id);

alter table memory.agent add column if not exists repos text[] not null default '{}';

create unique index if not exists agent_owner_nickname_idx
  on memory.agent (owner_id, lower(nickname))
  where nickname is not null;

-- Backfill type, repos, and device_id for agents created under earlier schemas.
update memory.agent
set type = agent_type
where type <> agent_type
  and agent_type is not null;

update memory.agent
set repos = projects
where cardinality(repos) = 0
  and cardinality(projects) > 0;

update memory.agent a
set device_id = d.id
from memory.device d
where a.device_id is null
  and d.owner_id = a.owner_id
  and d.name = a.registered_by;

create or replace function memory.sync_agent_v2() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.type is null or (new.type = 'other' and new.agent_type is not null and new.agent_type <> 'other') then
      new.type := coalesce(new.agent_type, 'other');
    else
      new.agent_type := new.type;
    end if;
    if coalesce(cardinality(new.repos), 0) = 0 and coalesce(cardinality(new.projects), 0) > 0 then
      new.repos := new.projects;
    elsif coalesce(cardinality(new.projects), 0) = 0 and coalesce(cardinality(new.repos), 0) > 0 then
      new.projects := new.repos;
    end if;
  else
    if new.type is distinct from old.type and new.agent_type is not distinct from old.agent_type then
      new.agent_type := new.type;
    elsif new.agent_type is distinct from old.agent_type and new.type is not distinct from old.type then
      new.type := new.agent_type;
    end if;
    if new.repos is distinct from old.repos and new.projects is not distinct from old.projects then
      new.projects := new.repos;
    elsif new.projects is distinct from old.projects and new.repos is not distinct from old.repos then
      new.repos := new.projects;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists agent_sync_v2 on memory.agent;
create trigger agent_sync_v2
  before insert or update on memory.agent
  for each row execute function memory.sync_agent_v2();
