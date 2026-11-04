/**
 * Tier 3: R44 (#48), spreading that expands best-first by path strength and is seeded by words and phrases, against the real
 * memory function. The pure ranking, the frontier and the 20,000-entry timing are in bestfirst_test.ts under deno.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { request } from '../../src/request.ts'
import { bearer, bedFor, nonce } from './bed.ts'
import { apply, SKIP, sql, startRealMemory, type RealMemory } from './server.ts'

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

const admin = (method: string, path: string, body?: unknown) =>
  request(method, `${memory.url}/api/v1${path}`, { headers: bearer(memory.adminToken), body, timeoutMs: 30_000 })
const word = () => 'zq' + nonce().replace(/[0-9]/g, 'k')

/** Ranks `query` on a parameter set the way the eval does, without the judge. */
async function rank(query: string, param_set: string): Promise<string[]> {
  const r = await admin('POST', '/eval/rank', { query, arm: 'spreading', filter: false, param_set })
  assert.equal(r.status, 200, r.text)
  return JSON.parse(r.text).candidates
}

/** Serves one parameter set to every new session. */
async function serve(id: string) {
  const rows = sql('select id from memory.param_set').map((r) => r.id as string)
    .map((param_set) => param_set === id ? { param_set, role: 'default', weight: 1000 } : { param_set, role: 'off', weight: 0 })
  const r = await admin('PUT', '/allocation', { rows })
  assert.equal(r.status, 200, r.text)
}

/** A recall by a new session, after serving `id`, so the session is drawn the set. Gives the retrieval's id. */
async function recallOn(id: string, query: string): Promise<string> {
  await serve(id)
  const reply = await (await bed.mcp()).tool('recall', { query })
  assert.equal(reply.error, false, reply.text)
  return /^retrieval (\S+)/.exec(reply.text)![1]
}

const add = (id: string, title: string, body = 'Nothing else to say about it.') =>
  sql(`insert into memory.entry (id, pattern, title, body, authority, scope, sensitivity, lang, valid_from, source_id, evidence_kind, evidence,
      evidence_sha256, project, kind, confidence, chances_left)
    values ('${id}', 'observations', '${title}', '${body}', 'observed', 'global', 'normal', 'en', '2026-11-01', 'src-a',
      'assistant', 'seen', 'x', 'proj-tea', 'wen', 0.8, 0)`)
const link = (a: string, b: string, weight: number) =>
  sql(`insert into memory.link (src, dst, type, weight) values ('${a}', '${b}', 'related', ${weight})`)

const w = word()
const phrase = [word(), word(), word()]

test('R44: the migration makes spreading.v5 a child of v4 with spreadMode bestfirst, allocates nothing, and leaves v1 to v4 alone', { skip: SKIP }, async () => {
  if (!sql(`select 1 from memory.param_set where id = 'spreading.v2'`).length) {
    const r = await admin('POST', '/param-sets', { id: 'spreading.v2', parent: 'spreading.v1', params: { otherRunFactor: 0.9 }, note: 'tier 3 stand-in for production\'s v2' })
    assert.equal(r.status, 201, r.text)
  }
  const before = sql(`select id, params from memory.param_set where id like 'spreading.v%' order by id`)
  const alloc = sql('select count(*)::int as n from memory.allocation')[0].n
  apply('20261103020000_trials_feedback.sql')
  apply('20261103030000_artifacts_storage.sql')
  apply('20261103040000_spreading_bestfirst.sql')
  apply('20261103040000_spreading_bestfirst.sql') // a second run changes nothing
  const [v4, v5] = ['v4', 'v5'].map((v) => sql(`select parent, params, arm from memory.param_set where id = 'spreading.${v}'`)[0])
  assert.equal(v5.arm, 'spreading')
  assert.equal(v5.parent, 'spreading.v4')
  assert.deepEqual(
    { ...v5.params, spreadMode: undefined, maxHops: undefined, minPath: undefined, wPath: undefined },
    { ...v4.params, spreadMode: undefined, maxHops: undefined, minPath: undefined, wPath: undefined })
  assert.deepEqual([v5.params.spreadMode, v5.params.maxHops, v5.params.minPath, v5.params.wPath], ['bestfirst', 3, 0.05, 1])
  for (const v of ['v1', 'v2', 'v3', 'v4']) {
    assert.equal(sql(`select params->'spreadMode' as m from memory.param_set where id = 'spreading.${v}'`)[0].m, null)
    const was = before.find((r) => r.id === `spreading.${v}`)
    if (was) assert.deepEqual(sql(`select params from memory.param_set where id = 'spreading.${v}'`)[0].params, was.params)
  }
  assert.equal(sql('select count(*)::int as n from memory.allocation')[0].n, alloc)
  assert.equal(sql(`select count(*)::int as n from memory.allocation where param_set = 'spreading.v5'`)[0].n, 0)
})

test('bestfirst: strong far beats weak near', { skip: SKIP }, async () => {
  // The seed S is the only entry that holds the word. A is one weak link out, D three strong links out.
  add(`${w}-s`, `${w} seed`)
  for (const x of ['a', 'b', 'c', 'd']) add(`${w}-${x}`, `Neighbour ${x} ${nonce()}`)
  link(`${w}-s`, `${w}-a`, 0.2)
  link(`${w}-s`, `${w}-b`, 0.9)
  link(`${w}-b`, `${w}-c`, 0.9)
  link(`${w}-c`, `${w}-d`, 0.9)
  const ranked = await rank(w, 'spreading.v5')
  const at = (x: string) => ranked.indexOf(`${w}-${x}`)
  assert.ok(at('d') >= 0 && at('a') >= 0, ranked.join())
  assert.ok(at('d') < at('a'), `D (path 0.729) before A (path 0.2): ${ranked.join()}`)
})

test('bestfirst: maxHops 2 leaves D out, and the frontier a recall logs lets recall_more reach it', { skip: SKIP }, async () => {
  const r = await admin('POST', '/param-sets', { id: 'spreading.bf2', parent: 'spreading.v5', params: { maxHops: 2 }, note: 'tier 3: two hops' })
  assert.equal(r.status, 201, r.text)
  const ranked = await rank(w, 'spreading.bf2')
  assert.ok(!ranked.includes(`${w}-d`), ranked.join())
  assert.ok(ranked.includes(`${w}-c`) && ranked.includes(`${w}-a`), ranked.join())
  const rid = await recallOn('spreading.bf2', w)
  const [row] = sql(`select context from memory.retrieval where id = '${rid}'`)
  assert.equal(row.context.param_set, 'spreading.bf2')
  const frontier: { id: string; strength: number }[] = row.context.frontier
  assert.deepEqual(frontier.map((f) => f.id), [`${w}-c`])
  assert.ok(Math.abs(frontier[0].strength - 0.81) < 1e-6, JSON.stringify(frontier))
  assert.ok(frontier.length <= 50)
  const v4 = await admin('POST', '/param-sets', { id: 'spreading.pprcheck', parent: 'spreading.v4', params: {}, note: 'tier 3: ppr leaves no frontier' })
  assert.equal(v4.status, 201, v4.text)
  const ppr = await recallOn('spreading.pprcheck', w)
  assert.equal(sql(`select context->'frontier' as f from memory.retrieval where id = '${ppr}'`)[0].f, null)
  await serve('spreading.v1')
})

test('bestfirst: phrase seeds', { skip: SKIP }, async () => {
  // P holds all three words in order, Q only the first. Neither is linked to anything.
  add(`${w}-p`, `${phrase.join(' ')} pricing note`)
  add(`${w}-q`, `${phrase[0]} on its own`)
  add(`${w}-r`, `Something else`, `Calls go ${phrase[1]} ${phrase[2]} in the body and the title says nothing.`)
  const query = phrase.join(' ')
  const ranked = await rank(query, 'spreading.v5')
  assert.ok(ranked.indexOf(`${w}-p`) >= 0 && ranked.indexOf(`${w}-p`) < ranked.indexOf(`${w}-q`), ranked.join())
  const rid = await recallOn('spreading.v5', query)
  const seen = Object.fromEntries(sql(`select c->>'id' as id, c->'arms' as arms from memory.retrieval r, jsonb_array_elements(r.context->'candidates') c
    where r.id = '${rid}'`).map((r) => [r.id, r.arms]))
  assert.ok(seen[`${w}-p`]?.phrase, JSON.stringify(seen))
  assert.ok(seen[`${w}-r`]?.phrase, 'a phrase in the body seeds too')
  assert.ok(!seen[`${w}-q`]?.phrase)
  assert.ok(seen[`${w}-p`].spreading.score >= seen[`${w}-q`].spreading.score)
  await serve('spreading.v1')
})
