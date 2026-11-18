import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startDelivery } from '../src/delivery.ts'
import { EventLog } from '../src/events.ts'
import { paseoBin, saveState } from '../src/paseo.ts'
import { writeJson } from '../src/store.ts'
import { FAKE_BIN, HARNESS, setup, waitFor } from './helpers.ts'

function harness() {
  const h = setup([], { CLYDE_PASEO_BIN: join(FAKE_BIN, 'paseo'), CLYDE_PASEO_DELIVER: join(FAKE_BIN, 'paseo-deliver') })
  writeJson(join(h.state, 'paseo.json'), {})
  saveState({ agentId: 'pointman', cwd: h.repo, createdAt: new Date().toISOString() })
  const calls = (): string[][] => {
    try { return readFileSync(join(h.state, 'paseo-argv.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) }
    catch { return [] }
  }
  // Messages reach the point man only through the delivery script, never through paseo send, which interrupts a running turn.
  const delivers = (): { id: string; text: string; running: boolean }[] => {
    try { return readFileSync(join(h.state, 'deliver-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) }
    catch { return [] }
  }
  const sends = () => delivers().map((s) => s.text)
  const interrupted = () => existsSync(join(h.state, 'interrupted'))
  return { ...h, calls, delivers, sends, interrupted, events: new EventLog() }
}

test('a Paseo executable found on PATH resolves to an absolute path for the delivery helper', () => {
  const before = { bin: process.env.CLYDE_PASEO_BIN, path: process.env.PATH }
  try {
    delete process.env.CLYDE_PASEO_BIN
    process.env.PATH = FAKE_BIN
    assert.equal(paseoBin(), join(FAKE_BIN, 'paseo'))
  } finally {
    if (before.bin === undefined) delete process.env.CLYDE_PASEO_BIN
    else process.env.CLYDE_PASEO_BIN = before.bin
    if (before.path === undefined) delete process.env.PATH
    else process.env.PATH = before.path
  }
})

test('delivery waits for the point man to finish its turn before sending', async () => {
  const h = harness()
  const running = join(h.state, 'pointman-running')
  writeFileSync(running, '')
  const stop = startDelivery(h.events, { batchMs: 10, retryMs: 10 })
  try {
    h.events.append({ type: 'thread.done', summary: 'Thread finished' })
    await waitFor(() => h.calls().some((args) => args[0] === 'wait'), 5000, 'the idle wait')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(h.sends(), [], 'a running turn received nothing')
    assert.ok(existsSync(running))
    rmSync(running)
    await waitFor(() => h.sends().length === 1, 5000, 'the send after idle')
    assert.deepEqual(h.calls().map((args) => args[0]), ['wait', 'inspect'])
    assert.deepEqual(h.delivers(), [{ id: 'pointman', text: 'clyde: Thread finished', running: false }])
    assert.equal(h.interrupted(), false)
  } finally { stop(); rmSync(running, { force: true }) }
})

test('a timed-out wait never permits a send while inspect still reports running', async () => {
  const h = harness()
  const running = join(h.state, 'pointman-running')
  writeJson(join(h.state, 'paseo.json'), { waitTimesOutWhileRunning: true })
  writeFileSync(running, '')
  const stop = startDelivery(h.events, { batchMs: 10, retryMs: 10 })
  try {
    h.events.append({ type: 'thread.done', summary: 'Thread finished' })
    await waitFor(() => h.calls().filter((args) => args[0] === 'wait').length >= 2, 5000, 'the second wait after running status')
    assert.deepEqual(h.sends(), [], 'a timed-out wait cannot send during a running turn')
    rmSync(running)
    await waitFor(() => h.sends().length === 1, 5000, 'the send after the turn ends')
    assert.deepEqual(h.calls().slice(0, 2).map((args) => args[0]), ['wait', 'inspect'])
    assert.equal(h.delivers()[0].running, false)
    assert.equal(h.interrupted(), false)
  } finally { stop(); rmSync(running, { force: true }) }
})

test('paseo send, which interrupts a running turn, is never what delivers to the point man', async () => {
  const h = harness()
  const stop = startDelivery(h.events, { batchMs: 10, retryMs: 10 })
  try {
    h.events.append({ type: 'thread.done', summary: 'Thread finished' })
    await waitFor(() => h.sends().length === 1, 5000, 'the delivery')
    assert.deepEqual(h.calls().filter((args) => args[0] === 'send'), [], 'the paseo CLI never sent, since it defaults to interrupt')
  } finally { stop() }
})

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'deliver-'))
}

test('a turn that starts between the idle check and the send gets nothing, and the message waits for idle', async () => {
  const h = harness()
  const running = join(h.state, 'pointman-running')
  writeJson(join(h.state, 'paseo.json'), { turnStartsAfterIdleCheck: true })
  const stop = startDelivery(h.events, { batchMs: 10, retryMs: 10 })
  try {
    h.events.append({ type: 'thread.done', summary: 'Thread finished' })
    await waitFor(() => busy().length >= 1, 5000, 'the send attempt that met the new turn')
    await waitFor(() => h.calls().filter((args) => args[0] === 'wait').length >= 2, 5000, 'the message waiting for idle again')
    assert.ok(existsSync(running), 'the turn is still running')
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.deepEqual(h.delivers(), [], 'nothing reached the point man while its turn ran')
    assert.deepEqual(h.calls().filter((args) => args[0] === 'send'), [])
    assert.equal(h.interrupted(), false)
    rmSync(running)
    await waitFor(() => h.delivers().length === 1, 5000, 'the delivery after the turn ends')
    assert.deepEqual(h.delivers(), [{ id: 'pointman', text: 'clyde: Thread finished', running: false }])
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(h.delivers().length, 1, 'the message is delivered once')
    assert.equal(h.interrupted(), false)
    function busy() {
      try { return readFileSync(join(h.state, 'deliver-busy.jsonl'), 'utf8').trim().split('\n').filter(Boolean) } catch { return [] }
    }
  } finally { stop(); rmSync(running, { force: true }) }
})

// A fake of the Paseo daemon's client, as the CLI's utils/client.js exports it. It behaves as Paseo 0.11.2 does: a schedule run
// aimed at an agent with a turn running is refused in the daemon with nothing sent (schedule/service.js:650), a run aimed at an
// idle agent starts a turn, and a plain send to a running agent cancels its tool call.
function fakeCli(config: { running?: boolean; turnStartsAfterCreate?: boolean; turnStartsInGap?: boolean; failWith?: string; turnStartsWhileLoading?: boolean } = {}) {
  const dist = join(scratchDir(), 'cli-dist')
  mkdirSync(join(dist, 'utils'), { recursive: true })
  const log = join(dist, 'daemon.jsonl')
  writeFileSync(join(dist, 'utils', 'daemon-target.js'), 'export const selectDaemonTarget = () => ({})\n')
  writeFileSync(join(dist, 'utils', 'client.js'), `
import { appendFileSync } from 'node:fs'
const note = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + '\\n')
const config = ${JSON.stringify(config)}
let running = Boolean(config.running)
let schedule = null
let run = null
let prompt = ''
export const connectToDaemon = async () => ({
  scheduleCreate: async (input) => {
    note({ created: input.target.agentId, text: input.prompt })
    schedule = { id: 's1' }
    prompt = input.prompt
    // A turn starting here is the widest window a client can see between asking and sending.
    if (config.turnStartsAfterCreate) running = true
    return { schedule }
  },
  scheduleRunOnce: async () => {
    // The daemon loads the agent first (schedule/service.js:640), and a turn can start during that await. Claude's live input
    // is not ready yet, so steering is unavailable (claude/agent.js:1851-1854) and the daemon would fall back to replacing the
    // turn (agent-manager.js:1861-1866). But the daemon's check (service.js:650, hasInFlightRun at agent-manager.js:449-457) and
    // its read of the active turn (agent-manager.js:1836) share one tick, so a turn running by then is refused first.
    if (config.turnStartsWhileLoading) {
      await Promise.resolve()
      running = true
      note({ toolCallStarted: true, steerReady: false })
    }
    // The daemon's check (schedule/service.js:650) passes, then a turn starts while it awaits startAgentRun (agent-prompt.js:64).
    // The schedule asks for activeTurnBehavior "steer" (service.js:655), so Claude's steerActiveTurn queues the message inside the
    // turn (claude/agent.js:1857) instead of cancelling its tool call, and the run stays open until that turn ends.
    if (config.turnStartsInGap) {
      note({ turnStartedInGap: true })
      running = true
      note({ toolCallStarted: true })
      note({ queued: prompt })
      setTimeout(() => {
        note({ toolCallFinished: true })
        note({ readQueued: prompt })
      }, 1800)
      run = { status: 'running' }
    } else if (running) {
      note({ refused: 'active run' })
      run = { status: 'failed', error: 'Agent pointman already has an active run' }
    } else {
      note({ startedTurn: true })
      running = true
      run = config.failWith ? { status: 'failed', error: config.failWith } : { status: 'running' }
    }
    await new Promise(() => {})
  },
  scheduleInspect: async () => ({ schedule: { ...schedule, runs: run ? [run] : [] } }),
  scheduleDelete: async () => note({ deleted: true }),
  sendAgentMessage: async (agentId, text) => note({ cancelledToolCall: text }),
  close: async () => {},
})
`)
  const run = (input = 'clyde: hi', args = [dist, 'pointman']) => spawnSync(process.execPath, [join(HARNESS, 'src', 'paseo-deliver.mjs'), ...args], { input, encoding: 'utf8' })
  const events = (): Record<string, unknown>[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
  return { run, events }
}

test('the delivery script starts a turn with the message when the agent is idle', () => {
  const cli = fakeCli()
  const r = cli.run()
  assert.equal(r.status, 0)
  assert.deepEqual(JSON.parse(r.stdout), { ok: true })
  assert.deepEqual(cli.events(), [{ created: 'pointman', text: 'clyde: hi' }, { startedTurn: true }, { deleted: true }])
})

test('the delivery script sends nothing to an agent whose turn is running', () => {
  const cli = fakeCli({ running: true })
  const r = cli.run()
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stdout).busy, true)
  assert.deepEqual(cli.events(), [{ created: 'pointman', text: 'clyde: hi' }, { refused: 'active run' }, { deleted: true }])
})

test('a turn that starts right after the script asks to send is refused by the daemon, so nothing reaches it and nothing is cancelled', () => {
  const cli = fakeCli({ turnStartsAfterCreate: true })
  const r = cli.run()
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stdout).busy, true, 'the caller is told to wait for idle again')
  const events = cli.events()
  assert.ok(events.some((e) => e.refused), 'the daemon refused the run')
  assert.ok(!events.some((e) => e.startedTurn), 'no turn was started with the message')
  assert.ok(!events.some((e) => e.cancelledToolCall), 'the script never sends a message that could cancel a tool call')
})

test('a turn that starts inside the daemon between its idle check and its run start gets the message steered, with no cancel and no resend', () => {
  const cli = fakeCli({ turnStartsInGap: true })
  const r = cli.run()
  assert.equal(r.status, 0)
  assert.deepEqual(JSON.parse(r.stdout), { ok: true }, 'the message is with the agent, so the caller must not send it again')
  const events = cli.events()
  assert.ok(events.some((e) => e.turnStartedInGap), 'the turn started in the gap')
  const ordered = events.filter((e) => e.toolCallStarted || e.queued || e.toolCallFinished || e.readQueued)
  assert.deepEqual(ordered, [
    { toolCallStarted: true },
    { queued: 'clyde: hi' },
    { toolCallFinished: true },
    { readQueued: 'clyde: hi' },
  ], 'the turn reads the queued message only after its tool call')
  assert.ok(!events.some((e) => e.cancelledToolCall || e.refused), 'no tool call was cancelled')
})

test('a turn that starts while the daemon loads the agent, before its steering is ready, is refused and its tool call is never replaced', () => {
  const cli = fakeCli({ turnStartsWhileLoading: true })
  const r = cli.run()
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stdout).busy, true, 'the caller is told to wait for idle again')
  const events = cli.events()
  assert.deepEqual(events.filter((e) => e.toolCallStarted).map((e) => e.steerReady), [false], 'steering was unavailable for that turn')
  assert.ok(events.some((e) => e.refused), 'the daemon refused the run instead of falling back to a replace')
  assert.ok(!events.some((e) => e.cancelledToolCall || e.startedTurn || e.queued), 'nothing replaced the turn and nothing else started')
})

test('a turn that stops on a permission after the message arrived still counts as delivered', () => {
  const cli = fakeCli({ failWith: 'Scheduled agent pointman is waiting for permission' })
  const r = cli.run()
  assert.equal(r.status, 0)
  assert.deepEqual(JSON.parse(r.stdout), { ok: true })
})

test('any other failed run is reported as an error, not as busy', () => {
  const cli = fakeCli({ failWith: 'Agent pointman is archived' })
  const r = cli.run()
  assert.equal(r.status, 1)
  const out = JSON.parse(r.stdout)
  assert.equal(out.ok, false)
  assert.equal(out.busy, undefined)
})

test('a pending ask stays quiet through a minute and survives restart until changed or due', async () => {
  const h = harness()
  let time = 1_000_000
  const reminder = 6 * 60 * 60 * 1000
  const options = { batchMs: 10, retryMs: 10, now: () => time }
  const ask = (summary: string, question = summary) => h.events.append({ type: 'run.ask', runId: 'r-1', summary, data: { key: 'approval', question } })
  let stop = startDelivery(h.events, options)
  try {
    ask('Run r-1 asks: Review?')
    ask('Run r-1 asks: Review?')
    await waitFor(() => h.sends().length === 1, 5000, 'the first ask')
    await waitFor(() => existsSync(join(h.home, 'delivery-asks.json')), 5000, 'the saved ask')
    assert.equal(h.sends()[0], 'clyde: Run r-1 asks: Review?')
    stop()
    stop = startDelivery(h.events, options)
    time += 61_000
    ask('Run r-1 asks: Review?')
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(h.sends().length, 1, 'the same ask is not sent after a minute or a restart')
    ask('Run r-1 asks: Revised review?')
    await waitFor(() => h.sends().length === 2, 5000, 'the changed ask')
    assert.equal(h.sends()[1], 'clyde: Run r-1 asks: Revised review?')
    ask('Run r-1 asks: Revised review?')
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(h.sends().length, 2, 'the changed ask is sent once')
    time += reminder - 1
    ask('Run r-1 asks: Revised review?')
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(h.sends().length, 2, 'the same ask stays quiet before the long reminder')
    time += 1
    ask('Run r-1 asks: Revised review?')
    await waitFor(() => h.sends().length === 3, 5000, 'the later reminder')
  } finally { stop() }
})

test('a repeated ask is omitted from a batch that has another wake event', async () => {
  const h = harness()
  const stop = startDelivery(h.events, { batchMs: 10, retryMs: 10 })
  const ask = () => h.events.append({ type: 'run.ask', runId: 'r-1', summary: 'Run r-1 asks: Review?', data: { key: 'approval', question: 'Review?' } })
  try {
    ask()
    await waitFor(() => existsSync(join(h.home, 'delivery-asks.json')), 5000, 'the saved ask')
    ask()
    h.events.append({ type: 'thread.done', summary: 'Thread finished' })
    await waitFor(() => h.sends().length === 2, 5000, 'the unrelated update')
    assert.equal(h.sends()[1], 'clyde: Thread finished')
  } finally { stop() }
})

test('the delivery script reports a usage error instead of sending without an agent or a message', () => {
  const r = spawnSync(process.execPath, [join(HARNESS, 'src', 'paseo-deliver.mjs')], { input: '', encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stdout).ok, false)
})

// The one answer the daemon can get stale is "inactive" (agent-manager.js:1839, :1858). This runs Paseo's real startAgentRun from
// the installed app with a stub manager, so it checks the daemon's own ordering, not a model of it.
function daemonProbe(steer: string, startsAt: string): { log: string[] } | null {
  const resources = '/Applications/Paseo.app/Contents/Resources'
  const runtime = '/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper'
  const runner = join(resources, 'app.asar.unpacked', 'dist', 'daemon', 'node-entrypoint-runner.js')
  if (!existsSync(runtime) || !existsSync(runner)) return null
  const dir = `file://${join(resources, 'app.asar', 'node_modules', '@getpaseo', 'server', 'dist', 'server', 'server')}`
  const r = spawnSync(runtime, ['--disable-warning=DEP0040', runner, 'node-script', join(HARNESS, 'test', 'fakes', 'paseo-prompt-probe.mjs'), dir, steer, startsAt], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PASEO_NODE_ENV: 'production' },
  })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!)
}

test('sweeping every turn-start point through Paseo\'s real startAgentRun: only a start inside the daemon\'s own microtask hops is replaced', (t) => {
  // Not "never cancels": the wire has no send that refuses to replace (every caller of startAgentRun sets replaceRunning, e.g.
  // schedule/service.js:654), so a turn that begins inside the 3 microtask hops between the steer answer and the in-flight
  // re-read (agent-prompt.js:21 after :64) is replaced. Any start from the 4th hop on, through the next event-loop turn, is left alone.
  const seen: Record<string, string[]> = {}
  for (const at of ['0', '1', '2', '3', '4', '6', '12', 'macrotask']) {
    const probe = daemonProbe('inactive', at)
    if (!probe) return t.skip('Paseo is not installed')
    seen[at] = probe.log
  }
  const cancelled = Object.keys(seen).filter((at) => seen[at].includes('CANCELLED-RUNNING-TURN'))
  // 0.16 waits for out-of-band commands and a stale plugin reload before attempting to steer.
  const lastHop = cancelled.includes('4') ? 4 : 2
  assert.deepEqual(cancelled, Array.from({length:lastHop+1}, (_,n) => String(n)))
  for (const at of Object.keys(seen).filter(at => !cancelled.includes(at))) assert.deepEqual(seen[at], ['steer:inactive', 'queued-start', 'turn-started'])
  const steered = daemonProbe('steered', 'macrotask')
  assert.ok(steered && !steered.log.includes('CANCELLED-RUNNING-TURN'), 'an accepted steer never replaces')
})
