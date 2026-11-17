-- Slice 1a of the learning loop (memory/LEARNING-PLAN.md): every ranking knob is a row, a stable unit picks the row a
-- recall runs on, real recalls tick a clock, each recall logs its candidates' features, and OpenAI spend is metered by
-- kind. Expand only: the function before this migration keeps working on the tables it knows. Idempotent.

-- ---------------------------------------------------------------- parameter sets (R32)
-- One row is one ranking, for good: the trigger below refuses a change to params or arm, so "hybrid.v1" always means
-- the same ranking. A new idea is a new id, with `parent` saying where it came from.
create table if not exists memory.param_set (
  id text primary key, arm text not null, params jsonb not null, parent text, note text, created_by text,
  created_at timestamptz not null default now());

create or replace function memory.param_set_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'memory.param_set rows are immutable: a set is never deleted';
  end if;
  if new.params is distinct from old.params or new.arm is distinct from old.arm then
    raise exception 'memory.param_set rows are immutable: params and arm never change, make a new set';
  end if;
  return new;
end $$;
drop trigger if exists param_set_immutable on memory.param_set;
create trigger param_set_immutable before update or delete on memory.param_set
  for each row execute function memory.param_set_immutable();

-- Today's constants, from service.ts, search.ts and config.ts before they read this table. Every set carries every knob,
-- so a child only names what it changes. The wT/wA/wK weights are the features slice 3 adds, at 0 until then.
-- spreading's link type weights are what link_type_weight holds right now, frozen into the set.
do $$
declare
  base jsonb := jsonb_build_object(
    'candidates', 50, 'packetItems', 8, 'packetTokens', 1500, 'filterK', 12, 'filterThreshold', 0.5,
    'tiltBase', 0.9, 'tiltUnknownConfidence', 0.7, 'tiltWindow', 48, 'rowWindow', 24, 'dormant', 0.15,
    'rrfK', 10, 'vecWeight', 1.5, 'indexDraftFactor', 0.5, 'scopeBoost', 3,
    'restart', 0.5, 'iterations', 20, 'supersededFactor', 0.3,
    'wTemperature', 0, 'wAge', 0, 'wKind', 0);
  weights jsonb := coalesce((select jsonb_object_agg(src_pattern || '|' || link_type || '|' || dst_pattern, weight)
                             from memory.link_type_weight), '{}'::jsonb);
begin
  insert into memory.param_set (id, arm, params, note, created_by) values
    ('index.v1', 'index', base || jsonb_build_object('linkTypeWeights', '{}'::jsonb), 'Today''s index arm, as of the learning loop''s first slice.', 'migration'),
    ('hybrid.v1', 'hybrid', base || jsonb_build_object('linkTypeWeights', '{}'::jsonb), 'Today''s hybrid arm.', 'migration'),
    ('spreading.v1', 'spreading', base || jsonb_build_object('linkTypeWeights', weights), 'Today''s spreading arm, with the link type weights it had.', 'migration')
  on conflict (id) do nothing;
end $$;

-- ---------------------------------------------------------------- allocation (R34)
-- Which sets serve, and to what share. off and shadow rows serve no one. live and default rows share the traffic by weight,
-- so rolling back is a weight of 0 or a role of off: one row, no deploy. With no rows at all, MEMORY_ARMS draws, each arm on
-- its v1, as it did before this table.
create table if not exists memory.allocation (
  param_set text primary key references memory.param_set(id),
  role text not null check (role in ('off', 'shadow', 'live', 'default')),
  weight integer not null default 0 check (weight >= 0),
  updated_at timestamptz not null default now());

-- The salt in hash(salt || unit). Changing it reshuffles every unit, so it's a setting and not a knob.
insert into memory.setting (name, value) values ('allocation_salt', md5(random()::text || clock_timestamp()::text))
  on conflict do nothing;

-- The set and the chance it was served with, on the session that drew it and on every recall.
alter table memory.mcp_session add column if not exists param_set text;
alter table memory.mcp_session add column if not exists propensity double precision;
alter table memory.retrieval add column if not exists param_set text;
alter table memory.retrieval add column if not exists propensity double precision;
update memory.mcp_session set param_set = arm || '.v1' where param_set is null;
update memory.retrieval set param_set = arm || '.v1' where param_set is null;

-- ---------------------------------------------------------------- the recall clock
-- seq ticks once per real recall, in order, and only then: the eval and preview routes write no retrieval, a degraded
-- recall takes null, and a shadow ranking lives in its own table. "Time" for age and temperature is recalls since.
create sequence if not exists memory.retrieval_seq;
alter table memory.retrieval add column if not exists seq bigint;
create index if not exists retrieval_seq on memory.retrieval (seq) where seq is not null;
do $$
begin
  if (select last_value from memory.retrieval_seq) = 1 and not (select is_called from memory.retrieval_seq) then
    update memory.retrieval r set seq = n.seq
      from (select id, row_number() over (order by created_at, id) as seq from memory.retrieval where degraded is null) n
      where r.id = n.id and r.seq is null;
    perform setval('memory.retrieval_seq', greatest((select coalesce(max(seq), 0) from memory.retrieval), 1),
                   (select coalesce(max(seq), 0) > 0 from memory.retrieval));
  end if;
end $$;

-- ---------------------------------------------------------------- OpenAI spend by kind
-- embed, judge_write, judge_recall, shadow and research. judge_write draws on a reserve (setting judge_write_reserve_tokens,
-- 5 million by default) that nothing else spends. The rest share embed_budget_tokens. embed_usage stays for the function
-- before this migration, which still writes it.
create table if not exists memory.openai_usage (
  month date not null, kind text not null check (kind in ('embed', 'judge_write', 'judge_recall', 'shadow', 'research')),
  tokens bigint not null default 0, primary key (month, kind));
insert into memory.openai_usage (month, kind, tokens)
  select month, 'embed', tokens from memory.embed_usage where month = date_trunc('month', now())::date
  on conflict do nothing;
