-- memory learns from how Wen reacts, with no approval step. Every entry carries a confidence and every link a weight.
-- Helpful recalls reinforce what they served, pushback weakens what caused it, and an entry the filter keeps judging
-- irrelevant eases off. Nothing moves by calendar time: an entry nobody recalls for a year stays as it was.

-- 0 to 1. Recall ranks by score × (0.5 + confidence / 2) and skips entries under 0.15, which stay stored as dormant.
-- Seeded once from authority when the column is created, so a rerun never resets what the learner has learned.
do $$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'memory' and table_name = 'entry' and column_name = 'confidence') then
    alter table memory.entry add column confidence real not null default 0.7 check (confidence between 0 and 1);
    update memory.entry set confidence = case authority when 'approved' then 0.95 when 'observed' then 0.7 else 0.4 end;
  end if;
end $$;
-- Recalls in a row where this entry was a candidate and the filter judged it irrelevant. Delivery resets it.
alter table memory.entry add column if not exists miss_streak integer not null default 0;

-- The learner's read of the prompt Wen sent after a recall: did he push back, and which delivered item caused it.
alter table memory.retrieval add column if not exists reaction jsonb;
alter table memory.retrieval add column if not exists learned_at timestamptz;
create index if not exists retrieval_unlearned on memory.retrieval (created_at) where learned_at is null;

-- Every change the learner or the groomer makes, so any of it can be traced and undone.
create table if not exists memory.confidence_log (
  id bigserial primary key, at timestamptz not null default now(),
  target text not null,            -- entry:<id> or link:<src>|<type>|<dst>
  before real, after real, reason text not null, retrieval_id uuid, event_id bigint);
create index if not exists confidence_log_target on memory.confidence_log (target, at);

-- Where the daily groomer left off: the last hook event it read.
insert into memory.setting (name, value) values ('groom_checkpoint', '0') on conflict do nothing;

-- entry_current expands e.* when it's created, so it's rebuilt to carry confidence and miss_streak.
create or replace view memory.entry_current as select e.* from memory.entry e
  where not exists (select 1 from memory.link l where l.dst = e.id and l.type = 'supersedes');
