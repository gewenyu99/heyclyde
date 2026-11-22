/**
 * Tier 3: R47 (#52), the quest board. Agents post quests, claim them under a lease, report progress and complete them with
 * evidence and the entry the work produced. Fan-out to all reaches registered agents and the claude and codex families only,
 * and the SessionStart hook and the hook inbox show a board of at most 5 lines. Against the real memory function.
 *
 * Each test names its own agents (r47-<test>-...), so no other test's rows reach it. The tests that empty tables or reset
 * every quest come last.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { after, before, test } from 'node:test'
import { CLIENT_VERSION } from '../../../memory/supabase/functions/memory/version.ts'
import { bearer, bedFor, countOf, idOf, marker, nonce, note } from './bed.ts'
import { FAKE_REFUSE } from './openai.ts'
import { waitFor } from '../helpers.ts'
import { apply, SKIP, sql, startRealMemory, type RealMemory } from './server.ts'

const MIGRATION = '20261115000000_quest_board.sql'

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

type Reply = { text: string; error: boolean }
type Session = { id: string; send: (name: string, args?: Record<string, unknown>) => Promise<Reply> }

/** An MCP session for a token and client name. */
async function open(token = memory.token, client = 'claude-code'): Promise<Session> {
  const init = await bed.call('POST', '/mcp', bearer(token),
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: client } } })
  assert.equal(init.status, 200, init.text)
  const id = String(init.headers['mcp-session-id'])
  const send = async (name: string, args: Record<string, unknown> = {}): Promise<Reply> => {
    const r = await bed.call('POST', '/mcp', { ...bearer(token), 'mcp-session-id': id },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
    assert.equal(r.status, 200, `${name}: ${r.text}`)
    const res = JSON.parse(r.text).result
    return { text: res.content[0].text as string, error: Boolean(res.isError) }
  }
  return { id, send }
}

/** A session registered as `name`. Its client name is the agent's own unless given, so it is no family's. */
async function agent(name: string, context = 'work', token = memory.token, client = `${name}-app`): Promise<Session> {
  const s = await open(token, client)
  const r = await s.send('register_agent', { name, context, surface: 'claude-code', description: `${name}, a tier 3 agent.` })
  assert.equal(r.error, false, r.text)
  return s
}

const QUEST = /^Posted quest #(\d+): /
/** Posts a quest and gives back its id. */
async function post(s: Session, extra: Record<string, unknown> = {}): Promise<number> {
  const r = await s.send('post_quest', {
    title: `Fix the docs links ${nonce()}`, brief: 'The docs links in the guide point at old pages.',
    done_when: 'Every link in the guide answers 200.', ...extra,
  })
  assert.equal(r.error, false, r.text)
  return Number((QUEST.exec(r.text) ?? assert.fail(r.text))[1])
}

/** An entry the agent writes, standing for what its work produced. */
async function entryBy(s: Session): Promise<string> {
  const r = await s.send('remember', note(`work product ${nonce()}`))
  assert.equal(r.error, false, r.text)
  return idOf(r.text)
}

const quest = (id: number) => sql(`select * from memory.quest where id = ${id}`)[0]
const notes = (id: number, kind: string) => countOf('quest_note', `quest_id = ${id} and kind = '${kind}'`)
const leaseLeft = (id: number) => Number(sql(`select extract(epoch from lease_until - now())::float as s from memory.quest where id = ${id}`)[0].s)
const listed = (text: string) => new Set([...text.matchAll(/#(\d+)\b/g)].map((m) => Number(m[1])))
const lines = (text: string) => text.split('\n').filter((l) => l.trim() !== '')
const hookAuth = (token: string) => ({ ...bearer(token), 'x-memory-client-version': CLIENT_VERSION })

/** A new computer's token, with the device row auth.ts reads. */
function newDevice(name: string): string {
  const token = `device-${randomBytes(8).toString('hex')}`
  sql(`insert into memory.device (name, token_sha256) values ('${name}', '${createHash('sha256').update(token).digest('hex')}')`)
  return token
}

test('R47 post_quest stores an open quest with its poster\'s provenance', { skip: SKIP }, async () => {
  const s = await agent('r47-post1')
  const id = await post(s, { tags: ['docs'], priority: 'high' })
  assert.deepEqual(sql(`select state, context, assignee, posted_by, posted_device, priority, tags from memory.quest where id = ${id}`),
    [{ state: 'open', context: 'work', assignee: 'any', posted_by: 'r47-post1', posted_device: 'clyde-test', priority: 'high', tags: ['docs'] }])
  assert.equal(countOf('quest_note', `quest_id = ${id}`), 1)
  assert.equal(notes(id, 'post'), 1)
})

test('R47 post_quest refuses fields past their limits and writes nothing', { skip: SKIP }, async () => {
  const s = await agent('r47-post2')
  const ok = { title: 'A quest', brief: 'A brief.', done_when: 'It is done.' }
  const bad: Record<string, unknown>[] = [
    { title: 'x'.repeat(121) }, { brief: 'x'.repeat(501) }, { done_when: '' }, { done_when: 'x'.repeat(301) },
    { priority: 'unrecognized' }, { context: 'invalid-realm' }, { tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }, { for: 'Bad Name' },
  ]
  const before = countOf('quest', 'true')
  for (const b of bad) {
    const r = await s.send('post_quest', { ...ok, ...b })
    assert.equal(r.error, true, `${JSON.stringify(b).slice(0, 60)}: ${r.text}`)
  }
  assert.equal(countOf('quest', 'true'), before, 'nothing was written')
  const r = await s.send('post_quest', { ...ok, title: 't'.repeat(120), brief: 'b'.repeat(500) })
  assert.equal(r.error, false, r.text)
  assert.match(r.text, QUEST)
})

test('R47 quests pass the judge', { skip: SKIP }, async () => {
  const s = await agent('r47-judge')
  const posted = await s.send('post_quest', { title: 'Judged', brief: `Do this. ${FAKE_REFUSE}`, done_when: 'Done.' })
  assert.equal(posted.error, true, posted.text)
  assert.ok(posted.text.startsWith('Not '), posted.text)
  const id = await post(s)
  assert.equal((await s.send('claim_quest', { id })).error, false)
  const updated = await s.send('update_quest', { id, note: `Progress. ${FAKE_REFUSE}` })
  assert.equal(updated.error, true, updated.text)
  assert.ok(updated.text.startsWith('Not '), updated.text)
  const done = await s.send('complete_quest', { id, evidence: `It works. ${FAKE_REFUSE}`, entry_id: await entryBy(s) })
  assert.equal(done.error, true, done.text)
  assert.ok(done.text.startsWith('Not '), done.text)
  assert.equal(countOf('quest', `brief like '%${FAKE_REFUSE}%'`), 0)
  assert.equal(countOf('quest_note', `body like '%${FAKE_REFUSE}%'`), 0)
  assert.equal(quest(id).state, 'claimed')
})

test('R47 claim, update and complete a quest', { skip: SKIP }, async () => {
  const poster = await agent('r47-post3')
  const worker = await agent('r47-a3')
  const doneWhen = `The guide's ${nonce()} links all answer 200.`
  const id = await post(poster, { done_when: doneWhen })
  const entry = await entryBy(worker)
  const claimed = await worker.send('claim_quest', { id })
  assert.equal(claimed.error, false, claimed.text)
  assert.ok(claimed.text.includes(`Claimed quest #${id}`), claimed.text)
  assert.ok(claimed.text.includes(doneWhen), claimed.text)
  const left = leaseLeft(id)
  assert.ok(left >= 7190 && left <= 7200, `lease ${left}`)
  sql(`update memory.quest set lease_until = now() + interval '1 minute' where id = ${id}`)
  const updated = await worker.send('update_quest', { id, note: 'Half the links are fixed.' })
  assert.equal(updated.error, false, updated.text)
  const renewed = leaseLeft(id)
  assert.ok(renewed >= 7190 && renewed <= 7200, `renewed lease ${renewed}`)
  assert.equal(notes(id, 'progress'), 1)
  const done = await worker.send('complete_quest', { id, evidence: 'Every link answers 200 in the link checker.', entry_id: entry })
  assert.equal(done.error, false, done.text)
  const q = quest(id)
  assert.equal(q.state, 'done')
  assert.equal(q.claimed_by, 'r47-a3')
  assert.equal(q.result_entry, entry)
  assert.notEqual(q.closed_at, null)
  assert.notEqual(q.history_entry, null)
  const [history] = sql(`select title from memory.entry where id = '${q.history_entry}'`)
  assert.ok(history.title.startsWith(`Quest #${id} done: `), history.title)
  assert.equal(countOf('link', `src = '${q.history_entry}' and dst = '${entry}' and type = 'relates'`), 1)
})

test('R47 concurrent claims: exactly one agent wins', { skip: SKIP }, async () => {
  const poster = await agent('r47-post4')
  const id = await post(poster)
  const racers = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((i) => agent(`r47-c${i}`)))
  for (let round = 0; round < 10; round++) {
    sql(`update memory.quest set state = 'open', claimed_by = null, claimed_device = null, claimed_session = null, lease_until = null where id = ${id}`)
    const replies = await Promise.all(racers.map((s) => s.send('claim_quest', { id })))
    const won = replies.filter((r) => /^Claimed quest #/.test(r.text))
    assert.equal(won.length, 1, `round ${round}: ${replies.map((r) => r.text.slice(0, 60)).join(' | ')}`)
    assert.equal(replies.filter((r) => r.error).length, 7, `round ${round}`)
  }
})

test('R47 an expired lease reopens the quest', { skip: SKIP }, async () => {
  const poster = await agent('r47-post5')
  const a = await agent('r47-a4')
  const b = await agent('r47-b4')
  const id = await post(poster)
  assert.equal((await a.send('claim_quest', { id })).error, false)
  sql(`update memory.quest set lease_until = now() - interval '1 second' where id = ${id}`)
  const list = await b.send('list_quests', {})
  assert.ok(listed(list.text).has(id), list.text)
  const q = quest(id)
  assert.equal(q.state, 'open')
  assert.equal(q.claimed_by, null)
  assert.equal(notes(id, 'reopen'), 1)
  assert.equal((await b.send('claim_quest', { id })).error, false)
  const upd = await a.send('update_quest', { id, note: 'Still on it.' })
  assert.equal(upd.error, true, upd.text)
  assert.ok(upd.text.includes('r47-b4'), upd.text)
  const done = await a.send('complete_quest', { id, evidence: 'Done.', entry_id: await entryBy(a) })
  assert.equal(done.error, true, done.text)
  assert.ok(done.text.includes('r47-b4'), done.text)
})

test('R47 only the claimer updates or completes a quest', { skip: SKIP }, async () => {
  const poster = await agent('r47-post6')
  const a = await agent('r47-a5')
  const b = await agent('r47-b5')
  const id = await post(poster)
  assert.equal((await a.send('claim_quest', { id })).error, false)
  const before = countOf('quest_note', `quest_id = ${id}`)
  for (const r of [await b.send('update_quest', { id, note: 'Mine now.' }),
    await b.send('complete_quest', { id, evidence: 'Done.', entry_id: await entryBy(b) })]) {
    assert.equal(r.error, true, r.text)
    assert.ok(r.text.includes('claimed by r47-a5'), r.text)
  }
  assert.equal(countOf('quest_note', `quest_id = ${id}`), before)
  assert.equal(quest(id).state, 'claimed')
  assert.equal(quest(id).claimed_by, 'r47-a5')
})

test('R47 completing needs evidence and an entry that exists', { skip: SKIP }, async () => {
  const poster = await agent('r47-post7')
  const a = await agent('r47-a6')
  const id = await post(poster)
  assert.equal((await a.send('claim_quest', { id })).error, false)
  const entry = await entryBy(a)
  for (const args of [{ entry_id: entry }, { evidence: 'x'.repeat(2001), entry_id: entry }, { evidence: 'Done.' },
    { evidence: 'Done.', entry_id: 'r47-no-such-entry' }]) {
    const r = await a.send('complete_quest', { id, ...args })
    assert.equal(r.error, true, r.text)
  }
  assert.equal(quest(id).state, 'claimed')
  assert.equal(quest(id).result_entry, null)
})

test('R47 abandon_quest: the claimer releases it, the poster withdraws it', { skip: SKIP }, async () => {
  const poster = await agent('r47-post8')
  const a = await agent('r47-a7')
  const x = await agent('r47-x7')
  const id = await post(poster)
  assert.equal((await a.send('claim_quest', { id })).error, false)
  const released = await a.send('abandon_quest', { id, reason: 'Blocked on access to the docs repo.' })
  assert.equal(released.error, false, released.text)
  assert.equal(quest(id).state, 'open')
  assert.equal(quest(id).claimed_by, null)
  assert.equal(notes(id, 'release'), 1)
  const stranger = await x.send('abandon_quest', { id, reason: 'Not needed.' })
  assert.equal(stranger.error, true, stranger.text)
  assert.equal(quest(id).state, 'open')
  const withdrawn = await poster.send('abandon_quest', { id, reason: 'Not needed any more.' })
  assert.equal(withdrawn.error, false, withdrawn.text)
  assert.equal(quest(id).state, 'abandoned')
  assert.notEqual(quest(id).closed_at, null)
  assert.equal(notes(id, 'abandon'), 1)
  const late = await a.send('claim_quest', { id })
  assert.equal(late.error, true, late.text)
  assert.ok(late.text.includes('abandoned'), late.text)
})

test('R47 a quest tagged for an agent or family is annotated in list_quests and claimable with an advisory note', { skip: SKIP }, async () => {
  const poster = await agent('r47-post9')
  await agent('r47-a8')
  const b = await agent('r47-b8')
  const forCodex = await post(poster, { for: 'codex' })
  const forA = await post(poster, { for: 'r47-a8' })
  const claude = await open(memory.token, 'claude-code')
  const listedForClaude = await claude.send('list_quests', {})
  assert.ok(listed(listedForClaude.text).has(forCodex), listedForClaude.text)
  assert.ok(listedForClaude.text.includes('other: quest is for codex'), listedForClaude.text)
  const crossClaim = await claude.send('claim_quest', { id: forCodex })
  assert.equal(crossClaim.error, false, crossClaim.text)
  assert.ok(crossClaim.text.includes('quest is for codex'), crossClaim.text)
  assert.equal((await claude.send('abandon_quest', { id: forCodex, reason: 'handing to codex' })).error, false)
  const codex = await open(memory.token, 'codex-mcp-client')
  const codexClaim = await codex.send('claim_quest', { id: forCodex })
  assert.equal(codexClaim.error, false, codexClaim.text)
  assert.ok(!codexClaim.text.includes('tagged for another agent/scope'), codexClaim.text)
  const bClaim = await b.send('claim_quest', { id: forA })
  assert.equal(bClaim.error, false, bClaim.text)
  assert.ok(bClaim.text.includes('quest is for r47-a8'), bClaim.text)
  assert.equal((await b.send('abandon_quest', { id: forA, reason: 'handing to r47-a8' })).error, false)
  // The same profile again, in a session of its own.
  const a = await open(memory.token, 'r47-a8-app')
  const aClaim = await a.send('claim_quest', { id: forA })
  assert.equal(aClaim.error, false, aClaim.text)
  assert.ok(!aClaim.text.includes('tagged for another agent/scope'), aClaim.text)
})

test('R47 list_quests shows all owner quests with advisory tags and honors explicit state, mine, tag and context filters', { skip: SKIP }, async () => {
  const poster = await agent('r47-post10', 'both')
  const a = await agent('r47-a9')
  const home = await agent('r47-home9', 'personal')
  const w = await post(poster, { context: 'work', tags: ['r47t'] })
  const p = await post(poster, { context: 'personal' })
  const b = await post(poster, { context: 'both' })
  const w2 = await post(poster, { context: 'work' })
  const d = await post(poster, { context: 'work' })
  assert.equal((await a.send('claim_quest', { id: w2 })).error, false)
  assert.equal((await a.send('claim_quest', { id: d })).error, false)
  const evidence = `Checked ${nonce()} by hand.`
  assert.equal((await a.send('complete_quest', { id: d, evidence, entry_id: await entryBy(a) })).error, false)
  const defaultList = await a.send('list_quests', {})
  const mine = listed(defaultList.text)
  assert.ok(mine.has(w) && mine.has(b) && mine.has(p), [...mine].join(','))
  assert.ok(!mine.has(d), [...mine].join(','))
  const workOnly = listed((await a.send('list_quests', { context: 'work' })).text)
  assert.ok(workOnly.has(w) && workOnly.has(b) && !workOnly.has(p), [...workOnly].join(','))
  const personalOnly = listed((await home.send('list_quests', { context: 'personal' })).text)
  assert.ok(personalOnly.has(p) && personalOnly.has(b) && !personalOnly.has(w), [...personalOnly].join(','))
  const all = listed((await poster.send('list_quests', { context: 'all' })).text)
  assert.ok(all.has(w) && all.has(p) && all.has(b), [...all].join(','))
  const crossVisible = listed((await a.send('list_quests', { context: 'all' })).text)
  assert.ok(crossVisible.has(w) && crossVisible.has(b) && crossVisible.has(p), [...crossVisible].join(','))
  const tagged = listed((await a.send('list_quests', { tag: 'r47t' })).text)
  assert.ok(tagged.has(w) && !tagged.has(b), [...tagged].join(','))
  const own = listed((await a.send('list_quests', { show: 'mine' })).text)
  assert.ok(own.has(w2) && own.has(d) && !own.has(w), [...own].join(','))
  const done = await a.send('list_quests', { show: 'done' })
  assert.ok(listed(done.text).has(d), done.text)
  assert.ok(done.text.includes(evidence), done.text)
})

test('R47 recall finds a completed quest', { skip: SKIP }, async () => {
  const poster = await agent('r47-post11')
  const a = await agent('r47-a10')
  const m = marker()
  const id = await post(poster, { title: `Rename the ${m} pages` })
  assert.equal((await a.send('claim_quest', { id })).error, false)
  assert.equal((await a.send('complete_quest', { id, evidence: 'Renamed all eleven pages.', entry_id: await entryBy(a) })).error, false)
  // Every arm finds it once the embedding sync has run, as it does in production a minute after the write.
  sql(`delete from memory.setting where name = 'embed_sync_status'`)
  const sync = await bed.call('POST', '/embeddings/sync', bearer(memory.cronSecret))
  assert.equal(sync.status, 202, sync.text)
  await waitFor(() => {
    const [row] = sql(`select value from memory.setting where name = 'embed_sync_status'`)
    const v = row && JSON.parse(row.value)
    return v && !v.running ? v : null
  }, 60_000, 'the embedding sync')
  const reader = await open(memory.token, 'r47-reader-app')
  const r = await reader.send('recall', { query: `What did agents do about the ${m} pages?` })
  assert.equal(r.error, false, r.text)
  assert.ok(r.text.includes(`Quest #${id} done:`), r.text)
})

test('R47 quests link artifacts memory holds', { skip: SKIP }, async () => {
  const poster = await agent('r47-post12')
  const a = await agent('r47-a11')
  const text = `The plan, ${nonce()}: fix each link, then run the checker.`
  const wrote = await poster.send('remember', note(`plan ${nonce()}`, { artifacts: [{ name: 'plan.md', kind: 'document', text }] }))
  assert.equal(wrote.error, false, wrote.text)
  const sha = (/Blob plan\.md: ([0-9a-f]{64})/.exec(wrote.text) ?? assert.fail(wrote.text))[1]
  const id = await post(poster, { artifacts: [{ name: 'plan.md', sha256: sha }] })
  assert.deepEqual(sql(`select quest_id::int as quest_id, name, sha256 from memory.quest_blob where quest_id = ${id}`),
    [{ quest_id: id, name: 'plan.md', sha256: sha }])
  const claimed = await a.send('claim_quest', { id })
  assert.ok(claimed.text.includes('plan.md') && claimed.text.includes(sha), claimed.text)
  const before = countOf('quest', 'true')
  const bad = await poster.send('post_quest', { title: 'Bad artifact', brief: 'A brief.', done_when: 'Done.',
    artifacts: [{ name: 'x.md', sha256: 'a'.repeat(64) }] })
  assert.equal(bad.error, true, bad.text)
  assert.equal(countOf('quest', 'true'), before)
})

test('R47 the groom flags quests open over 30 days', { skip: SKIP }, async () => {
  const poster = await agent('r47-post13')
  const old = await post(poster)
  const young = await post(poster)
  sql(`update memory.quest set created_at = now() - interval '31 days' where id = ${old}`)
  sql(`update memory.quest set created_at = now() - interval '29 days' where id = ${young}`)
  const r = await bed.call('GET', '/api/v1/groom/sessions', bearer(memory.adminToken))
  assert.equal(r.status, 200, r.text)
  const stale: number[] = JSON.parse(r.text).stale_quests.map((q: { id: number }) => Number(q.id))
  assert.ok(stale.includes(old), JSON.stringify(stale))
  assert.ok(!stale.includes(young), JSON.stringify(stale))
})

test('R47 list_quests stays fast over 5,000 quests', { skip: SKIP }, async () => {
  const s = await agent('r47-perf')
  sql(`insert into memory.quest (title, brief, done_when, context, posted_by, posted_device, state, claimed_by, evidence, closed_at)
    select 'Seeded ' || g, 'A seeded brief.', 'Seeded done.', 'work', 'r47-seed', 'clyde-test',
      case when g <= 4000 then 'done' else 'open' end, case when g <= 4000 then 'r47-seed' end,
      case when g <= 4000 then 'Seeded evidence.' end, case when g <= 4000 then now() end
    from generate_series(1, 5000) g`)
  sql('analyze memory.quest')
  const times: number[] = []
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now()
    const r = await s.send('list_quests', {})
    times.push(performance.now() - t0)
    assert.equal(r.error, false, r.text)
    assert.ok([...r.text.matchAll(/^- #\d+ /gm)].length <= 20, r.text)
  }
  times.sort((a, b) => a - b)
  assert.ok(times[2] < 1000, `median ${times[2]} ms`)
  sql(`delete from memory.quest where posted_by = 'r47-seed'`)
})

test('R47 tools/list includes Paseo dispatch and the quest tools and the instructions teach the flow', { skip: SKIP }, async () => {
  const init = await bed.call('POST', '/mcp', bearer(memory.token),
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'r47-tools' } } })
  const instructions: string = JSON.parse(init.text).result.instructions
  for (const t of ['post_quest', 'claim_quest', 'update_quest', 'complete_quest']) assert.ok(instructions.includes(t), t)
  const list = await bed.call('POST', '/mcp', { ...bearer(memory.token), 'mcp-session-id': String(init.headers['mcp-session-id']) },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const tools: Record<string, any> = Object.fromEntries(JSON.parse(list.text).result.tools.map((t: any) => [t.name, t]))
  const required = (name: string) => tools[name]?.inputSchema.required ?? []
  assert.deepEqual(required('post_quest'), ['title', 'brief', 'done_when'])
  assert.deepEqual(required('list_quests'), [])
  assert.deepEqual(required('claim_quest'), ['id'])
  assert.deepEqual(required('update_quest'), ['id', 'note'])
  assert.deepEqual(required('complete_quest'), ['id', 'evidence', 'entry_id'])
  assert.deepEqual(required('abandon_quest'), ['id', 'reason'])
  const before: Record<string, string[]> = {
    register_agent: ['name', 'context', 'surface', 'description'], recall: ['query'], recall_more: ['retrieval_id'], get_entry: ['id'],
    get_blob: ['sha256'], upload_blob: ['sha256', 'size'], remember: ['pattern', 'title', 'body', 'evidence'], feedback: ['retrieval_id'],
    post_message: ['to', 'body'], check_messages: [], ack_messages: ['ids'], dismiss_messages: [],
  }
  for (const [name, req] of Object.entries(before)) assert.deepEqual(required(name), req, name)
  assert.deepEqual(required('dispatch_quest'), ['action'])
  assert.equal(Object.keys(tools).length, 19)
})

test('Paseo dispatchprioritizes urgent work, fences acknowledgements, and recovers the same lease', {skip: SKIP}, async () => {
  const poster = await agent('r47-paseo-poster');
  const [alice,bob] = await Promise.all([agent('paseo-dispatch-a'),agent('paseo-dispatch-b')]);
  const tag = 'paseotest';
  const normal = await post(poster,{tags:[tag]});
  const urgent = await post(poster,{priority:'urgent',tags:[tag]});
  const peek = await alice.send('dispatch_quest',{action:'peek',areas:[tag]});
  assert.equal(peek.error,false,peek.text);
  assert.equal(JSON.parse(peek.text).id,urgent);
  const claims = await Promise.all([alice,bob].map(a => a.send('dispatch_quest',{action:'claim',id:urgent,areas:[tag]})));
  const winners = claims.flatMap((c,i) => c.error ? [] : [{ session:[alice,bob][i], job:JSON.parse(c.text) }]);
  assert.equal(winners.length,1);
  const {session,job} = winners[0];
  const ack = {action:'ack',id:urgent,run:'r-'+job.assignment,assignment:job.assignment};
  assert.ok((await session.send('dispatch_quest',{...ack,assignment:'stale'})).error);
  assert.equal(JSON.parse((await session.send('dispatch_quest',ack)).text).run,ack.run);
  assert.equal(JSON.parse((await session.send('dispatch_quest',{action:'peek',areas:[tag]})).text).assignment,job.assignment);
  sql(`update memory.quest set lease_until = now() - interval '1 hour' where id = ${urgent}`);
  assert.equal(JSON.parse((await session.send('dispatch_quest',{action:'peek',areas:[tag]})).text).assignment,job.assignment);
  assert.equal(quest(normal).state,'open');
  // Exclusive manual vs automatic claim: while holding a dispatched quest, manual claim of another quest is refused.
  assert.ok((await session.send('claim_quest', { id: normal })).error);
  // Stale acked lease (>24h past lease_until) reopens and clears dispatch_id/dispatch_run cleanly.
  sql(`update memory.quest set lease_until = now() - interval '25 hours' where id = ${urgent}`);
  assert.equal(JSON.parse((await session.send('dispatch_quest', { action: 'peek', areas: [tag] })).text).id, urgent);
  const reopened = quest(urgent);
  assert.equal(reopened.state, 'open');
  assert.equal(reopened.dispatch_id, null);
  assert.equal(reopened.dispatch_run, null);
  // Conversely, a manual claim blocks auto-dispatch until released or completed.
  assert.equal((await session.send('claim_quest', { id: normal })).error, false);
  assert.equal((await session.send('dispatch_quest', { action: 'peek', areas: [tag] })).text, 'null');
  assert.ok((await session.send('dispatch_quest', { action: 'claim', id: urgent, areas: [tag] })).error);
  assert.equal((await session.send('abandon_quest', { id: normal, reason: 'done testing exclusivity' })).error, false);
});

test('Paseo account board sees other projects and claimed jobs while auto-dispatch still scopes workers', {skip:SKIP}, async()=>{
  const poster=await agent('paseo-global-author'), assignee=await agent('paseo-global-writer')
  await assignee.send('register_agent',{name:'paseo-global-writer',surface:'paseo',description:'Test writer',context:'work',projects:['owner/one'],strict_projects:true})
  const tag=`paseoscope${nonce()}`
  const outside=await post(poster,{project:'owner/two',tags:[tag]}),owned=await post(poster,{project:'owner/one',tags:[tag]})
  assert.equal((await assignee.send('claim_quest',{id:owned})).error,false)
  const display=await open(memory.token,'clyde-paseo-board')
  const list=await display.send('list_quests',{show:'board',after:outside-1,limit:1})
  assert.equal(list.error,false,list.text)
  const first=JSON.parse(list.text.split('\n')[0]);assert.equal(first.quests[0].id,outside);assert.equal(first.after,outside)
  const second=JSON.parse((await display.send('list_quests',{show:'board',after:first.after})).text.split('\n')[0])
  assert.ok(second.quests.some((q:any)=>q.id===owned && q.state==='claimed'))
  assert.ok((await assignee.send('list_quests',{show:'board'})).error)
  assert.equal((await assignee.send('dispatch_quest',{action:'peek',areas:[tag]})).text,'null')
})

// ------------------------------------------------------------------ the tests below empty tables or reset every quest

test('R47 the migration purges junk deliveries and keeps real ones', { skip: SKIP }, async () => {
  sql(`insert into memory.agent (name, context, surface, description, registered_by) values ('r47-reg2', 'work', 'claude-code', 'Tier 3.', 'clyde-test')`)
  const [m] = sql(`insert into memory.message (sender, recipient, body) values ('claude', 'all', 'r47 junk ${nonce()}') returning id`)
  sql(`insert into memory.message_delivery (message_id, recipient) select ${m.id}, n
    from unnest(array['check', 'install-sh', 'acceptance-check', 'codex', 'r47-reg2']) n`)
  apply(MIGRATION)
  const live = () => sql(`select recipient from memory.message_delivery where message_id = ${m.id} and acked_at is null and dropped_at is null
    order by recipient`).map((r) => r.recipient)
  assert.deepEqual(live(), ['codex', 'r47-reg2'])
  const total = countOf('message_delivery', 'true')
  apply(MIGRATION)
  assert.deepEqual(live(), ['codex', 'r47-reg2'])
  assert.equal(countOf('message_delivery', 'true'), total, 'a second apply changes nothing')
})

let hookToken = ''

test('R47 SessionStart shows the board in at most 5 lines', { skip: SKIP }, async () => {
  hookToken = newDevice('r47-hookdev')
  await agent('r47-hook', 'work', hookToken, 'claude-code')
  const poster = await agent('r47-post14', 'both')
  sql(`update memory.message_delivery set acked_at = now() where recipient = 'claude' and acked_at is null and dropped_at is null`)
  sql(`update memory.quest set state = 'abandoned', closed_at = now(), claimed_by = null, lease_until = null where state in ('open', 'claimed')`)
  const ids = sql(`with m as (insert into memory.message (sender, recipient, body) select 'codex', 'claude', 'r47 board ' || g
      from generate_series(1, 2) g returning id)
    insert into memory.message_delivery (message_id, recipient) select id, 'claude' from m returning message_id as id`).map((r) => Number(r.id))
  for (let i = 0; i < 6; i++) await post(poster, { context: 'work' })
  const personal = `Personal errand ${nonce()}`
  await post(poster, { context: 'personal', title: personal })
  const start = await bed.call('POST', '/hooks/SessionStart?agent=claude', hookAuth(hookToken), { session_id: `r47-${nonce()}` })
  assert.equal(start.status, 200, start.text)
  const got = lines(start.text)
  assert.ok(got.length >= 1 && got.length <= 5, start.text)
  assert.match(got[0], /^memory board: 2 unread messages, 6 open quests/)
  assert.ok(!start.text.includes(personal), start.text)
  for (const id of ids) {
    assert.notEqual(sql(`select acked_at from memory.message_delivery where message_id = ${id}`)[0].acked_at, null, `message ${id} is acknowledged`)
  }
  assert.equal((await bed.call('GET', '/messages/claude', hookAuth(hookToken))).text, '')
  sql(`update memory.quest set state = 'abandoned', closed_at = now() where state = 'open'`)
  const empty = await bed.call('POST', '/hooks/SessionStart?agent=claude', hookAuth(hookToken), { session_id: `r47-${nonce()}` })
  assert.equal(empty.status, 200)
  assert.equal(empty.text, '')
})

test('R47 the hook inbox shows a new quest once', { skip: SKIP }, async () => {
  assert.ok(hookToken, 'runs after the SessionStart test')
  const poster = await agent('r47-post15')
  const id = await post(poster, { context: 'work' })
  const first = await bed.call('GET', '/messages/claude', hookAuth(hookToken))
  assert.equal(first.status, 200, first.text)
  assert.ok(lines(first.text).length <= 5, first.text)
  assert.equal(first.text.split(`quest #${id}`).length - 1, 1, first.text)
  assert.equal((await bed.call('GET', '/messages/claude', hookAuth(hookToken))).text, '')

  // Quest #43: a quest assigned by named agent appears on that agent's SessionStart board via its client family hook.
  const namedId = await post(poster, { context: 'work', for: 'r47-hook', title: `Named target ${nonce()}` })
  const namedBoard = await bed.call('POST', '/hooks/SessionStart?agent=claude', hookAuth(hookToken), { session_id: `r47-named-${nonce()}` })
  assert.equal(namedBoard.status, 200, namedBoard.text)
  assert.ok(namedBoard.text.includes(`quest #${namedId}`), `expected named quest #${namedId} on board: ${namedBoard.text}`)
})

test('R47 all reaches registered agents and claude and codex, never unregistered names', { skip: SKIP }, async () => {
  sql(`delete from memory.message`)
  sql(`delete from memory.mcp_client`)
  sql(`delete from memory.event where agent is not null`)
  sql(`update memory.agent set last_seen = now() - interval '40 days'`)
  sql(`insert into memory.agent (name, context, surface, description, registered_by, last_seen) values
    ('r47-reg', 'work', 'claude-code', 'Tier 3.', 'clyde-test', now()),
    ('r47-gone', 'work', 'claude-code', 'Tier 3.', 'clyde-test', now() - interval '40 days')`)
  sql(`insert into memory.event (event, payload, agent, received_at) values
    ('SessionStart', '{}', 'check', now() - interval '1 day'), ('SessionStart', '{}', 'install-sh', now() - interval '1 day')`)
  sql(`insert into memory.mcp_client (session_id, client) values ('r47-junk-${nonce()}', 'acceptance-check')`)
  await open(memory.token, 'codex-mcp-client')
  const claude = await open(memory.token, 'claude-code')
  const said = await claude.send('post_message', { to: 'all', body: `Everyone, r47 ${nonce()}.` })
  const id = Number((/^Posted message (\d+) to all\.$/.exec(said.text) ?? assert.fail(said.text))[1])
  assert.deepEqual(sql(`select recipient from memory.message_delivery where message_id = ${id} order by recipient`).map((r) => r.recipient),
    ['codex', 'r47-reg'])
})
