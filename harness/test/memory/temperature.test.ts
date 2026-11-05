/**
 * Tier 3: R32 (#36), age and temperature as ranking features with tunable weights, against the real memory function.
 * Temperature is ACT-R's base level on the recall clock, B = ln Σ w_e·(c_now − seq_e + 1)^−decay over an agent's used (3.0),
 * Wen's confirmation (3.0) and get_entry opens (1.0), floored at −3, and logged as h = max(B, −3) + 3. Age is recalls since
 * the entry was written. Under a logodds set the final score is wRelevance·r + wTemperature·h + wAge·ln(1 + age) +
 * wConfidence·logit(c). Nothing moves with calendar time, and a replay rebuilds every feature as of the recall's own clock.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { request } from '../../src/request.ts'
import { FAKE_DOWN } from './openai.ts'
import { SKIP, apply, sql, startRealMemory, type RealMemory } from './server.ts'

let memory: RealMemory

const MIGRATION = '20261104020000_temperature_shadows.sql'
const LOGODDS = {
  scoreForm: 'logodds', wRelevance: 4, wConfidence: 0.25, wTemperature: 0.5, wAge: -0.2,
  tempDecay: 0.5, tempFloor: -3, tempWindow: 1000, tempAgentUsed: 3, tempWenConfirm: 3, tempOpened: 1,
}
/** Every weight at 0, so a copy that raises one shows that feature alone, with ties broken by id. */
const FLAT = { ...LOGODDS, wRelevance: 0, wConfidence: 0, wTemperature: 0, wAge: 0 }

before(async () => {
  if (SKIP) return
  memory = await startRealMemory({ MEMORY_ARMS: 'hybrid' })
  await set('hybrid.lo', LOGODDS)
  await set('hybrid.flat', FLAT)
  // Confidence 0 is dormant under 0.15, so the formula's ends are checked on a set that serves every entry.
  await set('hybrid.lo0', { ...LOGODDS, dormant: 0 })
  await serve('hybrid.v1')
})

after(async () => {
  await memory?.close()
})

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const admin = (method: string, path: string, body?: unknown) =>
  request(method, `${memory.url}/api/v1${path}`, { headers: bearer(memory.adminToken), body, timeoutMs: 30_000 })
const json = (r: { status: number; text: string }, status = 200) => {
  assert.equal(r.status, status, r.text)
  return JSON.parse(r.text)
}
const recall = (query: string, scope?: string) =>
  request('POST', `${memory.url}/recall`, { headers: bearer(memory.token), body: { query, ...(scope ? { scope } : {}) }, timeoutMs: 30_000 })
const rid = (text: string) => /^retrieval (\S+)/.exec(text)![1]
const word = () => 'zq' + randomUUID().replaceAll('-', '').replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)]).slice(0, 12)
const clock = () => Number(sql('select memory.recall_clock() as c')[0].c)
const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`)

async function set(id: string, params: Record<string, unknown>, parent = 'hybrid.v1') {
  const r = await admin('POST', '/param-sets', { id, parent, params, note: 'tier 3 R32' })
  assert.ok([201, 409].includes(r.status), r.text)
}

async function serve(id: string) {
  const all = sql('select id from memory.param_set').map((r) => r.id as string)
  json(await admin('PUT', '/allocation', { rows: all.map((param_set) => param_set === id ? { param_set, role: 'default', weight: 1000 } : { param_set, role: 'off', weight: 0 }) }))
}

function seed(id: string, title: string, o: { confidence?: number; body?: string } = {}) {
  sql(`insert into memory.entry (id, pattern, title, body, authority, scope, sensitivity, lang, valid_from, source_id, evidence_kind, evidence,
      evidence_sha256, project, kind, confidence, chances_left)
    values ('${id}', 'observations', '${title}', '${o.body ?? 'A short body.'}', 'observed', 'global', 'normal', 'en', '2026-11-01', 'src-a',
      'assistant', 'seen', 'x', 'proj-tea', 'wen', ${o.confidence ?? 0.8}, 0)`)
}

/** A retrieval row for feedback to hang on, logged nowhere else. */
function fakeRetrieval() {
  const id = randomUUID()
  sql(`insert into memory.retrieval (id, arm, query) values ('${id}', 'hybrid', 'tier 3 fixture')`)
  return id
}
const used = (entry: string, seq: number | null, source = 'agent', retrieval = fakeRetrieval(), verdict = 'used') =>
  sql(`insert into memory.feedback (retrieval_id, source, verdict, entry_id${seq === null ? '' : ', seq'})
    values ('${retrieval}', '${source}', '${verdict}', '${entry}'${seq === null ? '' : `, ${seq}`})`)
const opened = (entry: string, seq: number, session = 's-' + randomUUID()) =>
  sql(`insert into memory.event (session_id, event, payload, seq) values ('${session}', 'get_entry', '{"entry_id": "${entry}"}', ${seq})`)

const base = (id: string, asOf: number, win = 100) =>
  sql(`select base, temperature from memory.temperature(array['${id}'], ${asOf}, 0.5, -3, ${win}, 3, 3, 1)`)[0]

async function rank(query: string, param_set: string, filter = false) {
  return json(await admin('POST', '/eval/rank', { query, param_set, filter }))
}
const order = (r: any, ids: string[]) => r.candidates.filter((id: string) => ids.includes(id))
const feature = (r: any, id: string) => r.scored.find((c: any) => c.id === id)

// R32 (#36): "temperature counts helpful and opened events by recalls inside the window, floored at -3".
test('R32: temperature counts used, confirmed and opened events by recalls inside the window, floored at -3', { skip: SKIP }, () => {
  used('heat-a', 10)
  opened('heat-b', 12)
  used('heat-c', 10)
  opened('heat-c', 12)
  used('heat-d', 10, 'wen')
  // Delivered, judged irrelevant and wrong, and its own write: none of them heat it.
  const r = fakeRetrieval()
  sql(`update memory.retrieval set delivered = '["heat-e"]' where id = '${r}'`)
  used('heat-e', 10, 'agent', r, 'irrelevant')
  used('heat-e', 11, 'agent', fakeRetrieval(), 'wrong')
  used('heat-f', 10)
  used('heat-f', 105)
  near(base('heat-a', 13).base, 0.405465, 1e-6, 'one agent used at seq 10')
  near(base('heat-b', 13).base, -0.346574, 1e-6, 'one get_entry at seq 12')
  near(base('heat-c', 13).base, 0.791683, 1e-6, 'both')
  near(base('heat-d', 13).base, 0.405465, 1e-6, "Wen's confirmation at seq 10")
  assert.equal(base('heat-e', 13).base, -3, 'only deliveries, irrelevant/wrong feedback and its own write')
  assert.equal(base('heat-e', 13).temperature, 0, 'h = max(B, floor) - floor, so a cold entry is 0')
  near(base('heat-f', 110).base, 0.202733, 1e-6, 'the seq 10 event is outside the window of 100')
  near(base('heat-a', 13).temperature, 0.405465 + 3, 1e-6, 'h is B shifted up by the floor')
  // An event after the reading doesn't count: features are as of c_now.
  assert.equal(base('heat-a', 9).base, -3)
})

// R32 (#36): "repeated feedback or opens heat an entry once".
test('R32: ten used on one retrieval and ten opens at one seq in one session heat an entry once', { skip: SKIP }, () => {
  const r = fakeRetrieval(), session = 's-' + randomUUID()
  for (let i = 0; i < 10; i++) used('heat-g', 10, 'agent', r)
  for (let i = 0; i < 10; i++) opened('heat-g', 12, session)
  near(base('heat-g', 13).base, 0.791683, 1e-6, 'the value for 1 used plus 1 get_entry')
})

// R32 (#36): "age is non-degraded recalls since the entry was written".
test('R32: age is real recalls since the entry was written, and eval, preview and degraded recalls age nothing', { skip: SKIP }, async () => {
  await serve('hybrid.v1')
  const w = word()
  seed(`age-${w}`, `${w} age probe`)
  const written = Number(sql(`select written_seq from memory.entry where id = 'age-${w}'`)[0].written_seq)
  assert.equal(written, clock(), 'written_seq is the clock at insert')
  for (let i = 0; i < 7; i++) assert.equal((await recall(`${w} age probe ${i}`)).status, 200)
  const eighth = rid((await recall(`${w} age probe 8`)).text)
  const [row] = sql(`select context from memory.retrieval where id = '${eighth}'`)
  assert.equal(row.context.c_now, written + 7)
  assert.equal(row.context.candidates.find((c: any) => c.id === `age-${w}`).age, 7)
  for (let i = 0; i < 3; i++) await rank(`${w} age probe`, 'hybrid.v1')
  json(await admin('POST', '/recall/preview', { query: `${w} age probe` }))
  assert.match((await recall(`${w} age probe ${FAKE_DOWN}`)).text, /^Degraded:/m)
  const r = await rank(`${w} age probe`, 'hybrid.v1')
  assert.equal(r.c_now, written + 8)
  assert.equal(feature(r, `age-${w}`).features.age, 8)
})

// R32 (#36): "each retrieval logs its param set and every candidate's features and final score".
test('R32: each retrieval logs c_now and every candidate\'s relevance, confidence, temperature, age and final score', { skip: SKIP }, async () => {
  await serve('hybrid.lo')
  const w = word()
  seed(`log-${w}`, `${w} logged features`)
  const id = rid((await recall(`${w} logged features`)).text)
  await serve('hybrid.v1')
  const [row] = sql(`select seq, param_set, candidates, context from memory.retrieval where id = '${id}'`)
  assert.equal(row.param_set, 'hybrid.lo')
  assert.ok(Number.isInteger(row.context.c_now))
  assert.equal(Number(row.seq), row.context.c_now + 1, 'the recall ranked at c_now and took the next seq')
  for (const c of row.context.candidates) {
    assert.deepEqual(Object.keys(c).sort(), ['age', 'arms', 'confidence', 'id', 'judge', 'kind', 'relevance', 'score', 'temperature'])
    for (const k of ['relevance', 'temperature', 'age', 'score']) assert.equal(typeof c[k], 'number', `${k} of ${JSON.stringify(c)}`)
    assert.ok(c.temperature >= 0 && c.age >= 0 && c.relevance >= 0 && c.relevance <= 1, JSON.stringify(c))
  }
  assert.deepEqual(row.context.candidates.map((c: any) => [c.id, c.score]), row.candidates.map((c: any) => [c.id, c.score]))
})

// R32 (#36): "the final score is the set's formula over the logged features".
test('R32: the final score is the set\'s formula over the logged features, on a tilt set and a logodds set', { skip: SKIP }, async () => {
  const w = word()
  seed(`f1-${w}`, `${w} formula one`, { confidence: 0 })
  seed(`f2-${w}`, `${w} formula two`, { confidence: 1 })
  used(`f1-${w}`, clock())
  const logit = (c: number) => { const x = Math.min(0.99, Math.max(0.01, c)); return Math.log(x / (1 - x)) }
  for (const id of ['hybrid.v1', 'hybrid.lo0']) {
    await serve(id)
    const r = rid((await recall(`${w} formula`)).text)
    const [row] = sql(`select context from memory.retrieval where id = '${r}'`)
    for (const c of row.context.candidates) {
      const conf = c.confidence ?? 0.7
      const want = id === 'hybrid.v1'
        ? c.arms.hybrid.score * (0.9 + (1 - 0.9) * conf)
        : 4 * c.relevance + 0.5 * c.temperature + -0.2 * Math.log(1 + c.age) + 0.25 * logit(conf)
      near(c.score, want, 1e-9, `${id} ${c.id}`)
    }
    if (id === 'hybrid.lo0') {
      // Confidence 0 and 1 are finite, their term w_conf × ∓4.59512.
      for (const [e, sign] of [[`f1-${w}`, -1], [`f2-${w}`, 1]] as const) {
        const c = row.context.candidates.find((x: any) => x.id === e)
        const term = c.score - (4 * c.relevance + 0.5 * c.temperature + -0.2 * Math.log(1 + c.age))
        near(term, 0.25 * sign * 4.59512, 1e-5, `${e} confidence term`)
      }
    }
  }
  await serve('hybrid.v1')
})

// R32 (#36): "raising a feature's weight reorders two otherwise equal entries toward the higher value".
test('R32: raising one weight from 0 reorders two otherwise equal entries toward the higher value of that feature', { skip: SKIP }, async () => {
  const w = word(), c = clock()
  // a sorts before b, so with every weight at 0 the tie goes to a.
  seed(`${w}-a-cold`, `${w} twin`)
  seed(`${w}-b-hot`, `${w} twin`)
  used(`${w}-b-hot`, c)
  used(`${w}-b-hot`, c)
  seed(`${w}-c-low`, `${w} trust`, { confidence: 0.4 })
  seed(`${w}-d-high`, `${w} trust`, { confidence: 0.9 })
  seed(`${w}-e-old`, `${w} era`)
  seed(`${w}-f-new`, `${w} era`)
  sql(`update memory.entry set written_seq = ${c} - 9 where id = '${w}-e-old'`)
  sql(`update memory.entry set written_seq = ${c} - 2 where id = '${w}-f-new'`)
  seed(`${w}-g-weak`, `${w} echo`)
  seed(`${w}-h-strong`, `${w} echo ${w} echo ${w} echo`)
  const cases: [string, number, string, string, string][] = [
    ['wTemperature', 1, 'twin', `${w}-a-cold`, `${w}-b-hot`],
    ['wConfidence', 1, 'trust', `${w}-c-low`, `${w}-d-high`],
    ['wAge', -1, 'era', `${w}-e-old`, `${w}-f-new`],
    ['wRelevance', 1, 'echo', `${w}-g-weak`, `${w}-h-strong`],
  ]
  for (const [knob, v, q, low, high] of cases) {
    await set(`hybrid.flip-${knob.toLowerCase()}`, { [knob]: v }, 'hybrid.flat')
    assert.deepEqual(order(await rank(`${w} ${q}`, 'hybrid.flat'), [low, high]), [low, high], `${knob} at 0: the tie goes by id`)
    assert.deepEqual(order(await rank(`${w} ${q}`, `hybrid.flip-${knob.toLowerCase()}`), [low, high]), [high, low], `${knob} at ${v}`)
  }
})

// R32 (#36): "every knob changes the ranking when changed alone under its own arm and score form" (the R32 knobs).
test('R32: each temperature and weight knob changes logodds scores when changed alone, and no tilt score', { skip: SKIP }, async () => {
  const w = word(), c = clock()
  seed(`${w}-hot`, `${w} knob`, { confidence: 0.6 })
  seed(`${w}-cold`, `${w} knob other`, { confidence: 0.6 })
  sql(`update memory.entry set written_seq = ${c} - 5 where id like '${w}-%'`)
  used(`${w}-hot`, c - 5)
  used(`${w}-hot`, c - 4, 'wen')
  opened(`${w}-hot`, c - 3)
  const scores = async (id: string) => Object.fromEntries((await rank(`${w} knob`, id)).scored.map((s: any) => [s.id, s.final_score]))
  const changes: [string, unknown][] = [
    ['wRelevance', 2], ['wConfidence', 1], ['wTemperature', 1], ['wAge', -1], ['tempDecay', 1], ['tempFloor', -4], ['tempWindow', 1],
    ['tempAgentUsed', 1], ['tempWenConfirm', 1], ['tempOpened', 5], ['scoreForm', 'tilt'],
  ]
  const lo = await scores('hybrid.lo'), v1 = await scores('hybrid.v1')
  for (const [knob, v] of changes) {
    const id = `hybrid.k-${knob.toLowerCase()}`
    await set(id, { [knob]: v }, 'hybrid.lo')
    assert.notDeepEqual(await scores(id), lo, `${knob} changed no logodds score`)
    if (knob === 'scoreForm') continue
    const tiltId = `hybrid.kt-${knob.toLowerCase()}`
    await set(tiltId, { [knob]: v }, 'hybrid.v1')
    assert.deepEqual(await scores(tiltId), v1, `${knob} changed a tilt score`)
  }
})

// R32 (#36): "a simulated year of calendar time with no recalls changes no score".
test('R32: a year of calendar time with no recalls changes no temperature, age or score', { skip: SKIP }, async () => {
  const w = word()
  seed(`${w}-yr`, `${w} year`)
  used(`${w}-yr`, clock())
  opened(`${w}-yr`, clock())
  const before = await rank(`${w} year`, 'hybrid.lo')
  for (const [table, col] of [['entry', 'created_at'], ['event', 'received_at'], ['feedback', 'created_at'], ['retrieval', 'created_at']]) {
    sql(`update memory.${table} set ${col} = ${col} - interval '365 days'`)
  }
  const later = await rank(`${w} year`, 'hybrid.lo')
  assert.ok(feature(before, `${w}-yr`).features.temperature > 0)
  assert.deepEqual(later.scored, before.scored)
  assert.deepEqual(later.candidates, before.candidates)
  const src = sql(`select pg_get_functiondef('memory.temperature'::regproc) || pg_get_functiondef('memory.ranking_features'::regproc) as d`)[0].d
  for (const banned of ['now(', 'created_at', 'received_at', 'current_timestamp', 'clock_timestamp']) assert.ok(!src.includes(banned), banned)
})

// R32 (#36): "logged features are as of the recall's clock, never recomputed later".
test('R32: feedback after a recall changes neither its logged temperature nor its replay', { skip: SKIP }, async () => {
  await serve('hybrid.lo')
  const w = word()
  seed(`${w}-asof`, `${w} as of`)
  const id = rid((await recall(`${w} as of`)).text)
  await serve('hybrid.v1')
  const [row] = sql(`select seq, context from memory.retrieval where id = '${id}'`)
  const logged = row.context.candidates.find((c: any) => c.id === `${w}-asof`)
  used(`${w}-asof`, null, 'agent', id)
  assert.equal(Number(sql(`select seq from memory.feedback where retrieval_id = '${id}'`)[0].seq), Number(row.seq), 'the feedback lands at the recall\'s seq')
  const [again] = sql(`select context from memory.retrieval where id = '${id}'`)
  assert.equal(again.context.candidates.find((c: any) => c.id === `${w}-asof`).temperature, logged.temperature)
  const asOf = sql(`select temperature from memory.temperature(array['${w}-asof'], ${row.context.c_now}, 0.5, -3, 1000, 3, 3, 1)`)[0]
  near(asOf.temperature, logged.temperature, 1e-9, 'as_of c_now')
  const now = sql(`select temperature from memory.temperature(array['${w}-asof'], ${clock()}, 0.5, -3, 1000, 3, 3, 1)`)[0]
  assert.ok(now.temperature > logged.temperature, 'the feedback heats it from the next recall on')
})

// R32 (#36): "as-of replay reproduces logged scores", through the route and retrieval_eval.py --replay.
test('R32: as-of replay rebuilds every logged temperature, age and final score, through the route and retrieval_eval.py', { skip: SKIP }, async () => {
  await serve('hybrid.lo')
  const w = word()
  for (let i = 0; i < 4; i++) seed(`${w}-r${i}`, `${w} replay ${i}`)
  const ids: string[] = []
  for (let i = 0; i < 5; i++) {
    const id = rid((await recall(`${w} replay ${i % 4}`)).text)
    ids.push(id)
    // Feedback and opens land after each recall, so later recalls see a hotter store than earlier ones did.
    used(`${w}-r${i % 4}`, null, 'agent', id)
    opened(`${w}-r${(i + 1) % 4}`, clock())
  }
  await serve('hybrid.v1')
  for (const id of ids) {
    const [row] = sql(`select context from memory.retrieval where id = '${id}'`)
    const r = json(await admin('POST', '/eval/replay', { retrieval_id: id }))
    assert.equal(r.param_set, 'hybrid.lo')
    assert.equal(r.c_now, row.context.c_now)
    const got = new Map(r.candidates.map((c: any) => [c.id, c]))
    for (const c of row.context.candidates) {
      const g: any = got.get(c.id)
      near(g.temperature, c.temperature, 1e-9, `${id} ${c.id} temperature`)
      assert.equal(g.age, c.age, `${id} ${c.id} age`)
      near(g.final_score, c.score, 1e-9, `${id} ${c.id} final score`)
    }
  }
  // Replayed under another set, the same recall re-scores with that set's weights.
  const other = json(await admin('POST', '/eval/replay', { retrieval_id: ids[0], param_set: 'hybrid.v1' }))
  assert.equal(other.param_set, 'hybrid.v1')
  const script = join(import.meta.dirname, '..', '..', '..', 'memory', 'eval', 'retrieval_eval.py')
  const run = (...args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('python3', [script, ...args], {
      env: { ...process.env, MEMORY_URL: memory.url, MEMORY_ADMIN_TOKEN: memory.adminToken, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
  const out = await run('--replay', '--params', 'hybrid.lo', '--limit', '5', '--json')
  assert.equal(out.status, 0, out.stderr || out.stdout)
  const report = JSON.parse(out.stdout)
  assert.equal(report.replayed, 5)
  assert.deepEqual(report.per_recall.map((p: any) => p.retrieval_id).sort(), [...ids].sort())
  assert.ok(report.max_score_diff <= 1e-9, String(report.max_score_diff))
  assert.ok(report.used_at_k >= 1, 'the recalls\' used feedback is read back')
  const text = await run('--replay', '--limit', '5')
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /^replay \(logged\): 5 recalls/m)
})

// R32 (#36): "one param set id always ranks the same state the same way".
test('R32: one logodds set ranks the same state the same way twice, features and scores alike', { skip: SKIP }, async () => {
  const w = word()
  seed(`${w}-same`, `${w} same`)
  used(`${w}-same`, clock())
  const a = await rank(`${w} same`, 'hybrid.lo', true), b = await rank(`${w} same`, 'hybrid.lo', true)
  assert.deepEqual(b.scored, a.scored)
})

// R32 (#36): "features add no OpenAI calls".
test('R32: temperature and age add no OpenAI call: a new query costs 1 embedding and 1 judge call', { skip: SKIP }, async () => {
  const w = word()
  seed(`${w}-oc`, `${w} openai count`)
  used(`${w}-oc`, clock())
  for (const id of ['hybrid.flat', 'hybrid.lo']) {
    await serve(id)
    const from = memory.openai.calls.length
    // A word no query has had, so the query is embedded afresh, and one the seeded entry matches, so the judge reads it.
    assert.equal((await recall(`${word()} ${w} openai count`)).status, 200)
    assert.deepEqual(memory.openai.calls.slice(from).map((c) => c.path).sort(), ['/decisions', '/embeddings'], id)
  }
  await serve('hybrid.v1')
})

// R32 (#36): "a failing feature query still returns a packet and says degraded".
test('R32: with the feature query failing, recall still answers, ranks without temperature and age, says so, and takes no seq', { skip: SKIP }, async () => {
  await serve('hybrid.lo')
  const w = word()
  seed(`${w}-ff`, `${w} features fail`)
  sql(`create or replace function memory.ranking_features(ids text[], as_of bigint, decay double precision, lo double precision,
      win integer, w_agent double precision, w_wen double precision, w_open double precision)
    returns table (id text, age bigint, temperature double precision) language plpgsql as $$
    begin raise exception 'tier 3 breaks the feature query'; end $$`)
  try {
    const before = clock()
    const r = await recall(`${w} features fail`)
    assert.equal(r.status, 200, r.text)
    assert.match(r.text, /features-failed/)
    assert.match(r.text, new RegExp(`${w}-ff`))
    const [row] = sql(`select seq, degraded, context from memory.retrieval where id = '${rid(r.text)}'`)
    assert.equal(row.seq, null)
    assert.match(row.degraded, /features-failed/)
    for (const c of row.context.candidates) {
      assert.equal(c.temperature, null)
      assert.equal(c.age, null)
      const conf = c.confidence ?? 0.7, x = Math.min(0.99, Math.max(0.01, conf))
      near(c.score, 4 * c.relevance + 0.25 * Math.log(x / (1 - x)), 1e-9, 'the temperature and age terms are 0')
    }
    assert.equal(clock(), before)
  } finally {
    apply(MIGRATION)
    await serve('hybrid.v1')
  }
})

// R32 (#36): "the migration backfills retrieval seq and entry written_seq, and edits keep written_seq".
test('R32: the migration backfills written_seq from the recalls before each entry, and an edit keeps it', { skip: SKIP }, async () => {
  const w = word()
  seed(`${w}-bf`, `${w} backfill`)
  sql(`update memory.entry set created_at = '2020-01-02' where id = '${w}-bf'`)
  for (const [day, seq] of [['2020-01-01', 7001], ['2020-01-01 12:00', 7002], ['2020-01-03', 7003]]) {
    sql(`insert into memory.retrieval (id, arm, query, seq, created_at) values ('${randomUUID()}', 'hybrid', 'old', ${seq}, '${day}')`)
  }
  sql(`insert into memory.retrieval (id, arm, query, seq, degraded, created_at) values ('${randomUUID()}', 'hybrid', 'old', null, 'embed-failed', '2020-01-01 18:00')`)
  sql(`alter table memory.entry alter column written_seq drop not null`)
  sql(`update memory.entry set written_seq = null where id = '${w}-bf'`)
  apply(MIGRATION)
  assert.equal(Number(sql(`select written_seq from memory.entry where id = '${w}-bf'`)[0].written_seq), 7002)
  assert.equal(sql(`select count(*)::int as n from memory.entry where written_seq is null`)[0].n, 0)
  json(await admin('PATCH', `/entries/${w}-bf`, { body: 'An edited body.' }))
  assert.equal(Number(sql(`select written_seq from memory.entry where id = '${w}-bf'`)[0].written_seq), 7002, 'an edit keeps written_seq')
})

// R32 (#36): "out-of-range, non-integer or non-numeric knobs are refused on every path" (the R32 knobs).
test('R32: an out-of-range, non-integer or non-numeric R32 knob is refused by the API and the eval route, naming it', { skip: SKIP }, async () => {
  const n = () => sql('select count(*)::int as n from memory.param_set')[0].n
  const before = n()
  for (const [knob, bad] of [['tempDecay', 0], ['tempWindow', 2.5], ['tempFloor', 1], ['wTemperature', 'hot'], ['scoreForm', 'sum']] as [string, unknown][]) {
    const made = await admin('POST', '/param-sets', { id: `hybrid.bad-${knob.toLowerCase()}`, parent: 'hybrid.v1', params: { [knob]: bad } })
    assert.equal(made.status, 422, made.text)
    assert.match(made.text, new RegExp(knob))
    const ranked = await admin('POST', '/eval/rank', { query: 'oolong', arm: 'hybrid', params: { [knob]: bad } })
    assert.equal(ranked.status, 422, ranked.text)
    assert.match(ranked.text, new RegExp(knob))
  }
  assert.equal(n(), before)
})
