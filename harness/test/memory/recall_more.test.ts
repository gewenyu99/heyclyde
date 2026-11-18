/**
 * Tier 3: R29 (#33), recall_more and recall's depth "deep", against the real memory function. A recall_more pages past a recall's
 * packet in the order the recall ranked, then into what recall hides: dormant and superseded entries, and for best-first spreading
 * the frontier it stopped at. Each page is a child retrieval of the recall, labelled item by item with kind, strength and state.
 *
 * Nothing in this file syncs embeddings, so the vector ranker finds nothing and every arm's candidates are the entries that match
 * the query's words. That's what lets a test pin a page to "R1's candidates 9 to 12".
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { repoRoot } from '../../src/config.ts'
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

const MIGRATION = '20261104000000_recall_more.sql'
const ARMS = { index: 'index.v1', hybrid: 'hybrid.v1', spreading: 'spreading.v1' } as const
type Arm = keyof typeof ARMS
const NOTHING_MORE = 'Nothing more in memory matches.'
const CAP_LINE = 'Memory ranks only the top 50 matches. Narrow the query to see more.'
const LABEL = /^    kind (fact|wen|observation|plan) · strength [01]\.\d\d · (settled|on trial, [123] left|dormant|superseded by [^ ,]+(, [^ ,]+)*)$/gm

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const admin = (method: string, path: string, body?: unknown) =>
  request(method, `${memory.url}/api/v1${path}`, { headers: bearer(memory.adminToken), body, timeoutMs: 30_000 })
const json = (r: { status: number; text: string }, status = 200) => {
  assert.equal(r.status, status, r.text)
  return JSON.parse(r.text)
}
/** A word no other test uses: letters only, so no stemmer or tokenizer splits it. */
const word = () => 'zq' + randomUUID().replaceAll('-', '').replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)]).slice(0, 12)
const count = (text: string, s: string) => text.split(s).length - 1
const rid = (text: string) => /^retrieval ([0-9a-f-]{36})$/m.exec(text.split('\n')[0])![1]
const rows = () => Number(sql('select count(*)::int as n from memory.retrieval')[0].n)
const retrieval = (id: string) => sql(`select * from memory.retrieval where id = '${id}'`)[0]
const conf = (id: string) => Number(sql(`select round(confidence::numeric, 2)::float as c from memory.entry where id = '${id}'`)[0].c)

/** An MCP session. tool() gives the text and whether it was an error. */
async function mcp(token = memory.token, client = 'claude-code') {
  const init = await request('POST', `${memory.url}/mcp`, {
    headers: bearer(token), timeoutMs: 15_000,
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: client } } },
  })
  assert.equal(init.status, 200, init.text)
  const session = String(init.headers['mcp-session-id'])
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await request('POST', `${memory.url}/mcp`, {
      headers: { ...bearer(token), 'mcp-session-id': session }, timeoutMs: 60_000,
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
    })
    assert.equal(r.status, 200, r.text)
    const out = JSON.parse(r.text)
    assert.ok(out.result, r.text)
    return { text: out.result.content[0].text as string, error: Boolean(out.result.isError) }
  }
  const rpc = async (method: string, params: unknown = {}) => JSON.parse((await request('POST', `${memory.url}/mcp`, {
    headers: { ...bearer(token), 'mcp-session-id': session }, timeoutMs: 15_000, body: { jsonrpc: '2.0', id: 3, method, params },
  })).text)
  return { session, tool, rpc, init: JSON.parse(init.text).result }
}
type Session = Awaited<ReturnType<typeof mcp>>

/** One entry by SQL, the way the criteria seed them. Confidences are written to 2 decimals. */
function seed(id: string, o: { title: string; body?: string; kind?: string; confidence?: number; chances?: number; scope?: string; sensitivity?: string; project?: string }) {
  const q = (s: string) => s.replaceAll("'", "''")
  sql(`insert into memory.entry (id, pattern, title, body, authority, scope, sensitivity, lang, valid_from, source_id, evidence_kind, evidence,
      evidence_sha256, project, kind, confidence, chances_left)
    values ('${id}', 'observations', '${q(o.title)}', '${q(o.body ?? 'A short body.')}', 'observed', '${o.scope ?? 'global'}',
      '${o.sensitivity ?? 'normal'}', 'en', '2026-11-01', 'src-a', 'assistant', 'seen', 'x', '${o.project ?? 'proj-tea'}',
      '${o.kind ?? 'observation'}', ${(o.confidence ?? 0.7).toFixed(2)}, ${o.chances ?? 0})`)
}
/** n settled entries at 0.70 whose titles hold `title`, ids <w>-00 and up. */
function settled(w: string, n: number, title = w, body?: string) {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = `${w}-${String(i).padStart(2, '0')}`
    seed(id, { title: `${title} note ${i}`, body })
    ids.push(id)
  }
  return ids
}

/** Serves one parameter set to every new session, and nothing else. */
async function serve(id: string) {
  const all = sql('select id from memory.param_set').map((r) => r.id as string)
  json(await admin('PUT', '/allocation', { by: 'wen', rows: all.map((param_set) => param_set === id ? { param_set, role: 'default', weight: 1000 } : { param_set, role: 'off', weight: 0 }) }))
}
/** A new session on the arm's set. */
async function on(arm: Arm | string) {
  await serve(arm in ARMS ? ARMS[arm as Arm] : arm)
  return await mcp()
}

const ids = (text: string) => [...text.matchAll(/^\[\d+\] (\S+): /gm)].map((m) => m[1])

/** Checks one recall_more reply item by item against the database: one label per delivered id, each item headed
 * "[n] <id>: <title>", the strength the entry's confidence to 2 places, and the state superseded, dormant, on trial or settled
 * in that order. */
function checkPage(text: string, delivered: string[]) {
  assert.equal([...text.matchAll(LABEL)].length, delivered.length, text)
  assert.deepEqual(ids(text), delivered, 'the delivered column is the reply\'s items, in order')
  const lines = text.split('\n')
  delivered.forEach((id, i) => {
    const [e] = sql(`select title, kind, round(confidence::numeric, 2)::float as c, chances_left,
        (select string_agg(l.src, ', ' order by l.src) from memory.link l where l.dst = e.id and l.type = 'supersedes') as by
      from memory.entry e where id = '${id}'`)
    const at = lines.indexOf(`[${i + 1}] ${id}: ${e.title}`)
    assert.ok(at >= 0, `item ${i + 1} is "[${i + 1}] ${id}: ${e.title}":\n${text}`)
    const state = e.by ? `superseded by ${e.by}` : e.c < 0.15 ? 'dormant' : e.chances_left > 0 ? `on trial, ${e.chances_left} left` : 'settled'
    assert.equal(lines[at + 1], `    kind ${e.kind} · strength ${e.c.toFixed(2)} · ${state}`)
  })
}

const calls = (from: number, path: string) => memory.openai.calls.slice(from).filter((c) => c.path === path).length

/** A recall, checked to have logged a row. */
async function recall(s: Session, query: string, extra: Record<string, unknown> = {}) {
  const r = await s.tool('recall', { query, ...extra })
  assert.equal(r.error, false, r.text)
  const id = rid(r.text)
  const row = retrieval(id)
  return { text: r.text, id, row, delivered: row.delivered as string[], candidates: (row.candidates as { id: string }[]).map((c) => c.id) }
}

/** One recall_more, checked: a new retrieval id on line 1, labels on every item, no judge call and at most one embedding. */
async function more(s: Session, parent: string, arm: string, extra: Record<string, unknown> = {}) {
  const from = memory.openai.calls.length
  const r = await s.tool('recall_more', { retrieval_id: parent, ...extra })
  assert.equal(r.error, false, r.text)
  assert.match(r.text.split('\n')[0], /^retrieval [0-9a-f-]{36}$/)
  const id = rid(r.text)
  assert.notEqual(id, parent)
  const row = retrieval(id)
  checkPage(r.text, row.delivered)
  assert.equal(calls(from, '/decisions'), 0, 'recall_more never asks the judge')
  assert.ok(calls(from, '/embeddings') <= (arm === 'index' ? 0 : 1), 'and embeds at most once')
  return { text: r.text, id, row, delivered: row.delivered as string[] }
}

/** recall_more on each new page's id until a page delivers nothing. */
async function pageToEnd(s: Session, first: string, arm: string) {
  const pages = []
  let at = first
  for (let i = 0; i < 20; i++) {
    const page = await more(s, at, arm)
    pages.push(page)
    if (!page.delivered.length) return pages
    at = page.id
  }
  throw new Error('recall_more never ran out')
}

/** Makes every unlearned recall old enough for the learner to settle without Wen's next prompt, then runs it to the end. */
async function learnNow() {
  sql(`update memory.retrieval set created_at = created_at - interval '31 minutes' where learned_at is null`)
  sql(`update memory.event set received_at = received_at - interval '31 minutes'`)
  for (let pass = 0; pass < 50; pass++) {
    const done = json(await request('POST', `${memory.url}/learn`, { headers: bearer(memory.cronSecret), timeoutMs: 120_000 }))
    if (!done.learned && !done.failed) break
  }
}

const logRows = (id: string) => sql(`select round(before::numeric, 2)::float as before, round(after::numeric, 2)::float as after, retrieval_id
  from memory.confidence_log where target = 'entry:${id}' order by at`)

// First in the file: the function caches the links for a minute from the first spreading recall, and this test's links are
// inserted by SQL, so they must be there before that.
test('R29: recall_more resumes a best-first recall\'s logged frontier', { skip: SKIP }, async () => {
  const set = 'spreading.r29bf'
  if (!sql(`select 1 from memory.param_set where id = '${set}'`).length) {
    json(await admin('POST', '/param-sets', { id: set, parent: 'spreading.v1', params: { spreadMode: 'bestfirst', maxHops: 2, minPath: 0.05, wPath: 1 }, note: 'tier 3: two hops' }), 201)
  }
  const w = word()
  // S holds the word. A chain S, B, C, D of strong links: two hops reach C, and D is past the frontier.
  seed(`${w}-s`, { title: `${w} seed` })
  for (const x of ['b', 'c', 'd']) seed(`${w}-${x}`, { title: `Neighbour ${x} ${word()}` })
  for (const [a, b] of [['s', 'b'], ['b', 'c'], ['c', 'd']]) sql(`insert into memory.link (src, dst, type, weight) values ('${w}-${a}', '${w}-${b}', 'relates', 0.9)`)
  const s = await on(set)
  const r1 = await recall(s, w)
  assert.deepEqual(r1.row.context.frontier?.map((f: any) => f.id), [`${w}-c`], JSON.stringify(r1.row.context))
  assert.equal(r1.delivered.includes(`${w}-d`), false)
  const page = await more(s, r1.id, 'spreading')
  assert.ok(page.delivered.includes(`${w}-d`), page.text)
})

// ---------------------------------------------------------------------------------------------------------- functionality
test('R29: recall_more returns the ranks past the packet\'s cut, in order, none repeated', { skip: SKIP }, async (t) => {
  for (const arm of Object.keys(ARMS) as Arm[]) {
    await t.test(arm, async () => {
      const w = word()
      settled(w, 12)
      const s = await on(arm)
      const r1 = await recall(s, w)
      assert.equal(r1.row.arm, arm)
      assert.equal(r1.candidates.length, 12, r1.candidates.join())
      assert.deepEqual(r1.delivered, r1.candidates.slice(0, 8))
      const page = await more(s, r1.id, arm)
      assert.deepEqual(page.delivered, r1.candidates.slice(8, 12))
      assert.equal(page.delivered.filter((id) => r1.delivered.includes(id)).length, 0)
    })
  }
})

test('R29: recall_more pages through the ranking until it says nothing more matches', { skip: SKIP }, async (t) => {
  for (const arm of Object.keys(ARMS) as Arm[]) {
    await t.test(arm, async () => {
      const w = word()
      const all = settled(w, 30)
      const s = await on(arm)
      const r1 = await recall(s, w)
      const pages = await pageToEnd(s, r1.id, arm)
      assert.deepEqual(pages.map((p) => p.delivered.length), [8, 8, 6, 0])
      let parent = r1.id
      for (const p of pages) {
        assert.equal(p.row.parent_id, parent)
        parent = p.id
      }
      assert.ok(pages[3].text.split('\n').includes(NOTHING_MORE), pages[3].text)
      const seen = [...r1.delivered, ...pages.flatMap((p) => p.delivered)]
      assert.equal(seen.length, 30)
      assert.deepEqual([...new Set(seen)].sort(), [...all].sort())
    })
  }
})

test('R29: paging stops at the 50-candidate cap and says so', { skip: SKIP }, async (t) => {
  for (const arm of Object.keys(ARMS) as Arm[]) {
    await t.test(arm, async () => {
      const w = word()
      settled(w, 60)
      const s = await on(arm)
      const r1 = await recall(s, w)
      const pages = await pageToEnd(s, r1.id, arm)
      assert.deepEqual(pages.map((p) => p.delivered.length), [8, 8, 8, 8, 8, 2, 0])
      const seen = [...r1.delivered, ...pages.flatMap((p) => p.delivered)]
      assert.equal(seen.length, 50)
      assert.equal(new Set(seen).size, 50)
      assert.ok(pages[6].text.split('\n').includes(CAP_LINE), pages[6].text)
      assert.equal(count(pages[6].text, NOTHING_MORE), 0)
    })
  }
})

test('R29: recall with depth deep returns the packet and the next page in one call', { skip: SKIP }, async (t) => {
  for (const arm of Object.keys(ARMS) as Arm[]) {
    await t.test(arm, async () => {
      const w = word()
      settled(w, 12)
      const s = await on(arm)
      const plain = await recall(s, w)
      const page = await more(s, plain.id, arm)
      const fresh = await mcp()
      const before = rows()
      const from = memory.openai.calls.length
      const deep = await recall(fresh, w, { depth: 'deep' })
      assert.ok(calls(from, '/decisions') <= 1, 'depth deep asks the judge at most once')
      assert.equal(rows(), before + 1)
      assert.equal(deep.row.depth, 'deep')
      assert.equal(deep.row.parent_id, null)
      assert.deepEqual(deep.delivered, [...plain.delivered, ...page.delivered])
      assert.equal(deep.delivered.length, 12)
      const packet = await recall(fresh, w, { depth: 'packet' })
      assert.deepEqual(packet.delivered, plain.delivered)
      assert.equal(packet.row.depth, 'packet')
      const at = rows()
      const shallow = await fresh.tool('recall', { query: w, depth: 'shallow' })
      assert.equal(shallow.error, true)
      assert.match(shallow.text, /deep/)
      assert.equal(rows(), at)
    })
  }
})

// ---------------------------------------------------------------------------------------------------------- correctness
test('R29: a dormant entry shows in recall_more, labelled dormant, and never in recall', { skip: SKIP }, async (t) => {
  for (const arm of Object.keys(ARMS) as Arm[]) {
    await t.test(arm, async () => {
      const w = word()
      const d = `${w}-dormant`
      seed(d, { title: `${w} ${w} the dormant one`, body: `${w} ${w} ${w}`, confidence: 0.1 })
      settled(w, 3)
      const s = await on(arm)
      const r1 = await recall(s, w)
      assert.equal(r1.delivered.filter((id) => id === d).length, 0)
      const page = await more(s, r1.id, arm)
      assert.deepEqual(page.delivered, [d])
      const lines = page.text.split('\n')
      assert.equal(lines[lines.indexOf(`[1] ${d}: ${w} ${w} the dormant one`) + 1], '    kind observation · strength 0.10 · dormant')
    })
  }
})

test('R29: a superseded entry shows in recall_more, labelled with its replacement', { skip: SKIP }, async (t) => {
  for (const arm of Object.keys(ARMS) as Arm[]) {
    await t.test(arm, async () => {
      const a = word(), b = word()
      const both = settled(`${a}x`, 9, `${a} ${b}`)
      const n = both[4]
      const old = `${a}x-old`
      seed(old, { title: `${a} the old way` })
      sql(`insert into memory.link (src, dst, type) values ('${n}', '${old}', 'supersedes')`)
      const s = await on(arm)
      const r1 = await recall(s, `${a} ${b}`)
      assert.equal(r1.delivered.filter((id) => id === old).length, 0)
      const pages = await pageToEnd(s, r1.id, arm)
      assert.equal(pages.flatMap((p) => p.delivered).filter((id) => id === old).length, 1)
      const text = pages.map((p) => p.text).join('\n')
      const lines = text.split('\n')
      const at = lines.findIndex((l) => new RegExp(`^\\[\\d+\\] ${old}: `).test(l))
      assert.equal(lines[at + 1], `    kind observation · strength 0.70 · superseded by ${n}`)
    })
  }
})

test('R29: every recall_more item is labelled with kind, strength and state', { skip: SKIP }, async (t) => {
  for (const arm of Object.keys(ARMS) as Arm[]) {
    await t.test(arm, async () => {
      const a = word(), b = word()
      settled(`${a}x`, 8, `${a} ${b}`)
      const l = `${a}x-low`
      seed(l, { title: `${a} the low one`, confidence: 0.2, chances: 0 })
      const s = await on(arm)
      const r1 = await recall(s, `${a} ${b}`)
      const pages = await pageToEnd(s, r1.id, arm)
      const text = pages.map((p) => p.text).join('\n')
      const lines = text.split('\n')
      assert.equal(lines[lines.indexOf(`[1] ${l}: ${a} the low one`) + 1], '    kind observation · strength 0.20 · settled')
    })
  }
})

/** The v2 stand-ins this database lacks, then the trial migration, so hybrid.v3 and spreading.v3 exist. */
async function trialSets() {
  for (const arm of ['hybrid', 'spreading']) {
    if (!sql(`select 1 from memory.param_set where id = '${arm}.v2'`).length) {
      json(await admin('POST', '/param-sets', { id: `${arm}.v2`, parent: `${arm}.v1`, params: { otherRunFactor: 0.9 }, note: 'tier 3 stand-in for production\'s v2' }), 201)
    }
  }
  apply('20261103020000_trials_feedback.sql')
}

test('R29: recall_more skips the On trial list and spends no trial chance', { skip: SKIP }, async (t) => {
  await trialSets()
  // The index arm has no trial lane, so only the two that do.
  for (const set of ['hybrid.v3', 'spreading.v3']) {
    await t.test(set, async () => {
      const w = word()
      const trial = [0, 1, 2, 3].map((i) => {
        const id = `${w}-t${i}`
        seed(id, { title: `${w} trial ${i}`, confidence: 0.5, chances: 3 })
        return id
      })
      settled(w, 8)
      const s = await on(set)
      const r1 = await recall(s, w)
      const shown: string[] = r1.row.on_trial
      assert.equal(shown.length, 3, r1.text)
      const pages = await pageToEnd(s, r1.id, set.split('.')[0])
      const paged = pages.flatMap((p) => p.delivered)
      for (const id of shown) assert.equal(paged.filter((x) => x === id).length, 0)
      const fourth = trial.find((id) => !shown.includes(id))!
      assert.equal(paged.filter((x) => x === fourth).length, 1)
      const lines = pages.map((p) => p.text).join('\n').split('\n')
      const at = lines.findIndex((l) => new RegExp(`^\\[\\d+\\] ${fourth}: `).test(l))
      assert.equal(lines[at + 1], '    kind observation · strength 0.50 · on trial, 3 left')
      assert.equal(sql(`select chances_left from memory.entry where id = '${fourth}'`)[0].chances_left, 3)
      for (const id of shown) assert.equal(sql(`select chances_left from memory.entry where id = '${id}'`)[0].chances_left, 2)
    })
  }
})

test('R29: when the judge rejects the whole packet, recall_more still returns the top ranks', { skip: SKIP }, async (t) => {
  for (const arm of Object.keys(ARMS) as Arm[]) {
    await t.test(arm, async () => {
      const w = word()
      // The fake judge rates an item holding the marker at 0.01. The index arm shows the judge its line, so the title holds it.
      settled(w, 5, `${w} ${FAKE_IRRELEVANT}`)
      const s = await on(arm)
      const r1 = await recall(s, w)
      assert.match(r1.text, /Nothing in memory matches/)
      assert.deepEqual(r1.delivered, [])
      const page = await more(s, r1.id, arm)
      assert.equal(page.delivered.length, 5)
      assert.deepEqual(page.delivered, r1.candidates.slice(0, 5))
    })
  }
})

test('R29: helpful feedback on a recall_more hit revives a dormant entry', { skip: SKIP }, async () => {
  const w = word()
  const d = `${w}-dormant`
  seed(d, { title: `${w} nearly gone`, confidence: 0.14 })
  settled(w, 3)
  const s = await on('hybrid')
  const r1 = await recall(s, w)
  assert.equal(r1.delivered.includes(d), false)
  const r2 = await more(s, r1.id, 'hybrid')
  assert.deepEqual(r2.delivered, [d])
  assert.match((await s.tool('feedback', { retrieval_id: r2.id, verdict: 'helpful', entry_id: d })).text, /^Logged\./)
  await learnNow()
  assert.equal(conf(d), 0.16)
  assert.deepEqual(logRows(d), [{ before: 0.14, after: 0.16, retrieval_id: r2.id }])
  const again = await recall(s, w)
  assert.equal(again.delivered.filter((id) => id === d).length, 1)
})

test('R29: wrong or irrelevant feedback on a recall_more hit lowers it, and feedback naming no entry moves none', { skip: SKIP }, async () => {
  // wrong is -1 step and irrelevant -0.3 (learn.ts WEIGHT), each times settledStep 0.02: 0.10 goes to 0.08 and to 0.094.
  for (const [verdict, after] of [['wrong', 0.08], ['irrelevant', 0.09], [null, 0.1]] as const) {
    const w = word()
    const d = `${w}-dormant`
    seed(d, { title: `${w} faded`, confidence: 0.1 })
    settled(w, 3)
    const s = await on('hybrid')
    const r1 = await recall(s, w)
    const r2 = await more(s, r1.id, 'hybrid')
    assert.deepEqual(r2.delivered, [d])
    const fb = verdict ? { retrieval_id: r2.id, verdict, entry_id: d } : { retrieval_id: r2.id, verdict: 'helpful' }
    assert.match((await s.tool('feedback', fb)).text, /^Logged\./)
    await learnNow()
    assert.equal(conf(d), after, String(verdict))
    assert.equal(logRows(d).length, verdict ? 1 : 0)
    assert.equal((await recall(s, w)).delivered.filter((id) => id === d).length, 0)
  }
})

// ---------------------------------------------------------------------------------------------------------- security
test('R29: helpful feedback cannot revive an entry its retrieval never showed', { skip: SKIP }, async () => {
  const w = word()
  const d2 = `${w}-dormant`
  seed(d2, { title: `${w} unseen`, confidence: 0.14 })
  settled(w, 3)
  const s = await on('hybrid')
  const r = await recall(s, w)
  assert.equal(r.delivered.includes(d2), false)
  await s.tool('feedback', { retrieval_id: r.id, verdict: 'helpful', entry_id: d2 })
  await learnNow()
  assert.equal(conf(d2), 0.14)
  assert.equal(logRows(d2).length, 0)
})

// ---------------------------------------------------------------------------------------------------------- reliability
/** Ties the MCP session to a client session the way a recall's PostToolUse hook does, then sends Wen's next prompt. */
async function prompt(client: string, r1: string, text: string) {
  for (const [event, body] of [['PostToolUse', { session_id: client, tool_name: 'mcp__memory__recall', tool_response: `retrieval ${r1}` }],
    ['UserPromptSubmit', { session_id: client, prompt: text }]] as const) {
    const r = await request('POST', `${memory.url}/hooks/${event}`, { headers: bearer(memory.token), body, timeoutMs: 15_000 })
    assert.equal(r.status, 200, r.text)
  }
}

test('R29: the learner never revives a dormant entry for being shown, and treats other recall_more items like packet items', { skip: SKIP }, async () => {
  const w = word()
  const r = settled(w, 9)
  const d = `${w}-dormant`
  seed(d, { title: `${w} dormant`, confidence: 0.1 })
  const s = await on('hybrid')
  const r1 = await recall(s, w)
  assert.deepEqual(r1.delivered, r.slice(0, 8))
  const r2 = await more(s, r1.id, 'hybrid')
  assert.deepEqual(r2.delivered, [r[8], d])
  await prompt(`r29-learn-${w}`, r1.id, 'Thanks, carry on.')
  sql(`update memory.retrieval set learned_at = now() where learned_at is null and id not in ('${r1.id}', '${r2.id}')`)
  const from = memory.openai.calls.length
  json(await request('POST', `${memory.url}/learn`, { headers: bearer(memory.cronSecret), timeoutMs: 120_000 }))
  for (const id of [r1.id, r2.id]) {
    const row = retrieval(id)
    assert.notEqual(row.learned_at, null)
    assert.equal(row.reaction.pushback, false)
  }
  assert.deepEqual(retrieval(r2.id).rejected, [])
  assert.equal(conf(d), 0.1)
  assert.equal(logRows(d).length, 0)
  assert.equal(conf(r[8]), conf(r[0]))
  assert.equal(calls(from, '/decisions'), 2, 'one reaction read per learned row')
})

test('R29: pushback blamed on a recall_more item weakens it like a packet item', { skip: SKIP }, async () => {
  const w = word()
  const r = settled(w, 9)
  const s = await on('hybrid')
  const r1 = await recall(s, w)
  const r2 = await more(s, r1.id, 'hybrid')
  assert.deepEqual(r2.delivered, [r[8]])
  await prompt(`r29-push-${w}`, r1.id, `No, that is not it. ${FAKE_PUSHBACK}`)
  sql(`update memory.retrieval set learned_at = now() where learned_at is null and id not in ('${r1.id}', '${r2.id}')`)
  json(await request('POST', `${memory.url}/learn`, { headers: bearer(memory.cronSecret), timeoutMs: 120_000 }))
  const row = retrieval(r2.id)
  assert.equal(row.reaction.pushback, true)
  assert.equal(row.reaction.cause, r[8])
  const blamed = retrieval(r1.id).reaction.cause
  assert.ok(blamed, 'the recall blamed one of its own')
  assert.equal(conf(r[8]), conf(blamed))
  assert.ok(conf(r[8]) < 0.7)
})

// ---------------------------------------------------------------------------------------------------------- the surface
test('R29: tools/list describes recall_more and recall\'s depth', { skip: SKIP }, async () => {
  const { rpc } = await mcp()
  const tools: any[] = (await rpc('tools/list')).result.tools
  // 11 tools before R29: register_agent, recall, get_entry, get_blob, upload_blob, remember, feedback and the three message tools.
  assert.equal(tools.length, 19, '12 tools, plus quest operations and Paseo dispatch')
  const named = tools.filter((t) => t.name === 'recall_more')
  assert.equal(named.length, 1)
  assert.deepEqual(named[0].inputSchema.required, ['retrieval_id'])
  assert.deepEqual(Object.keys(named[0].inputSchema.properties), ['retrieval_id'])
  assert.match(named[0].description, /dormant/)
  const recallTool = tools.find((t) => t.name === 'recall')
  assert.ok('depth' in recallTool.inputSchema.properties)
  assert.match(recallTool.inputSchema.properties.depth.description, /deep/)
})

test('R29: server instructions and the empty packet tell agents to dig deeper', { skip: SKIP }, async () => {
  const s = await mcp()
  assert.match(s.init.instructions, /recall_more/)
  // R53 (#58): "before saying memory has nothing" moved to the plugin's skill. The instructions say what recall_more returns.
  assert.ok(s.init.instructions.includes('the next page, dormant and replaced notes included'), s.init.instructions)
  const r = await s.tool('recall', { query: 'xqzzyv nomatch' })
  assert.match(r.text, /Nothing in memory matches/)
  assert.match(r.text, /recall_more/)
})

test('R29: recall_more and depth deep redact private bodies as recall does', { skip: SKIP }, async (t) => {
  for (const arm of Object.keys(ARMS) as Arm[]) {
    await t.test(arm, async () => {
      const a = word(), b = word()
      settled(`${a}x`, 8, `${a} ${b}`)
      const p = `${a}x-private`
      const title = `${a} a private matter`
      seed(p, { title, body: 'The secret-body-token is here.', sensitivity: 'private' })
      const s = await on(arm)
      const r1 = await recall(s, `${a} ${b}`)
      const pages = (await pageToEnd(s, r1.id, arm)).map((x) => x.text).join('\n')
      const deep = (await recall(await mcp(), `${a} ${b}`, { depth: 'deep' })).text
      for (const text of [pages, deep]) {
        assert.equal(count(text, p), 1, text)
        assert.equal(count(text, title), 1, text)
        assert.match(text, /\[private entry: ask Wen\]/)
        assert.equal(count(text, 'secret-body-token'), 0)
      }
    })
  }
})

test('R29: recall_more keeps the parent recall\'s run scope and ignores a scope argument', { skip: SKIP }, async (t) => {
  // No run is hidden (README, "Runs and blobs"): an unscoped recall serves run: notes like any other, so X is ranked there too.
  // What recall_more must not do is widen or change the scope its parent ranked under.
  for (const arm of Object.keys(ARMS) as Arm[]) {
    await t.test(arm, async () => {
      const w = word()
      const x = `${w}-run`
      seed(x, { title: `${w} run note`, scope: 'run:r29' })
      settled(w, 3)
      const s = await on(arm)
      const unscoped = await recall(s, w)
      const pages = await pageToEnd(s, unscoped.id, arm)
      const seen = [...unscoped.delivered, ...pages.flatMap((p) => p.delivered)]
      assert.equal(seen.filter((id) => id === x).length, 1)
      const plain = await more(s, unscoped.id, arm)
      const widened = await more(s, unscoped.id, arm, { scope: 'run:r29' })
      assert.deepEqual(widened.delivered, plain.delivered)
      assert.equal(widened.row.scope, null)
      const scoped = await recall(s, w, { scope: 'run:r29' })
      const scopedPages = await pageToEnd(s, scoped.id, arm)
      for (const p of scopedPages) assert.equal(p.row.scope, 'run:r29')
      assert.equal([...scoped.delivered, ...scopedPages.flatMap((p) => p.delivered)].filter((id) => id === x).length, 1)
    })
  }
})

test('R29: recall_more refuses an unknown retrieval id and writes nothing', { skip: SKIP }, async () => {
  const s = await mcp()
  for (const id of ['not-a-uuid', randomUUID()]) {
    const before = rows()
    const r = await s.tool('recall_more', { retrieval_id: id })
    assert.equal(r.text, `No retrieval ${id}.`)
    assert.equal(rows(), before)
  }
  // Only the session that made the recall can dig into it.
  const w = word()
  settled(w, 10)
  const mine = await recall(await on('hybrid'), w)
  const other = await mcp()
  const before = rows()
  assert.equal((await other.tool('recall_more', { retrieval_id: mine.id })).text, `No retrieval ${mine.id}.`)
  assert.equal(rows(), before)
})

test('R29: recall_more without a device token gets 401', { skip: SKIP }, async () => {
  const before = rows()
  const r = await request('POST', `${memory.url}/mcp`, {
    timeoutMs: 15_000, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recall_more', arguments: { retrieval_id: randomUUID() } } },
  })
  assert.equal(r.status, 401)
  assert.equal(rows(), before)
})

test('R29: with embeddings down, recall_more answers by keyword and says it is degraded', { skip: SKIP }, async (t) => {
  for (const arm of ['hybrid', 'spreading'] as Arm[]) {
    await t.test(arm, async () => {
      const w = word()
      // 11 rather than the criterion's 3: a degraded recall serves its ranking unfiltered, so 3 would all be in the packet.
      settled(w, 11)
      const s = await on(arm)
      const r1 = await recall(s, `${w} ${FAKE_DOWN}`)
      assert.match(r1.text, /embed-failed/)
      const r = await s.tool('recall_more', { retrieval_id: r1.id })
      assert.equal(r.error, false)
      assert.ok(retrieval(rid(r.text)).delivered.length >= 1)
      assert.equal(r.text.split('\n')[2], 'Degraded: embed-failed: Error; results are keyword-only.')
      assert.equal(count(r.text, 'filter-failed'), 0)
    })
  }
})

test('R29: recall_more on the same id twice returns the same page', { skip: SKIP }, async (t) => {
  for (const arm of Object.keys(ARMS) as Arm[]) {
    await t.test(arm, async () => {
      const w = word()
      settled(w, 12)
      const s = await on(arm)
      const r1 = await recall(s, w)
      const a = await more(s, r1.id, arm), b = await more(s, r1.id, arm)
      assert.deepEqual(a.delivered, b.delivered)
      assert.notEqual(a.id, b.id)
    })
  }
})

test('R29: recall_more skips an entry deleted since the recall', { skip: SKIP }, async (t) => {
  for (const arm of Object.keys(ARMS) as Arm[]) {
    await t.test(arm, async () => {
      const w = word()
      settled(w, 12)
      const s = await on(arm)
      const r1 = await recall(s, w)
      json(await admin('DELETE', `/entries/${r1.candidates[9]}`))
      const page = await more(s, r1.id, arm)
      assert.deepEqual(page.delivered, [r1.candidates[8], r1.candidates[10], r1.candidates[11]])
    })
  }
})

// ---------------------------------------------------------------------------------------------------------- performance
test('R29: recall_more costs no judge call and at most one embedding', { skip: SKIP }, async (t) => {
  for (const arm of Object.keys(ARMS) as Arm[]) {
    await t.test(arm, async () => {
      const w = word()
      settled(w, 20)
      const s = await on(arm)
      const r1 = await recall(s, w)
      let from = memory.openai.calls.length
      const page = await s.tool('recall_more', { retrieval_id: r1.id })
      assert.equal(page.error, false)
      assert.equal(calls(from, '/decisions'), 0)
      assert.ok(calls(from, '/embeddings') <= (arm === 'index' ? 0 : 1))
      from = memory.openai.calls.length
      await recall(await mcp(), w, { depth: 'deep' })
      assert.ok(calls(from, '/decisions') <= 1)
    })
  }
})

// ---------------------------------------------------------------------------------------------------------- scalability
test('R29: recall_more pages and depth deep stay inside the packet\'s item and token caps', { skip: SKIP }, async (t) => {
  for (const arm of Object.keys(ARMS) as Arm[]) {
    await t.test(arm, async () => {
      const w = word()
      settled(w, 30, w, 'lorem ipsum '.repeat(400).slice(0, 4000))
      const s = await on(arm)
      const r1 = await recall(s, w)
      let at = r1.id
      for (let i = 0; i < 5; i++) {
        const page = await more(s, at, arm)
        assert.ok(page.delivered.length >= 1 && page.delivered.length <= 8, String(page.delivered.length))
        assert.ok(page.text.split('\n').slice(1).join('\n').length <= 6200, String(page.text.length))
        at = page.id
      }
      const deep = await recall(await mcp(), w, { depth: 'deep' })
      assert.ok(deep.delivered.length >= 1 && deep.delivered.length <= 16)
      assert.ok(deep.text.split('\n').slice(1).join('\n').length <= 12400, String(deep.text.length))
    })
  }
})

// ---------------------------------------------------------------------------------------------------------- architecture
test('R29: a recall_more is logged as a child retrieval of the same arm, query and scope', { skip: SKIP }, async (t) => {
  for (const arm of Object.keys(ARMS) as Arm[]) {
    await t.test(arm, async () => {
      const w = word()
      settled(w, 12, w)
      const s = await on(arm)
      const r1 = await recall(s, w, { task: 'tier 3 checks the child row', scope: 'run:r29arch' })
      const page = await more(s, r1.id, arm)
      assert.equal(page.row.parent_id, r1.id)
      assert.equal(page.row.depth, 'deep')
      assert.deepEqual(page.row.rejected, [])
      for (const k of ['arm', 'query', 'task', 'scope', 'mcp_session']) assert.equal(page.row[k], r1.row[k], k)
      assert.deepEqual(page.row.delivered, ids(page.text))
      assert.equal(r1.row.depth, 'packet')
    })
  }
})

test('R29: the retrieval table gains parent_id and depth, every row has a depth', { skip: SKIP }, async () => {
  apply(MIGRATION)
  apply(MIGRATION) // a second run changes nothing
  const [col] = sql(`select data_type from information_schema.columns where table_schema = 'memory' and table_name = 'retrieval' and column_name = 'parent_id'`)
  assert.equal(col.data_type, 'uuid')
  assert.equal(sql(`select count(*)::int as n from memory.retrieval where depth is null or depth not in ('packet', 'deep')`)[0].n, 0)
  assert.ok(rows() > 0, 'earlier tests left rows to check')
})

test('R29: the overview counts recall_more pages apart from recalls', { skip: SKIP }, async () => {
  const before = Number(json(await admin('GET', '/overview')).counts.recalls)
  const w = word()
  settled(w, 20)
  const s = await on('hybrid')
  const r1 = await recall(s, w)
  const p1 = await more(s, r1.id, 'hybrid')
  await more(s, p1.id, 'hybrid')
  assert.equal(Number(json(await admin('GET', '/overview')).counts.recalls), before + 1)
})

test('R29: POST /recall refuses depth rather than ignoring it', { skip: SKIP }, async () => {
  const deep = await request('POST', `${memory.url}/recall`, { headers: bearer(memory.token), body: { query: 'zephyrine', depth: 'deep' }, timeoutMs: 30_000 })
  assert.equal(deep.status, 400)
  assert.equal(JSON.parse(deep.text).error, 'body must be {query, task, scope}, with a non-empty query')
  const plain = await request('POST', `${memory.url}/recall`, { headers: bearer(memory.token), body: { query: 'zephyrine' }, timeoutMs: 30_000 })
  assert.equal(plain.status, 200, plain.text)
})

test('R29: the docs name recall_more, recall\'s depth and parent_id', () => {
  const readme = readFileSync(join(repoRoot(), 'memory', 'README.md'), 'utf8')
  const api = readFileSync(join(repoRoot(), 'memory', 'API.md'), 'utf8')
  const lines = (text: string, re: RegExp) => text.split('\n').filter((l) => re.test(l)).length
  assert.equal(lines(readme, /^- \*\*`recall_more\(retrieval_id\)`/), 1)
  assert.equal(lines(readme, /^- \*\*`recall\(query, task, scope, depth\)`/), 1)
  assert.equal(lines(readme, /never moves weights/), 0)
  assert.ok(lines(api, /parent_id/) >= 1)
})
