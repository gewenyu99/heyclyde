-- Views for browsing memory in the Supabase dashboard (Table Editor, schema memory), the way the old console showed it.
-- They read the tables and change nothing.

-- Every entry with its project, how linked it is, how often recall delivered it, and what replaced it.
create or replace view memory.entries_overview as
select e.id, e.title, e.pattern, e.authority, e.scope, e.sensitivity, e.lang, e.valid_from, p.title as project,
  (select count(*) from memory.link l where l.src = e.id or l.dst = e.id) as links,
  (select count(*) from memory.retrieval r where r.delivered ? e.id) as times_delivered,
  (select string_agg(l.src, ', ') from memory.link l where l.dst = e.id and l.type = 'supersedes') as replaced_by,
  e.body, e.created_at
from memory.entry e left join memory.entry p on p.id = e.project;

-- Every binding between entries, with the titles on both ends.
create or replace view memory.links_readable as
select l.src, s.title as src_title, l.type, l.dst, d.title as dst_title, s.pattern as src_pattern, d.pattern as dst_pattern
from memory.link l join memory.entry s on s.id = l.src join memory.entry d on d.id = l.dst;

-- Recalls, newest first, with the titles of what each one delivered.
create or replace view memory.recalls_recent as
select r.created_at, r.arm, s.client, r.query, r.task, r.latency_ms, r.degraded,
  (select string_agg(coalesce(e.title, x.id), ' | ' order by x.n)
   from jsonb_array_elements_text(r.delivered) with ordinality as x(id, n) left join memory.entry e on e.id = x.id) as delivered,
  r.id
from memory.retrieval r left join memory.mcp_session s on s.id = r.mcp_session
order by r.created_at desc;

-- Hook events, newest first, with the prompt or tool name pulled out.
create or replace view memory.events_recent as
select v.received_at, v.agent, v.event, v.session_id,
  case v.event when 'UserPromptSubmit' then left(v.payload->>'prompt', 200) when 'PostToolUse' then v.payload->>'tool_name' end as summary,
  v.payload->>'cwd' as cwd, v.id
from memory.event v order by v.received_at desc;
