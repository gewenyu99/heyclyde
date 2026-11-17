-- Slice 3 and 4a of the learning loop (memory/LEARNING-PLAN.md): temperature and age as ranking features (R32, #36), and shadow
-- variants that rank every real recall in the background (R34, #38). Expand only, so the function before this migration keeps
-- working: every new column is nullable or has a default, and the new set is only a shadow. Every statement reruns safely.
--
-- Nothing here reads calendar time. "Now" is the recall clock, memory.retrieval_seq, which only a real recall moves.

-- ---------------------------------------------------------------- the clock, read
-- The clock's reading: the seq the last real recall took, 0 before the first. Reading never moves it.
create or replace function memory.recall_clock() returns bigint language sql volatile as $$
  select case when is_called then last_value else 0 end from memory.retrieval_seq
$$;

-- ---------------------------------------------------------------- what an entry's age and temperature count from
-- written_seq is the clock when the entry was written. An edit keeps it, and a note that replaces another is a new entry with
-- its own. Entries from before this migration get the seq of the last real recall made before they were written.
alter table memory.entry add column if not exists written_seq bigint;
update memory.entry e set written_seq = coalesce((select max(r.seq) from memory.retrieval r
    where r.seq is not null and r.created_at < e.created_at), 0)
  where e.written_seq is null;
alter table memory.entry alter column written_seq set default memory.recall_clock();
alter table memory.entry alter column written_seq set not null;

-- Each event temperature counts carries the clock at its insert: feedback (an agent's used or helpful, Wen's confirmation) and
-- get_entry opens. Rows from before this migration get the seq of the last real recall made before them.
alter table memory.feedback add column if not exists seq bigint;
update memory.feedback f set seq = coalesce((select max(r.seq) from memory.retrieval r
    where r.seq is not null and r.created_at <= f.created_at), 0)
  where f.seq is null;
alter table memory.feedback alter column seq set default memory.recall_clock();

alter table memory.event add column if not exists seq bigint;
update memory.event e set seq = coalesce((select max(r.seq) from memory.retrieval r
    where r.seq is not null and r.created_at <= e.received_at), 0)
  where e.seq is null and e.event = 'get_entry';
alter table memory.event alter column seq set default memory.recall_clock();

create index if not exists feedback_heat on memory.feedback (entry_id, seq) where verdict in ('helpful', 'used');
create index if not exists event_opened on memory.event ((payload->>'entry_id'), seq) where event = 'get_entry';

-- ---------------------------------------------------------------- temperature
-- ACT-R's base-level activation on the recall clock: B = ln Σ w_e·(as_of − seq_e + 1)^−decay over the counted events with
-- as_of − window < seq_e <= as_of, floored at lo, and lo when nothing counts. temperature is B − lo, a bonus of 0 or more, so
-- a cold entry is never buried. Counted: an agent's used or helpful (w_agent), Wen's confirmation from the console (w_wen)
-- and a get_entry open (w_open). An entry's own write and its deliveries don't count. Feedback counts once per (retrieval,
-- entry, source), an open once per (session, entry, seq), so repeating either heats nothing more.
create or replace function memory.temperature(ids text[], as_of bigint, decay double precision, lo double precision, win integer,
    w_agent double precision, w_wen double precision, w_open double precision)
  returns table (id text, base double precision, temperature double precision) language sql stable as $$
  with heard as (
    select distinct on (f.retrieval_id, f.entry_id, f.source) f.entry_id as eid, f.seq,
      case when f.source = 'wen' then w_wen else w_agent end as w
    from memory.feedback f
    where f.entry_id = any(ids) and f.verdict in ('helpful', 'used') and f.source in ('agent', 'wen')
      and f.seq <= as_of and f.seq > as_of - win
    order by f.retrieval_id, f.entry_id, f.source, f.seq
  ), opened as (
    select distinct on (e.session_id, e.payload->>'entry_id', e.seq) e.payload->>'entry_id' as eid, e.seq, w_open as w
    from memory.event e
    where e.event = 'get_entry' and e.payload->>'entry_id' = any(ids) and e.seq <= as_of and e.seq > as_of - win
  ), total as (
    select x.eid, sum(x.w * power((as_of - x.seq + 1)::double precision, -decay)) as s
    from (select * from heard union all select * from opened) x group by x.eid
  )
  select i.eid, greatest(coalesce(ln(nullif(t.s, 0)), lo), lo), greatest(coalesce(ln(nullif(t.s, 0)), lo), lo) - lo
  from unnest(ids) as i(eid) left join total t on t.eid = i.eid
$$;

-- Age and temperature for one recall's candidates as of a clock reading, in one statement. age is recalls since the entry
-- was written.
create or replace function memory.ranking_features(ids text[], as_of bigint, decay double precision, lo double precision,
    win integer, w_agent double precision, w_wen double precision, w_open double precision)
  returns table (id text, age bigint, temperature double precision) language sql stable as $$
  select e.id, greatest(as_of - e.written_seq, 0), t.temperature
  from memory.entry e join memory.temperature(ids, as_of, decay, lo, win, w_agent, w_wen, w_open) t on t.id = e.id
$$;

-- ---------------------------------------------------------------- shadows (R34)
-- One row per shadow set per real recall: what it ranked (its top 12, ids and scores only) and what it would have delivered,
-- or why it didn't rank. A shadow never ticks the clock and never changes what was served.
create table if not exists memory.shadow_retrieval (
  id bigserial primary key,
  retrieval_id uuid not null references memory.retrieval(id) on delete cascade,
  param_set text not null references memory.param_set(id),
  status text not null check (status in ('ranked', 'skipped:error', 'skipped:budget')),
  ranking jsonb not null default '[]',
  delivered jsonb not null default '[]',
  judge_calls integer not null default 0,
  latency_ms integer,
  created_at timestamptz not null default now(),
  unique (retrieval_id, param_set));
create index if not exists shadow_retrieval_set on memory.shadow_retrieval (param_set, created_at);

-- The judge's answers, so a shadow pays only for pairs nobody has judged: by the request's hash, the entry, the hash of the
-- text the judge read, and the judge's version. The served recall's own answers go in first.
create table if not exists memory.judge_cache (
  query_sha text not null, entry_id text not null, content_sha text not null, judge_version text not null,
  p double precision not null, created_at timestamptz not null default now(),
  primary key (query_sha, entry_id, content_sha, judge_version));

-- At most 2 shadows at once, so a recall's background work stays bounded. The API says so first, with a 422.
create or replace function memory.shadow_limit() returns trigger language plpgsql as $$
begin
  if (select count(*) from memory.allocation where role = 'shadow') > 2 then
    raise exception 'memory.allocation holds at most 2 shadow sets' using errcode = 'check_violation';
  end if;
  return null;
end $$;
drop trigger if exists shadow_limit on memory.allocation;
create constraint trigger shadow_limit after insert or update on memory.allocation deferrable initially deferred
  for each row execute function memory.shadow_limit();

-- Shadow rows and judge answers older than 180 days go, daily at 04:37 UTC.
create or replace function memory.variant_retention() returns jsonb language plpgsql as $$
declare shadows integer; judged integer;
begin
  delete from memory.shadow_retrieval where created_at < now() - interval '180 days';
  get diagnostics shadows = row_count;
  delete from memory.judge_cache where created_at < now() - interval '180 days';
  get diagnostics judged = row_count;
  return jsonb_build_object('shadow_retrieval', shadows, 'judge_cache', judged);
end $$;
select cron.unschedule('memory-variant-retention') where exists (select 1 from cron.job where jobname = 'memory-variant-retention');
select cron.schedule('memory-variant-retention', '37 4 * * *', $$select memory.variant_retention()$$);

-- ---------------------------------------------------------------- logodds.v1
-- spreading.v6 scored in log-odds space: wRelevance·r + wTemperature·h + wAge·ln(1 + age) + wConfidence·logit(c), with r the
-- arm's score over the recall's top score. It starts in shadow with no share of traffic. It exists only where a v6 does.
insert into memory.param_set (id, arm, params, parent, note, created_by)
select 'logodds.v1', p.arm,
  p.params || jsonb_build_object('scoreForm', 'logodds', 'wRelevance', 4, 'wConfidence', 0.25, 'wTemperature', 0.15, 'wAge', 0,
    'tempDecay', 0.5, 'tempFloor', -3, 'tempWindow', 1000, 'tempAgentUsed', 3, 'tempWenConfirm', 3, 'tempOpened', 1),
  p.id, 'spreading.v6 in log-odds space with temperature (R32): 4·r + 0.15·h + 0.25·logit(c), age at 0.', 'migration'
from memory.param_set p where p.id = 'spreading.v6'
on conflict (id) do nothing;
insert into memory.allocation (param_set, role, weight)
select 'logodds.v1', 'shadow', 0 where exists (select 1 from memory.param_set where id = 'logodds.v1')
on conflict (param_set) do nothing;
