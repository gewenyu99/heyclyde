-- Trials and per-entry feedback (R28, R33). Expand only, so the function that is live now keeps working: every new column has
-- a default, a wider check only lets more through, and the new parameter sets serve no one until an allocation names them.
-- It reruns safely.

-- The entries a recall put on trial, in the packet's order. delivered keeps the main list's ids, so the two never overlap.
alter table memory.retrieval add column if not exists on_trial jsonb not null default '[]'::jsonb;

-- A new note has 3 chances, and a chance is spent as it's shown, so the count stays between 0 and 3. 0 already holds.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'entry_chances_left_max' and conrelid = 'memory.entry'::regclass) then
    alter table memory.entry add constraint entry_chances_left_max check (chances_left <= 3);
  end if;
end $$;

-- Feedback now takes used per entry and nothing_useful for a whole packet, beside the older helpful, irrelevant and wrong.
do $$ declare c record; begin
  for c in select conname from pg_constraint
           where conrelid = 'memory.feedback'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%verdict%' loop
    execute format('alter table memory.feedback drop constraint %I', c.conname);
  end loop;
  alter table memory.feedback add constraint feedback_verdict_check
    check (verdict in ('helpful', 'used', 'irrelevant', 'wrong', 'nothing_useful'));
end $$;

-- Coverage and the reminder both look feedback up by retrieval.
create index if not exists feedback_retrieval on memory.feedback (retrieval_id);

-- The recalls of MCP sessions that have no agent feedback yet. The reminder reads this view, newest first, one session at a
-- time. Recalls over HTTP have no feedback path, so they never appear.
create or replace view memory.unanswered_recall as
  select r.id as retrieval_id, r.mcp_session, r.created_at
  from memory.retrieval r join memory.mcp_session s on s.id = r.mcp_session
  where s.client is distinct from 'http'
    and not exists (select 1 from memory.feedback f where f.retrieval_id = r.id and f.source = 'agent');

-- hybrid.v3 and spreading.v3 are the v2 sets with the trial lane on: 3 entries listed apart from the settled main list, the
-- same relevance floor the filter uses, and the step sizes learn.ts defaults to. They exist only where a v2 does. They are
-- not allocated here, so no recall is served by them until an allocation says so.
insert into memory.param_set (id, arm, params, parent, note, created_by)
select replace(p.id, '.v2', '.v3'), p.arm,
  p.params || jsonb_build_object('trialItems', 3, 'trialFloor', 0.5, 'trialStep', 0.12, 'settledStep', 0.02),
  p.id, 'v2 with the trial lane: 3 On trial items above 0.5 relevance, steps 0.12 in trial and 0.02 settled.', 'migration'
from memory.param_set p where p.id in ('hybrid.v2', 'spreading.v2')
on conflict (id) do nothing;
