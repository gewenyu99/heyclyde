/**
 * Tier 3: R19 (#23), agent profiles, and R41 (#45), provenance on every memory. Against the real memory function.
 *
 * Registration is gentle, not a gate: an unregistered session still works, and every tool reply carries a one-line nudge as
 * a second content block until it registers. The nudge is a block of its own, so the text a tool returns is never changed.
 * #23's "every other tool refuses" criteria are softened to that, and each test says which criterion it stands in for.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { repoRoot } from '../../src/config.ts'
import { request } from '../../src/request.ts'
import { jwt } from './auth.ts'
import { bearer, bedFor, countOf, idOf, nonce, note } from './bed.ts'
import { apply, SKIP, sql, startRealMemory, type RealMemory } from './server.ts'

let memory: RealMemory
let bed: ReturnType<typeof bedFor>
const BACKUP = `backup-${randomBytes(6).toString('hex')}`

before(async () => {
  if (SKIP) return
  memory = await startRealMemory()
  bed = bedFor(memory)
  sql(`insert into memory.setting (name, value) values ('backup_token_sha256', '${sha(BACKUP)}') on conflict (name) do update set value = excluded.value`)
})

after(async () => {
  await memory?.close()
})

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => bed.call(method, path, headers, body)
const admin = (method: string, path: string, body?: unknown) =>
  request(method, `${memory.url}/api/v1${path}`, { headers: bearer(memory.adminToken), body, timeoutMs: 30_000 })
const word = () => 'zq' + nonce().replace(/[0-9]/g, 'k')

/** The one-line nudge an unregistered session hears after every tool reply. */
const NUDGE = /^memory: you haven't registered yet\. Call register_agent \{name, context, surface, description\}/
const NAME_ERR = 'name must be 2 to 40 lowercase letters, digits and dashes, starting with a letter or digit.'
const GOOD = { name: 'r19-good', context: 'work', surface: 'claude-code', description: 'Tier 3 agent.' }

type Reply = { text: string; blocks: string[]; error: boolean; status: number }

/** A computer's device row and token. */
function newDevice(name: string): string {
  const token = `device-${randomBytes(8).toString('hex')}`
  sql(`insert into memory.device (name, token_sha256) values ('${name}', '${sha(token)}') on conflict do nothing`)
  return token
}

/** An MCP session. `send` calls one tool, as this session or, with `as`, as another session id or token. */
async function open(token: string, client: string | null) {
  const params: Record<string, unknown> = { protocolVersion: '2025-06-18' }
  if (client !== null) params.clientInfo = { name: client }
  const init = await call('POST', '/mcp', bearer(token), { jsonrpc: '2.0', id: 1, method: 'initialize', params })
  assert.equal(init.status, 200, init.text)
  const id = String(init.headers['mcp-session-id'])
  const rpc = async (method: string, p: Record<string, unknown> = {}, as: { session?: string | null; token?: string } = {}) => {
    const headers: Record<string, string> = bearer(as.token ?? token)
    const session = as.session === undefined ? id : as.session
    if (session) headers['mcp-session-id'] = session
    return await call('POST', '/mcp', headers, { jsonrpc: '2.0', id: 2, method, params: p })
  }
  const send = async (name: string, args: Record<string, unknown>, as: { session?: string | null; token?: string } = {}): Promise<Reply> => {
    const r = await rpc('tools/call', { name, arguments: args }, as)
    assert.equal(r.status, 200, `${name}: ${r.text}`)
    const res = JSON.parse(r.text).result
    return { text: res.content[0].text, blocks: res.content.map((c: any) => c.text), error: Boolean(res.isError), status: r.status }
  }
  return { id, rpc, send, init: JSON.parse(init.text) }
}

/** A session that registers as `name` and gives back the session. */
async function registered(token: string, client: string | null, name: string, context = 'work', surface = 'claude-code') {
  const s = await open(token, client)
  const r = await s.send('register_agent', { name, context, surface, description: `${name}, a tier 3 agent.` })
  assert.equal(r.error, false, r.text)
  return s
}

const agents = () => countOf('agent', 'true')
const bindings = () => countOf('agent_binding', 'true')
const agentOf = (session: string) => sql(`select agent from memory.mcp_client where session_id = '${session}'`)[0]?.agent ?? null

// ----------------------------------------------------------------------------------------------------- R19

// #23 criterion 1, softened: nothing is refused, and every reply says how to register.
test("R19: an unregistered session's every tool but register_agent works and carries a one-line nudge, and its writes land", { skip: SKIP }, async () => {
  const s = await open(memory.token, 'r19-t1-app')
  const tools: string[] = JSON.parse((await s.rpc('tools/list')).text).result.tools.map((t: any) => t.name)
  assert.ok(tools.includes('register_agent'))
  for (const name of tools.filter((t) => t !== 'register_agent')) {
    const r = await s.send(name, {})
    assert.equal(r.blocks.length, 2, `${name} carries the nudge as a second block: ${JSON.stringify(r.blocks)}`)
    assert.match(r.blocks[1], NUDGE, name)
    assert.ok(!r.blocks[1].includes('\n'), `${name}: one line`)
    assert.ok(!r.text.includes("haven't registered"), `${name}: the tool's own text is untouched`)
  }
  const title = `t1 ${nonce()}`
  const before = countOf('entry', `title = '${title}'`)
  const wrote = await s.send('remember', note(title))
  assert.equal(wrote.error, false, wrote.text)
  assert.match(wrote.text, /^Remembered /)
  assert.equal(wrote.blocks.length, 2)
  assert.equal(countOf('entry', `title = '${title}'`), before + 1, 'the write landed')
  const recalled = await s.send('recall', { query: 'oolong' })
  assert.equal(recalled.error, false)
  assert.match(recalled.text, /retrieval [0-9a-f-]{36}/)
})

// #23 criterion 2.
test('R19: initialize, ping and tools/list need no registration, mention register_agent and offer it', { skip: SKIP }, async () => {
  const s = await open(memory.token, 'r19-t2-app')
  assert.ok(s.init.result && !s.init.error)
  assert.ok(s.init.result.instructions.includes('register_agent'), 'the instructions say to register')
  const ping = JSON.parse((await s.rpc('ping')).text)
  assert.ok('result' in ping && !('error' in ping))
  const list = JSON.parse((await s.rpc('tools/list')).text)
  assert.ok(!list.error)
  const reg = list.result.tools.find((t: any) => t.name === 'register_agent')
  assert.deepEqual(reg.inputSchema.required, ['name', 'context', 'surface', 'description'])
})

// #23 criterion 3.
test('R19: register_agent stores the profile, and that session stops hearing the nudge', { skip: SKIP }, async () => {
  const s = await open(memory.token, 'r19-t3-app')
  const reg = await s.send('register_agent', { name: 'r19-t3', context: 'work', surface: 'claude-code', description: 'Tier 3 agent.' })
  assert.equal(reg.error, false, reg.text)
  assert.ok(reg.text.startsWith('Registered r19-t3: a work agent on claude-code.'), reg.text)
  assert.equal(reg.blocks.length, 1, 'registering is not nudged')
  const recalled = await s.send('recall', { query: 'oolong' })
  assert.equal(recalled.error, false)
  assert.match(recalled.text, /retrieval [0-9a-f-]{36}/)
  assert.equal(recalled.blocks.length, 1, 'no nudge once registered')
  assert.deepEqual(sql(`select name, context, surface, description, registered_by from memory.agent where name = 'r19-t3'`),
    [{ name: 'r19-t3', context: 'work', surface: 'claude-code', description: 'Tier 3 agent.', registered_by: 'clyde-test' }])
  assert.equal(agentOf(s.id), 'r19-t3')
})

// #23 criterion 4.
test('R19: register_agent refuses bad names, contexts, empty fields and reserved names, and writes nothing', { skip: SKIP }, async () => {
  const s = await open(memory.token, 'r19-t4-app')
  const cases: [Record<string, unknown>, string][] = [
    [{ name: 'x' }, NAME_ERR], [{ name: 'a'.repeat(41) }, NAME_ERR], [{ name: '-lead' }, NAME_ERR], [{ name: 'has space' }, NAME_ERR],
    [{ context: 'home' }, 'context must be work, personal or both.'],
    [{ surface: '' }, 'surface is required: where you run, like claude-code or claude.ai.'],
    [{ description: '' }, 'description is required: what you do for Wen.'],
    ...['claude', 'codex', 'all', 'wen', 'memory'].map((name): [Record<string, unknown>, string] => [{ name }, `${name} is reserved. Pick a name of your own.`]),
  ]
  assert.equal(cases.length, 12)
  const [a, b] = [agents(), bindings()]
  for (const [bad, want] of cases) {
    const r = await s.send('register_agent', { ...GOOD, name: 'r19-bad', ...bad })
    assert.equal(r.error, true, JSON.stringify(bad))
    assert.equal(r.text, want, JSON.stringify(bad))
  }
  assert.deepEqual([agents(), bindings()], [a, b])
})

// #23 criterion 5.
test('R19: register_agent accepts names at the edges and refuses blank or non-string fields', { skip: SKIP }, async () => {
  const s = await open(memory.token, 'r19-t5-app')
  const a = agents()
  const edge = ['ab', 'a'.repeat(40), '9lives', 'r19-']
  for (const name of edge) {
    const r = await s.send('register_agent', { ...GOOD, name })
    assert.equal(r.error, false, `${name}: ${r.text}`)
  }
  assert.equal(agents(), a + 4)
  const bad: [Record<string, unknown>, string][] = [
    [{ surface: '   ' }, 'surface is required: where you run, like claude-code or claude.ai.'],
    [{ description: '\t' }, 'description is required: what you do for Wen.'],
    [{ name: 123 }, NAME_ERR],
    [{ context: null }, 'context must be work, personal or both.'],
  ]
  for (const [override, want] of bad) {
    const r = await s.send('register_agent', { ...GOOD, name: 'r19-edge', ...override })
    assert.equal(r.error, true, JSON.stringify(override))
    assert.equal(r.text, want)
  }
  assert.equal(agents(), a + 4)
  sql(`delete from memory.agent where name in ('ab', '${'a'.repeat(40)}', '9lives', 'r19-')`)
})

// #23 criterion 6.
test('R19: register_agent lowercases and trims the name and caps surface at 40 and description at 500 characters', { skip: SKIP }, async () => {
  const s = await open(memory.token, 'r19-t6-app')
  const r = await s.send('register_agent', { name: ' R19-Mixed ', context: 'work', surface: 's'.repeat(60), description: 'd'.repeat(600) })
  assert.equal(r.error, false, r.text)
  assert.deepEqual(sql(`select name, char_length(surface)::int as surface, char_length(description)::int as description from memory.agent where name = 'r19-mixed'`),
    [{ name: 'r19-mixed', surface: 40, description: 500 }])
})

// #23 criterion 7.
test('R19: a new session with the same token and client name starts registered', { skip: SKIP }, async () => {
  await registered(memory.token, 'r19-t7-app', 'r19-t7')
  const s2 = await open(memory.token, 'r19-t7-app')
  const r = await s2.send('recall', { query: 'oolong' })
  assert.equal(r.error, false)
  assert.match(r.text, /retrieval [0-9a-f-]{36}/)
  assert.equal(r.blocks.length, 1, 'no nudge: it started registered')
  assert.equal(agentOf(s2.id), 'r19-t7')
})

// #23 criterion 8.
test('R19: registration is per credential and per client name, never shared across either', { skip: SKIP }, async () => {
  await registered(memory.token, 'r19-t8-app', 'r19-t8')
  const other = await open(memory.token, 'r19-t8-other')
  const t2 = newDevice('r19-t8-dev')
  const second = await open(t2, 'r19-t8-app')
  for (const s of [other, second]) {
    const r = await s.send('recall', { query: 'oolong' })
    assert.equal(r.error, false, 'it works')
    assert.equal(r.blocks.length, 2, 'and it is nudged')
    assert.match(r.blocks[1], NUDGE)
    assert.equal(agentOf(s.id), null)
  }
})

// #23 criterion 9.
test('R19: a client with no name registers for its session only', { skip: SKIP }, async () => {
  const b = bindings()
  const s = await open(memory.token, null)
  const reg = await s.send('register_agent', { ...GOOD, name: 'r19-t9' })
  assert.equal(reg.error, false, reg.text)
  assert.equal((await s.send('recall', { query: 'oolong' })).blocks.length, 1)
  assert.equal(bindings(), b, 'no binding without a client name')
  const s2 = await open(memory.token, null)
  assert.equal((await s2.send('recall', { query: 'oolong' })).blocks.length, 2, 'the next nameless session is unregistered')
})

// #23 criterion 10.
test('R19: re-registering updates the profile, and a new name rebinds the credential and app', { skip: SKIP }, async () => {
  const s = await registered(memory.token, 'r19-t10-app', 'r19-t10', 'work')
  const again = await s.send('register_agent', { name: 'r19-t10', context: 'both', surface: 'claude-code', description: 'Again.' })
  assert.ok(again.text.startsWith('Welcome back, r19-t10: a both agent on'), again.text)
  assert.deepEqual(sql(`select context from memory.agent where name = 'r19-t10'`), [{ context: 'both' }])
  assert.equal(countOf('agent', `name = 'r19-t10'`), 1)
  await s.send('register_agent', { name: 'r19-t10b', context: 'work', surface: 'claude-code', description: 'Renamed.' })
  assert.deepEqual(sql(`select agent from memory.agent_binding where principal = 'clyde-test' and client = 'r19-t10-app'`), [{ agent: 'r19-t10b' }])
  const next = await open(memory.token, 'r19-t10-app')
  const wrote = await next.send('remember', note(`t10 ${nonce()}`))
  assert.equal(wrote.error, false, wrote.text)
  assert.ok(sql(`select s.title from memory.entry e join memory.source s on s.id = e.source_id where e.id = '${idOf(wrote.text)}'`)[0].title.startsWith('r19-t10b, '))
})

// #23 criterion 11.
test("R19: a registered agent's note has a source naming the agent, its context and surface", { skip: SKIP }, async () => {
  const s = await registered(memory.token, 'r19-t11-app', 'r19-t11', 'work', 'claude-code')
  const wrote = await s.send('remember', note(`t11 ${nonce()}`, { scope: 'run:k19' }))
  assert.equal(wrote.error, false, wrote.text)
  assert.deepEqual(sql(`select s.kind, s.title from memory.entry e join memory.source s on s.id = e.source_id where e.id = '${idOf(wrote.text)}'`),
    [{ kind: 'session', title: 'r19-t11, a work agent on claude-code, through remember' }])
})

// #23 criterion 12.
test("R19: a registered agent's messages carry its name, and a caller can't set another", { skip: SKIP }, async () => {
  const s = await registered(memory.token, 'r19-t12-app', 'r19-t12')
  const b = `msg ${nonce()}`
  const r = await s.send('post_message', { to: 'codex', body: b, from: 'r19-b' })
  assert.match(r.text, /^Posted message/, r.text)
  assert.deepEqual(sql(`select sender from memory.message where body = '${b}'`), [{ sender: 'r19-t12' }])
  const inbox = (await call('GET', '/messages/codex', bearer(memory.token))).text
  assert.equal(inbox.split('from r19-t12 to codex').length - 1, 1, inbox)
  assert.equal(inbox.split(b).length - 1, 1)
})

// #23 criterion 13.
test("R19: post_message to an agent's name reaches only that agent, once, even when another client is named after it", { skip: SKIP }, async () => {
  const a = await registered(memory.token, 'r19-t13-app-a', 'r19-t13a')
  const b = await registered(memory.token, 'r19-t13-app-b', 'r19-t13b')
  const c = await registered(memory.token, 'r19-t13b', 'r19-t13c')
  const body = `to b ${nonce()}`
  assert.match((await a.send('post_message', { to: 'r19-t13b', body })).text, /^Posted message/)
  const first = await b.send('check_messages', {})
  assert.equal(first.text.split(body).length - 1, 1, first.text)
  assert.equal((await b.send('check_messages', {})).text, 'No new messages.')
  assert.ok(!(await c.send('check_messages', {})).text.includes(body), 'the client named r19-t13b is not the agent r19-t13b')
  for (const name of ['claude', 'codex']) assert.ok(!(await call('GET', `/messages/${name}`, bearer(memory.token))).text.includes(body))
})

// #23 criterion 14.
test('R19: post_message to an unknown name is refused and stores nothing', { skip: SKIP }, async () => {
  const s = await registered(memory.token, 'r19-t14-app', 'r19-t14')
  const n = countOf('message', 'true')
  const r = await s.send('post_message', { to: 'r19-nobody', body: 'hi' })
  assert.equal(r.text, "Need a recipient (claude, codex, all, or a registered agent's name) and a body.")
  assert.equal(countOf('message', 'true'), n)
})

// #23 criterion 15.
test('R19: a registered claude agent still reads messages to claude and to all, once each', { skip: SKIP }, async () => {
  const reader = await registered(memory.token, 'claude-code-r19', 'r19-t15')
  const poster = await registered(memory.token, 'r19-t15p-app', 'r19-t15p')
  const [b1, b2] = [`to claude ${nonce()}`, `to all ${nonce()}`]
  assert.match((await poster.send('post_message', { to: 'claude', body: b1 })).text, /^Posted message/)
  assert.match((await poster.send('post_message', { to: 'all', body: b2 })).text, /^Posted message/)
  const got = (await reader.send('check_messages', {})).text
  assert.equal(got.split(b1).length - 1, 1, got)
  assert.equal(got.split(b2).length - 1, 1, got)
})

// #23 criterion 17.
test("R19: another credential can't take over a registered agent's name or its messages", { skip: SKIP }, async () => {
  await registered(memory.token, 'r19-t17-app', 'r19-t17')
  const t2 = newDevice('r19-t17-dev')
  const thief = await open(t2, 'r19-t17-app')
  const r = await thief.send('register_agent', { name: 'r19-t17', context: 'personal', surface: 'x', description: 'y' })
  assert.equal(r.error, true)
  assert.deepEqual(sql(`select context, surface, description, registered_by from memory.agent where name = 'r19-t17'`),
    [{ context: 'work', surface: 'claude-code', description: 'r19-t17, a tier 3 agent.', registered_by: 'clyde-test' }])
  assert.equal(countOf('agent_binding', `principal = 'r19-t17-dev' and agent = 'r19-t17'`), 0)
  const poster = await registered(memory.token, 'r19-t17p-app', 'r19-t17p')
  const body = `for t17 ${nonce()}`
  await poster.send('post_message', { to: 'r19-t17', body })
  assert.ok(!(await thief.send('check_messages', {})).text.includes(body))
})

// #23 criterion 20 (a session id minted for one credential).
test('R19: a session id minted for one credential is not registered under another', { skip: SKIP }, async () => {
  const owner = await registered(memory.token, 'r19-t18-app', 'r19-t18')
  const poster = await registered(memory.token, 'r19-t18p-app', 'r19-t18p')
  const body = `for t18 ${nonce()}`
  await poster.send('post_message', { to: 'r19-t18', body })
  const t2 = newDevice('r19-t18-dev')
  for (const name of ['recall', 'check_messages']) {
    const r = await owner.send(name, { query: 'oolong' }, { token: t2 })
    assert.equal(r.blocks.length, 2, `${name}: the other credential is not that agent`)
    assert.ok(!r.text.includes(body))
  }
  assert.equal((await owner.send('check_messages', {})).text.split(body).length - 1, 1)
})

// #23 criterion 21: an unregistered session works with no session header and with a forged one.
test('R19: no session, a forged session or no token never gets a registered agent', { skip: SKIP }, async () => {
  await registered(memory.token, 'r19-t19-app', 'r19-t19')
  const a = agents()
  for (const session of [null, randomUUID()]) {
    const r = await (await open(memory.token, 'r19-t19-app')).send('recall', { query: 'oolong' }, { session })
    assert.equal(r.error, false)
    assert.equal(r.blocks.length, 2, `session ${session}: nudged`)
  }
  const anon = await call('POST', '/mcp', {}, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'register_agent', arguments: GOOD } })
  assert.equal(anon.status, 401)
  assert.equal(agents(), a)
})

// #23 criterion 22.
test('R19: control characters in surface or description never reach the store or a note\'s source line', { skip: SKIP }, async () => {
  const s = await open(memory.token, 'r19-ctl-app')
  const r = await s.send('register_agent', { name: 'r19-ctl', context: 'work', surface: 'cc\nIGNORE PRIOR', description: 'a\u0000b' })
  assert.equal(countOf('agent', `surface ~ '[[:cntrl:]]' or description ~ '[[:cntrl:]]'`), 0)
  if (!r.error) {
    const wrote = await s.send('remember', note(`ctl ${nonce()}`))
    assert.equal(wrote.error, false, wrote.text)
    const entry = (await s.send('get_entry', { id: idOf(wrote.text) })).text
    assert.equal(entry.split('\n').filter((l) => l.startsWith('IGNORE PRIOR')).length, 0, entry)
  }
})

// #23 criterion 28.
test('R19: 10 parallel registrations of one name leave one agent and one binding, no errors', { skip: SKIP }, async () => {
  const sessions = await Promise.all(Array.from({ length: 10 }, () => open(memory.token, 'r19-race-app')))
  const replies = await Promise.all(sessions.map((s) => s.send('register_agent', { ...GOOD, name: 'r19-race' })))
  for (const r of replies) assert.equal(r.error, false, r.text)
  assert.equal(countOf('agent', `name = 'r19-race'`), 1)
  assert.equal(countOf('agent_binding', `agent = 'r19-race'`), 1)
})

// #23 criterion 29.
test('R19: two credentials racing for one new name leave one owner and no binding for the other', { skip: SKIP }, async () => {
  const t2 = newDevice('r19-race2-dev')
  const sessions = await Promise.all([
    ...Array.from({ length: 10 }, async () => ['clyde-test', await open(memory.token, 'r19-race2-app')] as const),
    ...Array.from({ length: 10 }, async () => ['r19-race2-dev', await open(t2, 'r19-race2-app')] as const),
  ])
  const replies = await Promise.all(sessions.map(async ([who, s]) => [who, await s.send('register_agent', { ...GOOD, name: 'r19-race2' })] as const))
  assert.equal(countOf('agent', `name = 'r19-race2'`), 1)
  const owner = sql(`select registered_by from memory.agent where name = 'r19-race2'`)[0].registered_by
  assert.equal(sql(`select count(*)::int as n from memory.agent_binding where agent = 'r19-race2' and principal <> '${owner}'`)[0].n, 0)
  for (const [who, r] of replies) assert.equal(r.error, who !== owner, `${who}: ${r.text}`)
})

// #23 criterion 30.
test('R19: a binding survives the device token rotating, and a rotated or revoked token reaches nothing', { skip: SKIP }, async () => {
  const claim = async () => JSON.parse((await call('POST', '/devices/claim', bearer(jwt({ sub: 'user', email: sql('select email from memory.allowed_email')[0].email, jti: randomUUID() })), { name: 'r19-box' })).text).token as string
  const t1 = await claim()
  await registered(t1, 'r19-rot-app', 'r19-rot')
  const t2 = await claim()
  const s = await open(t2, 'r19-rot-app')
  const r = await s.send('recall', { query: 'oolong' })
  assert.equal(r.blocks.length, 1, 'no register_agent call needed')
  assert.equal(agentOf(s.id), 'r19-rot')
  assert.equal((await call('POST', '/mcp', bearer(t1), { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401)
  assert.equal((await admin('DELETE', '/devices/r19-box')).status, 200)
  assert.equal((await call('POST', '/mcp', bearer(t2), { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401)
})

// #23 criterion 31.
test('R19: deleting an agent unbinds it, and its sessions hear the nudge again', { skip: SKIP }, async () => {
  const s = await registered(memory.token, 'r19-del-app', 'r19-del')
  sql(`delete from memory.agent where name = 'r19-del'`)
  assert.equal(countOf('agent_binding', `agent = 'r19-del'`), 0)
  assert.equal(agentOf(s.id), null)
  const r = await s.send('recall', { query: 'oolong' })
  assert.equal(r.error, false)
  assert.equal(r.blocks.length, 2)
})

// #23 criterion 35.
test('R19: the overview counts a registered agent\'s unread messages', { skip: SKIP }, async () => {
  const reader = await registered(memory.token, 'r19-t24-app', 'r19-t24')
  const poster = await registered(memory.token, 'r19-t24p-app', 'r19-t24p')
  const overview = async () => JSON.parse((await admin('GET', '/overview')).text).counts
  const before = await overview()
  assert.match((await poster.send('post_message', { to: 'r19-t24', body: `unread ${nonce()}` })).text, /^Posted message/)
  const after = await overview()
  assert.equal(after.unread['r19-t24'], 1)
  assert.equal(after.unread_messages - before.unread_messages, 1)
  await reader.send('dismiss_messages', { ids: 'all' })
})

// #23 criterion 33 and 34, with R41's table.
test('R19: the agent schema is idempotent and keyed and cascades as designed', { skip: SKIP }, async () => {
  apply('20261103040000_identity.sql')
  apply('20261103040000_identity.sql')
  const defs = (table: string) => sql(`select pg_get_constraintdef(c.oid) as def from pg_constraint c where c.conrelid = 'memory.${table}'::regclass`).map((r) => r.def as string).join('\n')
  for (const part of ['PRIMARY KEY (name)', '^[a-z0-9][a-z0-9-]{1,39}$', "'work'::text"]) assert.ok(defs('agent').includes(part), `agent: ${part}\n${defs('agent')}`)
  for (const part of ['PRIMARY KEY (principal, client)', 'REFERENCES memory.agent(name) ON DELETE CASCADE']) assert.ok(defs('agent_binding').includes(part), part)
  assert.ok(defs('mcp_client').includes('REFERENCES memory.agent(name) ON DELETE SET NULL'))
  for (const part of ['PRIMARY KEY (entry_id)', 'REFERENCES memory.entry(id) ON DELETE CASCADE']) assert.ok(defs('entry_provenance').includes(part), part)
})

// ----------------------------------------------------------------------------------------------------- R41

const POSTHOG = '/Users/w/code/posthog'
const SETS = ['index.v1', 'hybrid.v1', 'spreading.v1', 'hybrid.v3']

/** Serves one parameter set to every new session. */
async function serve(id: string) {
  const known = sql('select id from memory.param_set').map((r) => r.id as string)
  const rows = [...new Set([...known.filter((p) => /^(index|hybrid|spreading)\./.test(p)), id])]
    .map((param_set) => param_set === id ? { param_set, role: 'default', weight: 1000 } : { param_set, role: 'off', weight: 0 })
  const r = await admin('PUT', '/allocation', { rows })
  assert.equal(r.status, 200, r.text)
}

/** The provenance lines in a packet: from the word "from" to the end of the line. */
const lines = (packet: string) => [...packet.matchAll(/from \S+ on [^\n]*/g)].map((m) => m[0].trim())
const rid = (packet: string) => /retrieval ([0-9a-f-]{36})/.exec(packet)![1]

/** Ties an MCP session to a Claude Code session in this folder, the way memory-hook's PostToolUse on recall does. */
async function inFolder(token: string, s: Awaited<ReturnType<typeof open>>, cwd: string) {
  const recalled = await s.send('recall', { query: 'oolong' })
  const hook = await call('POST', '/hooks/PostToolUse?agent=codex', bearer(token),
    { session_id: `cs-${nonce()}`, cwd, tool_name: 'mcp__memory__recall', tool_response: recalled.text })
  assert.equal(hook.status, 200, hook.text)
}

const mini = () => newDevice('mac-mini')
const air = () => newDevice('macbook-air')
let tokens: { mini: string; air: string }
const W = { one: word(), two: word(), three: word(), own: word() }

// #45 criterion 1.
test('R41: provenance is recorded from the token, the client, the hook data and the scope, not the payload', { skip: SKIP }, async () => {
  tokens = { mini: mini(), air: air() }
  const s = await open(tokens.mini, 'codex-mcp-client')
  await inFolder(tokens.mini, s, POSTHOG)
  assert.deepEqual(sql(`select cwd, repo from memory.mcp_session where id = '${s.id}'`), [{ cwd: POSTHOG, repo: 'posthog' }])
  const wrote = await s.send('remember', note(`${W.one} codex note`, { body: `${W.one} is how codex on the mini does it.` }))
  assert.equal(wrote.error, false, wrote.text)
  assert.deepEqual(sql(`select device, agent, agent_context, repo, cwd, session, run_scope from memory.entry_provenance where entry_id = '${idOf(wrote.text)}'`),
    [{ device: 'mac-mini', agent: 'codex', agent_context: null, repo: 'posthog', cwd: POSTHOG, session: s.id, run_scope: null }])
  const scoped = await s.send('remember', note(`${W.one} scoped`, { scope: 'run:p41' }))
  assert.equal(sql(`select run_scope from memory.entry_provenance where entry_id = '${idOf(scoped.text)}'`)[0].run_scope, 'run:p41')
  // A registered agent's context rides along.
  const reg = await registered(tokens.mini, 'r41-reg-app', 'r41-reg', 'personal')
  const mine = await reg.send('remember', note(`${W.one} registered`))
  assert.deepEqual(sql(`select agent, agent_context from memory.entry_provenance where entry_id = '${idOf(mine.text)}'`), [{ agent: 'r41-reg', agent_context: 'personal' }])
})

// #45 criterion 2, on every arm.
test("R41: recall shows another machine's note with its origin, on every arm and in the On trial list", { skip: SKIP }, async () => {
  for (const set of SETS) {
    await serve(set)
    const s = await open(tokens.air, 'claude-code-p2')
    const packet = (await s.send('recall', { query: `${W.one} codex note` })).text
    assert.ok(packet.includes('from codex on mac-mini'), `${set}:\n${packet}`)
    assert.ok(packet.includes('repo:posthog'), `${set}:\n${packet}`)
  }
})

// #45 criterion 3.
test("R41: the reader's own notes are marked, and another agent's are not", { skip: SKIP }, async () => {
  await serve('hybrid.v1')
  const s = await open(tokens.air, 'claude-code-p3')
  const wrote = await s.send('remember', note(`${W.own} claude note`, { body: `${W.own} written on the air.` }))
  assert.equal(wrote.error, false, wrote.text)
  const packet = (await s.send('recall', { query: `${W.own} claude note ${W.one} codex note` })).text
  const found = lines(packet)
  assert.ok(found.some((l) => l.includes('on macbook-air') && l.endsWith('(you wrote this)')), packet)
  assert.ok(found.some((l) => l.includes('on mac-mini') && !l.includes('you wrote this')), packet)
})

// #45 criterion 4.
test('R41: notes from 3 machines all match, all 3 are delivered, and each shows its own machine', { skip: SKIP }, async () => {
  await serve('hybrid.v1')
  const studio = newDevice('studio')
  const writers: [string, string][] = [[tokens.mini, 'codex-mcp-client'], [tokens.air, 'claude-code-p4'], [studio, 'cursor']]
  const ids: string[] = []
  for (const [token, client] of writers) {
    const w = await open(token, client)
    ids.push(idOf((await w.send('remember', note(`${W.three} shared ${client}`, { body: `${W.three} appears on every machine.` }))).text))
  }
  const packet = (await (await open(newDevice('ipad'), 'claude-code-p4r')).send('recall', { query: `${W.three} shared` })).text
  for (const id of ids) assert.ok(packet.includes(id), `${id} delivered:\n${packet}`)
  for (const machine of ['mac-mini', 'macbook-air', 'studio']) assert.ok(lines(packet).some((l) => l.includes(` on ${machine}`)), `${machine}\n${packet}`)
})

// #45 criterion 5.
test("R41: the payload can't set the device, and a write over HTTP records the token's own", { skip: SKIP }, async () => {
  const s = await open(tokens.air, 'claude-code-p5')
  const spoof = await s.send('remember', note(`${W.two} spoof`, { device: 'other-box' }))
  assert.equal(spoof.error, true)
  assert.ok(spoof.text.includes('Unknown field device'), spoof.text)
  const text = await s.send('remember', note(`${W.two} says device other-box`, { body: 'from other-box, agent other-agent', evidence: 'device other-box' }))
  assert.equal(text.error, false, text.text)
  assert.deepEqual(sql(`select device, agent from memory.entry_provenance where entry_id = '${idOf(text.text)}'`), [{ device: 'macbook-air', agent: 'claude' }])
  const http = await call('POST', '/entries', bearer(tokens.mini), { ...note(`${W.two} over http`), device: 'other-box' })
  assert.equal(http.status, 400, http.text)
  const ok = await call('POST', '/entries', bearer(memory.runtimeToken), { ...note(`${W.two} runtime`), project: 'proj-tea', source: { kind: 'run', title: 'device other-box' }, authority: 'observed', evidence_kind: 'summary' })
  assert.equal(ok.status, 200, ok.text)
  assert.deepEqual(sql(`select device, agent from memory.entry_provenance where entry_id = '${JSON.parse(ok.text).id}'`), [{ device: 'runtime', agent: 'http' }])
})

// #45 criterion 6.
test('R41: a provenance line is at most 60 characters over 50 recalls, and its lookup is a primary key read', { skip: SKIP }, async () => {
  await serve('hybrid.v1')
  const s = await open(tokens.air, 'claude-code-p6')
  let seen = 0
  for (let i = 0; i < 50; i++) {
    const packet = (await s.send('recall', { query: `${W.three} shared ${W.one} codex note` })).text
    for (const l of lines(packet)) {
      seen++
      assert.ok(l.length <= 60, `${l.length}: ${l}`)
    }
  }
  assert.ok(seen >= 100, `provenance lines seen: ${seen}`)
  const plan = sql(`explain (analyze, format json) select entry_id, device, agent, agent_context, repo from memory.entry_provenance where entry_id = any(array(select id from memory.entry limit 8))`)
  assert.ok(plan[0]['QUERY PLAN'][0]['Execution Time'] < 10, JSON.stringify(plan[0]['QUERY PLAN'][0]['Execution Time']))
  const latencies = sql(`select latency_ms from memory.retrieval where mcp_session = '${s.id}' order by latency_ms`)
  assert.equal(latencies.length, 50)
})

// #45 criterion 7.
test('R41: one function words provenance for every arm\'s packet', { skip: SKIP }, () => {
  const dir = join(repoRoot(), 'memory', 'supabase', 'functions', 'memory')
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('_test.ts'))
  const defined = files.filter((f) => /function provenanceLine\b/.test(readFileSync(join(dir, f), 'utf8')))
  assert.deepEqual(defined, ['provenance.ts'])
  for (const f of ['search.ts', 'service.ts', 'trial.ts']) {
    const code = readFileSync(join(dir, f), 'utf8')
    assert.ok(!/you wrote this|`from \$\{|in repo:/.test(code), `${f} words provenance itself`)
  }
  assert.ok(/provenanceLines\(/.test(readFileSync(join(dir, 'service.ts'), 'utf8')), 'service.ts loads the lines through provenance.ts')
  for (const f of ['search.ts', 'trial.ts']) assert.ok(/\.provenance\b/.test(readFileSync(join(dir, f), 'utf8')), `${f} prints the line it was given`)
})

// ----------------------------------------------------------------------------------------------------- backup and routes

// #23 criterion 32 and 33, and R41's table.
test('R19: the export carries every agent, binding and provenance row, and a restore loads them back', { skip: SKIP }, async () => {
  const listed = JSON.parse((await call('GET', '/export', bearer(BACKUP))).text).tables as { table: string; rows: number }[]
  const names = listed.map((t) => t.table)
  assert.ok(names.indexOf('agent') >= 0 && names.indexOf('agent') < names.indexOf('agent_binding'))
  assert.ok(names.indexOf('agent_binding') < names.indexOf('mcp_client'))
  assert.ok(names.indexOf('entry') < names.indexOf('entry_provenance'))
  const page = async (table: string) => (await call('GET', `/export?table=${table}&offset=0`, bearer(BACKUP))).text
  const rowsOf = (text: string) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l).row)
  const keep = { agent: agents(), agent_binding: bindings(), provenance: countOf('entry_provenance', 'true'), sessions: countOf('mcp_client', 'agent is not null') }
  assert.ok(keep.agent >= 3 && keep.agent_binding >= 3 && keep.provenance >= 3)
  for (const [table, order] of [['agent', 'name'], ['agent_binding', 'principal, client']]) {
    assert.equal(listed.find((t) => t.table === table)!.rows, sql(`select count(*)::int as n from memory.${table}`)[0].n)
    assert.deepEqual(rowsOf(await page(table)), sql(`select * from memory.${table} order by ${order}`))
  }
  const ndjson = [await page('agent'), await page('agent_binding'), await page('mcp_client'), await page('entry_provenance')].join('')
  sql('delete from memory.agent')
  sql('delete from memory.mcp_client')
  sql('delete from memory.entry_provenance')
  assert.equal(agents(), 0)
  const restored = await admin('POST', '/import', ndjson)
  assert.equal(restored.status, 200, restored.text)
  assert.deepEqual({ agent: agents(), agent_binding: bindings(), provenance: countOf('entry_provenance', 'true'), sessions: countOf('mcp_client', 'agent is not null') }, keep)
})

// #23 criterion 16, the last test because it empties the registry.
test('R19: hooks and HTTP routes keep working with no agent registered', { skip: SKIP }, async () => {
  sql('delete from memory.agent')
  const device = bearer(memory.token)
  const project = { id: 'run-r19', pattern: 'projects', title: 'Run r19', body: 'The r19 run.', authority: 'observed', scope: 'run:r19',
    evidence_kind: 'summary', evidence: 'Tier 3 made it.', source: { kind: 'run', title: 'clyde run r19', uri: 'clyde://runs/r19' } }
  const wrote = await call('POST', '/entries', bearer(memory.runtimeToken), project)
  const hook = await call('POST', '/hooks/UserPromptSubmit?agent=claude', device, { session_id: 'r19-hook', prompt: 'hello' })
  const inbox = await call('GET', '/messages/codex', device)
  const recalled = await call('POST', '/recall', device, { query: 'oolong' })
  const got = await call('GET', `/entries/${JSON.parse(wrote.text).id}`, device)
  for (const r of [wrote, hook, inbox, recalled, got]) assert.equal(r.status, 200, r.text)
  assert.equal(agents(), 0)
})
