import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { FakeTurn } from './fakes/common.ts'
import { flowDaemon, flowSetup, runEvents, waitStatus } from './golden/flow.ts'
import { argvLog } from './helpers.ts'

const TASK = { prompt: 'Write hello.txt.', criteria: ['hello.txt exists'], checks: ['test -f hello.txt'] }
const result = { status: 'done', summary: 'done', evidence: [] }
const blocked = { status: 'blocked', summary: 'Need a credential only Wen can provide.', evidence: [] }
const verdict = (pass: boolean, notes: string, count = 1) => ({
  verdict: pass ? 'pass' : 'fail',
  criteria: Array.from({ length: count }, (_, i) => ({ criterion: `criterion ${i + 1}`, pass, evidence: notes })), notes,
})

async function fixture(turns: FakeTurn[]) {
  const s = await flowSetup('task-rung1')
  writeFileSync(s.scenario, JSON.stringify({ turns }))
  const { d, client } = await flowDaemon()
  return { s, d, client }
}

test('four failed judge verdicts climb then stay at top rung, carrying findings until pass', async () => {
  const turns: FakeTurn[] = []
  for (let i = 1; i <= 5; i++) {
    turns.push({ match: 'worker for stage task of', reply: 'done', json: result, ...(i === 1 ? { write: { 'hello.txt': 'hello\n' }, commit: 'add hello' } : {}) })
    turns.push({ match: 'judge for stage task of', json: verdict(i === 5, `Finding ${i}`) })
  }
  const { s, d, client } = await fixture(turns)
  try {
    const started = await client.startRun('task', TASK, s.repo)
    const run = await waitStatus(client, started.id, ['done', 'failed', 'asking'])
    assert.equal(run.status, 'done', run.question)
    assert.deepEqual(run.stages[0].attempts.map((a) => a.rung.effort), ['medium', 'medium', 'high', 'high', 'high'])
    assert.deepEqual(run.stages[0].attempts.map((a) => a.ok), [false, false, false, false, true])
    assert.deepEqual(run.asks, [])
    const prompts = argvLog(s.state).filter((a) => a.bin === 'pi').map((a) => a.argv.at(-1) ?? '')
    for (let i = 1; i < 5; i++) assert.match(prompts[i], new RegExp(`Finding ${i}`))
  } finally { await d.close(); await s.memory.close() }
})

test('missing plan is an extraction failure, resent verbatim on the top planner rung', async () => {
  const plan = { intent: 'Write hello.', slices: [{ id: 's1', title: 'Write hello.txt', acceptance: ['test -f hello.txt'] }] }
  const turns: FakeTurn[] = [
    { match: 'worker for stage plan of', reply: `\`\`\`json\n${JSON.stringify(result)}\n\`\`\`` },
    { match: 'worker for stage plan of', reply: `\`\`\`json\n${JSON.stringify({ ...result, plan })}\n\`\`\`` },
    { match: 'judge for stage plan of', json: verdict(true, 'Plan is sound.', 4) },
  ]
  const { s, d, client } = await fixture(turns)
  try {
    const started = await client.startRun('ship', { intent: plan.intent }, s.repo)
    const run = await waitStatus(client, started.id, ['asking', 'failed'])
    assert.equal(run.status, 'asking', run.error)
    assert.match(run.question ?? '', /Approve the plan/)
    assert.equal(run.stages[0].attempts.length, 2)
    const error = 'The worker returned no plan. End the last message with a fenced json block holding plan: {intent, slices: [{id, title, acceptance}]}.'
    assert.equal(run.stages[0].attempts[0].reason, error)
    const worker = run.stages[0].attempts[1].threadId
    const second = JSON.parse(readFileSync(join(s.home, 'threads', `${worker}.json`), 'utf8'))
    assert.ok(second.turns[0].prompt.includes(error), 'the extraction error reaches the worker verbatim')
    assert.equal(run.stages[0].attempts[0].judgeId, undefined)
    await client.stopRun(run.id)
  } finally { await d.close(); await s.memory.close() }
})

test('a rejected blocked report returns to worker with judge reason', async () => {
  const { s, d, client } = await fixture([
    { match: 'worker for stage task of', reply: 'blocked', json: blocked },
    { match: 'judge for stage task of', json: verdict(false, 'Credential exists in the repo.') },
    { match: 'worker for stage task of', reply: 'done', json: result, write: { 'hello.txt': 'hello\n' } },
    { match: 'judge for stage task of', json: verdict(true, 'File exists.') },
  ])
  try {
    const started = await client.startRun('task', TASK, s.repo)
    const run = await waitStatus(client, started.id, ['done', 'failed', 'asking'])
    assert.equal(run.status, 'done', run.question)
    assert.match(run.stages[0].attempts[0].reason ?? '', /judge rejected the block: Credential exists/)
    const second = JSON.parse(readFileSync(join(s.home, 'threads', `${run.stages[0].attempts[1].threadId}.json`), 'utf8'))
    assert.match(second.turns[0].prompt, /The judge rejected the block:/)
    assert.match(second.turns[0].prompt, /Credential exists in the repo/)
    assert.deepEqual(run.asks, [])
  } finally { await d.close(); await s.memory.close() }
})

test('an accepted blocked report asks Wen with its reason', async () => {
  const { s, d, client } = await fixture([
    { match: 'worker for stage task of', reply: 'blocked', json: blocked },
    { match: 'judge for stage task of', json: verdict(true, 'Only Wen has the credential.') },
  ])
  try {
    const started = await client.startRun('task', TASK, s.repo)
    const asking = await waitStatus(client, started.id, ['asking', 'failed'])
    assert.equal(asking.status, 'asking', asking.error)
    assert.match(asking.question ?? '', /Need a credential only Wen can provide/)
    assert.equal(asking.asks[0].kind, 'block')
    await client.answer(started.id, 'stop')
    const stopped = await waitStatus(client, started.id, ['stopped', 'failed'])
    assert.equal(stopped.status, 'stopped')
  } finally { await d.close(); await s.memory.close() }
})

test('a backend usage limit emits an event and waits on a clear limit ask', async () => {
  const { s, d, client } = await fixture([{ match: 'worker for stage task of', error: 'Usage limit reached for model' }])
  try {
    const started = await client.startRun('task', TASK, s.repo)
    const asking = await waitStatus(client, started.id, ['asking', 'failed'])
    assert.equal(asking.status, 'asking', asking.error)
    assert.equal(asking.asks[0].kind, 'limit')
    assert.match(asking.question ?? '', /Usage limit reached for model/)
    assert.ok(runEvents(s.home, started.id).some((e) => e.type === 'run.limit'))
    await client.answer(started.id, 'stop')
    assert.equal((await waitStatus(client, started.id, ['stopped', 'failed'])).status, 'stopped')
  } finally { await d.close(); await s.memory.close() }
})
