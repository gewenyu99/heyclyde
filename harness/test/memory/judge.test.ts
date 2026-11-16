/**
 * Tier 3: R71 (#76), dual-key Gemini Decisions API judge (gemini-decision-1) with seamless OpenAI fallback (gpt-6-luna)
 * against the real memory function. Unit tests of judge.ts without a database live in judge_test.ts under deno.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { Memory } from '../../src/memory.ts'
import { request } from '../../src/request.ts'
import { bearer, bedFor, nonce } from './bed.ts'
import { FAKE_PUSHBACK, FAKE_REFUSE, FAKE_SAFETY } from './openai.ts'
import { SKIP, sql, startRealMemory, type RealMemory } from './server.ts'

let memory: RealMemory
let bed: ReturnType<typeof bedFor>

before(async () => {
  if (SKIP) return
  memory = await startRealMemory({ MEMORY_ARMS: 'hybrid' })
  bed = bedFor(memory)
})

after(async () => {
  await memory?.close()
})

const admin = (method: string, path: string, body?: unknown) =>
  request(method, `${memory.url}/api/v1${path}`, { headers: bearer(memory.adminToken), body, timeoutMs: 30_000 })

const rtNote = (id: string, body: string) => ({
  id,
  pattern: 'observations',
  title: `R71 note ${id}`,
  body,
  authority: 'observed',
  scope: 'domain:tea',
  evidence_kind: 'summary',
  evidence: 'Tier 3 made it.',
  project: 'proj-tea',
  source: { kind: 'run', title: 'r71 test', uri: 'clyde://runs/r71' },
})

async function until(ok: () => boolean, ms = 15_000, what = 'condition') {
  const deadline = Date.now() + ms
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`${what} timed out after ${ms} ms`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

test('R71: without gemini_key, calls fall back to OpenAI gpt-6-luna; PUT /secrets/gemini_key switches immediately to Gemini', { skip: SKIP }, async () => {
  // Ensure a shadow parameter set is active so judge_cache records both judge versions separately.
  assert.equal((await admin('POST', '/param-sets', { id: 'hybrid.jshadow', parent: 'hybrid.v1', params: { filterK: 20 }, note: 'R71 judge cache test' })).status, 201)
  const all = sql('select id from memory.param_set').map((r) => r.id as string)
  assert.equal((await admin('PUT', '/allocation', {
    by: 'wen',
    rows: all.map((param_set) => param_set === 'hybrid.v1'
      ? { param_set, role: 'default', weight: 1000 }
      : param_set === 'hybrid.jshadow' ? { param_set, role: 'shadow', weight: 0 } : { param_set, role: 'off', weight: 0 }),
  })).status, 200)

  const rt = new Memory(memory.url, memory.runtimeToken)

  // 1. No gemini_key -> OpenAI fallback
  let from = memory.openai.calls.length
  const rOpen = await request('POST', `${memory.url}/recall`, { headers: bearer(memory.token), body: { query: 'oolong temperature' } })
  assert.equal(rOpen.status, 200, rOpen.text)
  const openCalls = memory.openai.calls.slice(from).filter((c) => c.path === '/decisions')
  assert.ok(openCalls.length >= 1)
  assert.ok(openCalls.every((c) => c.api === 'openai' && c.body.model === 'gpt-6-luna'))
  await until(() => sql(`select count(*)::int as n from memory.judge_cache where judge_version = 'gpt-6-luna|relevance.1'`)[0].n > 0, 15_000, 'OpenAI judge_cache')

  // 2. PUT /api/v1/secrets/gemini_key invalidates cache immediately and switches to Gemini
  const gemKey = `fake-gem-key-${nonce()}`
  assert.equal((await admin('PUT', '/secrets/gemini_key', { value: gemKey })).status, 200)

  from = memory.openai.calls.length
  const okNote = await rt.remember(rtNote(`r71-ok-${nonce()}`, 'Clean oolong note.'))
  assert.ok(okNote.id)
  const s = await bed.mcp()
  const rGem = await s.tool('recall', { query: 'oolong temperature' })
  assert.equal(rGem.error, false, rGem.text)
  const gemCalls = memory.openai.calls.slice(from).filter((c) => c.path === '/decisions')
  assert.ok(gemCalls.length >= 2)
  for (const c of gemCalls) {
    assert.equal(c.api, 'gemini')
    assert.equal(c.body.model, 'gemini-decision-1')
    assert.equal(c.headers['x-goog-api-key'], gemKey)
    assert.equal(c.headers.authorization, undefined)
  }
  await until(() => sql(`select count(*)::int as n from memory.judge_cache where judge_version = 'gemini-decision-1|relevance.1'`)[0].n > 0, 15_000, 'Gemini judge_cache')

  // 3. Gemini refusal (FAKE_REFUSE) and 400 safety block (FAKE_SAFETY) both refuse cleanly
  await assert.rejects(rt.remember(rtNote(`r71-refuse-${nonce()}`, `Note ${FAKE_REFUSE}`)), /steer the assistants/)
  await assert.rejects(rt.remember(rtNote(`r71-safety-${nonce()}`, `Note ${FAKE_SAFETY}`)), /Gemini safety block \(safety\)/)

  // 4. Learner pushback via Gemini (choice "0" -> blamed item)
  const rid = /^retrieval (\S+)/.exec(rGem.text)![1]
  const cs = `r71-claude-${nonce()}`
  sql(`update memory.mcp_session set claude_session_id = '${cs}' where id = '${s.session}'`)
  sql(`insert into memory.event (session_id, event, payload) values ('${cs}', 'UserPromptSubmit', '${JSON.stringify({ prompt: `No wrong ${FAKE_PUSHBACK}` })}'::jsonb)`)
  const learn = await request('POST', `${memory.url}/learn`, { headers: bearer(memory.cronSecret), timeoutMs: 30_000 })
  assert.equal(learn.status, 200, learn.text)
  const reaction = sql(`select reaction from memory.retrieval where id = '${rid}'`)[0]?.reaction
  assert.equal(reaction?.pushback, true)
  assert.ok(reaction?.cause, JSON.stringify(reaction))

  // 5. DELETE /api/v1/secrets/gemini_key clears cache immediately and restores OpenAI fallback
  assert.equal((await admin('DELETE', '/secrets/gemini_key')).status, 200)
  from = memory.openai.calls.length
  const rBack = await request('POST', `${memory.url}/recall`, { headers: bearer(memory.token), body: { query: 'oolong temperature' } })
  assert.equal(rBack.status, 200, rBack.text)
  const backCalls = memory.openai.calls.slice(from).filter((c) => c.path === '/decisions')
  assert.ok(backCalls.length >= 1)
  assert.ok(backCalls.every((c) => c.api === 'openai' && c.body.model === 'gpt-6-luna'))
})
