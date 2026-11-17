-- Slice 4b and 5 of the learning loop (memory/LEARNING-PLAN.md): guardrails that roll a losing live set back (R34, #38), and the
-- research token the weekly researcher holds (R35, #39). Expand only: every new column is nullable or has a default, so the
-- function before this migration keeps working. Every statement reruns safely.

-- ---------------------------------------------------------------- what each recall cost and whose it was
-- openai_tokens is what the recall itself spent at OpenAI (its embedding and its judge, not its shadows'), for the cost guardrail.
-- unit_hash is the SHA-256 of the unit the allocation hashed (the run scope, or device, client and UTC day), so the sample-ratio
-- check counts units, not recalls. Both are null on rows from before this migration.
alter table memory.retrieval add column if not exists openai_tokens integer;
alter table memory.retrieval add column if not exists unit_hash text;
create index if not exists retrieval_set_created on memory.retrieval (param_set, created_at) where parent_id is null;

-- ---------------------------------------------------------------- who acted
-- admin for the admin token, research for the research token, guardrail for memory.variant_guard(), sql for anything else.
alter table memory.admin_audit add column if not exists actor text not null default 'admin';

-- ---------------------------------------------------------------- the guardrails' bounds, as settings
-- A live set rolls back when, over the last guard_days, it is behind its arm's default by more than: guard_leak_points points of
-- leak rate, guard_empty_points points of empty packets, guard_cost_pct percent of OpenAI tokens per recall (each once both sides
-- have guard_min_recalls recalls), or guard_latency_pct percent of p95 latency (once both have guard_min_latency_recalls). A
-- sample-ratio mismatch alerts at p < guard_srm_alpha.
insert into memory.setting (name, value) values
  ('guard_days', '7'), ('guard_min_recalls', '50'), ('guard_min_latency_recalls', '200'), ('guard_leak_points', '2'),
  ('guard_empty_points', '5'), ('guard_latency_pct', '30'), ('guard_cost_pct', '50'), ('guard_srm_alpha', '0.001')
on conflict (name) do nothing;

create or replace function memory.guard_setting(setting_name text, fallback double precision) returns double precision
  language sql stable as $$
  select coalesce((select value::double precision from memory.setting where name = setting_name), fallback)
$$;

-- ---------------------------------------------------------------- the chi-square tail
-- P(X > x) for X ~ chi-square with df degrees of freedom: the regularized upper incomplete gamma Q(df/2, x/2), by its series below
-- a + 1 and its continued fraction above (Numerical Recipes 6.2). ln Γ(df/2) is exact, since df/2 is a whole or half number.
create or replace function memory.chi2_sf(x double precision, df integer) returns double precision language plpgsql immutable as $$
declare
  a double precision := df / 2.0; z double precision := x / 2.0; lg double precision := 0; t double precision;
  ap double precision; s double precision; del double precision; front double precision;
  b double precision; c double precision; d double precision; h double precision; an double precision;
begin
  if df < 1 then raise exception 'df must be 1 or more'; end if;
  if x <= 0 then return 1; end if;
  if df % 2 = 0 then t := 1; else t := 0.5; lg := ln(sqrt(pi())); end if;
  while t < a loop lg := lg + ln(t); t := t + 1; end loop;
  front := -z + a * ln(z) - lg;
  if front < -700 then return 0; end if;
  if z < a + 1 then
    ap := a; s := 1 / a; del := s;
    for i in 1..1000 loop
      ap := ap + 1; del := del * z / ap; s := s + del;
      exit when abs(del) < abs(s) * 1e-15;
    end loop;
    return greatest(0, 1 - s * exp(front));
  end if;
  b := z + 1 - a; c := 1e300; d := 1 / b; h := d;
  for i in 1..1000 loop
    an := -i * (i - a); b := b + 2;
    d := an * d + b; if abs(d) < 1e-300 then d := 1e-300; end if;
    c := b + an / c; if abs(c) < 1e-300 then c := 1e-300; end if;
    d := 1 / d; del := d * c; h := h * del;
    exit when abs(del - 1) < 1e-15;
  end loop;
  return exp(front) * h;
end $$;

-- ---------------------------------------------------------------- the rollup
-- Every live and default set's real recalls (not recall_more pages) over the last window_days: how many, the share with a used or
-- helpful verdict, with a wrong verdict, and leaked (a wrong verdict or Wen's pushback), the share that delivered nothing, the p95
-- latency, and the mean OpenAI tokens of the recalls that logged them.
create or replace function memory.variant_stats(window_days integer)
  returns table (param_set text, arm text, role text, weight integer, recalls bigint, used_rate double precision,
    wrong_rate double precision, leaks bigint, leak_rate double precision, empty_rate double precision,
    p95_latency_ms double precision, costed bigint, cost_per_recall double precision)
  language sql stable as $$
  with recent as (
    select r.id, r.param_set, r.delivered, r.reaction, r.latency_ms, r.openai_tokens from memory.retrieval r
    where r.parent_id is null and r.created_at >= now() - make_interval(days => window_days)),
  verdicts as (
    select f.retrieval_id, bool_or(f.verdict in ('used', 'helpful')) as used, bool_or(f.verdict = 'wrong') as wrong
    from memory.feedback f where f.retrieval_id in (select id from recent) group by f.retrieval_id),
  per as (
    select r.*, coalesce(v.used, false) as used, coalesce(v.wrong, false) as wrong,
      coalesce(v.wrong, false) or coalesce((r.reaction->>'pushback')::boolean, false) as leak,
      jsonb_array_length(r.delivered) = 0 as empty
    from recent r left join verdicts v on v.retrieval_id = r.id)
  select a.param_set, p.arm, a.role, a.weight, count(x.id),
    avg(x.used::int)::double precision, avg(x.wrong::int)::double precision, count(x.id) filter (where x.leak),
    avg(x.leak::int)::double precision, avg(x.empty::int)::double precision,
    percentile_cont(0.95) within group (order by x.latency_ms), count(x.openai_tokens), avg(x.openai_tokens)::double precision
  from memory.allocation a join memory.param_set p on p.id = a.param_set
    left join per x on x.param_set = a.param_set
  where a.role in ('live', 'default')
  group by a.param_set, p.arm, a.role, a.weight
  order by a.param_set
$$;

-- ---------------------------------------------------------------- a message to every agent
-- What service.ts postMessage does for 'all', from memory: one message and a delivery for each agent seen lately. Nothing is
-- posted when no agent has been seen.
create or replace function memory.post_to_all(note text) returns bigint language sql as $$
  with r as (select a as name from memory.agent_names() a),
  m as (insert into memory.message (sender, recipient, body) select 'memory', 'all', note where exists (select 1 from r) returning id),
  d as (insert into memory.message_delivery (message_id, recipient) select m.id, r.name from m, r returning 1)
  select id from m
$$;

-- ---------------------------------------------------------------- the guard
-- Each live set with a weight against the default on its arm (the one with the most recalls, if several). A set past a bound gets
-- weight 0, an allocation.rollback audit row (actor guardrail) whose after.reason names the bound, and a message to all. Then the
-- serving sets' units since the last allocation change (within the window) are tested against their shares, and a mismatch at
-- p < guard_srm_alpha is an allocation.srm audit row and a message to all. With act false it only reports. Pure SQL, so pg_cron
-- runs it with no function call.
create or replace function memory.variant_guard(act boolean default true) returns jsonb language plpgsql as $$
declare
  win integer := memory.guard_setting('guard_days', 7)::integer;
  min_n double precision := memory.guard_setting('guard_min_recalls', 50);
  min_latency_n double precision := memory.guard_setting('guard_min_latency_recalls', 200);
  leak_points double precision := memory.guard_setting('guard_leak_points', 2);
  empty_points double precision := memory.guard_setting('guard_empty_points', 5);
  latency_pct double precision := memory.guard_setting('guard_latency_pct', 30);
  cost_pct double precision := memory.guard_setting('guard_cost_pct', 50);
  alpha double precision := memory.guard_setting('guard_srm_alpha', 0.001);
  s record; reasons text[]; rolled text[] := '{}'; checked jsonb := '[]';
  since timestamptz; k integer; total bigint; chi2 double precision; p double precision; units jsonb; srm jsonb; valid boolean;
begin
  for s in
    with st as (select * from memory.variant_stats(win))
    select l.*, b.param_set as base, b.recalls as base_recalls, b.leak_rate as base_leak, b.empty_rate as base_empty,
      b.p95_latency_ms as base_p95, b.costed as base_costed, b.cost_per_recall as base_cost
    from st l left join lateral (select * from st b where b.role = 'default' and b.weight > 0 and b.arm = l.arm
                                 order by b.recalls desc, b.param_set limit 1) b on true
    where l.role = 'live' and l.weight > 0
    order by l.param_set
  loop
    reasons := '{}';
    if s.base is not null and s.recalls >= min_n and s.base_recalls >= min_n then
      if s.leak_rate - s.base_leak > leak_points / 100 then
        reasons := reasons || format('leak: %s%% of its recalls were marked wrong or pushed back on, against %s%% for %s (bound +%s points)',
          round((100 * s.leak_rate)::numeric, 1), round((100 * s.base_leak)::numeric, 1), s.base, leak_points);
      end if;
      if s.empty_rate - s.base_empty > empty_points / 100 then
        reasons := reasons || format('empty: %s%% of its packets were empty, against %s%% for %s (bound +%s points)',
          round((100 * s.empty_rate)::numeric, 1), round((100 * s.base_empty)::numeric, 1), s.base, empty_points);
      end if;
      if s.costed >= min_n and s.base_costed >= min_n and s.cost_per_recall > s.base_cost * (1 + cost_pct / 100) then
        reasons := reasons || format('cost: %s OpenAI tokens a recall, against %s for %s (bound +%s%%)',
          round(s.cost_per_recall::numeric), round(s.base_cost::numeric), s.base, cost_pct);
      end if;
    end if;
    if s.base is not null and s.recalls >= min_latency_n and s.base_recalls >= min_latency_n
       and s.p95_latency_ms > s.base_p95 * (1 + latency_pct / 100) then
      reasons := reasons || format('latency: p95 %s ms, against %s ms for %s (bound +%s%%)',
        round(s.p95_latency_ms::numeric), round(s.base_p95::numeric), s.base, latency_pct);
    end if;
    checked := checked || jsonb_build_object('param_set', s.param_set, 'against', s.base, 'recalls', s.recalls,
      'against_recalls', s.base_recalls, 'reasons', to_jsonb(reasons));
    if act and cardinality(reasons) > 0 then
      update memory.allocation set weight = 0, updated_at = now() where param_set = s.param_set and role = 'live' and weight > 0;
      if found then
        rolled := rolled || s.param_set;
        insert into memory.admin_audit (action, target, before, after, actor) values ('allocation.rollback', 'param_set:' || s.param_set,
          jsonb_build_object('role', 'live', 'weight', s.weight),
          jsonb_build_object('role', 'live', 'weight', 0, 'reason', array_to_string(reasons, '; '), 'days', win,
            'recalls', s.recalls, 'against', s.base, 'against_recalls', s.base_recalls), 'guardrail');
        perform memory.post_to_all(format('memory''s guardrail rolled back %s: its weight is 0, so it serves no one now. Over the last %s days, %s. '
          'It stays registered, and Wen can put it back live with PUT /api/v1/allocation.', s.param_set, win, array_to_string(reasons, '; ')));
      end if;
    end if;
  end loop;

  -- The sample-ratio check, over units since any allocation row last changed.
  since := greatest(now() - make_interval(days => win),
    coalesce((select max(updated_at) from memory.allocation), '-infinity'));
  with w as (select a.param_set, a.weight::double precision / sum(a.weight) over () as share
             from memory.allocation a where a.role in ('live', 'default') and a.weight > 0),
  o as (select r.param_set, count(distinct coalesce(r.unit_hash, r.id::text)) as n from memory.retrieval r
        where r.parent_id is null and r.created_at >= since group by r.param_set),
  j as (select w.param_set, w.share, coalesce(o.n, 0) as n, sum(coalesce(o.n, 0)) over () as all_n from w left join o using (param_set))
  select count(*), max(all_n), sum(case when all_n > 0 then (n - share * all_n) ^ 2 / (share * all_n) end),
    coalesce(jsonb_object_agg(param_set, n), '{}'), bool_and(share * all_n >= 5)
  into k, total, chi2, units, valid from j;
  if k >= 2 and total > 0 and valid then
    p := memory.chi2_sf(chi2, k - 1);
    srm := jsonb_build_object('since', since, 'units', units, 'chi2', chi2, 'df', k - 1, 'p', p, 'mismatch', p < alpha);
    if act and p < alpha then
      insert into memory.admin_audit (action, target, before, after, actor)
        values ('allocation.srm', 'allocation', null, srm, 'guardrail');
      perform memory.post_to_all(format('memory''s guardrail found a sample-ratio mismatch: the serving sets'' units since %s are %s '
        'against their assigned shares (chi-square %s, p %s). Assignment or logging is off, so no comparison of these sets holds '
        'until it is fixed.', to_char(since at time zone 'utc', 'YYYY-MM-DD HH24:MI "UTC"'), units, round(chi2::numeric, 2), p));
    end if;
  else
    srm := jsonb_build_object('since', since, 'units', units, 'chi2', null, 'df', greatest(k - 1, 0), 'p', null, 'mismatch', false);
  end if;

  return jsonb_build_object('days', win, 'acted', act, 'checked', checked, 'rolled_back', to_jsonb(rolled), 'srm', srm,
    'sets', coalesce((select jsonb_agg(to_jsonb(v)) from memory.variant_stats(win) v), '[]'));
end $$;

-- Daily at 05:23 UTC, after the retention job.
select cron.unschedule('memory-variant-guard') where exists (select 1 from cron.job where jobname = 'memory-variant-guard');
select cron.schedule('memory-variant-guard', '23 5 * * *', $$select memory.variant_guard()$$);
