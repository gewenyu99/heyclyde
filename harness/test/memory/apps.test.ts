/**
 * Tier 3: R67 (#72), the function's side of the cards. A chat app that renders MCP Apps gets the card links, the card
 * resources and each result's card data in _meta. A coding app gets what it always got, byte for byte. Against the real
 * memory function. ui.test.ts renders the cards themselves.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { SERVER_VERSION } from '../../../memory/supabase/functions/memory/version.ts'
import { bearer, bedFor, idOf, marker, nonce, note } from './bed.ts'
import { waitFor } from '../helpers.ts'
import { SKIP, sql, startRealMemory, type RealMemory } from './server.ts'

const UI = 'io.modelcontextprotocol/ui', MIME = 'text/html;profile=mcp-app', KEY = 'clyde/card'
const CARD_TOOLS: Record<string, string> = {
  recall: 'recall', recall_more: 'recall', get_entry: 'entry', get_blob: 'artifact', remember: 'remembered', list_quests: 'quests',
  post_quest: 'quests', claim_quest: 'quests', update_quest: 'quests', complete_quest: 'quests', abandon_quest: 'quests', register_agent: 'agent',
}
const DENO = process.env.MEMORY_TEST_DENO || 'deno'

let memory: RealMemory
let bed: ReturnType<typeof bedFor>

before(async () => {
  if (SKIP) return
  memory = await startRealMemory()
  bed = bedFor(memory)
})

after(async () => {
  await memory?.close()
})

type Session = {
  id: string; init: any
  rpc: (method: string, params?: Record<string, unknown>) => Promise<any>
  send: (name: string, args?: Record<string, unknown>) => Promise<any>
}

/** An MCP session. ui: true declares the MCP Apps extension, as a chat app that renders cards does. */
async function open(client: string, ui = false): Promise<Session> {
  const params: Record<string, unknown> = { protocolVersion: '2025-11-25', clientInfo: { name: client, version: '1' } }
  if (ui) params.capabilities = { extensions: { [UI]: { mimeTypes: [MIME] } } }
  const init = await bed.call('POST', '/mcp', bearer(memory.token), { jsonrpc: '2.0', id: 1, method: 'initialize', params })
  assert.equal(init.status, 200, init.text)
  const id = String(init.headers['mcp-session-id'])
  const rpc = async (method: string, p: Record<string, unknown> = {}) => {
    const r = await bed.call('POST', '/mcp', { ...bearer(memory.token), 'mcp-session-id': id }, { jsonrpc: '2.0', id: 2, method, params: p })
    assert.equal(r.status, 200, `${method}: ${r.text}`)
    return JSON.parse(r.text)
  }
  const send = async (name: string, args: Record<string, unknown> = {}) => (await rpc('tools/call', { name, arguments: args })).result
  return { id, init: JSON.parse(init.text).result, rpc, send }
}
const ui = () => open('r67-chat', true)
const textOf = (r: any) => r.content[0].text as string

/** INSTRUCTIONS and TOOLS as mcp.ts has them, which only deno loads. */
function surface(): { instructions: string; tools: any[] } {
  const r = spawnSync(DENO, ['run', '-A', '--node-modules-dir=none', join(import.meta.dirname, 'surface.ts'), '--dump'], { encoding: 'utf8', timeout: 120_000 })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

/** Embeds what's waiting, so every arm finds a new note. */
async function sync() {
  sql(`delete from memory.setting where name = 'embed_sync_status'`)
  const s = await bed.call('POST', '/embeddings/sync', bearer(memory.cronSecret))
  assert.equal(s.status, 202, s.text)
  await waitFor(() => {
    const [row] = sql(`select value from memory.setting where name = 'embed_sync_status'`)
    const v = row && JSON.parse(row.value)
    return v && !v.running ? v : null
  }, 60_000, 'the embedding sync')
}

test('R67 a UI client gets the card links and resources', { skip: SKIP }, async () => {
  const s = await ui()
  assert.ok(s.init.capabilities.resources, JSON.stringify(s.init.capabilities))
  assert.ok(s.init.capabilities.extensions?.[UI], JSON.stringify(s.init.capabilities))
  const tools = (await s.rpc('tools/list')).result.tools as any[]
  const linked = tools.filter((t) => t._meta?.ui?.resourceUri)
  assert.equal(linked.length, 12)
  for (const t of linked) {
    assert.equal(t._meta.ui.resourceUri, `ui://clyde/${CARD_TOOLS[t.name]}.html`, t.name)
    assert.equal(t._meta['openai/outputTemplate'], t._meta.ui.resourceUri, t.name)
  }
  const plain = tools.filter((t) => !(t.name in CARD_TOOLS))
  assert.equal(plain.length, 6)
  for (const t of plain) assert.equal(t._meta, undefined, t.name)
  const resources = (await s.rpc('resources/list')).result.resources as any[]
  assert.equal(resources.length, 6)
  for (const r of resources) assert.equal(r.mimeType, MIME, r.uri)
})

test('R67 resources/read serves each card', { skip: SKIP }, async () => {
  const s = await ui()
  for (const card of ['recall', 'entry', 'remembered', 'artifact', 'quests', 'agent']) {
    const uri = `ui://clyde/${card}.html`
    const r = (await s.rpc('resources/read', { uri })).result
    assert.equal(r.contents.length, 1, card)
    const [c] = r.contents
    assert.deepEqual([c.uri, c.mimeType, c.text.slice(0, 15), c._meta.ui.prefersBorder], [uri, MIME, '<!doctype html>', false], card)
  }
  const nope = await s.rpc('resources/read', { uri: 'ui://clyde/nope.html' })
  assert.equal(nope.error?.code, -32002, JSON.stringify(nope))
})

test('R67 code clients see the pre-R67 initialize and tools', { skip: SKIP }, async () => {
  const { instructions, tools } = surface()
  let same = 0
  for (const client of ['claude-code', 'codex-mcp-client', 'gemini-cli-mcp-client', 'antigravity']) {
    const s = await open(client)
    assert.deepEqual(s.init, {
      protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'memory', version: SERVER_VERSION }, instructions,
    }, client)
    const listed = (await s.rpc('tools/list')).result.tools as any[]
    assert.deepEqual(listed, tools, client)
    assert.equal(listed.filter((t) => '_meta' in t).length, 0, client)
    same++
  }
  assert.equal(same, 4)
})

test('R67 cards add _meta and leave the text alone', { skip: SKIP }, async () => {
  const writer = await open('claude-code')
  const made = await writer.send('remember', note(`r67 entry ${nonce()}`, { artifacts: [{ name: 'notes.txt', kind: 'document', text: 'r67 artifact text' }] }))
  assert.equal(made.isError, undefined, textOf(made))
  const e = idOf(textOf(made)), sha = /Blob notes\.txt: ([0-9a-f]{64})/.exec(textOf(made))![1]
  const q = await writer.send('post_quest', { title: `r67 quest ${nonce()}`, brief: 'A quest for the cards.', done_when: 'It shows on the board.' })
  assert.equal(q.isError, undefined, textOf(q))
  const [chat, code] = [await ui(), await open('claude-code')]
  const calls: [string, Record<string, unknown>, string][] = [
    ['get_entry', { id: e }, 'entry'], ['get_blob', { sha256: sha }, 'artifact'], ['list_quests', { context: 'all' }, 'quests'],
  ]
  for (const [name, args, card] of calls) {
    const [a, b] = [await chat.send(name, args), await code.send(name, args)]
    assert.equal(JSON.stringify(a.content), JSON.stringify(b.content), `${name}: the same text`)
    assert.deepEqual(Object.keys(b).filter((k) => k !== 'content' && k !== 'isError'), [], `${name}: nothing else for code`)
    assert.equal(a._meta?.[KEY]?.card, card, `${name}: ${JSON.stringify(a._meta)}`)
  }
  const title = `r67 saved ${nonce()}`
  const [a, b] = [await chat.send('remember', note(title)), await code.send('remember', note(`${title} too`))]
  assert.deepEqual(Object.keys(b).filter((k) => k !== 'content' && k !== 'isError'), [])
  assert.equal(a._meta[KEY].card, 'remembered')
  assert.equal(a._meta[KEY].entry.id, idOf(textOf(a)))
})

test('R67 the recall card lists what the recall delivered', { skip: SKIP }, async () => {
  const writer = await open('claude-code'), m = marker()
  for (let i = 0; i < 3; i++) assert.equal((await writer.send('remember', note(`${m} deploy note ${i}`, { body: `How ${m} deploys, part ${i}.` }))).isError, undefined)
  await sync()
  const s = await ui()
  const r = await s.send('recall', { query: `${m} deploys` })
  const card = r._meta[KEY], text = textOf(r)
  assert.equal(card.card, 'recall')
  assert.equal(card.retrieval_id, /^retrieval (\S+)/.exec(text)![1])
  const [row] = sql(`select delivered, on_trial from memory.retrieval where id = '${card.retrieval_id}'`)
  assert.deepEqual(card.items.map((i: any) => i.id), [...row.delivered, ...row.on_trial])
  assert.ok(card.items.length >= 1, text)
  for (const i of card.items) assert.ok(text.includes(i.id), `${i.id} is in the text`)
})

test('R67 cards redact private entries as the text does', { skip: SKIP }, async () => {
  const writer = await open('claude-code'), m = marker()
  const p = idOf(textOf(await writer.send('remember', note(`${m} private ledger`, {
    body: `The ${m} ledger is hidden.`, sensitivity: 'private', artifacts: [{ name: 'ledger.txt', kind: 'document', text: 'hidden' }],
  }))))
  await sync()
  const s = await ui()
  const r = await s.send('recall', { query: `${m} ledger` })
  const item = r._meta[KEY].items.find((i: any) => i.id === p)
  assert.ok(item, textOf(r))
  assert.deepEqual([item.private, item.body, item.quote, item.artifacts.length], [true, '[private entry: ask Wen]', null, 0])
  const g = await s.send('get_entry', { id: p })
  assert.equal(g._meta[KEY].entry.artifacts.length, 0)
  assert.equal(g._meta[KEY].entry.body, '[private entry: ask Wen]')
})

test('R67 errors render as error cards and missing data adds no card', { skip: SKIP }, async () => {
  const s = await ui()
  const claim = await s.send('claim_quest', { id: 999999999 })
  assert.equal(claim.isError, true)
  assert.match(claim._meta[KEY].error, /No quest #999999999/)
  const none = await s.send('get_entry', { id: 'r67-none' })
  assert.equal(textOf(none), 'No entry r67-none.')
  assert.equal(none._meta, undefined)
})

test('R67 card data stays fast', { skip: SKIP }, async () => {
  const writer = await open('claude-code')
  const e = idOf(textOf(await writer.send('remember', note(`r67 fast ${nonce()}`))))
  const s = await ui()
  const times: number[] = []
  for (let i = 0; i < 5; i++) {
    const t = performance.now()
    const r = await s.send('get_entry', { id: e })
    times.push(performance.now() - t)
    assert.equal(r._meta[KEY].card, 'entry')
  }
  times.sort((a, b) => a - b)
  assert.ok(times[2] < 1000, `median ${times[2]} ms`)
})

// ChatGPT signs in through these callbacks (developers.openai.com/apps-sdk/build/auth).
test('R67 ChatGPT\'s OAuth callbacks are allowed', { skip: SKIP }, async () => {
  const owner = sql('select email from memory.allowed_email')[0].email as string
  const cases: [string, string, 'approve' | 'deny'][] = [
    ['chatgpt', 'https://chatgpt.com/connector_platform_oauth_redirect', 'approve'],
    ['chatgpt-id', 'https://chatgpt.com/connector/oauth/abc123', 'approve'],
    ['evil-chatgpt-sub', 'https://chatgpt.com.evil.example/cb', 'deny'],
    ['evil-chatgpt-http', 'http://chatgpt.com/connector_platform_oauth_redirect', 'deny'],
  ]
  for (const [name, target, want] of cases) {
    const id = `r67-app-${name}-0001`, code = `pkce-${name}`
    sql(`insert into memory.oauth_consent (authorization_id, code_verifier) values ('${id}', 'verifier-${name}')`)
    memory.auth.signIns[code] = owner
    memory.auth.authorizations[id] = { redirect_uri: target, client: { id: `client-${name}`, name: `App ${name}` } }
    const r = await bed.call('GET', `/oauth/approve?authorization_id=${id}&code=${code}`)
    assert.equal(r.status, want === 'approve' ? 200 : 403, `${name}: ${r.text}`)
  }
})
