-- R70 (#75): agents register computer, projects, agent_type, strict_projects, and expanded work/home/hobby/personal/both
-- realms; mcp_client snapshots per-session agent scope to prevent multi-window collisions; entries carry category, context,
-- transferability, project_slug, and computer; quests support expanded realms and optional project/computer/agent_type.
-- Idempotent: safe to rerun.
set search_path = memory, extensions, public;

-- ---------------------------------------------------------------- 1. memory.agent
do $$
declare con record;
begin
  for con in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'memory.agent'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%context%'
  loop
    execute format('alter table memory.agent drop constraint if exists %I', con.conname);
  end loop;
end $$;

alter table memory.agent add constraint agent_context_check
  check (context in ('work', 'home', 'hobby', 'personal', 'both'));

alter table memory.agent add column if not exists computer text;
alter table memory.agent drop constraint if exists agent_computer_check;
alter table memory.agent add constraint agent_computer_check
  check (computer is null or char_length(computer) between 1 and 64);

alter table memory.agent add column if not exists projects text[] not null default '{}';

alter table memory.agent add column if not exists agent_type text not null default 'other';
alter table memory.agent drop constraint if exists agent_type_check;
alter table memory.agent add constraint agent_type_check
  check (agent_type in ('coding', 'exploration', 'research', 'review', 'ops', 'assistant', 'other'));

alter table memory.agent add column if not exists strict_projects boolean not null default false;

-- ---------------------------------------------------------------- 2. memory.mcp_client session snapshot
alter table memory.mcp_client add column if not exists session_context text;
alter table memory.mcp_client drop constraint if exists mcp_client_session_context_check;
alter table memory.mcp_client add constraint mcp_client_session_context_check
  check (session_context is null or session_context in ('work', 'home', 'hobby', 'personal', 'both'));

alter table memory.mcp_client add column if not exists session_projects text[];
alter table memory.mcp_client add column if not exists session_computer text;
alter table memory.mcp_client add column if not exists session_strict_projects boolean;

-- ---------------------------------------------------------------- 3. memory.entry categorization & transferability
do $$
declare
  has_owner boolean := exists (
    select 1 from information_schema.columns
    where table_schema = 'memory' and table_name = 'entry' and column_name = 'owner_id'
  );
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'memory' and table_name = 'entry' and column_name = 'transferability'
  ) then
    alter table memory.entry add column if not exists category text not null default 'general';
    alter table memory.entry add column if not exists context text not null default 'general';
    alter table memory.entry add column if not exists transferability text not null default 'general';
    alter table memory.entry add column if not exists project_slug text;
    alter table memory.entry add column if not exists computer text;

    -- Backfill existing rows once on initial upgrade without disturbing tea-* / global baseline entries.
    update memory.entry
    set category = case pattern
      when 'decisions' then 'architecture'
      when 'preferences' then 'preferences'
      when 'projects' then 'product'
      when 'reactions' then 'workflow'
      else 'general'
    end
    where category = 'general'
      and pattern in ('decisions', 'preferences', 'projects', 'reactions');

    update memory.entry
    set project_slug = nullif(lower(regexp_replace(scope, '^repo:', '')), '')
    where project_slug is null and scope like 'repo:%';

    if has_owner then
      execute $b$
        update memory.entry e
        set project_slug = lower(p.repo)
        from memory.entry_provenance p
        where p.entry_id = e.id and p.owner_id = e.owner_id
          and e.project_slug is null and p.repo is not null and p.repo <> '';

        update memory.entry e
        set computer = p.device
        from memory.entry_provenance p
        where p.entry_id = e.id and p.owner_id = e.owner_id
          and e.computer is null and p.device is not null and p.device <> '';

        update memory.entry e
        set
          context = case
            when e.pattern in ('preferences', 'recommendations', 'references') and e.project_slug is null then 'general'
            when p.agent_context in ('work', 'home', 'hobby', 'personal') then p.agent_context
            else 'general'
          end,
          transferability = case
            when e.project_slug is not null then 'project'
            when e.pattern in ('preferences', 'recommendations', 'references') then 'general'
            when p.agent_context in ('work', 'home', 'hobby', 'personal') and e.scope <> 'global' then 'context'
            else 'general'
          end
        from (
          select e2.id, e2.owner_id, p2.agent_context
          from memory.entry e2
          left join memory.entry_provenance p2 on p2.entry_id = e2.id and p2.owner_id = e2.owner_id
        ) p
        where p.id = e.id and p.owner_id = e.owner_id
          and (
            e.project_slug is not null
            or (e.pattern not in ('preferences', 'recommendations', 'references') and p.agent_context in ('work', 'home', 'hobby', 'personal'))
          );
      $b$;
    else
      update memory.entry e
      set project_slug = lower(p.repo)
      from memory.entry_provenance p
      where p.entry_id = e.id
        and e.project_slug is null
        and p.repo is not null
        and p.repo <> '';

      update memory.entry e
      set computer = p.device
      from memory.entry_provenance p
      where p.entry_id = e.id
        and e.computer is null
        and p.device is not null
        and p.device <> '';

      update memory.entry e
      set
        context = case
          when e.pattern in ('preferences', 'recommendations', 'references') and e.project_slug is null then 'general'
          when p.agent_context in ('work', 'home', 'hobby', 'personal') then p.agent_context
          else 'general'
        end,
        transferability = case
          when e.project_slug is not null then 'project'
          when e.pattern in ('preferences', 'recommendations', 'references') then 'general'
          when p.agent_context in ('work', 'home', 'hobby', 'personal') and e.scope <> 'global' then 'context'
          else 'general'
        end
      from (
        select e2.id, p2.agent_context
        from memory.entry e2
        left join memory.entry_provenance p2 on p2.entry_id = e2.id
      ) p
      where p.id = e.id
        and (
          e.project_slug is not null
          or (e.pattern not in ('preferences', 'recommendations', 'references') and p.agent_context in ('work', 'home', 'hobby', 'personal'))
        );
    end if;
  end if;
end $$;

alter table memory.entry add column if not exists category text not null default 'general';
alter table memory.entry drop constraint if exists entry_category_check;
alter table memory.entry add constraint entry_category_check
  check (category ~ '^[a-z0-9][a-z0-9-]{0,39}$');

alter table memory.entry add column if not exists context text not null default 'general';
alter table memory.entry drop constraint if exists entry_context_check;
alter table memory.entry add constraint entry_context_check
  check (context in ('general', 'work', 'home', 'hobby', 'personal'));

alter table memory.entry add column if not exists transferability text not null default 'general';
alter table memory.entry drop constraint if exists entry_transferability_check;
alter table memory.entry add constraint entry_transferability_check
  check (transferability in ('general', 'context', 'project', 'computer'));

alter table memory.entry add column if not exists project_slug text;
alter table memory.entry add column if not exists computer text;

create index if not exists entry_category_idx on memory.entry (category);
create index if not exists entry_context_idx on memory.entry (context);
create index if not exists entry_transferability_idx on memory.entry (transferability);
create index if not exists entry_project_slug_idx on memory.entry (project_slug);

-- entry_current expands e.* when created, so rebuild it to expose the 5 new columns, preserving R48 tenancy if applied.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'memory' and table_name = 'entry' and column_name = 'owner_id'
  ) then
    execute $v$
      create or replace view memory.entry_current with (security_invoker = true) as
        select e.* from memory.entry e
        where not exists (
          select 1 from memory.link l
          where l.owner_id = e.owner_id and l.dst = e.id and l.type = 'supersedes'
        );
    $v$;
  else
    execute $v$
      create or replace view memory.entry_current as
        select e.* from memory.entry e
        where not exists (select 1 from memory.link l where l.dst = e.id and l.type = 'supersedes');
    $v$;
  end if;
  if exists (select 1 from pg_roles where rolname = 'memory_tenant') then
    execute 'grant select on memory.entry_current to memory_tenant';
  end if;
end $$;

-- ---------------------------------------------------------------- 4. memory.quest
do $$
declare con record;
begin
  for con in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'memory.quest'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%context%'
  loop
    execute format('alter table memory.quest drop constraint if exists %I', con.conname);
  end loop;
end $$;

alter table memory.quest add constraint quest_context_check
  check (context in ('work', 'home', 'hobby', 'personal', 'both'));

alter table memory.quest add column if not exists project text;
alter table memory.quest add column if not exists computer text;
alter table memory.quest add column if not exists agent_type text;
alter table memory.quest drop constraint if exists quest_agent_type_check;
alter table memory.quest add constraint quest_agent_type_check
  check (agent_type is null or agent_type in ('coding', 'exploration', 'research', 'review', 'ops', 'assistant', 'other'));
