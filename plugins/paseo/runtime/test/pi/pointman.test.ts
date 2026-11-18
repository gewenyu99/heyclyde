/** Tier 2: the real pi with the fake model and the clyde extension in point man mode, against an in-process daemon with fake backends. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { DaemonClient } from '../../src/client.ts'
import { readDaemonInfo } from '../../src/config.ts'
import { startDaemon } from '../../src/daemon.ts'
import { startFakeMemory } from '../fakes/memory.ts'
import { LV, setup, waitFor } from '../helpers.ts'
import {
  assistantTexts, piEnv, POINT_MAN_TOOLS, Rpc, runJson, sleep, statusUpdate, textOf, toolsGiven, WORKER_TOOLS, writeScript,
} from './helpers.ts'

const run = promisify(execFile)

test('the point man reads a full checkpoint pitch beyond the status excerpt', async () => {
  const pitch = `Shape pitch\n${'Keep this detail verbatim.\n'.repeat(200)}Do you approve?`
  const s = setup([{ reply: pitch }])
  const d = await startDaemon({ port: 0 })
  try {
    const t = d.ctx.threads.start({ title: 'shape', prompt: 'pitch', cwd: s.repo, rung: { backend: 'codex' } })
    await d.ctx.threads.waitIdle(t.id)
    const script = writeScript(s.state, [
      { tool: 'clyde_thread_read', args: { id: t.id } },
      { text: 'Waiting for Wen.' },
    ])
    const r = await runJson(['-p', 'read the checkpoint'], {
      cwd: s.repo, env: piEnv({ CLYDE_POINT_MAN: '1', CLYDE_FAKE_PI_SCRIPT: script.path }),
    })
    assert.equal(r.code, 0, r.stderr)
    const end = r.records.find((x) => x.type === 'tool_execution_end' && x.toolName === 'clyde_thread_read')
    assert.equal(end?.isError, false)
    assert.ok(textOf(end.result.content).includes(pitch), 'the tool returns every character of the pitch')
  } finally {
    await d.close()
  }
})

test('the point man calls clyde_thread_start, and the thread shows in clyde status', async () => {
  const s = setup([{ match: 'fix the readme', reply: 'The readme is fixed.' }])
  const d = await startDaemon({ port: 0 })
  const memory = await startFakeMemory()
  try {
    const script = writeScript(s.state, [
      { tool: 'clyde_thread_start', args: { prompt: 'fix the readme', title: 'readme fix', backend: 'pi', model: 'fake/other', effort: 'low' } },
      { text: 'Started it.' },
    ])
    const r = await runJson(['-p', 'start a thread that fixes the readme'], {
      cwd: s.repo, env: piEnv({ CLYDE_POINT_MAN: '1', CLYDE_FAKE_PI_SCRIPT: script.path, MEMORY_URL: memory.url, MEMORY_TOKEN: memory.token }),
    })
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(toolsGiven(r.records).filter((t) => t.startsWith('clyde_')), POINT_MAN_TOOLS)

    const [t] = d.ctx.threads.list()
    assert.ok(t, 'the daemon has the thread')
    assert.deepEqual([t.title, t.cwd, t.turns[0]?.prompt], ['readme fix', s.repo, 'fix the readme'])
    assert.deepEqual(t.rung, { backend: 'pi', model: 'fake/other', effort: 'low' })
    const end = r.records.find((x) => x.type === 'tool_execution_end' && x.toolName === 'clyde_thread_start')
    assert.equal(end?.isError, false)
    assert.equal(textOf(end.result.content).split('\n')[0], `Started thread ${t.id} "readme fix" in ${s.repo}.`)
    assert.deepEqual(assistantTexts(r.records).at(-1), 'Started it.')

    await d.ctx.threads.waitIdle(t.id)
    // clyde_thread_start put the thread on the point man's list, and thread.done closed it with the thread's answer.
    assert.deepEqual(d.ctx.threads.lists.get('pointman').items.map((i) => [i.text, i.status, i.threadId, i.evidence]), [
      [`Thread ${t.id}: readme fix`, 'done', t.id, 'The readme is fixed.'],
    ])
    const status = await run(process.execPath, [LV, 'status'], { env: process.env })
    assert.match(status.stdout, new RegExp(`^thread  ${t.id}\\s+idle\\s+pi fake/other low\\s+1 turn\\s+readme fix$`, 'm'))

    // The model got the durable rules in its system prompt and the status block with the prompt.
    const [first] = script.seen()
    assert.match(first.system, /You're Wen's point man\. Delegate any exploration/)
    assert.match(first.system, /Never approve, infer an answer or answer for him/)
    assert.equal(first.lastUser, 'clyde: 0 running · 0 asking\nNo threads or runs.')

    // Its own session events reach memory like memory-hook's, with the agent token and no thread id.
    const session = r.records.find((x) => x.type === 'session')?.id
    // Each hook is its own fire-and-forget request, so they may land in any order.
    assert.deepEqual(memory.hooks.map((h) => h.event).sort(), ['PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'])
    for (const h of memory.hooks) assert.deepEqual([h.payload.session_id, h.payload.thread_id, h.payload.cwd], [session, undefined, s.repo])
    assert.ok(memory.calls.filter((c) => c.path.startsWith('/hooks/')).every((c) => c.role === 'agent'))
    assert.equal(memory.hooks.find((h) => h.event === 'PostToolUse')?.payload.tool_name, 'clyde_thread_start')
  } finally {
    await d.close()
    await memory.close()
  }
})

test('in RPC mode a finished thread wakes the point man with one message the model sees', async () => {
  const s = setup([{ match: 'count the files', reply: 'There are 3 files.', delayMs: 1000 }])
  const d = await startDaemon({ port: 0 })
  const script = writeScript(s.state, [{ echo: true }, { echo: true }])
  const pi = new Rpc({ cwd: s.repo, env: piEnv({ CLYDE_POINT_MAN: '1', CLYDE_FAKE_PI_SCRIPT: script.path }) })
  try {
    await pi.waitFor((r) => statusUpdate(r, 'clyde: 0 running · 0 asking'), 'the first status line')
    const first = await pi.prompt('hello')
    assert.deepEqual(assistantTexts(pi.records, first), ['echo: clyde: 0 running · 0 asking\nNo threads or runs.'])

    const from = pi.records.length
    const t = d.ctx.threads.start({ title: 'count', prompt: 'count the files', cwd: s.repo, rung: { backend: 'pi' } })
    const running = await pi.waitFor((r) => statusUpdate(r, 'clyde: 1 running · 0 asking'), 'the running count', { from })
    await pi.waitFor((r) => statusUpdate(r, 'clyde: 0 running · 0 asking'), 'the count back at 0', { from: pi.records.indexOf(running) })
    const event = await pi.waitFor((r) => r.type === 'message_end' && r.message?.customType === 'clyde-event', 'the clyde-event message', { from })
    const summary = `clyde: Thread ${t.id} "count" is done: There are 3 files.`
    assert.equal(textOf(event.message.content), summary)
    assert.equal(event.message.display, true)
    const wake = pi.records.indexOf(event)
    await pi.waitFor((r) => r.type === 'agent_settled', 'the woken run to settle', { from: wake })
    assert.deepEqual(assistantTexts(pi.records, wake), [`echo: ${summary}`])
    assert.equal(pi.records.filter((r) => r.type === 'message_end' && r.message?.customType === 'clyde-event').length, 1, 'one message for the batch')
  } finally {
    await pi.close()
    await d.close()
  }
})

test('the point man starts a flow that continues without a memory server', async () => {
  const s = setup([
    { match: 'worker for stage task of', reply: 'Done.', json: { status: 'done', summary: 'wrote hello', evidence: [{ criterion: 'all', evidence: 'wrote hello' }] }, write: { 'hello.txt': 'hello\n' }, commit: 'add hello' },
    { match: 'judge for stage task of', json: { verdict: 'pass', criteria: [{ criterion: 'criterion 1', pass: true, evidence: 'checked' }], notes: 'Fine.' } },
  ])
  const d = await startDaemon({ port: 0 })
  const client = new DaemonClient({ pid: process.pid, port: d.port, token: d.token })
  const input = { prompt: 'Write hello.txt holding hello.', criteria: ['hello.txt holds hello.'], checks: ['test -f hello.txt'] }
  const script = writeScript(s.state, [{ tool: 'clyde_flow_start', args: { flow: 'task', input } }, { text: 'Started.' }, { echo: true }])
  const pi = new Rpc({ cwd: s.repo, env: piEnv({ CLYDE_POINT_MAN: '1', CLYDE_FAKE_PI_SCRIPT: script.path }) })
  const tools = (from: number) => pi.records.slice(from).filter((r) => r.type === 'tool_execution_end').map((r) => [r.toolName, r.isError, textOf(r.result.content)])
  try {
    await pi.waitFor((r) => statusUpdate(r), 'the first status line')
    const first = await pi.prompt('start a task that writes hello.txt')
    const [[, failed, started]] = tools(first)
    assert.equal(failed, false, started)
    const id = started.match(/^Started run (r-[0-9a-f]{8}), flow task, on branch clyde\/\1\.$/m)?.[1] as string
    assert.ok(id, started)
    assert.equal((await client.run(id)).repo, s.repo, 'the run is cut from the point man\'s directory')

    const done = await waitFor(async () => { const r = await client.run(id); return r.status === 'done' && r }, 20_000, 'the run to finish')
    assert.equal(done.asks.length, 0)
    // run.done wakes the point man up to 2 seconds after the run ends. That turn settles before the next prompt, or the
    // prompt would take the wake-up's step.
    const wake = await pi.waitFor((r) => r.type === 'message_end' && r.message?.customType === 'clyde-event' &&
      textOf(r.message.content).includes(`Run ${id} (task) is done`), 'the run.done wake-up', { from: first })
    await pi.waitFor((r) => r.type === 'agent_settled', 'the woken turn to settle', { from: pi.records.indexOf(wake) })
    // Each model call takes the next step, so the new ones start after however many wake-ups there were.
    script.add([...Array(Math.max(0, script.seen().length - 3)).fill({ text: 'ok' }), { tool: 'clyde_runs' }, { text: 'Finished.' }])
    const second = await pi.prompt('show the run')
    const [runs] = tools(second)
    assert.match(runs[2], new RegExp(`^run     ${id}\\s+done\\s+task`, 'm'))
  } finally {
    await pi.close()
    await d.close()
  }
})

test('events that land within 2 seconds batch into one message', async () => {
  const s = setup([])
  const d = await startDaemon({ port: 0 })
  const script = writeScript(s.state, [{ text: 'hi' }, { echo: true }])
  const pi = new Rpc({ cwd: s.repo, env: piEnv({ CLYDE_POINT_MAN: '1', CLYDE_FAKE_PI_SCRIPT: script.path }) })
  try {
    await pi.waitFor((r) => statusUpdate(r), 'the first status line')
    await pi.prompt('hello')
    const from = pi.records.length
    d.ctx.events.append({ type: 'thread.failed', threadId: 't-aaaa1111', summary: 'Thread t-aaaa1111 "a" failed: boom.' })
    d.ctx.events.append({ type: 'thread.started', threadId: 't-bbbb2222', summary: 'Started thread t-bbbb2222 "b".' })
    d.ctx.events.append({ type: 'thread.done', threadId: 't-cccc3333', runId: 'r-1', summary: 'Thread t-cccc3333 is done: a run step.' })
    await sleep(500)
    d.ctx.events.append({ type: 'run.ask', runId: 'r-2', summary: 'Run r-2 asks: Approve the plan?' })
    const event = await pi.waitFor((r) => r.type === 'message_end' && r.message?.customType === 'clyde-event', 'the batch', { from })
    assert.equal(textOf(event.message.content), [
      'clyde: 2 updates.', '- Thread t-aaaa1111 "a" failed: boom.', '- Run r-2 asks: Approve the plan?',
    ].join('\n'))
  } finally {
    await pi.close()
    await d.close()
  }
})

test('an event before the first prompt waits for that prompt to settle', async () => {
  const s = setup([])
  const d = await startDaemon({ port: 0 })
  const script = writeScript(s.state, [{ text: 'hi' }, { echo: true }])
  const pi = new Rpc({ cwd: s.repo, env: piEnv({ CLYDE_POINT_MAN: '1', CLYDE_FAKE_PI_SCRIPT: script.path }) })
  try {
    await pi.waitFor((r) => statusUpdate(r), 'the first status line')
    d.ctx.events.append({ type: 'thread.done', threadId: 't-dddd4444', summary: 'Thread t-dddd4444 "d" is done: ok.' })
    await sleep(3000)
    assert.equal(pi.records.filter((r) => r.type === 'agent_start').length, 0, 'no run before the first prompt')
    const from = await pi.prompt('hello')
    const event = await pi.waitFor((r) => r.type === 'message_end' && r.message?.customType === 'clyde-event', 'the held event', { from })
    assert.equal(textOf(event.message.content), 'clyde: Thread t-dddd4444 "d" is done: ok.')
    await pi.waitFor((r) => r.type === 'agent_settled', 'the woken run', { from: pi.records.indexOf(event) })
    assert.deepEqual(assistantTexts(pi.records, from), ['hi', 'echo: clyde: Thread t-dddd4444 "d" is done: ok.'])
  } finally {
    await pi.close()
    await d.close()
  }
})

test('after a daemon restart the stream reconnects and picks up where it left off', async () => {
  const s = setup([])
  let d = await startDaemon({ port: 0 })
  const script = writeScript(s.state, [{ text: 'hi' }, { text: 'one' }, { text: 'two' }])
  const pi = new Rpc({ cwd: s.repo, env: piEnv({ CLYDE_POINT_MAN: '1', CLYDE_FAKE_PI_SCRIPT: script.path }) })
  const clydeEvents = () => pi.records.filter((r) => r.type === 'message_end' && r.message?.customType === 'clyde-event').map((r) => textOf(r.message.content))
  try {
    await pi.waitFor((r) => statusUpdate(r), 'the first status line')
    await pi.prompt('hello')
    d.ctx.events.append({ type: 'thread.done', threadId: 't-eeee5555', summary: 'Thread t-eeee5555 "e" is done: first.' })
    await waitFor(() => clydeEvents().length === 1, 10_000, 'the first event')
    await d.close()
    // The extension retries after a second. The new daemon is up well before that, so it never starts its own.
    d = await startDaemon({ port: 0 })
    d.ctx.events.append({ type: 'run.done', runId: 'r-7', summary: 'Run r-7 is done.' })
    await waitFor(() => clydeEvents().length === 2, 15_000, 'the event after the restart')
    await sleep(2500)
    assert.deepEqual(clydeEvents(), ['clyde: Thread t-eeee5555 "e" is done: first.', 'clyde: Run r-7 is done.'], 'nothing replayed twice')
  } finally {
    await pi.close()
    await d.close()
  }
})

test('the point man starts the daemon when none answers', async () => {
  const s = setup([{ match: 'say hi', reply: 'hi' }])
  const script = writeScript(s.state, [{ tool: 'clyde_thread_start', args: { prompt: 'say hi', title: 'hi' } }, { text: 'Started.' }])
  try {
    const r = await runJson(['-p', 'start a thread'], { cwd: s.repo, env: piEnv({ CLYDE_POINT_MAN: '1', CLYDE_FAKE_PI_SCRIPT: script.path }) })
    assert.equal(r.code, 0, r.stderr)
    const info = readDaemonInfo()
    assert.ok(info && info.pid !== process.pid, 'a detached clyde daemon wrote daemon.json')
    const client = new DaemonClient(info)
    const [t] = await client.threads()
    assert.equal(t?.title, 'hi')
    assert.equal((await client.waitIdle(t.id, 50)).turns[0].text, 'hi')
  } finally {
    const info = readDaemonInfo()
    if (info && info.pid !== process.pid) process.kill(info.pid, 'SIGTERM')
    await waitFor(() => !existsSync(join(s.home, 'daemon.json')), 10_000, 'the spawned daemon to stop')
  }
})

test('with CLYDE_DELIVERY=happier the extension leaves wake-ups to Happier', async () => {
  const s = setup([{ match: 'count the files', reply: 'There are 3 files.', delayMs: 1000 }])
  const d = await startDaemon({ port: 0 })
  const script = writeScript(s.state, [{ text: 'hi' }, { echo: true }])
  const pi = new Rpc({ cwd: s.repo, env: piEnv({ CLYDE_POINT_MAN: '1', CLYDE_DELIVERY: 'happier', CLYDE_FAKE_PI_SCRIPT: script.path }) })
  try {
    await pi.waitFor((r) => statusUpdate(r), 'the first status line')
    await pi.prompt('hello')
    const from = pi.records.length
    const t = d.ctx.threads.start({ title: 'count', prompt: 'count the files', cwd: s.repo, rung: { backend: 'pi' } })
    // The status line still follows the events, so the stream is live.
    const running = await pi.waitFor((r) => statusUpdate(r, 'clyde: 1 running · 0 asking'), 'the running count', { from })
    await d.ctx.threads.waitIdle(t.id)
    const done = await pi.waitFor((r) => statusUpdate(r, 'clyde: 0 running · 0 asking'), 'the count back at 0', { from: pi.records.indexOf(running) })
    await sleep(3000)
    const after = pi.records.slice(pi.records.indexOf(done))
    assert.equal(after.filter((r) => r.message?.customType === 'clyde-event').length, 0, 'no injected message')
    assert.equal(pi.records.slice(from).filter((r) => r.type === 'agent_start').length, 0, 'no new run')
    assert.equal(script.seen().length, 1, 'the model ran once, for the prompt')
  } finally {
    await pi.close()
    await d.close()
  }
})

test('with neither CLYDE_POINT_MAN nor CLYDE_THREAD_ID the extension registers nothing', async () => {
  const s = setup([])
  const script = writeScript(s.state, [{ tools: true }])
  const r = await runJson(['-p', 'which tools do you have'], { cwd: s.repo, env: piEnv({ CLYDE_FAKE_PI_SCRIPT: script.path }) })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(toolsGiven(r.records), ['bash', 'edit', 'read', 'write'])
  assert.deepEqual(assistantTexts(r.records), ['tools: bash,edit,read,write'])
  assert.equal(r.records.filter((x) => x.message?.customType === 'clyde-status').length, 0, 'no status block')
  assert.equal(existsSync(join(s.home, 'daemon.json')), false, 'no daemon started')
  assert.ok(!POINT_MAN_TOOLS.concat(WORKER_TOOLS).some((t) => script.seen()[0].tools.includes(t)))
})

test("the point man keeps its own list with clyde_todo, and every prompt's status block carries it", async () => {
  const s = setup([])
  const d = await startDaemon({ port: 0 })
  const script = writeScript(s.state, [
    { tool: 'clyde_todo', args: { action: 'add', items: ['Ask Wen about the deploy window'] } },
    { tool: 'clyde_todo', args: { action: 'done', n: 1 } },
    { text: 'Noted.' },
    { echo: true },
  ])
  const pi = new Rpc({ cwd: s.repo, env: piEnv({ CLYDE_POINT_MAN: '1', CLYDE_FAKE_PI_SCRIPT: script.path }) })
  try {
    await pi.waitFor((r) => statusUpdate(r), 'the first status line')
    const first = await pi.prompt('remember to ask about the deploy')
    const ends = pi.records.slice(first).filter((r) => r.type === 'tool_execution_end').map((r) => [r.isError, textOf(r.result.content)])
    const list = 'Work list, point man: 0 done, 0 doing, 1 todo\n[ ] 1 Ask Wen about the deploy window\nNext: start 1, and say how.'
    assert.deepEqual(ends[0], [false, list])
    assert.deepEqual(ends[1], [true, `evidence must be a non-empty string\n\n${list}`], 'a refusal is a tool error that still shows the list')
    const second = await pi.prompt('what is on your list?')
    assert.deepEqual(assistantTexts(pi.records, second), [`echo: clyde: 0 running · 0 asking\nNo threads or runs.\n\n${list}`])
  } finally {
    await pi.close()
    await d.close()
  }
})
