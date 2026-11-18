/** The daemon over HTTP: auth, the thread routes, SSE replay, body limits, the runs stub, and restart recovery. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DaemonClient, DaemonError } from '../src/client.ts'
import { readDaemonInfo } from '../src/config.ts'
import { startDaemon } from '../src/daemon.ts'
import { request } from '../src/request.ts'
import type { ClydeEvent } from '../src/types.ts'
import { argvLog, LV, setup, turnsTaken, waitFor } from './helpers.ts'

async function daemon(turns: Parameters<typeof setup>[0]) {
  const s = setup(turns)
  const d = await startDaemon({ port: 0 })
  const client = new DaemonClient({ pid: process.pid, port: d.port, token: d.token })
  return { ...s, d, client, url: (p: string) => `http://127.0.0.1:${d.port}${p}` }
}

test('every route but /health needs the bearer token', async () => {
  const h = await daemon([])
  try {
    const health = await request('GET', h.url('/health'))
    assert.equal(health.status, 200)
    assert.deepEqual(JSON.parse(health.text), { ok: true, version: '0.1.0', pid: process.pid, threads: 0, runs: 0 })
    assert.equal((await request('GET', h.url('/threads'))).status, 401)
    assert.equal((await request('GET', h.url('/threads'), { headers: { authorization: 'Bearer nope' } })).status, 401)
    assert.equal((await request('GET', h.url('/events?since=0'))).status, 401)
    assert.equal((await request('POST', h.url('/threads'), { body: { prompt: 'x' } })).status, 401)
    assert.deepEqual(await h.client.threads(), [])
    const info = readDaemonInfo()
    assert.deepEqual(info, { pid: process.pid, port: h.d.port, token: h.d.token })
    assert.match(h.d.token, /^[0-9a-f]{64}$/)
    assert.equal(statSync(join(h.home, 'daemon.json')).mode & 0o777, 0o600)
  } finally {
    await h.d.close()
  }
  assert.equal(readDaemonInfo(), null, 'close removes daemon.json')
})

test('the thread routes start, read, message, stop and take results and progress', async () => {
  const h = await daemon([{ match: 'first', reply: 'first answer' }, { match: 'second', reply: 'second answer' }])
  try {
    const t = await h.client.startThread({ title: 'routes', prompt: 'first', cwd: h.repo })
    assert.equal(t.rung.backend, 'pi', 'the thread role defaults to pi')
    let done = await h.client.waitIdle(t.id, 50)
    assert.equal(done.turns[0].text, 'first answer')
    const listed = await h.client.threads()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].turns[0].text, undefined, 'the list leaves turn text out')
    await h.client.send(t.id, 'second')
    done = await h.client.waitIdle(t.id, 50)
    assert.deepEqual(done.turns.map((x) => x.text), ['first answer', 'second answer'])
    await h.client.postResult(t.id, { status: 'done', summary: 'all good', evidence: [] })
    assert.deepEqual(await h.client.result(t.id), { status: 'done', summary: 'all good', evidence: [] })
    assert.deepEqual(h.d.ctx.threads.result(t.id), { status: 'done', summary: 'all good', evidence: [] })
    await h.client.progress(t.id, 'halfway there')
    const last = h.d.ctx.events.since(0).at(-1) as ClydeEvent
    assert.deepEqual([last.type, last.threadId, last.summary], ['thread.progress', t.id, `Thread ${t.id}: halfway there`])
    await h.client.hook(t.id, 'PostToolUse', { tool_name: 'Bash' })
    assert.equal((await h.client.thread(t.id)).progress, 'PostToolUse Bash')
    assert.equal((await h.client.stop(t.id)).status, 'stopped')
  } finally {
    await h.d.close()
  }
})

test('bad requests get 400, unknown threads 404, big bodies 413, and runs list empty', async () => {
  const h = await daemon([])
  const auth = { authorization: `Bearer ${h.d.token}` }
  try {
    const status = async (p: Promise<unknown>) => p.then(() => 200, (e: DaemonError) => e.status)
    assert.equal(await status(h.client.startThread({ prompt: '' })), 400)
    assert.equal(await status(h.client.startThread({ prompt: 'x', role: 'nobody' })), 400)
    assert.equal(await status(h.client.startThread({ prompt: 'x', rung: { backend: 'gemini' } })), 400)
    assert.equal(await status(h.client.thread('t-missing')), 404)
    assert.equal(await status(h.client.send('t-missing', 'hi')), 404)
    const bad = await request('POST', h.url('/threads'), { headers: { ...auth, 'content-type': 'application/json' }, body: '{nope' })
    assert.equal(bad.status, 400)
    const big = await request('POST', h.url('/threads'), { headers: auth, body: { prompt: 'x'.repeat(1024 * 1024 + 10) } })
    assert.equal(big.status, 413)
    const runs = await request('GET', h.url('/runs'), { headers: auth })
    assert.deepEqual([runs.status, JSON.parse(runs.text)], [200, []])
    assert.equal((await request('GET', h.url('/nowhere'), { headers: auth })).status, 404)
  } finally {
    await h.d.close()
  }
})

test('SSE replays events after since, then streams live ones', async () => {
  const h = await daemon([{ reply: 'done' }])
  try {
    const t = await h.client.startThread({ title: 'sse', prompt: 'go', cwd: h.repo })
    await h.client.waitIdle(t.id, 50)
    const got: ClydeEvent[] = []
    const close = h.client.events(1, (e) => got.push(e))
    await waitFor(() => got.length >= 1, 3000, 'the replay')
    assert.deepEqual(got.map((e) => [e.id, e.type]), [[2, 'thread.done']])
    await h.client.progress(t.id, 'live one')
    await waitFor(() => got.length >= 2, 3000, 'the live event')
    assert.deepEqual(got.map((e) => e.id), [2, 3])
    assert.equal(got[1].type, 'thread.progress')
    close()
    const all: ClydeEvent[] = []
    const closeAll = h.client.events(0, (e) => all.push(e))
    await waitFor(() => all.length >= 3, 3000, 'the full replay')
    assert.deepEqual(all.map((e) => e.id), [1, 2, 3])
    closeAll()
  } finally {
    await h.d.close()
  }
})

test('events keep monotonic ids across a restart', async () => {
  const h = await daemon([{ reply: 'a' }])
  const t = await h.client.startThread({ title: 'ids', prompt: 'go', cwd: h.repo })
  await h.client.waitIdle(t.id, 50)
  await h.d.close()
  const again = await startDaemon({ port: 0 })
  try {
    const client = new DaemonClient({ pid: process.pid, port: again.port, token: again.token })
    await client.progress(t.id, 'after restart')
    assert.deepEqual(again.ctx.events.since(0).map((e) => e.id), [1, 2, 3])
  } finally {
    await again.close()
  }
})

test('a daemon killed mid-turn marks the thread failed on restart, and a send resumes its session', async () => {
  const s = setup([{ match: 'remember', hang: true }, { match: 'continue', reply: 'turn {{turn}} recalls {{history}}' }])
  // Its own process group, so one kill takes the daemon and the hanging worker down together.
  const child = spawn(process.execPath, [LV, 'daemon'], { env: process.env, detached: true, stdio: 'ignore' })
  try {
    const info = await waitFor(() => readDaemonInfo()?.pid === child.pid && readDaemonInfo(), 10_000, 'the child daemon')
    const first = new DaemonClient(info)
    const t = await first.startThread({ title: 'survivor', prompt: 'remember PELICAN', cwd: s.repo, rung: { backend: 'claude', model: 'haiku' } })
    await waitFor(() => turnsTaken(s.state), 5000, 'the worker to take its turn')
    const session = (await first.thread(t.id)).session
    assert.match(session ?? '', /^[0-9a-f-]{36}$/, 'the session is saved before the turn ends')
  } finally {
    process.kill(-(child.pid as number), 'SIGKILL')
  }
  await waitFor(() => { try { process.kill(child.pid as number, 0); return false } catch { return true } }, 5000, 'the child to die')

  const d = await startDaemon({ port: 0 })
  try {
    const client = new DaemonClient({ pid: process.pid, port: d.port, token: d.token })
    const [t] = await client.threads()
    assert.equal(t.status, 'failed')
    assert.equal(t.turns[0].error, 'daemon restarted')
    const failed = d.ctx.events.since(0).filter((e) => e.type === 'thread.failed')
    assert.deepEqual(failed.map((e) => e.summary), [`Thread ${t.id} "survivor" failed: daemon restarted.`])
    await client.send(t.id, 'continue')
    const done = await client.waitIdle(t.id, 50)
    assert.equal(done.status, 'idle')
    assert.equal(done.turns[1].text, 'turn 2 recalls remember PELICAN')
    const second = argvLog(s.state)[1].argv
    assert.equal(second[second.indexOf('--resume') + 1], t.session)
  } finally {
    await d.close()
  }
})
