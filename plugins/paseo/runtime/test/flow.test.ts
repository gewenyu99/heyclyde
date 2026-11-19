/** The task flow over the daemon with the fake CLIs and memory: the ladder, the judge, asks, stops, crashes and memory handoff. */
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { repoRoot } from '../src/config.ts'
import type { Run } from '../src/flow/types.ts'
import type { Thread } from '../src/types.ts'
import { flowDaemon, flowSetup, matchGolden, runEvents, waitStatus } from './golden/flow.ts'
import { argvLog, git, TEST_ROLES, turnsTaken, waitFor } from './helpers.ts'

const TASK = { prompt: 'Write hello.txt holding hello.', criteria: ['A hello file. hello.txt holds hello.'], checks: ['test -f hello.txt'] }

function thread(home: string, id: string): Thread {
  return JSON.parse(readFileSync(join(home, 'threads', `${id}.json`), 'utf8'))
}

/** The prompt each pi worker got, in order. pi takes the prompt as its last argv word. */
function piPrompts(state: string): string[] {
  return argvLog(state).filter((c) => c.bin === 'pi').map((c) => c.argv.at(-1) as string)
}

test('task passes on rung 1: worktree, checks, a judge from another family, and a verdict in memory', async () => {
  const s = await flowSetup('task-rung1')
  const { d, client } = await flowDaemon()
  try {
    const started: Run = await client.call('POST', '/runs', { flow: 'task', input: TASK, cwd: s.repo })
    assert.match(started.id, /^r-[0-9a-f]{8}$/)
    assert.equal(started.branch, `clyde/${started.id}`)
    assert.equal(started.cwd, join(s.home, 'worktrees', started.id))
    const run = await waitStatus(client, started.id, ['done', 'failed', 'stopped'])
    assert.equal(run.status, 'done', run.error)
    const [stage] = run.stages
    assert.deepEqual([stage.name, stage.status, stage.attempts.length], ['task', 'passed', 1])
    assert.equal(stage.base, git(s.repo, 'rev-parse', 'HEAD'))
    assert.equal(stage.attempts[0].checks?.[0].code, 0)
    assert.equal(git(run.cwd, 'log', '-1', '--format=%s'), 'add hello', 'the worker committed on the run branch')
    assert.equal(git(s.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the repo itself never moves')
    const worker = thread(s.home, stage.attempts[0].threadId)
    const judge = thread(s.home, stage.attempts[0].judgeId as string)
    assert.equal(worker.title, `${run.id} task #1 worker`)
    assert.deepEqual([worker.runId, worker.stage, worker.cwd], [run.id, 'task', run.cwd])
    assert.deepEqual([judge.rung.backend, judge.readOnly], ['claude', true], 'a pi openai worker gets the claude judge')
    const judgeArgv = argvLog(s.state).find((c) => c.bin === 'claude')?.argv ?? []
    assert.ok(judgeArgv.includes('--json-schema') && judgeArgv.includes('dontAsk'), 'the judge is read-only and answers through the schema')
    matchGolden('task-rung1', runEvents(s.home, run.id))

    const project = s.memory.entries.get(`run-${run.id}`)
    assert.deepEqual([project?.pattern, project?.authority, project?.scope], ['projects', 'observed', `run:${run.id}`])
    assert.deepEqual(project?.source, { kind: 'run', title: `clyde run ${run.id}`, uri: `clyde://runs/${run.id}` })
    const verdict = s.memory.entries.get(stage.entry as string)
    assert.deepEqual([verdict?.pattern, verdict?.authority, verdict?.scope, verdict?.project], ['observations', 'observed', `run:${run.id}`, `run-${run.id}`])
    const diff = verdict?.blobShas.find((b: { name: string }) => b.name === 'diff.patch')
    assert.match(s.memory.blobs.get(diff.sha256)?.text ?? '', /\+hello/)
    assert.deepEqual(run.entries, [`run-${run.id}`, stage.entry])
    assert.ok(s.memory.calls.filter((c) => c.method === 'POST' && c.path === '/entries').every((c) => c.role === 'runtime'))
  } finally {
    await d.close()
    await s.memory.close()
  }
})

test('task passes on rung 2 after a judge fail, the notes reach rung 2, and the judge never sees the worker result', async () => {
  const s = await flowSetup('task-rung2')
  const { d, client } = await flowDaemon()
  try {
    const started: Run = await client.call('POST', '/runs', { flow: 'task', input: TASK, cwd: s.repo })
    const run = await waitStatus(client, started.id, ['done', 'failed', 'stopped'])
    assert.equal(run.status, 'done', run.error)
    const [stage] = run.stages
    assert.deepEqual(stage.attempts.map((a) => [a.rung.effort, a.rung.notes ?? false, a.ok]), [['medium', false, false], ['medium', true, true]])
    assert.equal(stage.attempts[0].reason, 'The judge failed it: NOTE-7731: hello.txt says hullo, not hello.')
    const [first, second] = piPrompts(s.state)
    assert.doesNotMatch(first, /NOTE-7731/)
    assert.ok(second.includes([
      '## Notes from the last attempt', '', 'The last attempt failed. Fix what this says first.', '',
      'The judge failed it.', '- Failed: criterion 1', '  The judge saw: checked 1', "The judge's notes: NOTE-7731: hello.txt says hullo, not hello.",
    ].join('\n')), second)
    matchGolden('task-rung2', runEvents(s.home, run.id))

    // The worker's result and transcript exist, and neither reaches either judge.
    assert.match(stage.attempts[0].result?.summary ?? '', /WORKER-SUMMARY-4/)
    assert.match(thread(s.home, stage.attempts[0].threadId).turns[0].text ?? '', /WORKER-TRANSCRIPT-9/)
    for (const a of stage.attempts) {
      const prompt = thread(s.home, a.judgeId as string).turns[0].prompt
      assert.doesNotMatch(prompt, /WORKER-SUMMARY|WORKER-TRANSCRIPT/)
      assert.match(prompt, /`test -f hello\.txt` exited 0/)
    }
    const second_judge = thread(s.home, stage.attempts[1].judgeId as string).turns[0].prompt
    assert.match(second_judge, /\+hello\n/, 'the diff runs from the stage base, so it holds both attempts')
    assert.match(second_judge, /Commits since then:\n\n[0-9a-f]+ fix greeting\n[0-9a-f]+ add hullo\n/)
  } finally {
    await d.close()
    await s.memory.close()
  }
})

test('after the last ladder rung fails, the next attempt stays there with judge notes', async () => {
  const s = await flowSetup('task-ladder-stop')
  const { d, client } = await flowDaemon()
  try {
    const input = { ...TASK, checks: ['test -f a.txt'] }
    const started: Run = await client.call('POST', '/runs', { flow: 'task', input, cwd: s.repo })
    const run = await waitStatus(client, started.id, ['done', 'failed', 'asking'])
    assert.equal(run.status, 'done', run.question)
    assert.equal(run.stages[0].attempts.length, 3)
    assert.deepEqual(run.stages[0].attempts.map((a) => a.rung.effort), ['medium', 'high', 'high'])
    assert.match(piPrompts(s.state)[1], /The judge's notes: Not good enough\./, 'the high rung gets notes')
    assert.match(piPrompts(s.state)[2], /The judge's notes: Still not good enough\./)
    assert.deepEqual(run.asks, [])
    matchGolden('task-ladder-stop', runEvents(s.home, run.id))
  } finally {
    await d.close()
    await s.memory.close()
  }
})

test('a worker that never reports is resent automatically with the reason', async () => {
  const s = await flowSetup('task-no-report')
  const { d, client } = await flowDaemon()
  try {
    const started: Run = await client.call('POST', '/runs', { flow: 'task', input: TASK, cwd: s.repo })
    const run = await waitStatus(client, started.id, ['done', 'failed', 'asking'])
    assert.equal(run.status, 'done', run.error)
    assert.equal(run.stages[0].attempts[0].judgeId, undefined, 'no judge runs without a result')
    assert.deepEqual([run.stages[0].round, run.stages[0].attempts.length], [2, 2])
    // The silent first worker was sent back three times for its open items before its attempt failed.
    const prompts = piPrompts(s.state)
    assert.equal(prompts.filter((p) => p.endsWith('Your list has 2 open items. Continue with the next one, or block it with why.')).length, 3)
    assert.match(prompts.filter((p) => p.includes('worker for stage task'))[1], /The worker reported no result/)
    assert.deepEqual(run.asks, [])
    matchGolden('task-no-report', runEvents(s.home, run.id))
  } finally {
    await d.close()
    await s.memory.close()
  }
})

test('a worker crash fails the attempt and the next rung hears why', async () => {
  const s = await flowSetup('task-crash')
  const { d, client } = await flowDaemon()
  try {
    const started: Run = await client.call('POST', '/runs', { flow: 'task', input: TASK, cwd: s.repo })
    const run = await waitStatus(client, started.id, ['done', 'failed', 'stopped'])
    assert.equal(run.status, 'done', run.error)
    assert.equal(run.stages[0].attempts[0].reason, 'The worker failed: pi exited with code 1: fake pi crashed.')
    assert.match(piPrompts(s.state)[1], /The worker failed: pi exited with code 1: fake pi crashed\./)
    matchGolden('task-crash', runEvents(s.home, run.id))
  } finally {
    await d.close()
    await s.memory.close()
  }
})

test('stop mid-run stops the worker thread, then the run', async () => {
  const s = await flowSetup('task-stop')
  const { d, client } = await flowDaemon()
  try {
    const started: Run = await client.call('POST', '/runs', { flow: 'task', input: TASK, cwd: s.repo })
    await waitFor(() => turnsTaken(s.state), 10_000, 'the worker to start')
    const stopped: Run = await client.stopRun(started.id)
    assert.equal(stopped.status, 'stopped')
    assert.equal(stopped.error, 'stopped by the user')
    const worker = stopped.stages[0].attempts[0].threadId
    const t = await waitFor(async () => {
      const x = await client.thread(worker)
      return x.status === 'stopped' && x.turns[0].endedAt ? x : null
    }, 10_000, 'the worker to stop')
    assert.equal(t.turns[0].error, 'pi was stopped')
    assert.equal((await client.stopRun(started.id)).status, 'stopped', 'a second stop is a no-op')
    matchGolden('task-stop', runEvents(s.home, started.id))
  } finally {
    await d.close()
    await s.memory.close()
  }
})

test('a run continues with no server address and its entries stay pending', async () => {
  const s = await flowSetup('task-memory-down', { memory: false })
  const { d, client } = await flowDaemon()
  try {
    const started: Run = await client.call('POST', '/runs', { flow: 'task', input: TASK, cwd: s.repo })
    const run = await waitStatus(client, started.id, ['done', 'failed', 'stopped'])
    assert.equal(run.status, 'done', run.error)
    assert.equal(run.entries[0], `run-${run.id}`)
    assert.equal(run.asks.length, 0)
    Object.assign(process.env, { MEMORY_URL: s.memory.url, MEMORY_RUNTIME_TOKEN: s.memory.runtimeToken, MEMORY_TOKEN: s.memory.token })
    const { flushPending } = await import('../src/memory-flush.ts')
    assert.ok(await flushPending({ url: s.memory.url, runtimeToken: s.memory.runtimeToken, agentToken: s.memory.token }) >= 2)
  } finally {
    await d.close()
    await s.memory.close()
  }
})

test('a brief write outage keeps the run active and completes without a memory question', async () => {
  // Memory writes are spooled and never block the run, so the run can finish while the daemon is still retrying.
  // The worker therefore waits for a file the test writes after it has seen the run active, instead of racing the clock.
  const s = await flowSetup('task-rung1-held')
  let failures = 0
  const proxy = http.createServer(async (req, res) => {
    // A late flush can reach the proxy after the fake memory has closed; that must not become an unhandled rejection.
    try {
      if (req.method === 'POST' && req.url === '/entries' && failures < 2) {
        failures++
        res.writeHead(503).end('temporarily unavailable')
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const upstream = await fetch(`${s.memory.url}${req.url}`, {
        method: req.method, headers: { authorization: req.headers.authorization ?? '' },
        body: req.method === 'GET' ? undefined : Buffer.concat(chunks),
      })
      res.writeHead(upstream.status).end(Buffer.from(await upstream.arrayBuffer()))
    } catch {
      res.destroy()
    }
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  process.env.MEMORY_URL = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
  const { d, client } = await flowDaemon()
  try {
    const started: Run = await client.call('POST', '/runs', { flow: 'task', input: TASK, cwd: s.repo })
    await waitFor(() => failures === 2 ? true : null, 5000, 'two transient failures')
    const pending = await client.run(started.id)
    assert.equal(pending.status, 'running')
    assert.equal(pending.asks.length, 0)
    writeFileSync(join(s.state, 'release-worker'), '')
    const done = await waitStatus(client, started.id, ['done', 'failed', 'stopped'])
    assert.equal(done.status, 'done', done.error)
    assert.equal(done.asks.length, 0)
    assert.equal(s.memory.entries.has(`run-${done.id}`), true)
  } finally {
    writeFileSync(join(s.state, 'release-worker'), '')
    await d.close()
    proxy.closeAllConnections()
    proxy.close()
    await s.memory.close()
  }
})

test('a sustained write outage leaves the run active and then completed', async () => {
  const s = await flowSetup('task-rung1')
  const unavailable = http.createServer((_req, res) => res.writeHead(503).end('temporarily unavailable'))
  await new Promise<void>((resolve) => unavailable.listen(0, '127.0.0.1', resolve))
  process.env.MEMORY_URL = `http://127.0.0.1:${(unavailable.address() as { port: number }).port}`
  const { d, client } = await flowDaemon()
  try {
    const started: Run = await client.call('POST', '/runs', { flow: 'task', input: TASK, cwd: s.repo })
    const done = await waitStatus(client, started.id, ['done', 'failed', 'stopped'])
    assert.equal(done.status, 'done', done.error)
    assert.equal(done.asks.length, 0)
    assert.ok(done.entries.length >= 2)
  } finally {
    await d.close()
    unavailable.closeAllConnections()
    unavailable.close()
    await s.memory.close()
  }
})

test('the run routes refuse bad starts and answers, and /health counts runs', async () => {
  const s = await flowSetup('task-rung1')
  const { d, client } = await flowDaemon()
  const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status: number; message: string }) => `${e.status} ${e.message}`)
  try {
    assert.deepEqual(await client.runs(), [])
    assert.equal(await status(client.call('POST', '/runs', { flow: 'nope', input: TASK, cwd: s.repo })), '400 no flow nope. Flows: ship, task')
    assert.equal(await status(client.call('POST', '/runs', { flow: '../task', input: TASK })), '400 no flow ../task. Flows: ship, task')
    assert.equal(await status(client.call('POST', '/runs', { flow: 'task', input: { prompt: 'x' }, cwd: s.repo })), '400 bad input for flow task: criteria must be a non-empty list of strings')
    assert.equal(await status(client.call('POST', '/runs', { flow: 'ship', input: {}, cwd: s.repo })), '400 bad input for flow ship: intent must be a non-empty string')
    assert.match(String(await status(client.call('POST', '/runs', { flow: 'task', input: TASK, cwd: s.state }))), /^400 can't cut a worktree from /)
    assert.equal(await status(client.run('r-missing')), '404 no run r-missing')
    const started: Run = await client.call('POST', '/runs', { flow: 'task', input: TASK, cwd: s.repo })
    const run = await waitStatus(client, started.id, ['done', 'failed'])
    assert.equal(await status(client.answer(run.id, 'yes')), `409 run ${run.id} isn't asking anything`)
    assert.equal((await client.health()).runs, 1)
    assert.deepEqual((await client.runs()).map((r) => r.id), [run.id])
  } finally {
    await d.close()
    await s.memory.close()
  }
})

test('a result posted to the daemon, as clyde result does, wins over the fenced block', async () => {
  const s = await flowSetup('task-posted-result')
  const { d, client } = await flowDaemon()
  try {
    const started: Run = await client.call('POST', '/runs', { flow: 'task', input: TASK, cwd: s.repo })
    await waitFor(() => turnsTaken(s.state), 10_000, 'the worker to start')
    const worker = (await client.run(started.id)).stages[0].attempts[0].threadId
    // done is refused while the seeded list is open, so the worker closes both items first, as clyde todo does.
    await client.todo(`thread:${worker}`, 'done', { n: 1, evidence: 'hello.txt holds hello' })
    await client.todo(`thread:${worker}`, 'done', { n: 2, evidence: 'reported below' })
    await client.postResult(worker, { status: 'done', summary: 'FROM-LV-RESULT', evidence: [{ criterion: 'A hello file.', evidence: 'hello.txt' }] })
    const run = await waitStatus(client, started.id, ['done', 'failed', 'stopped'])
    assert.equal(run.status, 'done', run.error)
    assert.equal(run.stages[0].summary, 'FROM-LV-RESULT')
  } finally {
    await d.close()
    await s.memory.close()
  }
})

test('a worker that runs the real clyde result passes without a fenced block', { skip: !existsSync(join(repoRoot(), 'harness', 'src', 'cli', 'result.ts')) }, async () => {
  const s = await flowSetup('task-clyde-result')
  const { d, client } = await flowDaemon()
  try {
    const started: Run = await client.call('POST', '/runs', { flow: 'task', input: TASK, cwd: s.repo })
    const run = await waitStatus(client, started.id, ['done', 'failed', 'stopped'])
    assert.equal(run.status, 'done', run.error)
    assert.equal(run.stages[0].attempts[0].result?.summary, 'FROM-LV-RESULT')
  } finally {
    await d.close()
    await s.memory.close()
  }
})

test('a judge from the same family still judges, and the run logs why', async () => {
  const s = await flowSetup('task-clyde-result')
  writeFileSync(join(s.home, 'roles.json'), JSON.stringify({
    ...TEST_ROLES,
    worker: [{ backend: 'claude', model: 'haiku' }], judge: [{ backend: 'claude', model: 'sonnet' }],
  }))
  const { d, client } = await flowDaemon()
  try {
    const started: Run = await client.call('POST', '/runs', { flow: 'task', input: TASK, cwd: s.repo })
    const run = await waitStatus(client, started.id, ['done', 'failed', 'stopped'])
    assert.equal(run.status, 'done', run.error)
    assert.ok(run.log.some((l) => /No judge rung is from another family/.test(l)), 'the same-family judge is logged')
  } finally {
    await d.close()
    await s.memory.close()
  }
})

test('POST /runs/:id/parent reattaches an asking run and rejects terminal runs with 409', async () => {
  const s = await flowSetup('task-limit')
  const { d, client } = await flowDaemon()
  const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status: number; message: string }) => `${e.status} ${e.message}`)
  try {
    const started: Run = await client.call('POST', '/runs', { flow: 'task', input: TASK, cwd: s.repo, paseoParentId: 'old-chat' })
    const asking = await waitStatus(client, started.id, ['asking', 'done', 'failed'])
    assert.equal(asking.status, 'asking')
    const reattached: Run = await client.call('POST', `/runs/${started.id}/parent`, { paseoParentId: 'new-chat' })
    assert.equal(reattached.paseoParentId, 'new-chat')
    assert.equal((await client.run(started.id)).paseoParentId, 'new-chat')
    await client.stopRun(started.id)
    assert.equal(await status(client.call('POST', `/runs/${started.id}/parent`, { paseoParentId: 'later-chat' })), `409 run ${started.id} is stopped`)
  } finally {
    await d.close()
    await s.memory.close()
  }
})
