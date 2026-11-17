/**
 * Tier 3: trials and per-entry feedback (R28 #32, R33 #37), against the real memory function. A set with trialItems above 0
 * serves two lists, the settled main list and "On trial", and each showing on trial spends a chance. The feedback tool takes a
 * verdict per entry, and the learner moves confidence by one step() per entry per recall. The pure parts are in learn_test.ts.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { request } from '../../src/request.ts'
import { FAKE_DOWN, FAKE_IRRELEVANT, FAKE_PUSHBACK } from './openai.ts'
import { SKIP, apply, sql, startRealMemory, type RealMemory } from './server.ts'

let memory: RealMemory

before(async () => {
  if (!SKIP) memory = await startRealMemory()
})

after(async () => {
  await memory?.close()
})

const MIGRATION = '20261103020000_trials_feedback.sql'
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const admin = (method: string, path: string, body?: unknown) =>
  request(method, `${memory.url}/api/v1${path}`, { headers: bearer(memory.adminToken), body, timeoutMs: 30_000 })
const nonce = () => randomUUID().replaceAll('-', '').slice(0, 8)
const word = () => 'zq' + randomUUID().replaceAll('-', '').replace(/[0-9]/g, '').slice(0, 10)
const json = (r: { status: number; text: string }, status = 200) => {
  assert.equal(r.status, status, r.text)
  return JSON.parse(r.text)
}

/** An MCP session as `client`. tool() gives the text of one call, raw() the whole JSON-RPC answer. */
async function mcp(token = memory.token, client = 'claude-code') {
  const init = await request('POST', `${memory.url}/mcp`, {
    headers: bearer(token), timeoutMs: 15_000,
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: client } } },
  })
  assert.equal(init.status, 200, init.text)
  const session = String(init.headers['mcp-session-id'])
  const raw = async (name: string, args: Record<string, unknown>, headers: Record<string, string> = { 'mcp-session-id': session }) => {
    const r = await request('POST', `${memory.url}/mcp`, {
      headers: { ...bearer(token), ...headers }, timeoutMs: 30_000,
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
    })
    assert.equal(r.status, 200, r.text)
    return JSON.parse(r.text)
  }
  const tool = async (name: string, args: Record<string, unknown>) => (await raw(name, args)).result.content[0].text as string
  return { session, raw, tool, init: JSON.parse(init.text).result, rpc: async (method: string, params: unknown) =>
    JSON.parse((await request('POST', `${memory.url}/mcp`, { headers: { ...bearer(token), 'mcp-session-id': session }, timeoutMs: 15_000, body: { jsonrpc: '2.0', id: 3, method, params } })).text) }
}

/** Seeds one entry by SQL, the way the criteria say a trial entry is made. */
function seed(id: string, o: { title?: string; body?: string; kind?: string; confidence?: number; chances?: number; scope?: string } = {}) {
  const title = o.title ?? id
  sql(`insert into memory.entry (id, pattern, title, body, authority, scope, sensitivity, lang, valid_from, source_id, evidence_kind, evidence,
      evidence_sha256, project, kind, confidence, chances_left)
    values ('${id}', 'observations', '${title}', '${o.body ?? title}', 'observed', '${o.scope ?? 'global'}', 'normal', 'en', '2026-11-01', 'src-a',
      'assistant', 'seen', 'x', 'proj-tea', '${o.kind ?? 'observation'}', ${o.confidence ?? 0.5}, ${o.chances ?? 3})`)
}
const entry = (id: string) => sql(`select kind, confidence::float as confidence, chances_left from memory.entry where id = '${id}'`)[0]
const rid = (text: string) => /^retrieval ([0-9a-f-]{36})/.exec(text)![1]
const lines = (text: string) => text.split('\n')
/** The packet split at its "On trial" line: what is above it and what is below. */
function lists(text: string) {
  const at = lines(text).indexOf('On trial')
  const all = lines(text)
  return { main: at < 0 ? text : all.slice(0, at).join('\n'), trial: at < 0 ? '' : all.slice(at).join('\n'), has: at >= 0 }
}
const count = (text: string, id: string) => text.split(id).length - 1

/** The entries now served: hybrid.v3, a child of a v2 that this test database makes, since the v2 sets only exist in production. */
async function serveV3() {
  for (const arm of ['hybrid', 'spreading']) {
    if (!sql(`select 1 from memory.param_set where id = '${arm}.v2'`).length) {
      json(await admin('POST', '/param-sets', { id: `${arm}.v2`, parent: `${arm}.v1`, params: { otherRunFactor: 0.9 }, note: 'tier 3 stand-in for production\'s v2' }), 201)
    }
  }
  apply(MIGRATION)
  await allocate('hybrid.v3')
}
async function allocate(serve: string) {
  const rows = ['index.v1', 'hybrid.v1', 'spreading.v1', 'hybrid.v3', 'spreading.v3', 'hybrid.v2', 'spreading.v2']
    .filter((id) => sql(`select 1 from memory.param_set where id = '${id}'`).length)
    .map((param_set) => param_set === serve ? { param_set, role: 'default', weight: 1000 } : { param_set, role: 'off', weight: 0 })
  json(await admin('PUT', '/allocation', { rows, by: 'wen' }))
}

/** Makes every unlearned recall old enough for the learner to settle without Wen's next prompt, then runs it. */
async function learnNow() {
  sql(`update memory.retrieval set created_at = created_at - interval '31 minutes' where learned_at is null`)
  sql(`update memory.event set received_at = received_at - interval '31 minutes'`)
  // 40 recalls a pass, oldest first, and earlier tests left some, so go on until a pass learns nothing.
  const total = { learned: 0, failed: 0 }
  for (let pass = 0; pass < 50; pass++) {
    const done = json(await request('POST', `${memory.url}/learn`, { headers: bearer(memory.cronSecret), timeoutMs: 120_000 }))
    total.learned += done.learned
    total.failed += done.failed
    if (!done.learned && !done.failed) break
  }
  return total
}

// ---------------------------------------------------------------------------------------------------- R28: two lists
test('R28: the migration makes hybrid.v3 and spreading.v3 children of the v2 sets with trialItems 3, allocates nothing, and leaves v1 and v2 alone', { skip: SKIP }, async () => {
  await serveV3()
  const v3 = Object.fromEntries(sql(`select id, parent, params from memory.param_set where id like '%.v3'`).map((r) => [r.id, r]))
  assert.deepEqual(Object.keys(v3).sort(), ['hybrid.v3', 'spreading.v3'])
  for (const arm of ['hybrid', 'spreading']) {
    const v2 = sql(`select params from memory.param_set where id = '${arm}.v2'`)[0].params
    const child = v3[`${arm}.v3`]
    assert.equal(child.parent, `${arm}.v2`)
    assert.equal(child.params.trialItems, 3)
    assert.equal(typeof child.params.trialFloor, 'number')
    assert.equal(child.params.trialStep, 0.12)
    assert.equal(child.params.settledStep, 0.02)
    assert.deepEqual({ ...child.params, trialItems: undefined, trialFloor: undefined, trialStep: undefined, settledStep: undefined },
      { ...v2, trialItems: undefined, trialFloor: undefined, trialStep: undefined, settledStep: undefined }, 'everything else is the parent\'s')
    assert.equal(v2.trialItems, undefined, 'v2 is not edited')
  }
  for (const id of ['index.v1', 'hybrid.v1', 'spreading.v1']) assert.equal(sql(`select params->'trialItems' as t from memory.param_set where id = '${id}'`)[0].t, null)
  assert.equal(sql(`select count(*)::int as n from memory.allocation where param_set like '%.v3' and role <> 'off'`)[0].n, 1, 'only the one this test serves')
  const again = sql(`select count(*)::int as n from memory.param_set`)[0].n
  apply(MIGRATION)
  assert.equal(sql(`select count(*)::int as n from memory.param_set`)[0].n, again, 'the migration reruns safely')
})

test('R28: a new observation shows at once under "On trial", labelled new, and spends one chance', { skip: SKIP }, async () => {
  await serveV3()
  const w = word()
  const { tool } = await mcp()
  const title = `Heard ${w} on a call`
  const made = await tool('remember', { pattern: 'observations', title, body: `${w} was mentioned.`, evidence: 'the call' })
  const id = /^Remembered (\S+?)\./.exec(made)![1]
  const text = await tool('recall', { query: title })
  const { main, trial, has } = lists(text)
  assert.ok(has, text)
  assert.equal(count(main, id), 0)
  assert.equal(count(trial, id), 1)
  assert.match(trial, /new · observation · 0\.50 · chance 1 of 3/)
  assert.deepEqual(entry(id), { kind: 'observation', confidence: 0.5, chances_left: 2 })
  const [r] = sql(`select on_trial, delivered, context from memory.retrieval where id = '${rid(text)}'`)
  assert.deepEqual(r.on_trial, [id])
  assert.deepEqual(r.context.trial, [{ id, chance: 1 }], 'the spend is in context')
})

test('R28: settled entries fill the main list and the top 3 trial entries the On trial list', { skip: SKIP }, async () => {
  await serveV3()
  const w = word()
  for (let i = 0; i < 10; i++) seed(`${w}-s${i}`, { title: `${w} settled note ${i}`, kind: 'wen', confidence: 0.8, chances: 0 })
  for (let i = 0; i < 5; i++) seed(`${w}-t${i}`, { title: `${w} trial note ${i}`, chances: 3 })
  const { tool } = await mcp()
  const text = await tool('recall', { query: w })
  const { main, trial } = lists(text)
  const inMain = [...main.matchAll(/^\[\d+\] (\S+):/gm)].map((m) => m[1])
  const inTrial = [...trial.matchAll(/^\[T\d+\] (\S+):/gm)].map((m) => m[1])
  assert.equal(inMain.length, 8, main)
  assert.ok(inMain.every((id) => id.startsWith(`${w}-s`)), 'only settled entries above the line')
  assert.equal(inTrial.length, 3, trial)
  const [r] = sql(`select candidates from memory.retrieval where id = '${rid(text)}'`)
  const best = r.candidates.map((c: any) => c.id).filter((id: string) => id.startsWith(`${w}-t`)).slice(0, 3)
  assert.deepEqual(inTrial, best, 'the three best-ranked trial entries, in rank order')
  assert.equal(sql(`select sum(chances_left)::int as n from memory.entry where id like '${w}-t%'`)[0].n, 12, '15 chances less the 3 spent')
})

test('R28: a verified fact is settled and shows in the main list on its first recall', { skip: SKIP }, async () => {
  await serveV3()
  const w = word()
  seed(`${w}-fact`, { title: `${w} resolves to an address`, kind: 'fact', confidence: 0.9, chances: 0 })
  const { tool } = await mcp()
  const { main, trial } = lists(await tool('recall', { query: `${w} resolves` }))
  assert.equal(count(main, `${w}-fact`), 1)
  assert.equal(count(trial, `${w}-fact`), 0)
  assert.equal(entry(`${w}-fact`).chances_left, 0)
})

test('R28: no On trial section when nothing is on trial, and On trial alone is not "nothing matches"', { skip: SKIP }, async () => {
  await serveV3()
  const a = word(), b = word()
  seed(`${a}-s`, { title: `${a} settled`, kind: 'wen', confidence: 0.8, chances: 0 })
  seed(`${b}-t1`, { title: `${b} fresh one` })
  seed(`${b}-t2`, { title: `${b} fresh two` })
  const { tool } = await mcp()
  const settledOnly = await tool('recall', { query: `${a} settled` })
  assert.equal(count(settledOnly, 'On trial'), 0)
  assert.equal(count(settledOnly, `${a}-s`), 1)
  const trialOnly = await tool('recall', { query: `${b} fresh` })
  assert.equal(count(trialOnly, '[T1]') + count(trialOnly, '[T2]'), 2)
  assert.equal(count(trialOnly, 'Nothing in memory matches'), 0)
})

test('R28: each showing spends exactly one chance, 3 to 0, and the fourth recall finds it in the main list', { skip: SKIP }, async () => {
  await serveV3()
  const w = word()
  seed(`${w}-x`, { title: `${w} lone trial` })
  seed(`${w}-y`, { title: `${w} other trial` })
  const { tool } = await mcp()
  for (const left of [2, 1, 0]) {
    const { trial } = lists(await tool('recall', { query: `${w} lone trial` }))
    assert.equal(count(trial, `${w}-x`), 1)
    assert.equal(entry(`${w}-x`).chances_left, left)
  }
  const fourth = lists(await tool('recall', { query: `${w} lone trial` }))
  assert.equal(count(fourth.main, `${w}-x`), 1, 'graduated into the main list')
  assert.equal(count(fourth.trial, `${w}-x`), 0)
  assert.equal(entry(`${w}-x`).chances_left, 0)
})

test('R28: 5 concurrent recalls spend a trial entry\'s 3 chances exactly, and chances_left stays between 0 and 3', { skip: SKIP }, async () => {
  await serveV3()
  const w = word()
  seed(`${w}-c`, { title: `${w} contended` })
  const sessions = await Promise.all([1, 2, 3, 4, 5].map(() => mcp()))
  const packets = await Promise.all(sessions.map((s) => s.tool('recall', { query: `${w} contended` })))
  const shown = packets.filter((p) => count(lists(p).trial, `${w}-c`) === 1).length
  assert.equal(shown, 3)
  assert.equal(entry(`${w}-c`).chances_left, 0)
  for (const bad of [-1, 4]) {
    assert.throws(() => sql(`update memory.entry set chances_left = ${bad} where id = '${w}-c'`), /23514|check/)
  }
})

test('R28: a dormant entry is in neither list, and a set without trialItems serves everything in one list and spends nothing', { skip: SKIP }, async () => {
  await serveV3()
  const w = word()
  seed(`${w}-d`, { title: `${w} dormant`, confidence: 0.1 })
  seed(`${w}-t`, { title: `${w} dormant sibling` })
  const { tool } = await mcp()
  const v3 = await tool('recall', { query: `${w} dormant` })
  assert.equal(count(v3, `${w}-d`), 0)
  assert.equal(count(v3, `${w}-t`), 1)
  await allocate('hybrid.v1')
  const v1 = lists(await (await mcp(memory.token, 'codex')).tool('recall', { query: `${w} dormant` }))
  assert.equal(v1.has, false, 'v1 has no trial lane')
  assert.equal(count(v1.main, `${w}-t`), 1)
  assert.equal(entry(`${w}-t`).chances_left, 2, 'the v1 recall spent nothing')
  await allocate('hybrid.v3')
})

test('R28: a scoped recall, an HTTP recall and the admin preview show no On trial list and spend no chance', { skip: SKIP }, async () => {
  await serveV3()
  const w = word()
  seed(`${w}-p`, { title: `${w} guarded trial` })
  const { tool } = await mcp()
  const scoped = await tool('recall', { query: `${w} guarded`, scope: 'run:trials-1' })
  assert.equal(lists(scoped).has, false)
  assert.equal(count(scoped, `${w}-p`), 1, 'a scoped recall serves it in the main list')
  const http = await request('POST', `${memory.url}/recall`, { headers: bearer(memory.token), body: { query: `${w} guarded` }, timeoutMs: 30_000 })
  assert.equal(http.status, 200, http.text)
  assert.equal(count(http.text, 'On trial'), 0)
  assert.equal(count(http.text, 'feedback('), 0, 'an HTTP packet has no footer')
  const before = sql('select count(*)::int as n from memory.retrieval')[0].n
  for (let i = 0; i < 3; i++) json(await admin('POST', '/recall/preview', { query: `${w} guarded`, param_sets: ['hybrid.v3'] }))
  assert.equal(sql('select count(*)::int as n from memory.retrieval')[0].n, before)
  assert.equal(entry(`${w}-p`).chances_left, 3)
})

test('R28: a trial entry the judge cuts is not shown and keeps its chances; a degraded recall shows no trial', { skip: SKIP }, async () => {
  await serveV3()
  const w = word()
  seed(`${w}-cut`, { title: `${w} cut`, body: `${w} cut ${FAKE_IRRELEVANT}` })
  seed(`${w}-ok`, { title: `${w} kept` })
  const { tool } = await mcp()
  for (let i = 0; i < 3; i++) assert.equal(count(await tool('recall', { query: `${w} cut kept` }), `${w}-cut`), 0)
  assert.equal(entry(`${w}-cut`).chances_left, 3)
  const before = entry(`${w}-ok`).chances_left
  assert.equal(before, 0, 'three healthy recalls spent its three')
  seed(`${w}-ok2`, { title: `${w} kept again` })
  const down = await tool('recall', { query: `${w} kept ${FAKE_DOWN}` })
  assert.match(down, /Degraded:/)
  assert.equal(lists(down).has, false)
  assert.equal(entry(`${w}-ok2`).chances_left, 3, 'a degraded recall cannot judge relevance, so it shows no trial and spends nothing')
})

test('R28: a failed recall spends no chance', { skip: SKIP }, async () => {
  await serveV3()
  const w = word()
  seed(`${w}-f`, { title: `${w} fragile` })
  sql(`create or replace function memory.fail_retrieval() returns trigger language plpgsql as $$ begin raise exception 'tier 3 refuses'; end $$`)
  sql(`create trigger fail_retrieval before insert on memory.retrieval for each row execute function memory.fail_retrieval()`)
  try {
    const { raw } = await mcp()
    const r = await raw('recall', { query: `${w} fragile` })
    assert.equal(r.result.isError, true)
  } finally {
    sql('drop trigger fail_retrieval on memory.retrieval')
  }
  assert.equal(entry(`${w}-f`).chances_left, 3)
})

test('R28: the retrieval row keeps the On trial ids apart from delivered', { skip: SKIP }, async () => {
  await serveV3()
  const w = word()
  seed(`${w}-m1`, { title: `${w} main one`, kind: 'wen', confidence: 0.8, chances: 0 })
  seed(`${w}-m2`, { title: `${w} main two`, kind: 'wen', confidence: 0.8, chances: 0 })
  seed(`${w}-n1`, { title: `${w} trial one` })
  seed(`${w}-n2`, { title: `${w} trial two` })
  const { tool } = await mcp()
  const text = await tool('recall', { query: w })
  const [r] = sql(`select on_trial, delivered,
      (select count(*)::int from jsonb_array_elements_text(delivered) d where d in (select jsonb_array_elements_text(on_trial))) as overlap
    from memory.retrieval where id = '${rid(text)}'`)
  assert.deepEqual([...r.on_trial].sort(), [`${w}-n1`, `${w}-n2`])
  assert.deepEqual([...r.delivered].sort(), [`${w}-m1`, `${w}-m2`])
  assert.equal(r.overlap, 0)
})

test('R28: each On trial item renders in at most 400 characters', { skip: SKIP }, async () => {
  await serveV3()
  const w = word()
  for (let i = 0; i < 3; i++) seed(`${w}-l${i}`, { title: `${w} long ${i}`, body: `${w} long ${'padding '.repeat(500)}` })
  const { tool } = await mcp()
  const { trial: withFooter } = lists(await tool('recall', { query: `${w} long` }))
  const trial = withFooter.split('\nAfter using these')[0]
  const items = trial.split(/\n(?=\[T\d\])/).filter((part) => part.startsWith('[T')).map((part) => part.trim())
  assert.equal(items.length, 3)
  for (const item of items) assert.ok(item.length <= 400, String(item.length))
})

// ---------------------------------------------------------------------------------------------------- R33: the call
test('R33: tools/list feedback takes retrieval_id, entries and nothing_useful, and keeps the legacy properties', { skip: SKIP }, async () => {
  const { rpc } = await mcp()
  const fb = (await rpc('tools/list', {})).result.tools.find((t: any) => t.name === 'feedback')
  assert.deepEqual(fb.inputSchema.required, ['retrieval_id'])
  const props = fb.inputSchema.properties
  for (const p of ['entries', 'items', 'nothing_useful', 'verdict', 'entry_id', 'note']) assert.ok(p in props, p)
  assert.equal(props.entries.type, 'array')
  assert.deepEqual(props.entries.items.required, ['entry_id', 'verdict'])
  assert.deepEqual(props.entries.items.properties.verdict.enum, ['used', 'irrelevant', 'wrong'])
  assert.equal(props.nothing_useful.type, 'boolean')
})

// R53 (#58) moved "after every recall" into the plugin's skill. The server's text still names feedback and what it takes.
test('R33: server instructions and the recall description name feedback and the retrieval id it takes', { skip: SKIP }, async () => {
  const { init, rpc } = await mcp()
  assert.match(init.instructions, /feedback takes the same id/i)
  const recall = (await rpc('tools/list', {})).result.tools.find((t: any) => t.name === 'recall')
  assert.match(recall.description, /feedback/i)
  assert.match(recall.description, /retrieval id/i)
})

/** A session that has made a recall delivering `n` settled entries, ready for feedback. */
async function delivered(n = 3, client = 'claude-code') {
  await serveV3()
  const w = word()
  const ids = Array.from({ length: n }, (_, i) => `${w}-d${i}`)
  ids.forEach((id, i) => seed(id, { title: `${w} entry ${i}`, kind: 'wen', confidence: 0.8, chances: 0 }))
  const s = await mcp(memory.token, client)
  const text = await s.tool('recall', { query: `${w} entry` })
  return { ...s, w, ids, text, rid: rid(text) }
}
const fbRows = (r: string) => sql(`select entry_id, verdict, source, note from memory.feedback where retrieval_id = '${r}' order by id`)

test('R33: one feedback call logs a verdict per delivered entry, and nothing_useful logs one packet-level row', { skip: SKIP }, async () => {
  const a = await delivered(3)
  const verdicts = ['used', 'irrelevant', 'wrong']
  const reply = await a.tool('feedback', { retrieval_id: a.rid, entries: a.ids.map((entry_id, i) => ({ entry_id, verdict: verdicts[i] })) })
  assert.match(lines(reply)[0], /^Logged/)
  assert.deepEqual(fbRows(a.rid).map((r) => [r.entry_id, r.verdict, r.source]), a.ids.map((id, i) => [id, verdicts[i], 'agent']))
  const b = await delivered(2)
  assert.match(lines(await b.tool('feedback', { retrieval_id: b.rid, nothing_useful: true }))[0], /^Logged/)
  assert.deepEqual(fbRows(b.rid).map((r) => [r.entry_id, r.verdict, r.source]), [[null, 'nothing_useful', 'agent']])
  const c = await delivered(2)
  await c.tool('feedback', { retrieval_id: c.rid, items: [{ entry_id: c.ids[0], verdict: 'used' }], verdict: 'helpful', note: 'ok' })
  assert.deepEqual(fbRows(c.rid).map((r) => [r.entry_id, r.verdict]), [[c.ids[0], 'used'], [null, 'helpful']], 'items is an alias, with an overall verdict beside it')
})

test('R33: an empty call, a bad item, an undelivered entry and a contradiction are refused and write nothing', { skip: SKIP }, async () => {
  const a = await delivered(3)
  const [x, y] = a.ids
  const refuse = async (args: Record<string, unknown>, match: RegExp) => {
    const t = await a.tool('feedback', { retrieval_id: a.rid, ...args })
    assert.match(t, match)
    assert.match(t, /^Not logged/)
  }
  await refuse({}, /give entries or nothing_useful/)
  await refuse({ entries: [] }, /give entries or nothing_useful/)
  await refuse({ nothing_useful: true, entries: [{ entry_id: x, verdict: 'wrong' }] }, /nothing_useful/)
  await refuse({ entries: [{ entry_id: x, verdict: 'used' }, { entry_id: y, verdict: 'great' }] }, /great/)
  await refuse({ entries: [{ entry_id: x, verdict: 'used' }, { entry_id: 'not-in-this-recall', verdict: 'wrong' }] }, /not-in-this-recall/)
  await refuse({ entries: [{ entry_id: x, verdict: 'used' }, { entry_id: x, verdict: 'wrong' }] }, new RegExp(x))
  await refuse({ entries: Array.from({ length: 10_000 }, () => ({ entry_id: x, verdict: 'used' })) }, /Not logged/)
  await refuse({ verdict: 'great' }, /verdict must be helpful, used, irrelevant, wrong or nothing_useful/)
  assert.equal(fbRows(a.rid).length, 0)
  assert.match(await a.tool('feedback', { retrieval_id: a.rid, entries: [{ entry_id: x, verdict: 'used' }, { entry_id: y, verdict: 'wrong' }] }), /^Logged/, 'a subset is fine')
  assert.equal(fbRows(a.rid).length, 2)
})

test('R33: a repeat on one retrieval, an unknown retrieval and another session are refused', { skip: SKIP }, async () => {
  const a = await delivered(2)
  const other = await mcp()
  const args = { retrieval_id: a.rid, entries: [{ entry_id: a.ids[0], verdict: 'used' }] }
  assert.equal(await other.tool('feedback', args), `No retrieval ${a.rid}.`)
  const bare = await other.raw('feedback', args, {})
  assert.equal(bare.result.content[0].text, `No retrieval ${a.rid}.`)
  assert.equal(fbRows(a.rid).length, 0, 'neither another session nor a header-less call wrote')
  assert.match(await a.tool('feedback', args), /^Logged/)
  assert.equal(await a.tool('feedback', args), `Already logged for ${a.rid}.`)
  assert.equal(await a.tool('feedback', { retrieval_id: a.rid, nothing_useful: true }), `Already logged for ${a.rid}.`)
  assert.equal(await a.tool('feedback', { retrieval_id: a.rid, verdict: 'wrong' }), `Already logged for ${a.rid}.`)
  assert.equal(fbRows(a.rid).length, 1)
  const none = '00000000-0000-4000-8000-000000000000'
  const total = sql('select count(*)::int as n from memory.feedback')[0].n
  assert.equal(await a.tool('feedback', { retrieval_id: none, entries: [{ entry_id: a.ids[0], verdict: 'used' }] }), `No retrieval ${none}.`)
  assert.equal(await a.tool('feedback', { retrieval_id: 'not-a-uuid', entries: [{ entry_id: a.ids[0], verdict: 'used' }] }), 'No retrieval not-a-uuid.')
  assert.equal(sql('select count(*)::int as n from memory.feedback')[0].n, total)
})

test('R33: the legacy single-verdict call still logs, and the console route states the new verdict set', { skip: SKIP }, async () => {
  const a = await delivered(2), b = await delivered(2)
  assert.equal(lines(await a.tool('feedback', { retrieval_id: a.rid, verdict: 'helpful' }))[0], 'Logged.')
  assert.deepEqual(fbRows(a.rid).map((r) => [r.entry_id, r.verdict]), [[null, 'helpful']])
  assert.equal(lines(await b.tool('feedback', { retrieval_id: b.rid, verdict: 'wrong', entry_id: b.ids[0] }))[0], 'Logged.')
  assert.deepEqual(fbRows(b.rid).map((r) => [r.entry_id, r.verdict]), [[b.ids[0], 'wrong']])
  const msg = 'Not logged: verdict must be helpful, used, irrelevant, wrong or nothing_useful.'
  const c = await delivered(2)
  assert.equal((await admin('POST', '/feedback', { retrieval_id: c.rid, verdict: 'helpful' })).status, 201)
  const bad = await admin('POST', '/feedback', { retrieval_id: c.rid, verdict: 'great' })
  assert.equal(bad.status, 422)
  assert.equal(JSON.parse(bad.text).error, msg)
  assert.equal(readFileSync(join(import.meta.dirname, '../../../memory/API.md'), 'utf8').split(msg).length - 1, 1)
  // Wen's row doesn't count as the agent's feedback.
  assert.match(await c.tool('feedback', { retrieval_id: c.rid, nothing_useful: true }), /^Logged/)
})

test('R33: a feedback note is stored redacted and capped at 4,000 characters, and feedback sends nothing to OpenAI', { skip: SKIP }, async () => {
  const a = await delivered(2), b = await delivered(2), c = await delivered(2)
  const key = 'sk-proj-' + randomUUID().replaceAll('-', '').repeat(2).slice(0, 40)
  const calls = memory.openai.calls.length
  await a.tool('feedback', { retrieval_id: a.rid, entries: [{ entry_id: a.ids[0], verdict: 'used' }], note: `key ${key}` })
  assert.equal(memory.openai.calls.length, calls, 'no judge or embedding request')
  assert.equal(count(fbRows(a.rid)[0].note, key.slice(8)), 0)
  assert.match(await b.tool('feedback', { retrieval_id: b.rid, nothing_useful: true, note: 'n'.repeat(4000) }), /^Logged/)
  assert.equal(fbRows(b.rid)[0].note.length, 4000)
  const long = await c.tool('feedback', { retrieval_id: c.rid, nothing_useful: true, note: 'n'.repeat(4001) })
  assert.match(long, /^Not logged:.*note/)
  assert.equal(fbRows(c.rid).length, 0)
})

test('R33: the verdict check takes used and nothing_useful, refuses others, and feedback has a retrieval_id index', { skip: SKIP }, async () => {
  const a = await delivered(1)
  for (const v of ['used', 'nothing_useful', 'helpful']) sql(`insert into memory.feedback (retrieval_id, source, verdict) values ('${a.rid}', 'wen', '${v}')`)
  assert.throws(() => sql(`insert into memory.feedback (retrieval_id, source, verdict) values ('${a.rid}', 'wen', 'great')`), /23514|check/)
  assert.equal(sql(`select count(*)::int as n from pg_indexes where schemaname = 'memory' and tablename = 'feedback' and indexdef like '%(retrieval_id%'`)[0].n, 1)
})

// ---------------------------------------------------------------------------------------------------- R33: the footer and the reminder
test('R33: every MCP packet ends with a feedback line naming its retrieval, stored with it', { skip: SKIP }, async () => {
  await serveV3()
  const w = word()
  seed(`${w}-1`, { title: `${w} footer`, kind: 'wen', confidence: 0.8, chances: 0 })
  for (const query of [`${w} footer`, `${word()} nothing matches this`, `${w} footer ${FAKE_DOWN}`]) {
    const { tool } = await mcp()
    const text = await tool('recall', { query })
    assert.match(lines(text)[0], /^retrieval [0-9a-f-]{36}$/)
    const last = lines(text).at(-1)!
    for (const needle of ['feedback(', rid(text), 'used', 'irrelevant', 'wrong', 'nothing_useful']) assert.ok(last.includes(needle), `${needle} in ${last}`)
    assert.ok(last.length <= 200)
    const [row] = sql(`select packet from memory.retrieval where id = '${rid(text)}'`)
    assert.ok(row.packet.endsWith(last))
  }
})

test('R33: every tool reply after an unanswered recall ends with a one-line reminder naming it; feedback and nothing else clears it', { skip: SKIP }, async () => {
  const a = await delivered(2)
  for (const [name, args] of [['get_entry', { id: a.ids[0] }], ['check_messages', {}], ['get_blob', { sha256: 'nope' }], ['remember', { pattern: 'bogus', title: 't', body: 'b', evidence: 'e' }]] as const) {
    const r = await a.raw(name, args as Record<string, unknown>)
    const text = r.result.content[0].text as string
    const last = lines(text).at(-1)!
    assert.ok(last.includes(a.rid) && last.includes('feedback'), `${name}: ${last}`)
    assert.ok(last.length <= 300)
  }
  const unknown = await a.raw('nope', {})
  assert.equal(unknown.error.code, -32602)
  assert.equal(unknown.result, undefined)
  // Wen's verdict doesn't clear it, an agent verdict does.
  sql(`insert into memory.feedback (retrieval_id, source, verdict) values ('${a.rid}', 'wen', 'helpful')`)
  assert.equal(count(await a.tool('get_entry', { id: a.ids[0] }), a.rid), 1)
  assert.match(await a.tool('feedback', { retrieval_id: a.rid, nothing_useful: true }), /^Logged/)
  assert.equal(count(await a.tool('get_entry', { id: a.ids[0] }), a.rid), 0)
  // Straight SQL clears it too: the reminder reads the database.
  const b = await delivered(2)
  sql(`insert into memory.feedback (retrieval_id, source, verdict) values ('${b.rid}', 'agent', 'helpful')`)
  assert.equal(count(await b.tool('get_entry', { id: b.ids[0] }), b.rid), 0)
})

test('R33: the reminder names the newest 3 unanswered recalls, a second recall keeps its prefix, and no other session is named', { skip: SKIP }, async () => {
  const a = await delivered(2)
  const r2 = rid(await a.tool('recall', { query: `${a.w} entry` }))
  const r3 = rid(await a.tool('recall', { query: `${a.w} entry` }))
  const r4 = rid(await a.tool('recall', { query: `${a.w} entry` }))
  const last = lines(await a.tool('get_entry', { id: a.ids[0] })).at(-1)!
  for (const id of [r4, r3, r2]) assert.ok(last.includes(id))
  assert.ok(!last.includes(a.rid), 'the oldest is dropped')
  await a.tool('feedback', { retrieval_id: r4, nothing_useful: true })
  const next = lines(await a.tool('get_entry', { id: a.ids[0] })).at(-1)!
  for (const id of [r3, r2, a.rid]) assert.ok(next.includes(id))
  assert.ok(!next.includes(r4))
  // A new recall: line 1 is its own prefix, and the reminder, last, doesn't name it.
  const text = await a.tool('recall', { query: `${a.w} entry` })
  const mine = rid(text)
  assert.equal(lines(text)[0], `retrieval ${mine}`)
  assert.ok(lines(text).some((l) => l.startsWith('feedback(') && l.includes(mine)) || lines(text).some((l) => l.includes('feedback(') && l.includes(mine)))
  assert.ok(!lines(text).at(-1)!.includes(mine))
  // Another session and a header-less call hear nothing about them.
  const b = await mcp()
  assert.equal(count(await b.tool('get_entry', { id: a.ids[0] }), 'feedback'), 0)
  const bare = await b.raw('get_entry', { id: a.ids[0] }, {})
  assert.equal(count(bare.result.content[0].text, 'feedback'), 0)
})

test('R33: an HTTP recall carries no feedback line and no reminder', { skip: SKIP }, async () => {
  const w = word()
  seed(`${w}-h`, { title: `${w} over http`, kind: 'wen', confidence: 0.8, chances: 0 })
  const r = await request('POST', `${memory.url}/recall`, { headers: bearer(memory.runtimeToken), body: { query: `${w} over http` }, timeoutMs: 30_000 })
  assert.equal(count(r.text, 'feedback('), 0)
  const got = await request('GET', `${memory.url}/entries/${w}-h`, { headers: bearer(memory.runtimeToken), timeoutMs: 15_000 })
  assert.equal(count(got.text, 'feedback'), 0)
  assert.equal(sql(`select count(*)::int as n from memory.retrieval where packet like '%feedback(%' and mcp_session like 'http-%'`)[0].n, 0)
})

// ---------------------------------------------------------------------------------------------------- R33: health
test('R33: /api/v1/overview reports 7-day feedback coverage, agent feedback only, per client', { skip: SKIP }, async () => {
  const read = async () => json(await admin('GET', '/overview')).health.feedback_coverage_7d
  const before = await read()
  const mk = (id: string, client: string | null) => sql(`insert into memory.mcp_session (id, arm, client) values ('${id}', 'hybrid', ${client ? `'${client}'` : 'null'})`)
  const recall = (session: string, ago = '1 hour') => {
    const id = randomUUID()
    sql(`insert into memory.retrieval (id, mcp_session, arm, query, created_at) values ('${id}', '${session}', 'hybrid', 'q', now() - interval '${ago}')`)
    return id
  }
  const give = (r: string, source: string, n = 1) => { for (let i = 0; i < n; i++) sql(`insert into memory.feedback (retrieval_id, source, verdict) values ('${r}', '${source}', 'helpful')`) }
  const n = nonce()
  const cc = `cov-cc-${n}`, cx = `cov-cx-${n}`, nu = `cov-nu-${n}`, ht = `cov-http-${n}`
  mk(cc, 'claude-code'); mk(cx, 'codex'); mk(nu, null); mk(ht, 'http')
  give(recall(cc), 'agent'); give(recall(cc), 'agent', 2); give(recall(cc), 'wen'); recall(cc)
  give(recall(cx), 'agent'); recall(cx)
  recall(nu); recall(ht)
  give(recall(cc, '8 days'), 'agent')
  const after = await read()
  assert.equal(after.recalls - before.recalls, 7)
  assert.equal(after.with_feedback - before.with_feedback, 3)
  const by = (o: any, k: string) => o.by_client[k] ?? { recalls: 0, with_feedback: 0 }
  assert.equal(by(after, 'claude-code').recalls - by(before, 'claude-code').recalls, 4)
  assert.equal(by(after, 'claude-code').with_feedback - by(before, 'claude-code').with_feedback, 2)
  assert.equal(by(after, 'codex').recalls - by(before, 'codex').recalls, 2)
  assert.equal(by(after, 'unknown').recalls - by(before, 'unknown').recalls, 1)
  assert.equal(by(after, 'unknown').with_feedback - by(before, 'unknown').with_feedback, 0)
  assert.ok(!('http' in after.by_client))
  assert.ok(Math.abs(after.share - after.with_feedback / after.recalls) <= 0.005)
  const device = await request('GET', `${memory.url}/api/v1/overview`, { headers: bearer(memory.token), timeoutMs: 15_000 })
  assert.equal(device.status, 401)
})

test('R33: coverage is null with no recalls in the window', { skip: SKIP }, async () => {
  sql(`update memory.retrieval set created_at = created_at - interval '8 days'`)
  const c = json(await admin('GET', '/overview')).health.feedback_coverage_7d
  assert.deepEqual([c.recalls, c.with_feedback, c.share], [0, 0, null])
  sql(`update memory.retrieval set created_at = created_at + interval '8 days'`)
})

test('R33: API.md and the README document the feedback arguments and coverage', { skip: SKIP }, () => {
  const dir = join(import.meta.dirname, '../../../memory')
  assert.ok(readFileSync(join(dir, 'API.md'), 'utf8').includes('nothing_useful'))
  assert.ok(readFileSync(join(dir, 'API.md'), 'utf8').includes('feedback_coverage_7d'))
  assert.ok(readFileSync(join(dir, 'README.md'), 'utf8').includes('nothing_useful'))
})

// ---------------------------------------------------------------------------------------------------- R28: learning
test('R28: three used verdicts take a trial observation from 0.50 to 0.86 and into the main list; the log row is a step', { skip: SKIP }, async () => {
  await serveV3()
  const w = word()
  seed(`${w}-u`, { title: `${w} helpful note` })
  const s = await mcp()
  for (let i = 0; i < 3; i++) {
    const text = await s.tool('recall', { query: `${w} helpful note` })
    assert.equal(count(lists(text).trial, `${w}-u`), 1)
    assert.match(await s.tool('feedback', { retrieval_id: rid(text), entries: [{ entry_id: `${w}-u`, verdict: 'used' }] }), /^Logged/)
  }
  const done = await learnNow()
  assert.ok(done.learned >= 3 && done.failed === 0, JSON.stringify(done))
  const e = entry(`${w}-u`)
  assert.ok(Math.abs(e.confidence - 0.86) < 0.005, String(e.confidence))
  assert.equal(e.chances_left, 0)
  const log = sql(`select before::float as before, after::float as after from memory.confidence_log where target = 'entry:${w}-u' order by id`)
  assert.equal(log.length, 3)
  assert.ok(log.every((l) => Math.abs(l.after - l.before - 0.12) < 0.001), JSON.stringify(log))
  assert.equal(count(lists(await s.tool('recall', { query: `${w} helpful note` })).main, `${w}-u`), 1)
  await learnNow()
  assert.equal(sql(`select count(*)::int as n from memory.confidence_log where target = 'entry:${w}-u'`)[0].n, 3, 'a second pass moves nothing again')
  assert.ok(Math.abs(entry(`${w}-u`).confidence - 0.86) < 0.005, 'a second pass changes nothing')
})

test('R28: three wrong verdicts take an observation under 0.15, out of both lists, with its row kept', { skip: SKIP }, async () => {
  await serveV3()
  const w = word()
  seed(`${w}-w`, { title: `${w} bad note` })
  const s = await mcp()
  for (let i = 0; i < 3; i++) {
    const text = await s.tool('recall', { query: `${w} bad note` })
    await s.tool('feedback', { retrieval_id: rid(text), entries: [{ entry_id: `${w}-w`, verdict: 'wrong' }] })
  }
  await learnNow()
  const e = entry(`${w}-w`)
  assert.ok(e.confidence < 0.15, String(e.confidence))
  assert.equal(e.chances_left, 0)
  assert.equal(count(await s.tool('recall', { query: `${w} bad note` }), `${w}-w`), 0)
  assert.equal(sql(`select count(*)::int as n from memory.entry where id = '${w}-w'`)[0].n, 1)
})

test('R28: a shown entry that feedback never names fades by 0.05 a showing in trial, and an opened one rises', { skip: SKIP }, async () => {
  await serveV3()
  const w = word()
  seed(`${w}-ig`, { title: `${w} ignored note` })
  seed(`${w}-op`, { title: `${w} opened note` })
  seed(`${w}-ss`, { title: `${w} settled note`, kind: 'wen', confidence: 0.8, chances: 0 })
  const s = await mcp()
  const q = `${w} note`
  for (let i = 0; i < 3; i++) {
    const text = await s.tool('recall', { query: q })
    if (i === 0) await s.tool('get_entry', { id: `${w}-op` })
    await s.tool('feedback', { retrieval_id: rid(text), entries: [{ entry_id: `${w}-ss`, verdict: 'used' }] })
  }
  await learnNow()
  assert.ok(Math.abs(entry(`${w}-ig`).confidence - 0.35) < 0.005, `ignored: ${entry(`${w}-ig`).confidence}`)
  assert.equal(entry(`${w}-ig`).chances_left, 0)
  // opened once at +0.024, then ignored twice at -0.05
  assert.ok(Math.abs(entry(`${w}-op`).confidence - (0.5 + 0.024 - 0.1)) < 0.005, `opened: ${entry(`${w}-op`).confidence}`)
  assert.ok(Math.abs(entry(`${w}-ss`).confidence - (0.8 + 3 * 0.02)) < 0.005, `settled: ${entry(`${w}-ss`).confidence}`)
})

test('R28: a recall with no feedback and no opens moves nothing, and a shown entry never takes two steps in one recall', { skip: SKIP }, async () => {
  await serveV3()
  const w = word()
  const v = word()
  seed(`${w}-q`, { title: `${w} quiet` })
  seed(`${w}-r`, { title: `${v} loud` })
  const s = await mcp()
  const quiet = await s.tool('recall', { query: w })
  assert.equal(count(lists(quiet).trial, `${w}-q`), 1)
  const loud = await s.tool('recall', { query: v })
  await s.tool('get_entry', { id: `${w}-r` })
  await s.tool('feedback', { retrieval_id: rid(loud), entries: [{ entry_id: `${w}-r`, verdict: 'wrong' }] })
  await learnNow()
  assert.equal(entry(`${w}-q`).confidence, 0.5)
  assert.equal(sql(`select count(*)::int as n from memory.confidence_log where target = 'entry:${w}-q'`)[0].n, 0)
  assert.equal(sql(`select count(*)::int as n from memory.confidence_log where target = 'entry:${w}-r' and retrieval_id = '${rid(loud)}'`)[0].n, 1, 'wrong and opened: one step')
  assert.ok(Math.abs(entry(`${w}-r`).confidence - 0.38) < 0.005)
})

test('R28: Wen\'s pushback blaming a trial entry takes the trial step of -1, and a settled one the settled step', { skip: SKIP }, async () => {
  await serveV3()
  const w = word(), v = word()
  seed(`${w}-pb`, { title: `${w} alpha` })
  seed(`${v}-pb`, { title: `${v} beta`, kind: 'wen', confidence: 0.8, chances: 0 })
  for (const query of [w, v]) {
    const s = await mcp()
    await s.tool('recall', { query })
    const cs = `claude-${nonce()}`
    sql(`update memory.mcp_session set claude_session_id = '${cs}' where id = '${s.session}'`)
    sql(`insert into memory.event (session_id, event, payload) values ('${cs}', 'UserPromptSubmit', '{"prompt": "no, wrong ${FAKE_PUSHBACK}"}'::jsonb)`)
  }
  await learnNow()
  assert.ok(Math.abs(entry(`${w}-pb`).confidence - 0.38) < 0.005, String(entry(`${w}-pb`).confidence))
  assert.ok(Math.abs(entry(`${v}-pb`).confidence - 0.78) < 0.005, String(entry(`${v}-pb`).confidence))
})

test('R28: feedback names only what the recall showed, so a verdict on another entry moves nothing', { skip: SKIP }, async () => {
  await serveV3()
  const w = word()
  seed(`${w}-in`, { title: `${w} shown` })
  seed(`${w}-out`, { title: `${word()} elsewhere`, body: 'unrelated text', confidence: 0.7, chances: 0 })
  const s = await mcp()
  const text = await s.tool('recall', { query: `${w} shown` })
  assert.match(await s.tool('feedback', { retrieval_id: rid(text), entries: [{ entry_id: `${w}-out`, verdict: 'wrong' }] }), /^Not logged/)
  await learnNow()
  assert.ok(Math.abs(entry(`${w}-out`).confidence - 0.7) < 0.0001)
})

test('Quest #11: immediate recall of 2+ title words finds a fresh unembedded project note across index, hybrid and spreading', { skip: SKIP }, async () => {
  await serveV3()
  const w = word()
  // Seed >12 settled approved entries matching one query word so filterK=12 fills with 1-word matches on index.v1.
  for (let i = 0; i < 15; i++) seed(`${w}-noise-${i}`, { title: `${w} unrelated background ${i}`, kind: 'fact', confidence: 0.9, chances: 0 })
  const s = await mcp()
  const oldReply = await s.tool('remember', {
    pattern: 'projects', title: `${w} Legacy Handoff Plan`, body: `Earlier ${w} handoff notes.`, evidence: 'session log',
  })
  const oldId = /^Remembered (\S+?)\./.exec(oldReply)![1]
  const freshReply = await s.tool('remember', {
    pattern: 'projects',
    title: `Sticky-Note ${w} Fresh Handoff`,
    body: `Actionable ${w} handoff work left to ship.`,
    supersedes: [oldId],
    evidence: 'session handoff',
  })
  const freshId = /^Remembered (\S+?)\./.exec(freshReply)![1]

  for (const [i, set] of (['hybrid.v3', 'spreading.v3', 'index.v1'] as const).entries()) {
    await allocate(set)
    const client = await mcp(memory.token, `q11-${i}`)
    // Query uses 2 non-adjacent words from the title plus an unrelated task sentence, with no prior syncEmbeddings().
    const packet = await client.tool('recall', { query: `${w} Handoff`, task: 'Investigating unrelated build step' })
    assert.ok(packet.includes(freshId), `${set} missed fresh project note ${freshId}:\n${packet}`)
    if (set === 'index.v1') {
      const deeper = await client.tool('recall_more', { retrieval_id: rid(packet) })
      assert.ok(deeper.includes(oldId), `recall_more missed superseded project note ${oldId}:\n${deeper}`)
    }
  }
  await allocate('hybrid.v3')
})
