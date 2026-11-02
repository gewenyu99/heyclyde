-- entries_overview carries each entry's confidence and where it came from (seed, runtime or groomer).
create or replace view memory.entries_overview as
select e.id, e.title, e.pattern, e.authority, e.scope, e.sensitivity, e.lang, e.valid_from, p.title as project,
  (select count(*) from memory.link l where l.src = e.id or l.dst = e.id) as links,
  (select count(*) from memory.retrieval r where r.delivered ? e.id) as times_delivered,
  (select string_agg(l.src, ', ') from memory.link l where l.dst = e.id and l.type = 'supersedes') as replaced_by,
  e.body, e.created_at, e.confidence, e.origin
from memory.entry e left join memory.entry p on p.id = e.project;
