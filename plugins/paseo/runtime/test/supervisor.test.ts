import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TurnInput, TurnOutput } from '../src/backends/types.ts'
import type { DaemonCtx } from '../src/daemon.ts'
import { EventLog } from '../src/events.ts'
import { Runs } from '../src/flow/runtime.ts'
import { Supervisors } from '../src/flow/supervisor.ts'
import type { Run } from '../src/flow/types.ts'
import { runRoutes } from '../src/routes/runs.ts'
import { writeJson } from '../src/store.ts'
import { Threads } from '../src/threads.ts'
import { tempDir, waitFor } from './helpers.ts'

function fixture(runTurn: (input: TurnInput) => Promise<TurnOutput>) {
  const home = tempDir('supervisor')
  const previous = process.env.CLYDE_HOME
  process.env.CLYDE_HOME = home
  const events = new EventLog()
  const workers = new Threads({ events, maxTurns: 1, backend: () => ({ name: 'codex', family: () => 'codex', runTurn }) })
  const ctx = { home, events, threads: workers, memory: null, beforeClose: [] } as unknown as DaemonCtx
  const run: Run = { id: 'r-supervisor', title: 'Explain a failed plan', flow: 'task', status: 'failed',
    input: { prompt: 'Build a widget' }, cwd: home, repo: home, branch: 'test', base: 'base', stages: [],
    answers: [], asks: [], entries: [], plans: [], agents: {}, log: [], firstEvent: 1, createdAt: '', updatedAt: '' }
  writeJson(join(home, 'runs', `${run.id}.json`), run)
  const clean = () => { if (previous === undefined) delete process.env.CLYDE_HOME; else process.env.CLYDE_HOME = previous; rmSync(home, { recursive: true, force: true }) }
  return { home, ctx, workers, run, clean }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

const answer = (text: string): TurnOutput => ({ ok: true, text, session: 'ephemeral-session' })

test('supervisor preserves conversations across turns and restarts with fresh failed-planning evidence', async () => {
  const inputs: TurnInput[] = []
  const f = fixture(async input => { inputs.push(input); return answer(`Answer ${inputs.length}`) })
  let supervisors = new Supervisors(f.ctx, () => structuredClone(f.run))
  try {
    const planner = f.workers.start({ title: 'planning', prompt: 'Draft the plan', cwd: f.home, runId: f.run.id,
      stage: 'plan', readOnly: true, rung: { backend: 'codex' } })
    await f.workers.waitIdle(planner.id)
    f.workers.need(planner.id).turns[0] = { n: 1, prompt: 'Draft', startedAt: '', endedAt: '', ok: false,
      text: 'FAILED PLANNING DRAFT: slices alpha and beta', json: { intent: 'draft widget' }, error: 'invalid plan shape' }
    inputs.length = 0
    const id = randomUUID()
    supervisors.send(f.run.id, 'What was the proposed plan?', id)
    assert.equal(supervisors.view(f.run.id).busy, true)
    await waitFor(() => !supervisors.view(f.run.id).busy)
    assert.equal(inputs[0].readOnly, true)
    assert.equal(inputs[0].rung.model, 'gpt-6.2-sol')
    assert.match(inputs[0].prompt, /FAILED PLANNING DRAFT/)
    assert.match(inputs[0].prompt, /invalid plan shape/)
    assert.match(inputs[0].prompt, /unapproved/)
    assert.equal(f.run.status, 'failed')
    assert.deepEqual(f.run.answers, [])
    supervisors.send(f.run.id, 'What was the proposed plan?', id)
    assert.equal(inputs.length, 1, 'an idempotent retry does not run another turn')
    assert.throws(() => supervisors.send(f.run.id, 'Different question', id), /different text/)
    f.run.log.push('NEW VERIFIED EVIDENCE')
    supervisors.send(f.run.id, 'Why did that fail?', randomUUID())
    await waitFor(() => !supervisors.view(f.run.id).busy)
    assert.match(inputs[1].prompt, /NEW VERIFIED EVIDENCE/)
    assert.match(inputs[1].prompt, /Answer 1/)
    assert.equal(inputs[1].session, undefined, 'ephemeral read-only sessions are not resumed')
    const threadId = supervisors.conversations.get(f.run.id)!.threadId
    assert.equal(supervisors.threads.list().length, 1, 'one distinct supervisor thread handles follow-ups')
    const before = supervisors.view(f.run.id)
    await supervisors.shutdown()
    supervisors = new Supervisors(f.ctx, () => structuredClone(f.run))
    assert.deepEqual(supervisors.view(f.run.id), before)
    assert.equal(supervisors.conversations.get(f.run.id)?.threadId, threadId)
    supervisors.send(f.run.id, 'Explain beta', randomUUID())
    await waitFor(() => !supervisors.view(f.run.id).busy)
    assert.match(inputs[2].prompt, /Why did that fail/)
    assert.equal(supervisors.view(f.run.id).messages.length, 6)
  } finally { await supervisors.shutdown(); await f.workers.shutdown(); f.clean() }
})

test('supervisor runs while the worker cap is full and cannot answer a pending decision', async () => {
  const hold = deferred<TurnOutput>()
  const f = fixture(async input => input.readOnly ? answer('It is waiting for approval') : hold.promise)
  const runs = new Runs(f.ctx)
  runs.runs.set(f.run.id, f.run)
  f.run.status = 'asking'
  f.run.question = 'Approve this plan?'
  f.run.asks.push({ key: 'approval', kind: 'approve', question: f.run.question, askedAt: '' })
  try {
    f.workers.start({ title: 'worker', prompt: 'Work', cwd: f.home, runId: f.run.id, rung: { backend: 'codex' } })
    assert.equal(f.workers.live.size, 1)
    runs.supervisors.send(f.run.id, 'What does approval mean?', randomUUID())
    await waitFor(() => !runs.supervisors.view(f.run.id).busy)
    assert.equal(f.workers.live.size, 1, 'supervisor does not consume or interrupt worker slots')
    assert.equal(f.run.status, 'asking')
    assert.equal(f.run.asks[0].answer, undefined)
    assert.throws(() => runs.steer(f.run.id, 'yes'), /explicit answer control/)
    assert.equal(f.run.asks[0].answer, undefined)
    runs.answer(f.run.id, 'approve')
    assert.equal(f.run.asks[0].answer, 'approve')
  } finally { hold.resolve(answer('worker complete')); await runs.shutdown(); await f.workers.shutdown(); f.clean() }
})

test('supervisor reports failures, rejects overlapping messages, and accepts a later retry', async () => {
  const hold = deferred<TurnOutput>()
  let n = 0
  const f = fixture(async () => ++n === 1 ? hold.promise : answer('Recovered'))
  const supervisors = new Supervisors(f.ctx, () => f.run)
  try {
    const id = randomUUID()
    supervisors.send(f.run.id, 'Explain', id)
    supervisors.send(f.run.id, 'Explain', id)
    assert.throws(() => supervisors.send(f.run.id, 'Another question', randomUUID()), /still answering/)
    hold.resolve({ ok: false, text: '', error: 'provider unavailable' })
    await waitFor(() => !supervisors.view(f.run.id).busy)
    assert.equal(supervisors.view(f.run.id).error, 'provider unavailable')
    supervisors.send(f.run.id, 'Try again', randomUUID())
    await waitFor(() => !supervisors.view(f.run.id).busy)
    assert.equal(supervisors.view(f.run.id).error, undefined)
    assert.equal(supervisors.view(f.run.id).messages.at(-1)?.text, 'Recovered')
  } finally { await supervisors.shutdown(); f.clean() }
})

test('supervisor shutdown settles both running and queued conversations', async () => {
  const f = fixture(input => new Promise(resolve => input.signal.addEventListener('abort', () => resolve({ ok: false, text: '', error: 'stopped' }), { once: true })))
  const supervisors = new Supervisors(f.ctx, id => ({ ...f.run, id }))
  try {
    supervisors.send('r-one', 'Explain first', randomUUID())
    supervisors.send('r-two', 'Explain second', randomUUID())
    await new Promise(resolve => setImmediate(resolve))
    await supervisors.shutdown()
    assert.equal(supervisors.view('r-one').busy, false)
    assert.equal(supervisors.view('r-two').busy, false)
  } finally { await supervisors.shutdown(); f.clean() }
})

test('restart makes an interrupted supervisor turn visible as a recoverable error', async () => {
  const f = fixture(async () => answer('unexpected replay'))
  const threadId = 't-interrupted'
  writeJson(join(f.home, 'supervisor-threads', `${threadId}.json`), {
    id: threadId, title: 'supervisor', cwd: f.home, runId: f.run.id, readOnly: true, status: 'running', queue: [],
    rung: { backend: 'codex' }, turns: [{ n: 1, prompt: 'Explain', startedAt: '2026-01-01' }], createdAt: '', updatedAt: '' })
  writeJson(join(f.home, 'supervisors', `${f.run.id}.json`), {
    id: f.run.id, threadId, messages: [{ role: 'user', text: 'Explain' }], requests: [{ id: 'interrupted', text: 'Explain' }], pending: { requestId: 'interrupted', turn: 1 } })
  const supervisors = new Supervisors(f.ctx, () => f.run)
  try {
    await waitFor(() => !supervisors.view(f.run.id).busy)
    assert.equal(supervisors.view(f.run.id).error, 'daemon restarted')
    supervisors.send(f.run.id, 'Retry explanation', randomUUID())
    await waitFor(() => !supervisors.view(f.run.id).busy)
    assert.equal(supervisors.view(f.run.id).messages.at(-1)?.text, 'unexpected replay')
  } finally { await supervisors.shutdown(); f.clean() }
})

test('supervisor HTTP endpoint accepts asynchronously, validates inputs, and works after a run ends', async () => {
  const hold = deferred<TurnOutput>()
  const f = fixture(async () => hold.promise)
  const table = runRoutes(f.ctx)
  const request = async (path: string, body?: unknown) => {
    const method = body ? 'POST' : 'GET'
    const id = path.split('/')[2]
    const route = table.find(r => r.method === method && r.path === '/runs/:id/supervisor')!
    try {
      const reply = await route.handle({ params: { id }, body } as any)
      return { status: reply!.status ?? 200, json: async () => reply!.body }
    } catch (err) {
      return { status: (err as {status: number}).status, json: async () => ({ error: (err as Error).message }) }
    }
  }
  try {
    const path = `/runs/${f.run.id}/supervisor`
    assert.deepEqual(await (await request(path)).json(), { messages: [], busy: false })
    assert.equal((await request('/runs/missing/supervisor')).status, 404)
    assert.equal((await request(path, { text: 'question', requestId: 'bad' })).status, 400)
    assert.equal((await request(path, { text: 'x'.repeat(8001), requestId: randomUUID() })).status, 400)
    const accepted = await request(path, { text: 'Explain the failure', requestId: randomUUID() })
    assert.equal(accepted.status, 202)
    assert.deepEqual(await accepted.json(), { ok: true })
    assert.equal((await (await request(path)).json() as any).busy, true)
    assert.equal(f.ctx.activeRunCount(), 1, 'supervisor activity prevents idle daemon reloads')
    hold.resolve(answer('Here is what failed'))
    await waitFor(async () => !(await (await request(path)).json() as any).busy)
    assert.equal(f.ctx.activeRunCount(), 0)
    assert.deepEqual((await (await request(path)).json() as any).messages, [
      { role: 'user', text: 'Explain the failure' }, { role: 'assistant', text: 'Here is what failed' }])
  } finally {
    hold.resolve(answer('done'))
    for (const close of f.ctx.beforeClose) await close()
    f.clean()
  }
})

test('pending follow-up persisted before enqueue never reuses the previous answer', async () => {
  const f = fixture(async () => answer('Previous answer'))
  let supervisors = new Supervisors(f.ctx, () => f.run)
  try {
    supervisors.send(f.run.id, 'First question', randomUUID())
    await waitFor(() => !supervisors.view(f.run.id).busy)
    const c = supervisors.conversations.get(f.run.id)!
    const id = randomUUID()
    c.messages.push({ role: 'user', text: 'Lost follow-up' })
    c.requests.push({ id, text: 'Lost follow-up' })
    c.pending = { requestId: id, turn: 2 }
    supervisors.save(c)
    await supervisors.shutdown()
    supervisors = new Supervisors(f.ctx, () => f.run)
    await waitFor(() => !supervisors.view(f.run.id).busy)
    assert.match(supervisors.view(f.run.id).error!, /interrupted before its turn started/)
    assert.equal(supervisors.view(f.run.id).messages.filter(m => m.role === 'assistant').length, 1)
  } finally { await supervisors.shutdown(); f.clean() }
})

test('supervisor bounds huge evidence and excludes raw notes and provider JSON', async () => {
  const inputs: TurnInput[] = []
  const f = fixture(async input => { inputs.push(input); return answer('Summary') })
  const supervisors = new Supervisors(f.ctx, () => f.run)
  try {
    f.run.input = { prompt: 'Intent', criteria: ['CONFIRMED ACCEPTANCE CRITERION'], notes: 'SECRET RAW NOTES'.repeat(100000) }
    f.run.plan = { intent: 'APPROVED PLAN' }
    f.run.stages = Array.from({length: 15}, (_, n) => ({ name: 'stage' + n, status: 'failed', role: 'worker', base: '',
      round: 0, attempts: [], artifact: 'draft'.repeat(10000), startedAt: '' }))
    f.run.stages.at(-1)!.attempts.push({ n: 1, round: 0, rung: {backend: 'codex'}, threadId: 'worker', startedAt: '',
      result: { status: 'blocked', summary: 'ACTUAL WORKER FINDING', evidence: [] } })
    const worker = f.workers.start({ title: 'worker', prompt: 'Work', cwd: f.home, runId: f.run.id, readOnly: true, rung: { backend: 'codex' } })
    await f.workers.waitIdle(worker.id)
    f.workers.need(worker.id).turns[0].json = { giantProviderTranscript: 'PROVIDER RAW JSON'.repeat(100000) }
    inputs.length = 0
    supervisors.send(f.run.id, 'Current question ' + 'x'.repeat(7900), randomUUID())
    await waitFor(() => !supervisors.view(f.run.id).busy)
    assert.ok(inputs[0].prompt.length < 60000)
    assert.match(inputs[0].prompt, /APPROVED PLAN/)
    assert.match(inputs[0].prompt, /CONFIRMED ACCEPTANCE CRITERION/)
    assert.match(inputs[0].prompt, /ACTUAL WORKER FINDING/)
    assert.match(inputs[0].prompt, /Current question/)
    assert.doesNotMatch(inputs[0].prompt, /SECRET RAW NOTES|PROVIDER RAW JSON/)
  } finally { await supervisors.shutdown(); await f.workers.shutdown(); f.clean() }
})
