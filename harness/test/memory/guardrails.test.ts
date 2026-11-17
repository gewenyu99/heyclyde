/**
 * Tier 3: R34 (#38) guardrails and promotion, and R35 (#39) the research token, against the real memory function.
 *
 * memory.variant_guard() runs daily in pg_cron (memory-variant-guard) and on POST /api/v1/variants/guard. Over the last 7 days it
 * rolls up every live and default set: recalls, used rate, wrong rate, leaks, empty packets, p95 latency and OpenAI tokens per
 * recall. A live set that falls behind its arm's default by more than a guardrail (memory.setting guard_*) gets weight 0, one
 * admin_audit row (allocation.rollback, actor guardrail) and a memory message to all. It also tests the serving sets' units
 * against their assigned shares and alerts on a sample-ratio mismatch at p < 0.001. Making a set other than an arm's v1 the
 * default takes by 'wen'. The research token (research_token_sha256) reads the research routes, makes at most 3 sets a UTC
 * week with a written hypothesis, and moves only its own sets, only to off or shadow. Nobody reads the test split without
 * freeze=1, and the research token never does.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { request } from '../../src/request.ts'
import { SKIP, sql, startRealMemory, type RealMemory } from './server.ts'

const MIGRATIONS = join(import.meta.dirname, '../../../memory/supabase/migrations')
let memory: RealMemory

before(async () => {
  if (SKIP) return
  memory = await startRealMemory({ MEMORY_ARMS: 'hybrid' })
  for (const id of ['hybrid.g1', 'hybrid.g2']) {
    const r = await admin('POST', '/param-sets', { id, parent: 'hybrid.v1', params: { tiltBase: 0.85 }, note: 'tier 3 guardrails' })
    assert.equal(r.status, 201, r.text)
  }
  // An agent seen lately, so a message to all has someone to reach.
  sql(`insert into memory.event (event, payload, agent) values ('SessionStart', '{}', 'claude')`)
})

after(async () => {
  await memory?.close()
})

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const call = (token: string, method: string, path: string, body?: unknown) =>
  request(method, `${memory.url}${path}`, { headers: bearer(token), body, timeoutMs: 30_000 })
const admin = (method: string, path: string, body?: unknown) => call(memory.adminToken, method, `/api/v1${path}`, body)
const research = (method: string, path: string, body?: unknown) => call(memory.researchToken, method, `/api/v1${path}`, body)
const json = (r: { status: number; text: string }, status = 200) => {
  assert.equal(r.status, status, r.text)
  return JSON.parse(r.text)
}
const count = (table: string, where = 'true') => sql(`select count(*)::int as n from memory.${table} where ${where}`)[0].n as number
const digest = (table: string, order: string) => sql(`select md5(coalesce(string_agg(t::text, '|' order by ${order}), '')) as h from memory.${table} t`)[0].h
const weightOf = (id: string) => sql(`select weight from memory.allocation where param_set = '${id}'`)[0]?.weight
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** hybrid.v1 the default at `control`, `live` the live set at `share`, every other set off. Straight to the table, so it
 * writes no audit row of its own. Dated a day back, so the sample-ratio window, which starts at the last allocation change,
 * holds every fixture recall. */
function allocate(live: string | null = 'hybrid.g1', control = 500, share = 500) {
  sql(`delete from memory.allocation`)
  sql(`insert into memory.allocation (param_set, role, weight, updated_at) select id,
      case when id = 'hybrid.v1' then 'default' when id = '${live}' then 'live' else 'off' end,
      case when id = 'hybrid.v1' then ${control} when id = '${live}' then ${share} else 0 end, now() - interval '1 day'
    from memory.param_set`)
}

/** Clears every retrieval, so the rollups see only the fixture. */
function clearRecalls() {
  sql(`delete from memory.feedback`)
  sql(`delete from memory.retrieval`)
}

type Fixture = { n: number; wrong?: number; pushback?: number; used?: number; empty?: number; latency?: number; cost?: number | null; ageDays?: number }

/** n recalls served by `set`, each its own unit. The first `wrong` get a wrong verdict, the next `pushback` Wen's pushback, the
 * first `used` a used verdict, and the first `empty` deliver nothing. Every one takes `latency` ms and `cost` tokens. */
function fixture(set: string, f: Fixture) {
  const { n, wrong = 0, pushback = 0, used = 0, empty = 0, latency = 1000, cost = 100, ageDays = 0 } = f
  const tag = `${set}-${Math.random().toString(36).slice(2)}`
  sql(`insert into memory.retrieval (id, arm, query, delivered, latency_ms, param_set, propensity, openai_tokens, unit_hash, reaction, created_at)
    select gen_random_uuid(), 'hybrid', 'guard fixture ' || g, (case when g <= ${empty} then '[]' else '["tea-oolong-temp"]' end)::jsonb,
      ${latency}, '${set}', 0.5, ${cost === null ? 'null' : cost}, md5('${tag}' || g),
      case when g > ${wrong} and g <= ${wrong + pushback} then '{"pushback": true, "cause": "tea-oolong-temp"}'::jsonb end,
      now() - make_interval(days => ${ageDays}) - make_interval(secs => g)
    from generate_series(1, ${n}) g`)
  const ids = (k: number) => `(select id from memory.retrieval where unit_hash in (select md5('${tag}' || g) from generate_series(1, ${k}) g))`
  if (wrong) sql(`insert into memory.feedback (retrieval_id, source, verdict, entry_id) select id, 'agent', 'wrong', 'tea-oolong-temp' from memory.retrieval where id in ${ids(wrong)}`)
  if (used) sql(`insert into memory.feedback (retrieval_id, source, verdict, entry_id) select id, 'agent', 'used', 'tea-oolong-temp' from memory.retrieval where id in ${ids(used)}`)
}

const guard = () => sql(`select memory.variant_guard() as g`)[0].g
const rollbacks = (id: string) => sql(`select actor, before, after from memory.admin_audit where action = 'allocation.rollback' and target = 'param_set:${id}' order by id`)

// R34 (#38): "variants: guardrails and retention are scheduled daily in pg_cron".
test('R34: memory-variant-guard is scheduled daily in pg_cron, once, and runs memory.variant_guard()', () => {
  const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).map((f) => readFileSync(join(MIGRATIONS, f), 'utf8')).join('\n')
  const calls = [...all.matchAll(/cron\.schedule\(\s*'memory-variant-guard'\s*,\s*'([^']+)'\s*,\s*\$\$([\s\S]*?)\$\$\s*\)/g)]
  assert.equal(calls.length, 1, 'exactly one schedule names memory-variant-guard')
  assert.match(calls[0][1], /^[0-9]{1,2} [0-9]{1,2} \* \* \*$/, 'once a day')
  assert.match(calls[0][2], /memory\.variant_guard\(\)/)
  assert.match(readFileSync(join(import.meta.dirname, 'database.ts'), 'utf8'), /'memory-variant-guard'/, 'the tests unschedule it')
})

// R34 (#38): the sample-ratio check's p-value is the chi-square upper tail.
test('R34: memory.chi2_sf gives the chi-square upper tail within 0.1%', { skip: SKIP }, () => {
  const cases: [number, number, number][] = [[40, 1, 2.5396e-10], [0.4, 1, 0.527089], [10.828, 1, 0.001], [13.816, 2, 0.001], [16.266, 3, 0.001], [3, 4, 0.557825]]
  for (const [x, df, p] of cases) {
    const got = Number(sql(`select memory.chi2_sf(${x}, ${df}) as p`)[0].p)
    assert.ok(Math.abs(got - p) <= p * 1e-3, `chi2_sf(${x}, ${df}) = ${got}, want ${p}`)
  }
  assert.equal(Number(sql(`select memory.chi2_sf(0, 1) as p`)[0].p), 1)
  assert.equal(Number(sql(`select memory.chi2_sf(1e6, 1) as p`)[0].p), 0, 'a huge statistic underflows to 0, not an error')
})

// R34 (#38): the daily rollup per live set.
test('R34: the guard rolls up each live set over 7 days: recalls, used, wrong, leaks, empty, p95 latency, cost', { skip: SKIP }, async () => {
  clearRecalls()
  allocate()
  // 100 recalls: 10 deliver nothing, 20 used, 5 wrong and 3 more pushed back on, latency 1 to 100 ms, cost 1 to 100 tokens.
  sql(`insert into memory.retrieval (id, arm, query, delivered, latency_ms, param_set, propensity, openai_tokens, unit_hash, created_at)
    select gen_random_uuid(), 'hybrid', 'guard rollup ' || g, (case when g <= 10 then '[]' else '["tea-oolong-temp"]' end)::jsonb, g,
      'hybrid.g1', 0.1, g, md5('rollup' || g), now() - make_interval(mins => g)
    from generate_series(1, 100) g`)
  const pick = (from: number, to: number) => `(select id from memory.retrieval where unit_hash in (select md5('rollup' || g) from generate_series(${from}, ${to}) g))`
  sql(`insert into memory.feedback (retrieval_id, source, verdict, entry_id) select id, 'agent', 'used', 'tea-oolong-temp' from memory.retrieval where id in ${pick(11, 30)}`)
  sql(`insert into memory.feedback (retrieval_id, source, verdict, entry_id) select id, 'agent', 'wrong', 'tea-oolong-temp' from memory.retrieval where id in ${pick(31, 35)}`)
  sql(`update memory.retrieval set reaction = '{"pushback": true, "cause": "tea-oolong-temp"}' where id in ${pick(36, 38)}`)
  // 30 more, 8 days old and all wrong, which the window leaves out.
  fixture('hybrid.g1', { n: 30, wrong: 30, ageDays: 8 })
  const audits = count('admin_audit'), allocation = digest('allocation', 'param_set')
  const report = json(await admin('GET', '/variants/guard'))
  assert.equal(report.days, 7)
  const g1 = report.sets.find((s: any) => s.param_set === 'hybrid.g1')
  assert.deepEqual({ role: g1.role, weight: g1.weight, recalls: g1.recalls, leaks: g1.leaks },
    { role: 'live', weight: 500, recalls: 100, leaks: 8 })
  const near = (got: number, want: number, what: string) => assert.ok(Math.abs(got - want) < 1e-9, `${what}: ${got}, want ${want}`)
  near(g1.used_rate, 0.2, 'used_rate')
  near(g1.wrong_rate, 0.05, 'wrong_rate')
  near(g1.leak_rate, 0.08, 'leak_rate')
  near(g1.empty_rate, 0.1, 'empty_rate')
  near(g1.p95_latency_ms, 95.05, 'p95_latency_ms')
  near(g1.cost_per_recall, 50.5, 'cost_per_recall')
  assert.ok(report.sets.some((s: any) => s.param_set === 'hybrid.v1' && s.role === 'default'))
  assert.equal(count('admin_audit'), audits, 'GET only reads')
  assert.equal(digest('allocation', 'param_set'), allocation, 'GET rolls nothing back')
})

// R34 (#38): "variants: a live variant whose outcome drops is rolled back", and "guardrails roll back once".
test('R34: a live set 2.1 points over the default\'s leak rate gets weight 0, one audit row and a message to all, once', { skip: SKIP }, async () => {
  clearRecalls()
  allocate()
  fixture('hybrid.v1', { n: 1000 })
  fixture('hybrid.g1', { n: 1000, wrong: 21 })
  const messages = count('message')
  const out = json(await admin('POST', '/variants/guard'))
  assert.deepEqual(out.rolled_back, ['hybrid.g1'])
  assert.equal(weightOf('hybrid.g1'), 0)
  assert.equal(weightOf('hybrid.v1'), 500, 'the default keeps its weight')
  const [row] = rollbacks('hybrid.g1')
  assert.equal(row.actor, 'guardrail')
  assert.deepEqual([row.before.role, row.before.weight, row.after.role, row.after.weight], ['live', 500, 'live', 0])
  assert.match(row.after.reason, /leak/)
  const [m] = sql(`select id, sender, recipient, body from memory.message order by id desc limit 1`)
  assert.equal(count('message'), messages + 1)
  assert.deepEqual([m.sender, m.recipient], ['memory', 'all'])
  assert.match(m.body, /hybrid\.g1/)
  assert.match(m.body, /leak/)
  assert.equal(count('message_delivery', `message_id = ${m.id} and recipient = 'claude'`), 1)
  // The next recalls are all the default's.
  for (let i = 0; i < 10; i++) {
    const r = await call(memory.token, 'POST', '/recall', { query: 'oolong water temperature', scope: `run:guard-after-${i}` })
    assert.equal(r.status, 200, r.text)
  }
  assert.deepEqual(sql(`select distinct param_set from memory.retrieval where mcp_session like 'http-run:guard-after-%'`), [{ param_set: 'hybrid.v1' }])
  // A second run finds nothing live past a bound.
  assert.deepEqual(guard().rolled_back, [])
  assert.equal(rollbacks('hybrid.g1').length, 1, 'rolled back once')
})

// R34 (#38): "variants: guardrail bounds on leaks, empty packets, latency and cost".
test('R34: guardrail bounds: leak +2 and empty +5 points, cost +50% from 50 recalls, p95 latency +30% from 200, all settings', { skip: SKIP }, () => {
  type Case = { what: string; live: Fixture; base?: Fixture; rolls: string | null; setting?: [string, string] }
  const cases: Case[] = [
    { what: 'leak +1.9 points', live: { n: 1000, wrong: 19 }, rolls: null },
    { what: 'leak +2.1 points, half of it pushback', live: { n: 1000, wrong: 10, pushback: 11 }, rolls: 'leak' },
    { what: 'empty +4.9 points', live: { n: 1000, empty: 49 }, rolls: null },
    { what: 'empty +5.1 points', live: { n: 1000, empty: 51 }, rolls: 'empty' },
    { what: 'cost +49%', live: { n: 1000, cost: 149 }, rolls: null },
    { what: 'cost +51%', live: { n: 1000, cost: 151 }, rolls: 'cost' },
    { what: 'p95 latency +29%', live: { n: 200, latency: 1290 }, base: { n: 200 }, rolls: null },
    { what: 'p95 latency +31%', live: { n: 200, latency: 1310 }, base: { n: 200 }, rolls: 'latency' },
    { what: 'p95 latency +31% on 199 live recalls', live: { n: 199, latency: 1310 }, base: { n: 200 }, rolls: null },
    { what: '49 live recalls, all wrong', live: { n: 49, wrong: 49 }, rolls: null },
    { what: '49 default recalls', live: { n: 1000, wrong: 500 }, base: { n: 49 }, rolls: null },
    { what: 'leak +2.1 points under guard_leak_points 10', live: { n: 1000, wrong: 21 }, rolls: null, setting: ['guard_leak_points', '10'] },
    { what: 'cost +20% under guard_cost_pct 10', live: { n: 1000, cost: 120 }, rolls: 'cost', setting: ['guard_cost_pct', '10'] },
  ]
  for (const c of cases) {
    clearRecalls()
    allocate()
    fixture('hybrid.v1', c.base ?? { n: 1000 })
    fixture('hybrid.g1', c.live)
    const old = c.setting ? sql(`select value from memory.setting where name = '${c.setting[0]}'`)[0]?.value : undefined
    if (c.setting) sql(`update memory.setting set value = '${c.setting[1]}' where name = '${c.setting[0]}'`)
    try {
      const before = rollbacks('hybrid.g1').length
      const out = guard()
      if (c.rolls) {
        assert.deepEqual(out.rolled_back, ['hybrid.g1'], c.what)
        assert.equal(weightOf('hybrid.g1'), 0, c.what)
        const last = rollbacks('hybrid.g1').at(-1)
        assert.equal(rollbacks('hybrid.g1').length, before + 1, c.what)
        assert.match(last.after.reason, new RegExp(c.rolls), c.what)
      } else {
        assert.deepEqual(out.rolled_back, [], c.what)
        assert.equal(weightOf('hybrid.g1'), 500, c.what)
      }
    } finally {
      if (c.setting) sql(`update memory.setting set value = '${old}' where name = '${c.setting[0]}'`)
    }
  }
})

// R34 (#38): "variants: a sample-ratio mismatch is flagged".
test('R34: units split 600/400 against a 50/50 allocation alert as a sample-ratio mismatch; 510/490 does not', { skip: SKIP }, () => {
  for (const [a, b, mismatch, chi2] of [[600, 400, true, 40], [510, 490, false, 0.4]] as const) {
    clearRecalls()
    allocate('hybrid.g1', 500, 500)
    fixture('hybrid.v1', { n: a })
    fixture('hybrid.g1', { n: b })
    const messages = count('message')
    const { srm, rolled_back } = guard()
    assert.deepEqual(rolled_back, [])
    assert.equal(srm.mismatch, mismatch, JSON.stringify(srm))
    assert.ok(Math.abs(srm.chi2 - chi2) < 1e-9, JSON.stringify(srm))
    assert.equal(srm.df, 1)
    assert.deepEqual(srm.units, { 'hybrid.v1': a, 'hybrid.g1': b })
    if (mismatch) {
      assert.ok(srm.p < 0.001, JSON.stringify(srm))
      assert.equal(count('message'), messages + 1, 'an alert to all')
      assert.match(sql(`select body from memory.message order by id desc limit 1`)[0].body, /sample.ratio/i)
    } else {
      assert.ok(srm.p > 0.5, JSON.stringify(srm))
      assert.equal(count('message'), messages)
    }
  }
})

// R34 (#38): the guard route is the admin's to run. The research token may read it.
test('R34: POST /variants/guard runs the guard for the admin only; research reads GET; a device token gets 401', { skip: SKIP }, async () => {
  clearRecalls()
  allocate()
  fixture('hybrid.v1', { n: 1000 })
  fixture('hybrid.g1', { n: 1000, wrong: 100 })
  assert.equal((await research('POST', '/variants/guard')).status, 403)
  assert.equal((await call(memory.token, 'POST', '/api/v1/variants/guard')).status, 401)
  assert.equal(weightOf('hybrid.g1'), 500, 'a refused call rolls nothing back')
  const read = json(await research('GET', '/variants/guard'))
  assert.ok(read.sets.some((s: any) => s.param_set === 'hybrid.g1'))
  assert.equal(weightOf('hybrid.g1'), 500, 'a read rolls nothing back')
  assert.deepEqual(json(await admin('POST', '/variants/guard')).rolled_back, ['hybrid.g1'])
})

// R34 (#38) and R35 (#39): promotion to default is Wen's.
test('R34: making a set other than an arm\'s v1 the default takes by wen; anything else is refused and changes nothing', { skip: SKIP }, async () => {
  allocate()
  const rows = [{ param_set: 'hybrid.g1', role: 'default', weight: 1000 }, { param_set: 'hybrid.v1', role: 'off', weight: 0 }]
  for (const by of [undefined, 'admin', 'Wen ']) {
    const audits = count('admin_audit'), allocation = digest('allocation', 'param_set')
    const r = await admin('PUT', '/allocation', { rows, ...(by === undefined ? {} : { by }) })
    assert.equal(r.status, 403, `${by}: ${r.text}`)
    assert.match(r.text, /wen/)
    assert.equal(count('admin_audit'), audits, `${by}: no audit row`)
    assert.equal(digest('allocation', 'param_set'), allocation, `${by}: allocation unchanged`)
  }
  const ok = json(await admin('PUT', '/allocation', { rows, by: 'wen' }))
  assert.equal(ok.rows.find((r: any) => r.param_set === 'hybrid.g1').role, 'default')
  const [audit] = sql(`select actor, after from memory.admin_audit where action = 'allocation.put' order by id desc limit 1`)
  assert.deepEqual([audit.actor, audit.after.by], ['admin', 'wen'])
  // Reweighting the set that is already the default, and going back to an arm's v1, need no by.
  json(await admin('PUT', '/allocation', { rows: [{ param_set: 'hybrid.g1', role: 'default', weight: 900 }] }))
  json(await admin('PUT', '/allocation', { rows: [{ param_set: 'hybrid.v1', role: 'default', weight: 1000 }, { param_set: 'hybrid.g1', role: 'off', weight: 0 }] }))
  assert.equal(sql(`select role from memory.allocation where param_set = 'hybrid.v1'`)[0].role, 'default')
})

// R35 (#39): "the research token is its own role and only its hash is stored", and its allowlist.
test('R35: the research token reads the research routes, gets 403 on every other /api/v1 route, and 401 off /api/v1', { skip: SKIP }, async () => {
  allocate()
  for (const [method, path, body] of [['GET', '/allocation'], ['GET', '/param-sets'], ['GET', '/param-sets/hybrid.v1'], ['GET', '/variants/compare?days=7'],
    ['GET', '/variants/guard'], ['GET', '/eval/questions?split=train'], ['GET', '/eval/recalls?limit=5'],
    ['POST', '/eval/rank', { query: 'oolong water temperature', arm: 'hybrid' }]] as [string, string, unknown?][]) {
    assert.equal((await research(method, path, body)).status, 200, `${method} ${path}`)
  }
  assert.equal((await research('POST', '/eval/replay', { retrieval_id: '00000000-0000-4000-8000-000000000000' })).status, 404, 'replay is open to research')
  const tables = ['entry', 'link', 'setting', 'allocation', 'param_set', 'message', 'device', 'feedback', 'admin_audit']
  const before = Object.fromEntries(tables.map((t) => [t, digest(t, 't::text')]))
  const refused: [string, string, unknown?][] = [
    ['GET', '/overview'], ['GET', '/entries'], ['GET', '/entries/tea-oolong-temp'], ['GET', '/retrievals'], ['GET', '/feedback'], ['GET', '/audit'],
    ['GET', '/events'], ['GET', '/sessions'], ['GET', '/devices'], ['GET', '/messages'], ['GET', '/groom/sessions'],
    ['POST', '/entries', { id: 'r35-x', title: 'x', body: 'x', pattern: 'observations', authority: 'observed', scope: 'global' }],
    ['PATCH', '/entries/tea-oolong-temp', { title: 'changed' }], ['DELETE', '/entries/tea-oolong-temp'], ['POST', '/messages', { to: 'all', body: 'hi' }],
    ['POST', '/devices', { name: 'r35-dev' }], ['PUT', '/secrets/openai_key', { value: 'sk-x' }], ['POST', '/feedback', { retrieval_id: 'x', verdict: 'wrong' }],
    ['POST', '/recall/preview', { query: 'oolong' }], ['POST', '/import'], ['POST', '/redact/backfill', { table: 'entry' }],
    ['POST', '/groom/checkpoint', { through: 1 }], ['POST', '/embeddings/sync'], ['POST', '/variants/guard'],
  ]
  for (const [method, path, body] of refused) assert.equal((await research(method, path, body)).status, 403, `${method} ${path}`)
  for (const t of tables) assert.equal(digest(t, 't::text'), before[t], `${t} unchanged`)
  for (const [method, path] of [['POST', '/mcp'], ['POST', '/recall'], ['GET', '/export'], ['POST', '/learn'], ['POST', '/embeddings/sync'], ['GET', '/messages/claude']]) {
    assert.equal((await call(memory.researchToken, method, path, method === 'POST' ? {} : undefined)).status, 401, `${method} ${path}`)
  }
  const plain = memory.researchToken.replaceAll("'", "''")
  assert.equal(count('setting', `value like '%${plain}%'`), 0, 'only the hash is stored')
  assert.equal(sql(`select value from memory.setting where name = 'research_token_sha256'`)[0].value, sha256(memory.researchToken))
})

// R35 (#39): "a research param set needs a written hypothesis, the parent's knobs and values in range", "proposes at most 3 sets a
// UTC week", "overlapping runs still create at most 3 sets a week", "a new research set starts off and touches no recall".
test('R35: a research set needs a parent and a 20-character hypothesis, starts off, and research makes at most 3 a UTC week', { skip: SKIP }, async () => {
  const thisWeek = `created_by = 'research' and created_at >= date_trunc('week', now() at time zone 'utc') at time zone 'utc'`
  const age = () => sql(`update memory.param_set set created_at = (date_trunc('week', now() at time zone 'utc') at time zone 'utc') - interval '1 second'
    where created_by = 'research'`)
  age()
  const hypothesis = 'A lower tilt base lets fresh notes surface.'
  const sets = count('param_set')
  for (const bad of [
    { id: 'hybrid.r-short', parent: 'hybrid.v1', params: { tiltBase: 0.8 }, note: 'x'.repeat(19) },
    { id: 'hybrid.r-none', parent: 'hybrid.v1', params: { tiltBase: 0.8 } },
    { id: 'hybrid.r-orphan', arm: 'hybrid', params: { tiltBase: 0.8 }, note: hypothesis },
    { id: 'hybrid.r-knob', parent: 'hybrid.v1', params: { bogus: 1 }, note: hypothesis },
    { id: 'hybrid.r-range', parent: 'hybrid.v1', params: { candidates: 201 }, note: hypothesis },
  ]) assert.equal((await research('POST', '/param-sets', bad)).status, 422, JSON.stringify(bad))
  assert.equal(count('param_set'), sets, 'refused posts make nothing')
  const made = json(await research('POST', '/param-sets', { id: 'hybrid.r1', parent: 'hybrid.v1', params: { tiltBase: 0.8 }, note: hypothesis, by: 'admin' }), 201)
  assert.equal(made.created_by, 'research', 'research sets are research\'s, whatever by says')
  assert.deepEqual(sql(`select role, weight from memory.allocation where param_set = 'hybrid.r1'`), [{ role: 'off', weight: 0 }])
  assert.equal(sql(`select actor from memory.admin_audit where target = 'param_set:hybrid.r1'`)[0].actor, 'research')
  for (const id of ['hybrid.r2', 'hybrid.r3']) json(await research('POST', '/param-sets', { id, parent: 'hybrid.v1', params: { tiltBase: 0.7 }, note: hypothesis }), 201)
  const fourth = await research('POST', '/param-sets', { id: 'hybrid.r4', parent: 'hybrid.v1', params: { tiltBase: 0.6 }, note: hypothesis })
  assert.equal(fourth.status, 429, fourth.text)
  assert.equal(count('param_set', thisWeek), 3)
  // The admin's sets don't count against it.
  json(await admin('POST', '/param-sets', { id: 'hybrid.a1', parent: 'hybrid.v1', params: { tiltBase: 0.6 }, note: 'admin' }), 201)
  // A new week, and 6 posts at once: 3 land.
  age()
  const posts = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    research('POST', '/param-sets', { id: `hybrid.p${i}`, parent: 'hybrid.v1', params: { tiltBase: 0.5 + i / 100 }, note: hypothesis })))
  assert.deepEqual(posts.map((p) => p.status).sort(), [201, 201, 201, 429, 429, 429])
  assert.equal(count('param_set', thisWeek), 3)
  // An off research set serves and shadows nothing.
  for (let i = 0; i < 5; i++) assert.equal((await call(memory.token, 'POST', '/recall', { query: 'oolong water temperature', scope: `run:r35-off-${i}` })).status, 200)
  assert.equal(count('retrieval', `param_set = 'hybrid.r1'`), 0)
  assert.equal(count('shadow_retrieval', `param_set = 'hybrid.r1'`), 0)
})

// R35 (#39): "the research token can't change allocation for sets it didn't create", "can never make a set default", "every
// research allocation change is audited with before and after".
test('R35: the research token moves only its own sets, only to off or shadow, and each move is audited as research', { skip: SKIP }, async () => {
  allocate()
  const own = sql(`select id from memory.param_set where created_by = 'research' order by id limit 1`)[0]?.id
    ?? json(await research('POST', '/param-sets', { id: 'hybrid.r9', parent: 'hybrid.v1', params: { tiltBase: 0.75 }, note: 'A research set for the allocation test.' }), 201).id
  const refused: [string, string][] = [[own, 'live'], [own, 'default'], ['hybrid.g1', 'off'], ['hybrid.v1', 'off'], ['hybrid.g2', 'shadow']]
  for (const [id, role] of refused) {
    const audits = count('admin_audit'), allocation = digest('allocation', 'param_set')
    const r = await research('PUT', '/allocation', { rows: [{ param_set: id, role, weight: role === 'live' ? 1 : 0 }], by: 'wen' })
    assert.equal(r.status, 403, `${id} ${role}: ${r.text}`)
    assert.equal(count('admin_audit'), audits)
    assert.equal(digest('allocation', 'param_set'), allocation)
  }
  const audits = count('admin_audit', `actor = 'research' and action = 'allocation.put'`)
  for (const role of ['shadow', 'off']) {
    const r = json(await research('PUT', '/allocation', { rows: [{ param_set: own, role, weight: 0 }], by: 'wen' }))
    assert.equal(r.rows.find((x: any) => x.param_set === own).role, role)
    const [a] = sql(`select actor, before, after from memory.admin_audit where action = 'allocation.put' order by id desc limit 1`)
    assert.equal(a.actor, 'research')
    assert.equal(a.after.by, 'research', 'research can\'t sign as anyone else')
    assert.ok(a.before.rows.some((x: any) => x.param_set === own))
  }
  assert.equal(count('admin_audit', `actor = 'research' and action = 'allocation.put'`), audits + 2)
})

// R35 (#39): "the research token can never read the test split", "a test-split read needs freeze=1 and is audited".
test('R35: the research token never reads the test split; the admin reads it only with freeze=1, audited', { skip: SKIP }, async () => {
  const reads = () => count('admin_audit', `action = 'eval.test_read'`)
  const before = reads()
  for (const q of ['split=test', 'split=all', 'split=test&freeze=1', 'split=all&freeze=1']) {
    assert.equal((await research('GET', `/eval/questions?${q}`)).status, 403, q)
  }
  assert.equal(reads(), before)
  assert.equal((await admin('GET', '/eval/questions?split=test')).status, 403)
  assert.equal((await admin('GET', '/eval/questions?split=all')).status, 403)
  assert.equal(reads(), before)
  json(await admin('GET', '/eval/questions?split=test&freeze=1'))
  assert.equal(reads(), before + 1)
  json(await admin('GET', '/eval/questions?split=train'))
  assert.equal(reads(), before + 1, 'train reads are not audited')
})

// R34 (#38): cost and units per recall, for the guardrails.
test('R34: a recall logs the OpenAI tokens it spent and the hash of its unit', { skip: SKIP }, async () => {
  allocate(null)
  const marker = `zqtokens${Date.now()}`
  const from = memory.openai.calls.length
  const r = await call(memory.token, 'POST', '/recall', { query: `${marker} oolong water temperature`, scope: 'run:tokens-1' })
  assert.equal(r.status, 200, r.text)
  const id = /^retrieval (\S+)/.exec(r.text)![1]
  const spent = memory.openai.calls.slice(from).filter((c) => JSON.stringify(c.body).includes(marker)).reduce((sum, c) => sum + c.tokens, 0)
  assert.ok(spent > 0, 'the recall called the fake')
  const [row] = sql(`select openai_tokens, unit_hash from memory.retrieval where id = '${id}'`)
  assert.equal(row.openai_tokens, spent)
  assert.equal(row.unit_hash, sha256('run:tokens-1'))
})
