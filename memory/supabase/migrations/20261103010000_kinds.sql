-- Every note has a claim kind: fact (checked against an event memory holds), wen (Wen's own words), observation (an agent's
-- inference or summary) or plan. Kind says what a note claims, and chances_left how many showings it still has to prove
-- itself. Neither hides a note: a new note is visible the moment it's written. Expand only, so the function that is live
-- now keeps working: every new column has a default.

-- The kind an entry written before this migration gets, from its pattern and evidence. One function, so a test can check
-- the rule on its own.
create or replace function memory.legacy_kind(pattern text, evidence_kind text) returns text language sql immutable as $$
  select case
    when pattern = 'references' and evidence_kind = 'quote' then 'fact'
    when evidence_kind = 'quote' then 'wen'
    else 'observation' end $$;

-- Existing entries migrate settled: chances_left 0, and their confidence stays as it is. The backfill runs once, when the
-- column is created, so a rerun never changes a kind that has been set since.
do $$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'memory' and table_name = 'entry' and column_name = 'kind') then
    alter table memory.entry add column kind text not null default 'observation'
      constraint entry_kind_check check (kind in ('fact', 'wen', 'observation', 'plan'));
    update memory.entry set kind = memory.legacy_kind(pattern, evidence_kind);
  end if;
end $$;

-- Showings left in the trial. 0 is settled.
alter table memory.entry add column if not exists chances_left integer not null default 0 check (chances_left >= 0);
-- The hook event whose text backs the note. No foreign key: events are trimmed on their own schedule.
alter table memory.entry add column if not exists evidence_event bigint;
-- true when the quote checked out against that event, false when a claimed fact or wen failed the check, null when no check ran.
alter table memory.entry add column if not exists verified boolean;

-- entry_current expands e.* when it's created, so it's rebuilt to carry the new columns.
create or replace view memory.entry_current as select e.* from memory.entry e
  where not exists (select 1 from memory.link l where l.dst = e.id and l.type = 'supersedes');
