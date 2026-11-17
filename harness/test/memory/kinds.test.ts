/**
 * Tier 3: claim kinds and unhidden agent notes (R27 #20, R15 #18), against the real memory function. A fact is stored as a
 * fact only when its quote is in the event it cites, an unscoped recall serves every agent note on every arm, and the
 * packet labels each item. The pure parts, the quote check and the labels, are also in kinds_test.ts under deno.
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

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const call = (method: string, path: string, token: string, body?: unknown) =>
  request(method, `${memory.url}${path}`, { headers: bearer(token), body, timeoutMs: 30_000 })
const nonce = () => randomUUID().replaceAll('-', '').slice(0, 10)
const DIG = 'memory.heyclyde.me. 300 IN A 104.21.32.1'

/** An MCP session as `client`, with its session id. Calls one tool and gives back its text, errors included. */
async function mcp(token: string, client = 'claude-code') {
  const init = await call('POST', '/mcp', token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: client } } })
  assert.equal(init.status, 200, init.text)
  const session = String(init.headers['mcp-session-id'])
  const rpc = async (method: string, params: unknown) => {
    const r = await request('POST', `${memory.url}/mcp`, { headers: { ...bearer(token), 'mcp-session-id': session }, body: { jsonrpc: '2.0', id: 2, method, params }, timeoutMs: 30_000 })
    assert.equal(r.status, 200, r.text)
    return JSON.parse(r.text)
  }
  const tool = async (name: string, args: Record<string, unknown>) => (await rpc('tools/call', { name, arguments: args })).result.content[0].text as string
  return { session, rpc, tool }
}

/** Posts a hook event as the device and gives back its id. */
async function post(event: string, payload: Record<string, unknown>): Promise<number> {
  const r = await call('POST', `/hooks/${event}?agent=claude`, memory.token, { session_id: `kinds-${nonce()}`, hook_event_name: event, ...payload })
  assert.equal(r.status, 200, r.text)
  return Number(sql('select max(id) as id from memory.event')[0].id)
}

const bash = (command: string, response: unknown) => post('PostToolUse', { tool_name: 'Bash', tool_input: { command }, tool_response: response })

/** The fields of a remember that cites event `evidence_event` for `evidence`. */
const fact = (over: Record<string, unknown> = {}) => ({
  pattern: 'observations', title: `Host resolves ${nonce()}`, body: 'dig shows the host at an address.', kind: 'fact', evidence: DIG, ...over,
})

const row = (title: string) => sql(`select id, kind, verified, evidence_event::int as evidence_event, scope, authority, chances_left, round(confidence::numeric, 2)::float as confidence
  from memory.entry where title = '${title}'`)

/** The line that follows "[n] id:" in a packet, or the index line that holds the id. */
const itemLine = (text: string, id: string, after = 1) => {
  const lines = text.split('\n')
  const at = lines.findIndex((l) => l.includes(id))
  return lines[at + after]
}

const preview = async (query: string, arms = ['index', 'hybrid', 'spreading']) => {
  const r = await call('POST', '/api/v1/recall/preview', memory.adminToken, { query, arms })
  assert.equal(r.status, 200, r.text)
  return Object.fromEntries(JSON.parse(r.text).arms.map((a: any) => [a.arm, a.text as string]))
}

const rank = async (query: string, arm: string, filter = true) => {
  const r = await call('POST', '/api/v1/eval/rank', memory.adminToken, { query, arm, filter })
  assert.equal(r.status, 200, r.text)
  return JSON.parse(r.text) as { candidates: string[]; delivered: string[] }
}

const ARMS = ['index', 'hybrid', 'spreading']

// R27 (#20): remember takes kind and evidence_event, and scope and project are optional.
test('R27: remember\'s MCP schema takes kind and evidence_event, and scope is optional', { skip: SKIP }, async () => {
  const { rpc } = await mcp(memory.token)
  const remember = (await rpc('tools/list', {})).result.tools.find((t: any) => t.name === 'remember')
  assert.ok('kind' in remember.inputSchema.properties && 'evidence_event' in remember.inputSchema.properties)
  assert.ok(!remember.inputSchema.required.includes('scope') && !remember.inputSchema.required.includes('project'), remember.inputSchema.required.join())
  assert.deepEqual([...remember.inputSchema.required].sort(), ['body', 'evidence', 'pattern', 'title'])
  assert.equal(remember.description.split('draft').length - 1, 0, 'the description no longer says a note is a draft')
  assert.ok(remember.description.includes('evidence_event'))
  const note = { pattern: 'observations', body: 'A body.', scope: 'global', evidence_kind: 'summary', evidence: 'seen' }
  const title = `Global note ${nonce()}`
  const ok = await call('POST', '/entries', memory.token, { ...note, title })
  assert.equal(ok.status, 200, ok.text)
  assert.equal(row(title)[0].scope, 'global')
  const above = await call('POST', '/entries', memory.token, { ...note, title: `${title} 2`, authority: 'observed' })
  assert.equal(above.status, 400)
  assert.match(above.text, /above draft/)
})

test('R27: the server instructions say remember needs only pattern, title, body and evidence', { skip: SKIP }, async () => {
  const init = await call('POST', '/mcp', memory.token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex' } } })
  const text: string = JSON.parse(init.text).result.instructions
  assert.match(text, /remember/)
  assert.match(text, /pattern, title, body and evidence/)
})

test('R27: a fact whose quote is in the cited tool output is stored as kind fact at 0.90', { skip: SKIP }, async () => {
  const e = await bash('dig memory.heyclyde.me', { stdout: `${DIG}\n` })
  const { tool } = await mcp(memory.token)
  const args = fact({ evidence_event: e })
  const reply = await tool('remember', args)
  assert.match(reply, /^Remembered \S+\./)
  assert.deepEqual(row(args.title).map(({ id: _, ...r }) => r), [{ kind: 'fact', verified: true, evidence_event: e, scope: 'global', authority: 'draft', chances_left: 0, confidence: 0.9 }])
})

test('R27: a claimed fact whose quote isn\'t in the cited event is stored as an unverified observation at 0.50', { skip: SKIP }, async () => {
  const e = await bash('dig memory.heyclyde.me', { stdout: `${DIG}\n` })
  const { tool } = await mcp(memory.token)
  const args = fact({ evidence_event: e, evidence: 'memory.heyclyde.me. 300 IN A 10.9.9.9', title: `Unverified host ${nonce()}` })
  const reply = await tool('remember', args)
  assert.match(reply, /^Remembered \S+\./, 'the call is not refused')
  const [r] = row(args.title)
  assert.deepEqual([r.kind, r.verified, r.confidence, r.chances_left], ['observation', false, 0.5, 3])
  const text = (await preview(args.title, ['hybrid'])).hybrid
  assert.match(itemLine(text, r.id), /^ {4}observation · unverified · confidence 0\.50 · /)
})

test('R27: a fact with no cited event or a missing event is stored as an unverified observation', { skip: SKIP }, async () => {
  const { tool } = await mcp(memory.token)
  for (const over of [{}, { evidence_event: 999999999 }]) {
    const args = fact({ ...over, title: `Uncited fact ${nonce()}` })
    assert.match(await tool('remember', args), /^Remembered /)
    const [r] = row(args.title)
    assert.deepEqual([r.kind, r.verified, r.confidence], ['observation', false, 0.5])
  }
})

test('R27: plan and default notes start at 0.50, an unknown kind is refused', { skip: SKIP }, async () => {
  const { tool } = await mcp(memory.token)
  const plan = fact({ kind: 'plan', title: `Plan ${nonce()}` }), plain = fact({ kind: undefined, title: `Plain ${nonce()}` })
  await tool('remember', plan)
  await tool('remember', plain)
  const [p] = row(plan.title), [d] = row(plain.title)
  assert.deepEqual([p.kind, p.verified, p.confidence, p.scope, p.chances_left], ['plan', null, 0.5, 'global', 3])
  assert.deepEqual([d.kind, d.verified, d.confidence, d.scope, d.chances_left], ['observation', null, 0.5, 'global', 3])
  const guess = fact({ kind: 'guess', title: `Guess ${nonce()}` })
  const reply = await tool('remember', guess)
  for (const kind of ['fact', 'wen', 'observation', 'plan']) assert.ok(reply.includes(kind), reply)
  assert.deepEqual(row(guess.title), [])
})

test('R27: confidence starts from the evidence, not the writer', { skip: SKIP }, async () => {
  const e = await bash('dig memory.heyclyde.me', { stdout: `${DIG}\n` })
  const { tool } = await mcp(memory.token)
  const note = (evidence: string, title: string) => ({
    pattern: 'observations', title, body: 'A body.', kind: 'fact', evidence, evidence_event: e, evidence_kind: 'summary',
    authority: 'approved', scope: 'global', project: 'proj-tea', source: { kind: 'run', title: 'tier 3', uri: 'tier3://kinds' },
  })
  for (const [evidence, kind, confidence] of [[DIG, 'fact', 0.9], ['memory.heyclyde.me. 300 IN A 10.9.9.9', 'observation', 0.5]] as const) {
    const mcpTitle = `By MCP ${nonce()}`, rtTitle = `By runtime ${nonce()}`
    await tool('remember', fact({ evidence, evidence_event: e, title: mcpTitle }))
    const r = await call('POST', '/entries', memory.runtimeToken, note(evidence, rtTitle))
    assert.equal(r.status, 200, r.text)
    for (const title of [mcpTitle, rtTitle]) assert.deepEqual([row(title)[0].kind, row(title)[0].confidence], [kind, confidence], title)
  }
})

test('R27: an agent can\'t set its own confidence or verified flag', { skip: SKIP }, async () => {
  const e = await bash('dig memory.heyclyde.me', { stdout: `${DIG}\n` })
  const base = { pattern: 'observations', body: 'A body.', evidence_kind: 'summary', evidence: DIG, kind: 'fact', evidence_event: e }
  for (const [field, value] of [['confidence', 0.99], ['verified', true]] as const) {
    const title = `Forced ${field} ${nonce()}`
    const r = await call('POST', '/entries', memory.token, { ...base, title, [field]: value })
    assert.equal(r.status, 400)
    assert.match(r.text, new RegExp(`Unknown field ${field}\\.`))
    assert.deepEqual(row(title), [])
  }
  const { tool } = await mcp(memory.token)
  const title = `Forced over MCP ${nonce()}`
  await tool('remember', fact({ title, evidence_event: e, confidence: 0.99, verified: false }))
  assert.deepEqual([row(title)[0].verified, row(title)[0].confidence], [true, 0.9])
})

test('R27: a quote anywhere in the cited tool response verifies, across lines and quote marks', { skip: SKIP }, async () => {
  const { tool } = await mcp(memory.token)
  const cases: [string, number, string][] = [
    ['a', await bash('host', { stdout: 'Address: 104.21.32.1\nName: memory.heyclyde.me' }), 'Address: 104.21.32.1 Name: memory.heyclyde.me'],
    ['b', await bash('echo', { stdout: 'say "ok" now please' }), 'say "ok" now'],
    ['c', await bash('git status', { stdout: '', stderr: 'fatal: not a git repository' }), 'fatal: not a git repository'],
    ['d', await post('PostToolUse', { tool_name: 'mcp__github__get_file', tool_response: { content: [{ type: 'text', text: 'version = 2.4.1 released' }] } }), 'version = 2.4.1 released'],
    ['e', await post('PostToolUse', { tool_name: 'WebFetch', tool_response: 'Cloudflare Registrar: heyclyde.me registered' }), 'Cloudflare Registrar: heyclyde.me registered'],
  ]
  for (const [label, event, evidence] of cases) {
    const title = `Shape ${label} ${nonce()}`
    await tool('remember', fact({ title, evidence, evidence_event: event }))
    assert.deepEqual([row(title)[0].kind, row(title)[0].verified], ['fact', true], label)
  }
})

test('R27: a quote must start and end on a token boundary in the event', { skip: SKIP }, async () => {
  const { tool } = await mcp(memory.token)
  const longer = await bash('dig', { stdout: 'memory.heyclyde.me. 300 IN A 104.21.32.123' })
  const e = await bash('dig', { stdout: `${DIG}\n` })
  for (const [event, evidence] of [[longer, DIG], [e, 'emory.heyclyde.me. 300 IN A 104.21.32.1']] as const) {
    const title = `Boundary ${nonce()}`
    await tool('remember', fact({ title, evidence, evidence_event: event }))
    assert.deepEqual([row(title)[0].kind, row(title)[0].verified], ['observation', false], evidence)
  }
})

test('R27: text the agent sent, or an event other than the cited kind, never verifies a fact', { skip: SKIP }, async () => {
  const { tool } = await mcp(memory.token)
  const inCommand = await bash(`echo ${DIG}`, { stdout: 'nothing\n' })
  const session = await post('SessionStart', { prompt: DIG })
  for (const event of [inCommand, session]) {
    const title = `Not output ${nonce()}`
    await tool('remember', fact({ title, evidence_event: event }))
    assert.deepEqual([row(title)[0].kind, row(title)[0].verified], ['observation', false])
  }
})

test('R27: wen from an agent needs Wen\'s prompt, and the runtime token\'s kind wen is taken as given', { skip: SKIP }, async () => {
  const p = await post('UserPromptSubmit', { prompt: 'From now on deploys go through deploy.sh only, never by hand.' })
  const { tool } = await mcp(memory.token)
  const good = `Deploy only by script ${nonce()}`, bad = `Deploy by hand ${nonce()}`
  await tool('remember', fact({ kind: 'wen', title: good, evidence_event: p, evidence: 'deploys go through deploy.sh only' }))
  await tool('remember', fact({ kind: 'wen', title: bad, evidence_event: p, evidence: 'deploys never need deploy.sh' }))
  const [g] = row(good), [b] = row(bad)
  assert.deepEqual([g.kind, g.verified, g.confidence, g.chances_left], ['wen', true, 0.7, 3])
  assert.deepEqual([b.kind, b.verified, b.confidence, b.chances_left], ['observation', false, 0.5, 3])
  const runtime = `Runtime wen ${nonce()}`
  const r = await call('POST', '/entries', memory.runtimeToken, {
    pattern: 'preferences', title: runtime, body: 'Wen said so.', kind: 'wen', evidence_kind: 'quote', evidence: 'I said so', authority: 'observed',
    scope: 'global', project: 'proj-tea', source: { kind: 'run', title: 'tier 3', uri: 'tier3://kinds' },
  })
  assert.equal(r.status, 200, r.text)
  assert.deepEqual([row(runtime)[0].kind, row(runtime)[0].confidence], ['wen', 0.7])
})

test('R27: a resent fact lands once, and a malformed evidence_event is refused', { skip: SKIP }, async () => {
  const e = await bash('dig', { stdout: `${DIG}\n` })
  const { tool } = await mcp(memory.token)
  const args = fact({ evidence_event: e, title: `Resent ${nonce()}` })
  const first = await tool('remember', args), again = await tool('remember', args)
  assert.equal(first, again)
  assert.deepEqual(row(args.title).map((r) => r.kind), ['fact'])
  const bad = fact({ evidence_event: 'abc', title: `Malformed ${nonce()}` })
  assert.match(await tool('remember', bad), /evidence_event must be an event id\./)
  assert.deepEqual(row(bad.title), [])
})

test('R27: every packet item and get_entry show kind and confidence on all three arms', { skip: SKIP }, async () => {
  const tag = `lbl${nonce()}`
  const e = await bash('dig', { stdout: `${DIG}\n` })
  const { tool } = await mcp(memory.token)
  const titles = { fact: `${tag} fact`, observation: `${tag} unverified observation`, plan: `${tag} plan`, wen: `${tag} wen` }
  await tool('remember', fact({ title: titles.fact, evidence_event: e }))
  await tool('remember', fact({ title: titles.observation, evidence: 'not in the event at all' }))
  await tool('remember', fact({ kind: 'plan', title: titles.plan }))
  const rt = await call('POST', '/entries', memory.runtimeToken, {
    pattern: 'preferences', title: titles.wen, body: 'Wen said so.', kind: 'wen', evidence_kind: 'quote', evidence: 'I said so', authority: 'observed',
    scope: 'global', project: 'proj-tea', source: { kind: 'run', title: 'tier 3', uri: 'tier3://kinds' },
  })
  assert.equal(rt.status, 200, rt.text)
  const packets = await preview(tag)
  const want = {
    fact: { meta: 'fact · confidence 0.90', index: '[fact, 0.90, ', entry: 'kind fact · confidence 0.90' },
    observation: { meta: 'observation · unverified · confidence 0.50', index: '[observation unverified, 0.50, ', entry: 'kind observation · confidence 0.50' },
    plan: { meta: 'plan · confidence 0.50', index: '[plan, 0.50, ', entry: 'kind plan · confidence 0.50' },
    wen: { meta: 'wen · confidence 0.70', index: '[wen, 0.70, ', entry: 'kind wen · confidence 0.70' },
  }
  for (const [kind, title] of Object.entries(titles)) {
    const [{ id }] = row(title)
    const w = want[kind as keyof typeof want]
    for (const arm of ['hybrid', 'spreading']) assert.ok(itemLine(packets[arm], id).startsWith(`    ${w.meta} · `), `${arm} ${kind}: ${itemLine(packets[arm], id)}`)
    assert.ok(itemLine(packets.index, id, 0).includes(w.index), `index ${kind}: ${itemLine(packets.index, id, 0)}`)
    assert.ok((await tool('get_entry', { id })).includes(w.entry), `get_entry ${kind}`)
  }
})

test('R27: the kind migration backfills by pattern and evidence, keeps confidence, and reruns as a no-op', { skip: SKIP }, async () => {
  const cases = [['references', 'quote', 'fact'], ['decisions', 'quote', 'wen'], ['observations', 'assistant', 'observation'], ['references', 'summary', 'observation']]
  for (const [pattern, evidence, kind] of cases) {
    assert.equal(sql(`select memory.legacy_kind('${pattern}', '${evidence}') as k`)[0].k, kind, `${pattern}/${evidence}`)
  }
  const snapshot = () => sql(`select id, kind, verified, chances_left, evidence_event, confidence from memory.entry order by id`)
  const before = snapshot()
  apply('20261103010000_kinds.sql')
  apply('20261103010000_kinds.sql')
  assert.deepEqual(snapshot(), before, 'a second run changes nothing')
  assert.equal(Number(sql(`select count(*) as n from memory.entry where kind is null or kind not in ('fact','wen','observation','plan')`)[0].n), 0)
  assert.deepEqual(sql(`select kind, verified, evidence_event, chances_left from memory.entry_current limit 1`).length, 1, 'entry_current carries the new columns')
  assert.throws(() => sql(`insert into memory.entry (id, kind) values ('guess-kind', 'guess')`), /entry_kind_check/)
})

// R15 (#18): every agent note is visible the moment it's written.
test('R15: an agent note with no scope and no project lands in global and an unscoped recall serves it at once', { skip: SKIP }, async () => {
  const { tool } = await mcp(memory.token, 'codex-mcp-client')
  const title = `R15 oolong canary ${nonce()}`
  const reply = await tool('remember', { pattern: 'observations', title, body: 'The canary body.', evidence: 'seen once' })
  const id = /^Remembered (\S+?)\./.exec(reply)?.[1] as string
  assert.ok(id, reply)
  const [r] = row(title)
  assert.deepEqual([r.scope, r.authority, r.confidence], ['global', 'draft', 0.5])
  assert.equal(sql(`select p.pattern from memory.entry e join memory.entry p on p.id = e.project where e.id = '${id}'`)[0].pattern, 'projects', 'it hangs off a notes project')
  const again = await tool('remember', { pattern: 'observations', title: `${title} again`, body: 'Another body.', evidence: 'seen twice' })
  assert.match(again, /^Remembered /)
  assert.equal(sql(`select count(distinct project)::int as n from memory.entry where title like '${title}%'`)[0].n, 1, 'the notes project is made once')
  const text = await tool('recall', { query: title })
  assert.ok(text.includes(id), text)
})

test('R15: every arm delivers another run\'s draft to an unscoped recall', { skip: SKIP }, async () => {
  const tag = `r15run${nonce()}`
  const { tool } = await mcp(memory.token)
  const title = `${tag} oolong canary`
  const id = /^Remembered (\S+?)\./.exec(await tool('remember', { pattern: 'observations', title, body: 'A note from a run.', scope: 'run:k15a', evidence: 'seen' }))![1]
  for (const arm of ARMS) assert.ok((await rank(`${tag} oolong canary`, arm)).delivered.includes(id), arm)
})

test('R15: a recall scoped to another run still serves the draft, below its own run\'s notes', { skip: SKIP }, async () => {
  const tag = `r15two${nonce()}`
  const { tool } = await mcp(memory.token)
  const note = (scope: string) => ({ pattern: 'observations', title: `${tag} oolong canary`, body: 'The same body.', scope, evidence: scope })
  const d = /^Remembered (\S+?)\./.exec(await tool('remember', note('run:k15a')))![1]
  const e = /^Remembered (\S+?)\./.exec(await tool('remember', note('run:k15b')))![1]
  for (const arm of ARMS) {
    sql(`insert into memory.mcp_session (id, arm, param_set, unit) values ('http-run:k15b', '${arm}', '${arm}.v1', 'run:k15b')
      on conflict (owner_id, id) do update set arm = excluded.arm, param_set = excluded.param_set, unit = excluded.unit`)
    const r = await call('POST', '/recall', memory.token, { query: `${tag} oolong canary`, scope: 'run:k15b' })
    assert.equal(r.status, 200, r.text)
    assert.ok(r.text.includes(d) && r.text.includes(e), `${arm} serves both`)
    assert.ok(r.text.indexOf(e) < r.text.indexOf(d), `${arm} puts its own run first`)
  }
})

test('R15: an unscoped packet marks a draft unreviewed on every arm, and only a draft', { skip: SKIP }, async () => {
  const tag = `r15mark${nonce()}`
  const { tool } = await mcp(memory.token)
  const d = /^Remembered (\S+?)\./.exec(await tool('remember', { pattern: 'observations', title: `${tag} canary`, body: 'A draft.', scope: 'run:k15a', evidence: 'seen' }))![1]
  const rt = await call('POST', '/entries', memory.runtimeToken, {
    pattern: 'observations', title: `${tag} canary approved`, body: 'Approved.', authority: 'approved', scope: 'run:k15c', evidence_kind: 'summary', evidence: 'tier 3',
    project: 'proj-tea', source: { kind: 'run', title: 'tier 3', uri: 'tier3://kinds' },
  })
  assert.equal(rt.status, 200, rt.text)
  const a = JSON.parse(rt.text).id as string
  const packets = await preview(`${tag} canary`)
  for (const arm of ['hybrid', 'spreading']) {
    const meta = itemLine(packets[arm], d)
    assert.ok(meta.includes('draft') && meta.includes('unreviewed'), `${arm}: ${meta}`)
    assert.ok(!itemLine(packets[arm], a).includes('unreviewed'), arm)
  }
  assert.ok(itemLine(packets.index, d, 0).includes('unreviewed'))
  assert.ok(!itemLine(packets.index, a, 0).includes('unreviewed'))
})

test('R15: a dormant draft stays out of unscoped recall on every arm, and no arm leaves out another run\'s drafts', { skip: SKIP }, async () => {
  const tag = `r15dorm${nonce()}`
  const { tool } = await mcp(memory.token)
  const ids = []
  for (const run of ['k15m', 'k15n', 'k15o']) {
    ids.push(/^Remembered (\S+?)\./.exec(await tool('remember', { pattern: 'observations', title: `${tag} ${run}`, body: `${tag} body.`, scope: `run:${run}`, evidence: 'seen' }))![1])
  }
  for (const arm of ARMS) {
    const seen = await rank(tag, arm, false)
    for (const id of ids) assert.ok(seen.candidates.includes(id), `${arm} leaves out ${id}`)
  }
  sql(`update memory.entry set confidence = 0.1 where id = '${ids[0]}'`)
  for (const arm of ARMS) {
    const seen = await rank(tag, arm)
    assert.ok(!seen.delivered.includes(ids[0]) && !seen.candidates.includes(ids[0]), `${arm} serves a dormant draft`)
    assert.ok(seen.candidates.includes(ids[1]), arm)
  }
})
