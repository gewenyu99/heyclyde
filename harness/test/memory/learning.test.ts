/**
 * Tier 3: the learning loop's plumbing (R32 #36, R34 #38, R36 #40, slice 1a). Parameter sets and their admin API, which set
 * a unit is served and how it's logged, the recall clock, the features each recall logs, the OpenAI budgets by kind, and
 * the eval run against any parameter set. The golden test that v1 ranks like the code before it is golden.test.ts.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Memory } from '../../src/memory.ts'
import { request } from '../../src/request.ts'
import { tempDir } from '../helpers.ts'
import { FAKE_DOWN } from './openai.ts'
import { SKIP, sql, startRealMemory, type RealMemory } from './server.ts'

let memory: RealMemory

before(async () => {
  if (!SKIP) memory = await startRealMemory()
})

after(async () => {
  await memory?.close()
})

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const admin = (method: string, path: string, body?: unknown) =>
  request(method, `${memory.url}/api/v1${path}`, { headers: bearer(memory.adminToken), body, timeoutMs: 30_000 })
const recall = (query: string, scope?: string, token = memory.token) =>
  request('POST', `${memory.url}/recall`, { headers: bearer(token), body: { query, ...(scope ? { scope } : {}) }, timeoutMs: 30_000 })
const json = (r: { status: number; text: string }, status = 200) => {
  assert.equal(r.status, status, r.text)
  return JSON.parse(r.text)
}
/** Today's constants, typed out by hand, so a wrong seed can't pass by agreeing with itself. */
const TODAY = {
  candidates: 50, packetItems: 8, packetTokens: 1500, filterK: 12, filterThreshold: 0.5, tiltBase: 0.9, tiltUnknownConfidence: 0.7,
  tiltWindow: 48, rowWindow: 24, dormant: 0.15, rrfK: 10, vecWeight: 1.5, indexDraftFactor: 0.5, scopeBoost: 3, restart: 0.5,
  iterations: 20, supersededFactor: 0.3, linkTypeWeights: {}, wTemperature: 0, wAge: 0, wKind: 0,
}
const clearAllocation = () => sql('delete from memory.allocation')
/** Every recall on hybrid.v1, so a test that needs the vector ranker gets it. */
async function onlyHybrid() {
  json(await admin('PUT', '/allocation', { rows: [
    { param_set: 'index.v1', role: 'off', weight: 0 }, { param_set: 'spreading.v1', role: 'off', weight: 0 }, { param_set: 'hybrid.v1', role: 'default', weight: 1000 },
  ] }))
}

/** An MCP session as `client`, with its Mcp-Session-Id and a function that calls one tool. */
async function mcp(token: string, client: string) {
  const init = await request('POST', `${memory.url}/mcp`, {
    headers: bearer(token), timeoutMs: 15_000,
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: client } } },
  })
  assert.equal(init.status, 200, init.text)
  const session = String(init.headers['mcp-session-id'])
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await request('POST', `${memory.url}/mcp`, {
      headers: { ...bearer(token), 'mcp-session-id': session }, timeoutMs: 30_000,
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
    })
    assert.equal(r.status, 200, r.text)
    return JSON.parse(r.text).result.content[0].text as string
  }
  return { session, tool }
}

/** A hybrid.split set next to hybrid.v1, served 50/50 on a salt this test fixes, so the split is the same on every run. */
async function splitHalf() {
  sql(`update memory.setting set value = 'tier3-salt' where name = 'allocation_salt'`)
  const made = await admin('POST', '/param-sets', { id: 'hybrid.split', parent: 'hybrid.v1', params: { tiltBase: 0.8 }, note: 'tier 3 split' })
  assert.ok([201, 409].includes(made.status), made.text)
  json(await admin('PUT', '/allocation', { rows: [
    { param_set: 'index.v1', role: 'off', weight: 0 }, { param_set: 'spreading.v1', role: 'off', weight: 0 },
    { param_set: 'hybrid.v1', role: 'default', weight: 500 }, { param_set: 'hybrid.split', role: 'live', weight: 500 },
  ] }))
}

// R32 (#36): v1 holds today's constants. The golden test proves they rank the same.
test('index.v1, hybrid.v1 and spreading.v1 hold today\'s constants, with the new features at weight 0', { skip: SKIP }, async () => {
  const sets = json(await admin('GET', '/param-sets'))
  for (const [id, arm] of [['index.v1', 'index'], ['hybrid.v1', 'hybrid'], ['spreading.v1', 'spreading']]) {
    const set = sets.find((s: any) => s.id === id)
    assert.ok(set, `${id} is seeded`)
    assert.equal(set.arm, arm)
    assert.deepEqual(set.params, TODAY, id)
    assert.equal(set.parent, null)
  }
  assert.deepEqual(json(await admin('GET', '/param-sets/hybrid.v1')).params, TODAY)
  assert.equal((await admin('GET', '/param-sets/nope.v1')).status, 404)
})

// R32 (#36): changing a weight is a data change. A parameter set is immutable: the database refuses to change one.
test('a parameter set is created through the API with a parent, and the database refuses to change its params or arm', { skip: SKIP }, async () => {
  const body = { id: 'hybrid.t1', parent: 'hybrid.v1', params: { tiltBase: 0.5, vecWeight: 2 }, note: 'tier 3 variant', by: 'tier3' }
  const made = json(await admin('POST', '/param-sets', body), 201)
  assert.deepEqual([made.id, made.arm, made.parent, made.created_by], ['hybrid.t1', 'hybrid', 'hybrid.v1', 'tier3'])
  assert.deepEqual(made.params, { ...TODAY, tiltBase: 0.5, vecWeight: 2 }, 'a set stores every knob, parent\'s and its own')
  assert.deepEqual(sql(`select action, target from memory.admin_audit where target = 'param_set:hybrid.t1'`), [{ action: 'param_set.create', target: 'param_set:hybrid.t1' }])
  assert.equal((await admin('POST', '/param-sets', body)).status, 409, 'creating an id again is refused')
  for (const bad of [{ id: 'x.1', parent: 'hybrid.v1', params: { bogus: 1 } }, { id: 'x.2', parent: 'hybrid.v1', params: { tiltBase: 3 } },
    { id: 'x.3', parent: 'nope.v1', params: {} }, { id: 'Bad Id', parent: 'hybrid.v1', params: {} }, { id: 'x.4', params: { tiltBase: 0.5 } }]) {
    assert.equal((await admin('POST', '/param-sets', bad)).status, 422, JSON.stringify(bad))
  }
  assert.deepEqual(sql(`select id from memory.param_set where id like 'x.%'`), [])
  assert.equal((await admin('PUT', '/param-sets/hybrid.t1', { params: {} })).status, 405, 'the API has no update')
  assert.throws(() => sql(`update memory.param_set set params = '{}' where id = 'hybrid.t1'`), /immutable/)
  assert.throws(() => sql(`update memory.param_set set arm = 'index' where id = 'hybrid.t1'`), /immutable/)
  assert.throws(() => sql(`delete from memory.param_set where id = 'hybrid.v1'`), /immutable/)
  sql(`update memory.param_set set note = 'reworded' where id = 'hybrid.t1'`)
  assert.deepEqual(json(await admin('GET', '/param-sets/hybrid.t1')).params, made.params)
})

// R34 (#38): flags and variants change through the admin API with no deploy; every change is audited.
test('PUT /allocation changes who is served with no deploy, is audited, and refuses an allocation that serves nothing', { skip: SKIP }, async () => {
  try {
    const put = json(await admin('PUT', '/allocation', { by: 'tier3', rows: [
      { param_set: 'hybrid.v1', role: 'default', weight: 750 }, { param_set: 'hybrid.t1', role: 'live', weight: 250 }, { param_set: 'index.v1', role: 'shadow', weight: 0 },
    ] }))
    const shares = Object.fromEntries(put.rows.map((r: any) => [r.param_set, r.share]))
    assert.deepEqual(shares, { 'hybrid.v1': 0.75, 'hybrid.t1': 0.25, 'index.v1': null })
    assert.deepEqual(json(await admin('GET', '/allocation')).rows, put.rows)
    const [row] = sql(`select target, before, after from memory.admin_audit where action = 'allocation.put' order by id desc limit 1`)
    assert.equal(row.target, 'allocation')
    assert.deepEqual(row.before, [])
    assert.deepEqual(row.after.map((r: any) => [r.param_set, r.role, r.weight]).sort(), [['hybrid.t1', 'live', 250], ['hybrid.v1', 'default', 750], ['index.v1', 'shadow', 0]])
    // A second PUT keeps what the first said, and the audit row shows the table before it.
    json(await admin('PUT', '/allocation', { rows: [{ param_set: 'hybrid.t1', role: 'off', weight: 0 }] }))
    const [second] = sql(`select before, after from memory.admin_audit where action = 'allocation.put' order by id desc limit 1`)
    assert.equal(second.before.length, 3)
    assert.equal(second.after.find((r: any) => r.param_set === 'hybrid.v1').weight, 750)
    const nothing = [{ rows: [{ param_set: 'hybrid.v1', role: 'off', weight: 0 }] }, { rows: [{ param_set: 'hybrid.v1', role: 'default', weight: 0 }] },
      { rows: [{ param_set: 'nope.v1', role: 'live', weight: 1 }] }, { rows: [{ param_set: 'hybrid.v1', role: 'sometimes', weight: 1 }] },
      { rows: [{ param_set: 'hybrid.v1', role: 'live', weight: -1 }] }, { rows: [] }, {}]
    for (const bad of nothing) assert.equal((await admin('PUT', '/allocation', bad)).status, 422, JSON.stringify(bad))
    assert.equal(sql(`select weight from memory.allocation where param_set = 'hybrid.v1'`)[0].weight, 750, 'a refused PUT changes nothing')
  } finally {
    clearAllocation()
  }
})

// R34 (#38): a live variant at 50% serves about half the units, sticky per unit, and the retrieval logs which one served it.
test('a live 50/50 split is sticky per unit: 85 to 115 of 200 run units land on each side, propensity 0.5 logged', { skip: SKIP }, async () => {
  await splitHalf()
  try {
    const scopes = Array.from({ length: 200 }, (_, i) => `run:u-${i}`)
    for (const scope of scopes) assert.equal((await recall('oolong water temperature', scope)).status, 200)
    const split = sql(`select param_set, count(*)::int as n, min(propensity)::float as lo, max(propensity)::float as hi
      from memory.retrieval where mcp_session like 'http-run:u-%' group by param_set order by param_set`)
    assert.deepEqual(split.map((s) => s.param_set), ['hybrid.split', 'hybrid.v1'])
    for (const s of split) {
      assert.ok(s.n >= 85 && s.n <= 115, `${s.n} of 200 on ${s.param_set}`)
      assert.deepEqual([s.lo, s.hi], [0.5, 0.5], s.param_set)
    }
    const arms = sql(`select distinct r.arm, r.param_set, s.param_set as session_set, s.propensity::float as session_propensity
      from memory.retrieval r join memory.mcp_session s on s.id = r.mcp_session where r.mcp_session like 'http-run:u-%'`)
    assert.ok(arms.every((a) => a.arm === 'hybrid' && a.session_propensity === 0.5 && a.session_set === a.param_set), JSON.stringify(arms))
    // Sticky: the same units, asked again, are served by the same sets.
    const before = Object.fromEntries(sql(`select mcp_session, param_set from memory.retrieval where mcp_session like 'http-run:u-%'`).map((r) => [r.mcp_session, r.param_set]))
    for (const scope of scopes.slice(0, 40)) await recall('brew oolong at 90C', scope)
    const after = sql(`select mcp_session, count(distinct param_set)::int as sets from memory.retrieval where mcp_session like 'http-run:u-%' group by mcp_session`)
    assert.ok(after.every((r) => r.sets === 1), 'no unit saw two sets')
    assert.equal(Object.keys(before).length, 200)
  } finally {
    clearAllocation()
  }
})

// R36 (#40): assignment doesn't depend on MCP sessions, which newer protocol versions drop.
test('without a run scope the unit is device, client and day: eight MCP sessions of one client get one set', { skip: SKIP }, async () => {
  await splitHalf()
  try {
    const seen = new Set<string>(), sessions: string[] = []
    for (let i = 0; i < 8; i++) {
      const { session, tool } = await mcp(memory.token, 'claude-code')
      sessions.push(session)
      assert.match(await tool('recall', { query: `oolong water temperature ${i}` }), /^retrieval [0-9a-f-]{36}/)
    }
    for (const s of sessions) seen.add(sql(`select param_set from memory.retrieval where mcp_session = '${s}'`)[0].param_set)
    assert.equal(seen.size, 1, `eight sessions, one unit: ${[...seen]}`)
    assert.equal(new Set(sessions).size, 8, 'they really were eight sessions')
  } finally {
    clearAllocation()
  }
})

// R34 (#38): rollback is one row, no deploy.
test('setting a live set\'s role to off takes it out of service at once, even for a session it already served', { skip: SKIP }, async () => {
  await splitHalf()
  try {
    for (let i = 0; i < 40; i++) await recall('oolong water temperature', `run:roll-${i}`)
    const [served] = sql(`select mcp_session, param_set from memory.retrieval where mcp_session like 'http-run:roll-%' and param_set = 'hybrid.split' limit 1`)
    assert.ok(served, 'some unit was served by the variant')
    json(await admin('PUT', '/allocation', { rows: [{ param_set: 'hybrid.split', role: 'off', weight: 0 }] }))
    const scope = served.mcp_session.replace('http-', '')
    assert.equal((await recall('oolong water temperature', scope)).status, 200)
    assert.deepEqual(sql(`select param_set, propensity::float as p from memory.retrieval where mcp_session = '${served.mcp_session}' order by created_at desc limit 1`),
      [{ param_set: 'hybrid.v1', p: 1 }])
    assert.equal(sql(`select param_set from memory.mcp_session where id = '${served.mcp_session}'`)[0].param_set, 'hybrid.v1')
  } finally {
    clearAllocation()
  }
})

test('with no allocation, MEMORY_ARMS still decides, each arm on its v1, and the retrieval says so', { skip: SKIP }, async () => {
  clearAllocation()
  const r = await recall('oolong water temperature', 'run:plain-1')
  assert.equal(r.status, 200, r.text)
  const [row] = sql(`select arm, param_set, propensity::float as p from memory.retrieval where mcp_session = 'http-run:plain-1'`)
  assert.equal(row.param_set, `${row.arm}.v1`)
  assert.equal(row.p, 0.5, 'index and hybrid, a coin each')
  assert.deepEqual(json(await admin('GET', '/allocation')).rows, [])
})

// R32 (#36): the recall clock is real recalls only.
test('the recall clock: a recall advances seq by one, the eval rank route and a degraded recall do not', { skip: SKIP }, async () => {
  const clock = () => Number(sql('select coalesce(max(seq), 0)::int as n from memory.retrieval')[0].n)
  const start = clock()
  const ranked = json(await admin('POST', '/eval/rank', { query: 'oolong water temperature', arm: 'hybrid' }))
  assert.ok(ranked.candidates.length > 0)
  const preview = await admin('POST', '/recall/preview', { query: 'oolong water temperature' })
  assert.equal(preview.status, 200, preview.text)
  assert.equal(clock(), start, 'eval and preview leave the clock alone')
  assert.equal((await recall('oolong clock one')).status, 200)
  assert.equal(clock(), start + 1)
  // OpenAI down: the recall still answers, degraded, and takes no tick.
  const down = await recall(`oolong clock ${FAKE_DOWN}`)
  assert.match(down.text, /^Degraded:/m)
  assert.equal(clock(), start + 1, 'a degraded recall is not on the clock')
  const [degraded] = sql(`select seq, degraded from memory.retrieval where query like '%${FAKE_DOWN}%'`)
  assert.equal(degraded.seq, null)
  assert.ok(degraded.degraded)
  assert.equal((await recall('oolong clock two')).status, 200)
  assert.equal(clock(), start + 2, 'no gap where the degraded recall was')
  const seqs = sql('select seq from memory.retrieval where seq is not null order by seq').map((r) => Number(r.seq))
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'seq counts 1, 2, 3 without gaps or repeats')
})

// R32 (#36): each retrieval logs the parameter set and every candidate's feature values and final score.
test('a recall logs its parameter set and 1 to 50 candidates, each with arms, confidence, kind, judge and score', { skip: SKIP }, async () => {
  sql(`update memory.entry set confidence = 0.95 where id = 'tea-oolong-temp'`)
  assert.equal((await recall('what temperature for oolong water', 'run:features-1')).status, 200)
  const [row] = sql(`select param_set, candidates, context from memory.retrieval where mcp_session = 'http-run:features-1'`)
  assert.match(row.param_set, /^(index|hybrid)\.v1$/)
  assert.equal(row.context.param_set, row.param_set)
  const logged = row.context.candidates
  assert.ok(logged.length >= 1 && logged.length <= 50, `${logged.length} candidates`)
  for (const c of logged) {
    assert.deepEqual(Object.keys(c).sort(), ['arms', 'confidence', 'id', 'judge', 'kind', 'score'])
    assert.ok(Object.keys(c.arms).length >= 1)
    for (const a of Object.values<any>(c.arms)) assert.ok(Number.isInteger(a.rank) && a.rank >= 1, JSON.stringify(c))
    assert.equal(c.kind, null)
    assert.equal(typeof c.score, 'number')
  }
  assert.deepEqual(logged.map((c: any) => [c.id, c.score]), row.candidates.map((c: any) => [c.id, c.score]), 'the final score is the one ranking used')
  const top = logged.find((c: any) => c.id === 'tea-oolong-temp')
  assert.equal(top.confidence, 0.95)
  assert.ok(logged.some((c: any) => c.judge === 0.9), 'the fake judge\'s probability is logged where the filter asked')
})

// R32 (#36): OpenAI tokens are metered by kind, and the write judge has a reserve.
test('OpenAI tokens are metered by kind: embed and judge_recall by a recall, judge_write by a write', { skip: SKIP }, async () => {
  sql('delete from memory.openai_usage')
  await onlyHybrid()
  assert.equal((await recall('a brand new question about gaiwan sizes')).status, 200)
  clearAllocation()
  const used = () => Object.fromEntries(sql(`select kind, tokens::int as tokens from memory.openai_usage where month = date_trunc('month', now())::date`).map((r) => [r.kind, r.tokens]))
  assert.ok(used().embed > 0 && used().judge_recall > 0, JSON.stringify(used()))
  assert.equal(used().judge_write, undefined)
  const rt = new Memory(memory.url, memory.runtimeToken)
  await rt.remember({ id: 'run-meter', pattern: 'projects', title: 'Run meter', body: 'The metering run.', authority: 'observed', scope: 'run:meter',
    evidence_kind: 'summary', evidence: 'Tier 3 made it.', source: { kind: 'run', title: 'clyde run meter', uri: 'clyde://runs/meter' } })
  assert.ok(used().judge_write > 0, JSON.stringify(used()))
  assert.deepEqual(sql(`select kind from memory.openai_usage where kind not in ('embed', 'judge_write', 'judge_recall', 'shadow', 'research')`), [])
})

const spend = (kind: string, tokens: number) => sql(`insert into memory.openai_usage (month, kind, tokens)
  values (date_trunc('month', now())::date, '${kind}', ${tokens}) on conflict (month, kind) do update set tokens = excluded.tokens`)

function writer(run: string) {
  const rt = new Memory(memory.url, memory.runtimeToken)
  const entry = (title: string) => ({
    pattern: 'observations', title, body: 'A body.', authority: 'observed', scope: `run:${run}`, evidence_kind: 'summary', evidence: 'Tier 3 made it.',
    project: `run-${run}`, source: { kind: 'run', title: `clyde run ${run}`, uri: `clyde://runs/${run}` },
  })
  return { rt, entry }
}

// R32 (#36): over the general cap, recall stays up degraded, and remember still screens from the reserve.
test('with the general cap spent, recall answers degraded and remember still works, with the judge called', { skip: SKIP }, async () => {
  const { rt, entry } = writer('cap1')
  await rt.remember({ id: 'run-cap1', pattern: 'projects', title: 'Run cap1', body: 'The cap run.', authority: 'observed', scope: 'run:cap1',
    evidence_kind: 'summary', evidence: 'Tier 3 made it.', source: { kind: 'run', title: 'clyde run cap1', uri: 'clyde://runs/cap1' } })
  sql('delete from memory.openai_usage')
  spend('embed', 1_000_000_000)
  try {
    const r = await recall('oolong water temperature over the cap')
    assert.equal(r.status, 200, r.text)
    assert.match(r.text, /^Degraded: .*OverBudget.*; results are .+\.$/m)
    const from = memory.openai.calls.length
    const { id } = await rt.remember(entry('Written over the general cap'))
    assert.ok(id)
    assert.ok(memory.openai.calls.slice(from).some((c) => c.path === '/decisions'), 'the judge screened the note')
    assert.equal(sql(`select title from memory.entry where id = '${id}'`).length, 1)
    assert.ok(sql(`select tokens::int as t from memory.openai_usage where kind = 'judge_write'`)[0].t > 0, 'the screening came out of the reserve')
  } finally {
    sql('delete from memory.openai_usage')
  }
})

test('with the write reserve spent, remember is refused with a clear message, and recall is unaffected', { skip: SKIP }, async () => {
  const { rt, entry } = writer('cap1')
  sql('delete from memory.openai_usage')
  spend('judge_write', 5_000_000)
  try {
    await assert.rejects(rt.remember(entry('Written over the reserve')),
      /memory refused the entry \(400\): memory won't take new notes this month: its reserve for screening writes is spent \(5000000 of 5000000 tokens\)\./)
    assert.deepEqual(sql(`select id from memory.entry where title = 'Written over the reserve'`), [])
    const r = await recall('oolong water temperature with the reserve spent')
    assert.equal(r.status, 200, r.text)
    assert.ok(!/^Degraded:/m.test(r.text), 'the reserve is the write judge\'s alone')
  } finally {
    sql('delete from memory.openai_usage')
  }
})

// R32 (#36): the eval runs any parameter set offline, and the default set gives today's numbers.
test('retrieval_eval.py --params runs a parameter set by id or from a file, and hybrid.v1 reports what no --params does', { skip: SKIP }, async () => {
  sql(`insert into memory.question (id, text, lang, qtype, split, origin) values
    ('q-temp', 'what temperature for oolong', 'en', 'lookup', 'train', 'tier3'), ('q-zh', '乌龙茶', 'zh', 'lookup', 'train', 'tier3')`)
  sql(`insert into memory.qrel (question_id, entry_id, grade) values ('q-temp', 'tea-oolong-temp', 2), ('q-temp', 'tea-oolong-old', -1), ('q-zh', 'tea-zh', 2)`)
  const script = join(import.meta.dirname, '..', '..', '..', 'memory', 'eval', 'retrieval_eval.py')
  const run = (...args: string[]) => {
    const r = spawnSync('python3', [script, '--arms', 'hybrid', ...args], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, MEMORY_URL: memory.url, MEMORY_ADMIN_TOKEN: memory.adminToken, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' },
    })
    return r
  }
  const report = (...args: string[]) => {
    const r = run('--json', ...args)
    assert.equal(r.status, 0, r.stderr || r.stdout)
    return JSON.parse(r.stdout).hybrid
  }
  const plain = report(), byId = report('--params', 'hybrid.v1')
  assert.equal(plain.gold_hit_rate, 1)
  assert.equal(byId.param_set, 'hybrid.v1')
  assert.deepEqual({ ...byId, param_set: undefined }, { ...plain, param_set: undefined }, 'the default set reproduces the numbers')
  // A file is a POST /param-sets body without the id. Here the packet shrinks to one item, so the knob reached the ranking.
  const file = join(tempDir('eval-params'), 'one-item.json')
  writeFileSync(file, JSON.stringify({ arm: 'hybrid', params: { packetItems: 1 } }))
  const one = report('--params', file)
  assert.ok(plain.per_query.some((q: any) => q.delivered.length > 1))
  assert.ok(one.per_query.every((q: any) => q.delivered.length === 1), JSON.stringify(one.per_query.map((q: any) => q.delivered)))
  assert.match(one.param_set, /one-item/)
  // The same set, made through the API, evaluates the same as the file did.
  json(await admin('POST', '/param-sets', { id: 'hybrid.one', parent: 'hybrid.v1', params: { packetItems: 1 } }), 201)
  assert.deepEqual(report('--params', 'hybrid.one').per_query, one.per_query)
  const text = run('--params', 'hybrid.v1')
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /^hybrid \(hybrid\.v1\): gold hit 100% of 2 answerable/m)
  const missing = run('--params', 'nope.v1')
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr + missing.stdout, /nope\.v1/)
})
