/** Happier wiring with the fake happier: the point man session, delivery batching, retry and fallback, clyde up and clyde install. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { extensionInstalled, extensionPath } from '../src/backends/pi.ts'
import { clydeBin } from '../src/config.ts'
import { startDaemon } from '../src/daemon.ts'
import { message, startDelivery, wakes } from '../src/delivery.ts'
import { EventLog } from '../src/events.ts'
import { createArgs, createPointMan, notify, readState, saveState, send, unavailable } from '../src/happier.ts'
import type { ClydeEvent } from '../src/types.ts'
import { argvLog, FAKE_BIN, LV, setup, tempDir, waitFor } from './helpers.ts'

type Ran = { code: number | null; stdout: string; stderr: string }

function clyde(args: string[], extra: Record<string, string | undefined> = {}): Promise<Ran> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LV, ...args], { env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** A fresh CLYDE_HOME with the fake happier, configured by cfg. */
function happierSetup(cfg: Record<string, unknown> = {}) {
  const s = setup([])
  const config = join(s.state, 'happier.json')
  writeFileSync(config, JSON.stringify(cfg))
  Object.assign(process.env, { CLYDE_HAPPIER_BIN: join(FAKE_BIN, 'happier'), CLYDE_FAKE_HAPPIER: config })
  const calls = () => argvLog(s.state).filter((c) => c.bin === 'happier').map((c) => c.argv)
  return { ...s, config, calls }
}

const POINT_MAN_ARGS = (cwd: string) => [
  'session', 'create', '--backend', 'pi', '--path', cwd, '--title', 'Point man', '--tag', 'clyde-point-man',
  '--auth', 'native', '--permission-mode', 'auto', '--env', 'CLYDE_POINT_MAN=1', '--env', 'CLYDE_DELIVERY=happier', '--json',
]

test('the happier wrapper creates the point man with the exact PLAN flags, sends, notifies and reads sign-in', async () => {
  const h = happierSetup({ sessionId: 'sess-42' })
  assert.deepEqual(createArgs('/w'), POINT_MAN_ARGS('/w'))
  assert.equal(await createPointMan(h.repo), 'sess-42')
  await send('sess-42', 'clyde: hello')
  await notify('clyde', 'buzz')
  assert.equal(await unavailable(), null)
  assert.deepEqual(h.calls(), [POINT_MAN_ARGS(h.repo), ['session', 'send', 'sess-42', 'clyde: hello', '--json'], ['notify', '-p', 'buzz', '-t', 'clyde'], ['auth', 'status', '--json']])
  writeFileSync(h.config, JSON.stringify({ authed: false }))
  assert.equal(await unavailable(), 'happier is not signed in. Run happier auth login')
  await assert.rejects(send('sess-42', 'x'), /happier session send failed: not_authenticated/)
  await assert.rejects(createPointMan(h.repo), /not_authenticated/)
  process.env.CLYDE_HAPPIER_BIN = join(h.state, 'no-such-happier')
  assert.match(await unavailable() ?? '', /is not on PATH$/)
})

function event(id: number, type: string, summary: string, extra: Partial<ClydeEvent> = {}): Omit<ClydeEvent, 'id' | 'at'> {
  return { type, summary: `${summary} (${id})`, ...extra }
}

test('only the wake events of threads you started, and run events, reach the point man', () => {
  const e = (type: string, runId?: string) => ({ id: 1, at: '', type, summary: '', runId }) as ClydeEvent
  assert.deepEqual(
    ['thread.done', 'thread.failed', 'run.ask', 'run.passed', 'run.failed', 'run.done', 'thread.started', 'thread.progress', 'run.stage'].map((t) => wakes(e(t))),
    [true, true, true, true, true, true, false, false, false],
  )
  assert.equal(wakes(e('thread.done', 'r-1')), false, "a flow's own thread reports through its run")
  assert.equal(wakes(e('run.done', 'r-1')), true)
  assert.equal(message([{ summary: 'one' } as ClydeEvent]), 'clyde: one')
  assert.equal(message([{ summary: 'one' }, { summary: 'two' }] as ClydeEvent[]), 'clyde: 2 updates.\n- one\n- two')
})

test('delivery batches wake events within the window into one happier send to the saved session', async () => {
  const h = happierSetup()
  saveState({ sessionId: 'sess-7', tag: 'clyde-point-man', cwd: h.repo, createdAt: new Date().toISOString() })
  const events = new EventLog()
  const stop = startDelivery(events, { batchMs: 300, retryMs: 10 })
  try {
    events.append(event(1, 'thread.done', 'Thread t-1 is done'))
    events.append(event(2, 'thread.progress', 'Thread t-1: tests'))
    events.append(event(3, 'thread.done', 'Thread t-2 is done', { runId: 'r-1' }))
    events.append(event(4, 'run.ask', 'Run r-1 asks'))
    const sends = () => h.calls().filter((a) => a[1] === 'send')
    await waitFor(() => sends().length === 1, 5000, 'the batch')
    assert.deepEqual(sends()[0], ['session', 'send', 'sess-7', 'clyde: 2 updates.\n- Thread t-1 is done (1)\n- Run r-1 asks (4)', '--json'])
    events.append(event(5, 'run.done', 'Run r-1 is done'))
    await waitFor(() => sends().length === 2, 5000, 'the second batch')
    assert.deepEqual(sends()[1], ['session', 'send', 'sess-7', 'clyde: Run r-1 is done (5)', '--json'])
    assert.equal(h.calls().filter((a) => a[0] === 'auth').length, 1, 'sign-in is checked once while it holds')
  } finally {
    stop()
  }
})

test('a failed send is retried once, then falls back to a notify push', async () => {
  const h = happierSetup({ failSends: 1 })
  saveState({ sessionId: 'sess-7', tag: 'clyde-point-man', cwd: h.repo, createdAt: new Date().toISOString() })
  const events = new EventLog()
  const stop = startDelivery(events, { batchMs: 50, retryMs: 10 })
  try {
    events.append(event(1, 'thread.failed', 'Thread t-1 failed'))
    await waitFor(() => h.calls().filter((a) => a[1] === 'send').length === 2, 5000, 'the retry')
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(h.calls().filter((a) => a[0] === 'notify').length, 0, 'the retry worked, so no push')
    writeFileSync(h.config, JSON.stringify({ failSends: 99 }))
    events.append(event(2, 'run.failed', 'Run r-2 failed'))
    await waitFor(() => h.calls().some((a) => a[0] === 'notify'), 5000, 'the notify fallback')
    assert.equal(h.calls().filter((a) => a[1] === 'send').length, 4)
    assert.deepEqual(h.calls().find((a) => a[0] === 'notify'), ['notify', '-p', 'clyde: Run r-2 failed (2)', '-t', 'clyde'])
  } finally {
    stop()
  }
})

test('delivery stays quiet without happier.json, and without a signed-in happier', async () => {
  const h = happierSetup()
  const events = new EventLog()
  let stop = startDelivery(events, { batchMs: 30, retryMs: 10 })
  events.append(event(1, 'run.done', 'Run r-1 is done'))
  await new Promise((r) => setTimeout(r, 300))
  stop()
  assert.deepEqual(h.calls(), [], 'no happier.json, so happier never runs')
  saveState({ sessionId: 'sess-7', tag: 'clyde-point-man', cwd: h.repo, createdAt: new Date().toISOString() })
  writeFileSync(h.config, JSON.stringify({ authed: false }))
  stop = startDelivery(events, { batchMs: 30, retryMs: 10 })
  events.append(event(2, 'run.done', 'Run r-2 is done'))
  await waitFor(() => h.calls().length >= 2, 5000, 'the sign-in check')
  await new Promise((r) => setTimeout(r, 300))
  stop()
  assert.deepEqual(h.calls().map((a) => a.slice(0, 2)), [['auth', 'status'], ['session', 'list']])
})

test('clyde up starts the point man in Happier once, saves the session, and reuses it', async () => {
  const h = happierSetup({ sessionId: 'sess-up' })
  const d = await startDaemon({ port: 0 })
  try {
    const r = await clyde(['up', '--happier', '--cwd', h.repo])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^daemon {6}ok {8}pid \d+, port \d+\n/)
    assert.match(r.stdout, /\npoint man {3}started {3}Happier session sess-up\. Open it in the Happier app\.\n$/)
    const state = readState()
    assert.deepEqual([state?.sessionId, state?.tag, state?.cwd], ['sess-up', 'clyde-point-man', h.repo])
    assert.deepEqual(h.calls().filter((a) => a[1] === 'create'), [POINT_MAN_ARGS(h.repo)])
    assert.ok(extensionInstalled(process.env), 'clyde up links the extension, since Happier cannot pass -e')
    const again = await clyde(['up', '--happier', '--cwd', h.repo])
    assert.match(again.stdout, /point man {3}ok {8}Happier session sess-up\./)
    assert.equal(h.calls().filter((a) => a[1] === 'create').length, 1)
    writeFileSync(h.config, JSON.stringify({ sessionId: 'sess-new', lostSession: true }))
    const lost = await clyde(['up', '--happier', '--cwd', h.repo])
    assert.match(lost.stdout, /started {3}Happier session sess-new/)
    assert.equal(readState()?.sessionId, 'sess-new')
  } finally {
    await d.close()
  }
})

test('clyde up runs CLYDE_POINT_MAN=1 pi in the terminal when happier is not signed in, and says why', async () => {
  const h = happierSetup({ authed: false })
  const record = join(h.state, 'pi-env.json')
  const pi = join(h.state, 'pi')
  writeFileSync(pi, `#!/bin/sh\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({argv: process.argv.slice(2), man: process.env.CLYDE_POINT_MAN ?? null, delivery: process.env.CLYDE_DELIVERY ?? null, cwd: process.cwd()}))' ${JSON.stringify(record)} "$@"\nexit 7\n`)
  chmodSync(pi, 0o755)
  const d = await startDaemon({ port: 0 })
  try {
    const r = await clyde(['up', '--happier', '--cwd', h.repo], { CLYDE_PI_BIN: pi, CLYDE_DELIVERY: 'happier' })
    assert.equal(r.code, 7, r.stderr)
    assert.match(r.stdout, /\npoint man {3}terminal {2}happier is not signed in\. Run happier auth login, so pi runs here\.\n/)
    assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), { argv: ['--model', 'openai/gpt-6.1-sol'], man: '1', delivery: null, cwd: h.repo })
    assert.equal(h.calls().filter((a) => a[1] === 'create').length, 0)
    const missing = await clyde(['up', '--cwd', h.repo, '--terminal'], { CLYDE_PI_BIN: join(h.state, 'no-pi') })
    assert.equal(missing.code, 1)
    assert.match(missing.stderr, /can't start .*no-pi/)
  } finally {
    await d.close()
  }
})

test('clyde install links the extension and clyde, and a second run changes nothing', async () => {
  setup([])
  const home = tempDir('home-dir')
  const env = { HOME: home, PATH: process.env.PATH }
  const first = await clyde(['install'], env)
  assert.equal(first.code, 0, first.stderr)
  const index = join(process.env.PI_CODING_AGENT_DIR as string, 'extensions', 'clyde', 'index.ts')
  assert.equal(readFileSync(index, 'utf8'), `export { default } from ${JSON.stringify(extensionPath())}\n`)
  const bin = join(process.env.CLYDE_HOME as string, 'bin')
  assert.equal(readlinkSync(join(bin, 'clyde')), clydeBin())
  assert.equal(first.stdout, [
    `extension   linked  ${index} now loads ${extensionPath()}`,
    `clyde       to do   Add this line to your shell profile: export PATH="${bin}:$PATH"`, '',
  ].join('\n'))
  const second = await clyde(['install'], env)
  assert.match(second.stdout, /^extension {3}ok {6}.* already loads /)

  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  const local = join(home, '.local', 'bin')
  const linked = await clyde(['install'], { ...env, PATH: `${local}:${process.env.PATH}` })
  assert.match(linked.stdout, new RegExp(`\\nclyde {7}linked  ${local}/clyde -> ${clydeBin()}\\.\\n$`))
  assert.equal(readlinkSync(join(local, 'clyde')), clydeBin())
  const again = await clyde(['install'], { ...env, PATH: `${local}:${process.env.PATH}` })
  assert.match(again.stdout, /\nclyde {7}ok {6}/)

  const other = tempDir('home-dir')
  mkdirSync(join(other, '.local', 'bin'), { recursive: true })
  writeFileSync(join(other, '.local', 'bin', 'clyde'), '#!/bin/sh\n')
  const taken = await clyde(['install'], { HOME: other })
  assert.match(taken.stdout, /\nclyde {7}to do   .*\/\.local\/bin\/clyde is another program\. Remove it, then run clyde install again\.\n$/)
  assert.equal(readFileSync(join(other, '.local', 'bin', 'clyde'), 'utf8'), '#!/bin/sh\n', 'someone else\'s clyde is left alone')
  assert.ok(existsSync(index))
})
