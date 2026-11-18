/** The clyde CLI end to end: help and dispatch, clyde thread run with an in-process daemon, and start, read, stop and status. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { readDaemonInfo } from '../src/config.ts'
import { argvLog, LV, setup, TEST_ROLES, waitFor } from './helpers.ts'

type Run = { code: number | null; stdout: string; stderr: string }

function clyde(args: string[], cwd = process.cwd()): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LV, ...args], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('clyde help lists every command, and an unknown one exits 2', async () => {
  setup([])
  const help = await clyde(['help'])
  assert.equal(help.code, 0)
  for (const cmd of ['daemon', 'status', 'thread', 'flow', 'recall', 'remember', 'plan', 'progress', 'result', 'hook', 'doctor', 'up', 'install']) {
    assert.match(help.stdout, new RegExp(`^  ${cmd} `, 'm'))
  }
  const bad = await clyde(['frobnicate'])
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /unknown command frobnicate/)
})

test('clyde thread run starts a daemon in-process, prints the text and exits 0', async () => {
  const s = setup([{ reply: 'the answer is 4' }])
  const r = await clyde(['thread', 'run', '--prompt', 'what is 2+2'], s.repo)
  assert.equal(r.stderr, '')
  assert.equal(r.stdout, 'the answer is 4\n')
  assert.equal(r.code, 0)
  assert.equal(readDaemonInfo(), null, 'the in-process daemon is gone with the command')
  const [call] = argvLog(s.state)
  assert.equal(call.bin, 'pi')
  assert.equal(call.cwd, s.repo)
})

test('clyde thread run takes a role from roles.json and exits 1 when the turn fails', async () => {
  const s = setup([{ error: 'model is down' }])
  writeFileSync(join(s.home, 'roles.json'), JSON.stringify({ ...TEST_ROLES, fast: [{ backend: 'claude', model: 'haiku' }] }))
  const r = await clyde(['thread', 'run', '--prompt', 'try', '--role', 'fast', '--cwd', s.repo])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^clyde: thread t-[0-9a-f]{8} failed: model is down\n$/)
  const [call] = argvLog(s.state)
  assert.equal(call.bin, 'claude')
  assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'haiku')
})

test('clyde thread start runs a detached daemon that status, read and stop talk to', async () => {
  const s = setup([{ match: 'background', reply: 'background done' }])
  const started = await clyde(['thread', 'start', '--prompt', 'background job', '--title', 'bg', '--json'], s.repo)
  assert.equal(started.code, 0, started.stderr)
  const t = JSON.parse(started.stdout)
  const info = readDaemonInfo()
  assert.ok(info && info.pid !== process.pid)
  try {
    await waitFor(async () => (await clyde(['status', '--json'])).stdout.includes('"idle"'), 10_000, 'the thread to finish')
    const status = await clyde(['status'])
    assert.equal(status.code, 0)
    assert.match(status.stdout, new RegExp(`^thread  ${t.id}  idle     pi openai/gpt-6.1-sol medium\\s+1 turn\\s+bg\\n`))
    assert.match(status.stdout, /memory spool  0 pending, oldest 0s/)
    const read = await clyde(['thread', 'read', t.id])
    assert.match(read.stdout, /Turn 1 prompt: background job\n\nbackground done\n$/)
    const stop = await clyde(['thread', 'stop', t.id])
    assert.match(stop.stdout, new RegExp(`^thread  ${t.id}  stopped`))
  } finally {
    process.kill((info as { pid: number }).pid, 'SIGTERM')
    await waitFor(() => readDaemonInfo() === null, 5000, 'the daemon to remove daemon.json')
  }
  const after = await clyde(['status'])
  assert.equal(after.code, 1)
  assert.match(after.stderr, /not running/)
})
