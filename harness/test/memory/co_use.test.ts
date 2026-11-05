/**
 * Tier 3: R43 (#47), memories used together get linked together, against the real memory function. When one recall's feedback
 * marks two or more entries used, the learner adds or strengthens a co_used link between each pair: +0.1 a co-use, capped at 1,
 * at most 6 pairs a recall. A link ranks only once 2 different sessions have co-used the pair, fades by 0.05 for every 200 recalls
 * on the clock that showed an end without the pair, and never by calendar time. Co-use across projects links the projects too.
 * Only a set that names co_used in its linkTypeWeights spreads along them: spreading.v6.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { request } from '../../src/request.ts'
import { SKIP, apply, sql, startRealMemory, type RealMemory } from './server.ts'

let memory: RealMemory

before(async () => {
  if (!SKIP) memory = await startRealMemory()
})

after(async () => {
  await memory?.close()
})

const MIGRATION = '20261104010000_co_use.sql'
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const admin = (method: string, path: string, body?: unknown) =>
  request(method, `${memory.url}/api/v1${path}`, { headers: bearer(memory.adminToken), body, timeoutMs: 30_000 })
const json = (r: { status: number; text: string }, status = 200) => {
  assert.equal(r.status, status, r.text)
  return JSON.parse(r.text)
}
const word = () => 'zq' + randomUUID().replaceAll('-', '').replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)]).slice(0, 12)
const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a])

function seed(id: string, title: string, o: { project?: string; pattern?: string } = {}) {
  sql(`insert into memory.entry (id, pattern, title, body, authority, scope, sensitivity, lang, valid_from, source_id, evidence_kind, evidence,
      evidence_sha256, project, kind, confidence, chances_left)
    values ('${id}', '${o.pattern ?? 'observations'}', '${title}', 'A short body.', 'observed', 'global', 'normal', 'en', '2026-11-01', 'src-a',
      'assistant', 'seen', 'x', ${o.project === null ? 'null' : `'${o.project ?? 'proj-tea'}'`}, 'wen', 0.80, 0)`)
}

/** The co_used link between a and b, in either order, with its weight and the sessions that co-used it, or undefined. */
function link(a: string, b: string) {
  const [src, dst] = pair(a, b)
  return sql(`select l.weight::float as weight, c.sessions, c.misses from memory.link l left join memory.co_use c using (src, dst, type)
    where l.src = '${src}' and l.dst = '${dst}' and l.type = 'co_used'`)[0]
}
const coUsedAmong = (ids: string[]) => Number(sql(`select count(*)::int as n from memory.link where type = 'co_used'
  and src = any(array[${ids.map((i) => `'${i}'`).join(',')}]) and dst = any(array[${ids.map((i) => `'${i}'`).join(',')}])`)[0].n)

async function mcp() {
  const init = await request('POST', `${memory.url}/mcp`, {
    headers: bearer(memory.token), timeoutMs: 15_000,
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } },
  })
  const session = String(init.headers['mcp-session-id'])
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await request('POST', `${memory.url}/mcp`, {
      headers: { ...bearer(memory.token), 'mcp-session-id': session }, timeoutMs: 60_000,
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
    })
    assert.equal(r.status, 200, r.text)
    return JSON.parse(r.text).result.content[0].text as string
  }
  return { session, tool }
}

async function serve(id: string) {
  const all = sql('select id from memory.param_set').map((r) => r.id as string)
  json(await admin('PUT', '/allocation', { rows: all.map((param_set) => param_set === id ? { param_set, role: 'default', weight: 1000 } : { param_set, role: 'off', weight: 0 }) }))
}

/** A new session recalls `query` and marks `used` used and every other delivered entry irrelevant. Gives the retrieval's
 * id and what it delivered. */
async function coUse(query: string, used: string[]) {
  const s = await mcp()
  const text = await s.tool('recall', { query })
  const id = /^retrieval (\S+)/.exec(text)![1]
  const delivered: string[] = sql(`select delivered from memory.retrieval where id = '${id}'`)[0].delivered
  for (const u of used) assert.ok(delivered.includes(u), `${u} was delivered: ${delivered.join()}`)
  const entries = delivered.map((entry_id) => ({ entry_id, verdict: used.includes(entry_id) ? 'used' : 'irrelevant' }))
  assert.equal(await s.tool('feedback', { retrieval_id: id, entries }), 'Logged.')
  return { id, delivered, session: s.session }
}

async function learnNow() {
  sql(`update memory.retrieval set created_at = created_at - interval '31 minutes' where learned_at is null`)
  sql(`update memory.event set received_at = received_at - interval '31 minutes'`)
  for (let pass = 0; pass < 50; pass++) {
    const done = json(await request('POST', `${memory.url}/learn`, { headers: bearer(memory.cronSecret), timeoutMs: 120_000 }))
    if (!done.learned && !done.failed) break
  }
}

/** spreading.v6 needs a v4, which only production has: make stand-ins for v2 and v4, then run the migrations that derive from them. */
async function v6() {
  if (!sql(`select 1 from memory.param_set where id = 'spreading.v2'`).length) {
    json(await admin('POST', '/param-sets', { id: 'spreading.v2', parent: 'spreading.v1', params: { otherRunFactor: 0.9 }, note: 'tier 3 stand-in for production\'s v2' }), 201)
  }
  apply('20261103020000_trials_feedback.sql')
  if (!sql(`select 1 from memory.param_set where id = 'spreading.v4'`).length) {
    json(await admin('POST', '/param-sets', { id: 'spreading.v4', parent: 'spreading.v3', params: { globalAgentDraftFactor: 0.9 }, note: 'tier 3 stand-in for production\'s v4' }), 201)
  }
  apply('20261103040000_spreading_bestfirst.sql')
  apply(MIGRATION)
}

async function rank(query: string, param_set: string): Promise<string[]> {
  return json(await admin('POST', '/eval/rank', { query, filter: false, param_set })).candidates
}

before(async () => {
  if (!SKIP) await serve('hybrid.v1')
})

test('R43: the migration makes spreading.v6 a child of spreading.v4 with co_used linkTypeWeight 1, and allocates nothing', { skip: SKIP }, async () => {
  const alloc = sql('select param_set, role, weight from memory.allocation order by param_set')
  await v6()
  apply(MIGRATION) // a second run changes nothing
  const [v4, set] = ['v4', 'v6'].map((v) => sql(`select arm, parent, params from memory.param_set where id = 'spreading.${v}'`)[0])
  assert.equal(set.arm, 'spreading')
  assert.equal(set.parent, 'spreading.v4')
  assert.equal(set.params.linkTypeWeights['*|co_used|*'], 1)
  assert.deepEqual({ ...set.params, linkTypeWeights: undefined }, { ...v4.params, linkTypeWeights: undefined })
  assert.deepEqual({ ...set.params.linkTypeWeights, '*|co_used|*': undefined }, { ...v4.params.linkTypeWeights, '*|co_used|*': undefined })
  assert.deepEqual(sql('select param_set, role, weight from memory.allocation order by param_set'), alloc)
  assert.equal(sql(`select count(*)::int as n from memory.allocation where param_set = 'spreading.v6'`)[0].n, 0)
  assert.equal(sql(`select count(*)::int as n from memory.param_set where params->'linkTypeWeights' ? '*|co_used|*' and id <> 'spreading.v6'`)[0].n, 0, 'no other set ranks by co-use')
})

test('R43: co-use: two used entries link', { skip: SKIP }, async () => {
  const w = word()
  const [a, b] = [`${w}-a`, `${w}-b`]
  seed(a, `${w} alpha`)
  seed(b, `${w} beta`)
  const first = await coUse(w, [a, b])
  await learnNow()
  assert.ok(Math.abs(link(a, b).weight - 0.1) < 1e-6, JSON.stringify(link(a, b)))
  assert.deepEqual(link(a, b).sessions, [first.session])
  const second = await coUse(w, [a, b])
  await learnNow()
  assert.ok(Math.abs(link(a, b).weight - 0.2) < 1e-6, JSON.stringify(link(a, b)))
  assert.deepEqual([...link(a, b).sessions].sort(), [first.session, second.session].sort())
  const [src, dst] = pair(a, b)
  assert.equal(sql(`select count(*)::int as n from memory.confidence_log where target = 'link:${src}|co_used|${dst}'`)[0].n, 2)
})

test('R43: co-use: delivery alone links nothing', { skip: SKIP }, async () => {
  const w = word()
  const [a, b] = [`${w}-a`, `${w}-b`]
  seed(a, `${w} alpha`)
  seed(b, `${w} beta`)
  const r = await coUse(w, [a])
  assert.ok(r.delivered.includes(b))
  await learnNow()
  assert.equal(link(a, b), undefined)
})

test('R43: co-use: at most 6 pairs per recall', { skip: SKIP }, async () => {
  const w = word()
  const ids = Array.from({ length: 10 }, (_, i) => `${w}-${String(i).padStart(2, '0')}`)
  for (const id of ids) seed(id, `${w} item ${id.slice(-2)}`)
  // The packet holds 8 of the 10, and a deep recall the other 2, so one recall's feedback can mark all 10 used.
  const s = await mcp()
  const text = await s.tool('recall', { query: w, depth: 'deep' })
  const id = /^retrieval (\S+)/.exec(text)![1]
  const delivered: string[] = sql(`select delivered from memory.retrieval where id = '${id}'`)[0].delivered
  assert.equal(delivered.length, 10)
  assert.equal(await s.tool('feedback', { retrieval_id: id, entries: delivered.map((entry_id) => ({ entry_id, verdict: 'used' })) }), 'Logged.')
  await learnNow()
  assert.equal(sql(`select count(*)::int as n from memory.confidence_log where retrieval_id = '${id}' and target like 'link:%|co_used|%'`)[0].n, 6)
  assert.equal(coUsedAmong(ids), 6)
  const top = delivered.slice(0, 4)
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) assert.ok(link(top[i], top[j]), `${top[i]} with ${top[j]}: the top-ranked used entries`)
})

test('R43: co-use: a link counts for ranking only after co-use in 2 different sessions', { skip: SKIP }, async () => {
  await v6()
  const w = word(), u = word()
  const [a, b] = [`${w}-a`, `${w}-b`]
  // The query w matches A alone. B is reachable only along the co_used link, which a recall for u builds.
  seed(a, `${w} ${u} alpha`)
  seed(b, `${u} beta`)
  assert.equal((await rank(w, 'spreading.v6')).includes(b), false)
  await coUse(u, [a, b])
  await learnNow()
  assert.ok(link(a, b))
  assert.equal((await rank(w, 'spreading.v6')).includes(b), false, 'one session: the link counts 0')
  await coUse(u, [a, b])
  await learnNow()
  assert.ok((await rank(w, 'spreading.v6')).includes(b), 'two sessions: the link spreads')
  assert.equal((await rank(w, 'spreading.v3')).includes(b), false, 'a set that names no co_used weight never spreads along one')
})

test('R43: co-use: fades by recalls, not time', { skip: SKIP }, async () => {
  const w = word()
  const [a, b] = [`${w}-a`, `${w}-b`]
  seed(a, `${w} alpha`)
  seed(b, `${w} beta`)
  await coUse(w, [a, b])
  await coUse(w, [a, b])
  await learnNow()
  assert.ok(Math.abs(link(a, b).weight - 0.2) < 1e-6)
  // A year passes with no recall: nothing moves.
  sql(`update memory.co_use set updated_at = updated_at - interval '365 days'`)
  await learnNow()
  assert.ok(Math.abs(link(a, b).weight - 0.2) < 1e-6, 'calendar time alone fades nothing')
  // 199 recalls on the clock that show A without B: still 0.2. The 200th fades it by 0.05.
  const session = sql(`select id from memory.mcp_session limit 1`)[0].id
  const shown = (n: number) => sql(`insert into memory.retrieval (id, mcp_session, arm, query, delivered, seq, created_at)
    select gen_random_uuid(), '${session}', 'hybrid', 'tier 3 clock', '["${a}"]'::jsonb, nextval('memory.retrieval_seq'), now() - interval '1 hour'
    from generate_series(1, ${n})`)
  shown(199)
  // A recall off the clock (degraded, no seq) doesn't count.
  sql(`insert into memory.retrieval (id, mcp_session, arm, query, delivered, created_at, degraded)
    values (gen_random_uuid(), '${session}', 'hybrid', 'tier 3 off the clock', '["${a}"]'::jsonb, now() - interval '1 hour', 'embed-failed: Error')`)
  await learnNow()
  assert.ok(Math.abs(link(a, b).weight - 0.2) < 1e-6, JSON.stringify(link(a, b)))
  shown(1)
  await learnNow()
  assert.ok(link(a, b).weight <= 0.15 + 1e-6, JSON.stringify(link(a, b)))
})

test('R43: co-use across projects strengthens a project-level co_used link', { skip: SKIP }, async () => {
  const w = word()
  const [p1, p2, a, b] = [`${w}-p1`, `${w}-p2`, `${w}-a`, `${w}-b`]
  seed(p1, 'Project one', { pattern: 'projects', project: null })
  seed(p2, 'Project two', { pattern: 'projects', project: null })
  seed(a, `${w} alpha`, { project: p1 })
  seed(b, `${w} beta`, { project: p2 })
  await coUse(w, [a, b])
  await coUse(w, [a, b])
  await learnNow()
  assert.ok(link(p1, p2)?.weight > 0, JSON.stringify(link(p1, p2)))
  assert.equal(link(p1, p2).sessions.length, 2)
})

test('R43: q24, a gold pair co-used twice ranks higher on spreading.v6 than on spreading.v3', { skip: SKIP }, async () => {
  await v6()
  const u = word()
  const query = 'recommend a hosted video API for me'
  const [video, pay] = [`${u}-video`, `${u}-payg`]
  seed(video, `${u} hosted video API with per-second billing`)
  seed(pay, `${u} Wen prefers pay-as-you-go plans over subscriptions`)
  await coUse(u, [video, pay])
  await coUse(u, [video, pay])
  await learnNow()
  const at = (list: string[]) => (list.includes(pay) ? list.indexOf(pay) : Infinity)
  const onV6 = at(await rank(query, 'spreading.v6')), onV3 = at(await rank(query, 'spreading.v3'))
  assert.ok(onV6 < onV3, `pay-as-you-go ranks ${onV6} on v6 and ${onV3} on v3`)
})
