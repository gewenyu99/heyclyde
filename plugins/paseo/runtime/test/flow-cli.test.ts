/** clyde flow from the command line: exit codes, --answers, --auto-approve, an unanswered ask resumed later, and the daemon commands. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { readDaemonInfo } from '../src/config.ts'
import type { Run } from '../src/flow/types.ts'
import { flowDaemon, flowSetup, clyde, matchGolden, runEvents, waitStatus } from './golden/flow.ts'
import { turnsTaken, waitFor } from './helpers.ts'

const TASK = { prompt: 'Write hello.txt holding hello.', criteria: ['A hello file. hello.txt holds hello.'], checks: ['test -f hello.txt'] }

function savedRun(home: string, id: string): Run {
  return JSON.parse(readFileSync(join(home, 'runs', `${id}.json`), 'utf8'))
}

function runId(text: string): string {
  return (text.match(/Started run (r-[0-9a-f]{8})/) ?? [])[1] ?? ''
}

test('clyde flow run exits 2 on a limit ask, and the next daemon resumes that ask', async () => {
  const s = await flowSetup('task-limit')
  try {
    const r = await clyde(['flow', 'run', 'task', '--input', JSON.stringify(TASK)], s.repo)
    assert.equal(r.code, 2, r.stderr)
    const id = runId(r.stdout)
    assert.match(r.stdout, new RegExp(`\\nRun ${id} is waiting on this, and nothing here answers it:\\n\\nStage task of run ${id} hit a backend limit:`))
    assert.match(r.stdout, new RegExp(`Answer with clyde flow answer ${id} "<text>"\\.\\n$`))
    assert.equal(readDaemonInfo(), null, 'the in-process daemon closed with the command')
    const saved = savedRun(s.home, id)
    assert.deepEqual([saved.status, saved.stages[0].status], ['asking', 'asking'])

    const { d, client } = await flowDaemon()
    try {
      const asking = await waitFor(() => runEvents(s.home, id).filter((e) => e.type === 'run.ask').length === 2, 10_000, 'the ask again')
      assert.ok(asking)
      assert.equal(turnsTaken(s.state), 1, 'the limited worker did not run again')
      await client.answer(id, 'stop')
      const run = await waitStatus(client, id, ['done', 'failed', 'stopped'])
      assert.deepEqual([run.status, run.error, run.stages[0].status], ['stopped', 'stage task stopped by the user', 'failed'])
      matchGolden('task-unanswered', runEvents(s.home, id))
    } finally {
      await d.close()
    }
  } finally {
    await s.memory.close()
  }
})

test('clyde flow run --answers answers a limit ask by regex, and exits 0 after recovery', async () => {
  const s = await flowSetup('task-limit')
  try {
    const answers = join(s.state, 'answers.json')
    writeFileSync(answers, JSON.stringify([{ match: 'Approve', text: 'approved' }, { match: 'hit a backend limit', text: 'retry after reset' }]))
    const r = await clyde(['flow', 'run', 'task', '--input', JSON.stringify(TASK), '--answers', answers], s.repo)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /\nanswer {10}retry after reset \(answers file\)\n/)
    assert.match(r.stdout, /\nrun\.done {8}Run r-[0-9a-f]{8} \(task\) is done on branch clyde\/r-[0-9a-f]{8}\.\n$/)
    assert.equal(savedRun(s.home, runId(r.stdout)).asks[0].via, 'answers file')
  } finally {
    await s.memory.close()
  }
})

test('--auto-approve answers a limit ask with stop, so the run stops and clyde exits 1', async () => {
  const s = await flowSetup('task-limit')
  try {
    const r = await clyde(['flow', 'run', 'task', '--input', JSON.stringify(TASK), '--auto-approve', '--json'], s.repo)
    assert.equal(r.code, 1, r.stderr)
    const report = JSON.parse(r.stdout)
    assert.deepEqual([report.status, report.stages[0].passed, report.stages[0].attempts], ['stopped', false, 1])
    assert.equal(report.events.at(-1).type, 'run.stopped')
  } finally {
    await s.memory.close()
  }
})

test('clyde flow refuses bad usage and a flow that does not exist', async () => {
  const s = await flowSetup('task-rung1')
  try {
    const none = await clyde(['flow', 'run'], s.repo)
    assert.equal(none.code, 2)
    assert.match(none.stderr, /^clyde flow run needs a flow name, like task or ship\.\nUsage:/)
    const bad = await clyde(['flow', 'run', 'task', '--input', '{nope'], s.repo)
    assert.equal(bad.code, 2)
    assert.match(bad.stderr, /^--input must be JSON or @file\.json, and \{nope isn't/)
    const missing = await clyde(['flow', 'run', 'nope', '--input', '{}'], s.repo)
    assert.equal(missing.code, 1)
    assert.equal(missing.stderr, 'clyde flow run: no flow nope. Flows: ship, task\n')
    const input = join(s.state, 'input.json')
    writeFileSync(input, JSON.stringify({ prompt: 'x' }))
    const fromFile = await clyde(['flow', 'run', 'task', '--input', `@${input}`], s.repo)
    assert.equal(fromFile.stderr, 'clyde flow run: bad input for flow task: criteria must be a non-empty list of strings\n')
  } finally {
    await s.memory.close()
  }
})

test('clyde flow start, list, read, answer and stop talk to a detached daemon', async () => {
  const s = await flowSetup('task-stop')
  let pid = 0
  try {
    const started = await clyde(['flow', 'start', 'task', '--input', JSON.stringify(TASK), '--json'], s.repo)
    assert.equal(started.code, 0, started.stderr)
    const run: Run = JSON.parse(started.stdout)
    pid = readDaemonInfo()?.pid ?? 0
    assert.ok(pid && pid !== process.pid)
    assert.equal(run.repo, s.repo, 'start cuts the worktree from the caller\'s directory')
    await waitFor(() => turnsTaken(s.state), 10_000, 'the worker to start')
    const list = await clyde(['flow', 'list'], s.repo)
    assert.match(list.stdout, new RegExp(`^run     ${run.id}  running  task\\s+stage task\\n$`))
    const read = await clyde(['flow', 'read', run.id], s.repo)
    assert.match(read.stdout, new RegExp(`branch clyde/${run.id} in ${run.cwd}\\n  stage  task\\s+running  1 attempt\\n$`))
    const answer = await clyde(['flow', 'answer', run.id, 'yes'], s.repo)
    assert.equal(answer.code, 1)
    assert.equal(answer.stderr, `clyde: run ${run.id} isn't asking anything\n`)
    const stop = await clyde(['flow', 'stop', run.id], s.repo)
    assert.match(stop.stdout, new RegExp(`^run     ${run.id}  stopped  task`))
  } finally {
    if (pid) {
      process.kill(pid, 'SIGTERM')
      await waitFor(() => readDaemonInfo() === null, 10_000, 'the daemon to exit')
    }
    await s.memory.close()
  }
})
