/**
 * R31: memory-hook updates itself when the server's version is newer. HOME is a temp dir and the server is a small fake
 * over node:http that serves the real client files the way the function does (stamping memory-hook's VERSION), so this
 * runs without a database. The real function's headers and notes are in memory.test.ts and version.test.ts.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { repoRoot } from '../../src/config.ts'
import { tempDir, waitFor } from '../helpers.ts'

const CLIENT = join(repoRoot(), 'memory', 'supabase', 'functions', 'memory', 'client')
const OLD = '20261101.1'
const NEW = '20261102.1'
const TOKEN = 'device-token-for-the-update-test'
const read = (name: string) => readFileSync(join(CLIENT, name), 'utf8')

type Fake = {
  url: string
  /** "METHOD /path" for every request, in order. */
  hits: string[]
  /** The x-memory-client-version of each request, by "METHOD /path". */
  sent: Record<string, string[]>
  version: string
  /** Per file: the body to serve instead of the real one, an HTTP status, or 0 to drop the connection. */
  override: Record<string, string | number>
  /** Sent as x-memory-client-status on hook calls. */
  status: string
  /** The x-memory-device of each request, by "METHOD /path". */
  devices: Record<string, string[]>
  /** What a hook call answers with, by event, as {status, body}. Empty and 200 when the event has none. */
  answer: Record<string, { status: number; body: string }>
  delayMs: number
  close: () => Promise<void>
}

/** A server that answers hooks and /messages with its version header and serves /install/files like the function. */
async function fakeServer(version = NEW): Promise<Fake> {
  const fake = { hits: [], sent: {}, devices: {}, answer: {}, version, override: {}, status: 'behind', delayMs: 0 } as unknown as Fake
  const server = http.createServer((req, res) => {
    const key = `${req.method} ${(req.url ?? '').split('?')[0]}`
    fake.hits.push(key)
    ;(fake.sent[key] ??= []).push(String(req.headers['x-memory-client-version'] ?? ''))
    ;(fake.devices[key] ??= []).push(String(req.headers['x-memory-device'] ?? ''))
    req.resume()
    req.on('end', () => {
      res.setHeader('x-memory-version', fake.version)
      if (req.method === 'POST' && req.url?.startsWith('/hooks/')) {
        res.setHeader('x-memory-client-status', fake.status)
        const answer = fake.answer[/^\/hooks\/([^/?]+)/.exec(req.url)?.[1] ?? ''] ?? { status: 200, body: '' }
        res.statusCode = answer.status
        res.end(answer.body)
        return
      }
      const file = /^\/install\/files\/([^/]+)$/.exec(req.url ?? '')?.[1]
      if (!file) {
        res.end(req.url === '/healthz' ? JSON.stringify({ ok: true, version: fake.version }) : '')
        return
      }
      setTimeout(() => {
        const over = fake.override[file]
        if (over === 0) {
          res.destroy()
          return
        }
        if (typeof over === 'number') {
          res.statusCode = over
          res.end('nope')
          return
        }
        const body = over ?? read(file).replace('VERSION=@MEMORY_VERSION@', `VERSION=${fake.version}`)
        res.setHeader('content-type', 'text/plain')
        res.end(body)
      }, fake.delayMs)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  fake.close = () => new Promise<void>((r) => {
    server.closeAllConnections()
    server.close(() => r())
  })
  return fake
}

type Computer = { home: string; dir: string; hook: string; claude: string; codex: string }

const USER_HOOK = { hooks: [{ type: 'command', command: 'echo my own hook' }] }

/** A computer connected at version `at`: the installed memory-hook, its token, and the hook config merged beside a user's own hook. */
function computer(url: string, at = OLD): Computer {
  const home = tempDir('memory-client-')
  const dir = join(home, '.config', 'memory')
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(home, '.claude'))
  mkdirSync(join(home, '.codex'))
  const hook = join(dir, 'memory-hook')
  writeFileSync(hook, read('memory-hook').replace('VERSION=@MEMORY_VERSION@', `VERSION=${at}`), { mode: 0o700 })
  writeFileSync(join(dir, 'url'), `${url}\n`)
  writeFileSync(join(dir, 'token'), `${TOKEN}\n`, { mode: 0o600 })
  writeFileSync(join(dir, 'device-id'), 'test-mac\n')
  const claude = join(home, '.claude', 'settings.json')
  const ours = JSON.parse(read('claude-settings.json')).hooks
  writeFileSync(claude, JSON.stringify({ model: 'opus', hooks: { ...ours, UserPromptSubmit: [USER_HOOK, ...ours.UserPromptSubmit] } }, null, 2))
  const codex = join(home, '.codex', 'hooks.json')
  writeFileSync(codex, JSON.stringify(JSON.parse(read('codex-hooks.json')), null, 2))
  return { home, dir, hook, claude, codex }
}

type Ran = { code: number | null; stdout: string; ms: number }

/** One hook call, the way Claude Code makes it: the payload on stdin, the exit waited for. */
function runHook(c: Computer, event: string, args: string[] = [], bin = c.hook, extra: Record<string, string> = {}): Promise<Ran> {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH ?? '', HOME: c.home, LANG: 'C', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1', ...extra }
    const t0 = Date.now()
    const child = spawn(bin, [event, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stdin.end('{"session_id":"s1","cwd":"/tmp"}')
    child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - t0 }))
  })
}

const versionOf = (c: Computer) => /^VERSION=(.*)$/m.exec(readFileSync(c.hook, 'utf8'))?.[1]
const tokenOf = (c: Computer) => readFileSync(join(c.dir, 'token'), 'utf8')
const files = (fake: Fake) => fake.hits.filter((h) => h.startsWith('GET /install/files/'))
/** What a self-update leaves behind besides the client: a lock or a temp dir. */
const litter = (c: Computer) => readdirSync(c.dir).filter((n) => n.startsWith('update.') && n !== 'update-failed')
/** Waits for the update's process to exit, which is just after it moves the new hook in, and checks it left nothing. */
const clean = async (c: Computer, what = 'the update to clean up') => {
  await waitFor(() => litter(c).length === 0, 5000, what)
}

test('a hook call sends its version, and a server at the same version starts no update', async () => {
  const fake = await fakeServer(NEW)
  const c = computer(fake.url, NEW)
  try {
    const ran = await runHook(c, 'Stop')
    assert.equal(ran.code, 0)
    assert.deepEqual(fake.sent['POST /hooks/Stop'], [NEW])
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(files(fake).length, 0, 'nothing to fetch when the versions match')
    await runHook(c, 'UserPromptSubmit')
    assert.deepEqual(fake.sent['GET /messages/claude'], [NEW], 'the inbox call sends it too')
  } finally {
    await fake.close()
    rmSync(c.home, { recursive: true, force: true })
  }
})

test('a newer server version updates memory-hook and the hook config in the background, with the same token', async () => {
  const fake = await fakeServer(NEW)
  fake.delayMs = 1200
  // The new hook config grows an event, so the merge has something to do beyond the version.
  const grown = JSON.parse(read('claude-settings.json'))
  grown.hooks.Notification = [{ hooks: [{ type: 'command', command: '~/.config/memory/memory-hook Notification' }] }]
  fake.override['claude-settings.json'] = JSON.stringify(grown)
  const c = computer(fake.url, OLD)
  const before = tokenOf(c)
  try {
    const ran = await runHook(c, 'Stop')
    assert.equal(ran.code, 0)
    assert.equal(ran.stdout, '')
    // The fake takes 1.2 s per file, and the hook was done long before the update could be.
    assert.ok(ran.ms < 1000, `the hook returned in ${ran.ms} ms, so it didn't wait for the update`)
    assert.equal(versionOf(c), OLD, 'still the old client when the hook returns')
    await waitFor(() => versionOf(c) === NEW, 15_000, 'the update to land')
    assert.equal(tokenOf(c), before, 'the same device token')
    assert.equal(readFileSync(join(c.dir, 'url'), 'utf8'), `${fake.url}\n`)
    assert.ok(statSync(c.hook).mode & 0o100, 'memory-hook stays executable')
    assert.equal(statSync(c.hook).mode & 0o077, 0, 'and private')
    const settings = JSON.parse(readFileSync(c.claude, 'utf8'))
    assert.ok(settings.hooks.Notification, 'the new event is merged in')
    assert.equal(settings.model, 'opus', 'the rest of settings.json is untouched')
    assert.deepEqual(settings.hooks.UserPromptSubmit[0], USER_HOOK, "the user's own hook stays")
    assert.equal(JSON.stringify(settings).split('memory-hook UserPromptSubmit').length, 2, 'ours is there once, not twice')
    assert.ok(JSON.parse(readFileSync(c.codex, 'utf8')).hooks.SessionStart)
    await clean(c)
    // The next call is the new client's, and it finds nothing newer.
    const fetched = files(fake).length
    await runHook(c, 'Stop')
    assert.deepEqual(fake.sent['POST /hooks/Stop'].at(-1), NEW)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(files(fake).length, fetched)
  } finally {
    await fake.close()
    rmSync(c.home, { recursive: true, force: true })
  }
})

test('a server that dies mid-fetch leaves the old client working, and a failed try waits 10 minutes', async () => {
  const fake = await fakeServer(NEW)
  fake.override['codex-hooks.json'] = 0
  const c = computer(fake.url, OLD)
  const hookBefore = readFileSync(c.hook, 'utf8')
  const claudeBefore = readFileSync(c.claude, 'utf8')
  const codexBefore = readFileSync(c.codex, 'utf8')
  try {
    assert.equal((await runHook(c, 'Stop')).code, 0)
    await waitFor(() => existsSync(join(c.dir, 'update-failed')), 15_000, 'the failed try to be noted')
    assert.equal(readFileSync(c.hook, 'utf8'), hookBefore, 'the old memory-hook is still there')
    assert.equal(readFileSync(c.claude, 'utf8'), claudeBefore)
    assert.equal(readFileSync(c.codex, 'utf8'), codexBefore)
    await clean(c)
    // It still works: events and the inbox go through.
    fake.status = 'behind'
    const again = await runHook(c, 'UserPromptSubmit')
    assert.equal(again.code, 0)
    assert.equal(fake.hits.filter((h) => h === 'POST /hooks/UserPromptSubmit').length, 1)
    assert.equal(fake.hits.filter((h) => h === 'GET /messages/claude').length, 1)
    // And it doesn't hammer the server: no new fetches inside 10 minutes.
    const fetched = files(fake).length
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(files(fake).length, fetched)
    // Back up, and past the wait, the next call updates.
    delete fake.override['codex-hooks.json']
    const old = new Date(Date.now() - 11 * 60_000)
    utimesSync(join(c.dir, 'update-failed'), old, old)
    await runHook(c, 'Stop')
    await waitFor(() => versionOf(c) === NEW, 15_000, 'the retry to land')
    await waitFor(() => !existsSync(join(c.dir, 'update-failed')), 5000, 'the failure note to clear')
  } finally {
    await fake.close()
    rmSync(c.home, { recursive: true, force: true })
  }
})

test('a server that is down leaves the client working and silent', async () => {
  const fake = await fakeServer(NEW)
  const c = computer(fake.url, OLD)
  await fake.close()
  try {
    const ran = await runHook(c, 'SessionStart')
    assert.deepEqual([ran.code, ran.stdout], [0, ''])
    assert.equal(versionOf(c), OLD)
  } finally {
    rmSync(c.home, { recursive: true, force: true })
  }
})

test('files that are empty, unparseable, unstamped or not scripts are never installed', async () => {
  const bad: [string, Record<string, string | number>][] = [
    ['an empty config', { 'claude-settings.json': '' }],
    ['a config the server fails on', { 'codex-hooks.json': 500 }],
    ['a config that is not JSON', { 'codex-hooks.json': '{"hooks": ' }],
    ['a memory-hook with no shebang', { 'memory-hook': 'VERSION=20261102.1\necho hi\n' }],
    ['a memory-hook that does not parse', { 'memory-hook': '#!/bin/sh\nVERSION=20261102.1\nif then fi (\n' }],
    ['a memory-hook with no version', { 'memory-hook': '#!/bin/sh\necho hi\n' }],
    ['a memory-hook that is not newer', { 'memory-hook': '#!/bin/sh\nVERSION=20261101.1\necho hi\n' }],
    ['an installer that does not parse', { 'install.sh': '#!/bin/sh\nif then fi (\n' }],
  ]
  for (const [what, override] of bad) {
    const fake = await fakeServer(NEW)
    Object.assign(fake.override, override)
    const c = computer(fake.url, OLD)
    const hookBefore = readFileSync(c.hook, 'utf8')
    const settingsBefore = readFileSync(c.claude, 'utf8')
    try {
      await runHook(c, 'Stop')
      await waitFor(() => existsSync(join(c.dir, 'update-failed')), 15_000, `${what} to be refused`)
      assert.equal(readFileSync(c.hook, 'utf8'), hookBefore, what)
      assert.equal(readFileSync(c.claude, 'utf8'), settingsBefore, what)
      await clean(c, `${what} to leave nothing behind`)
    } finally {
      await fake.close()
      rmSync(c.home, { recursive: true, force: true })
    }
  }
})

test('two hook calls at once fetch once, and a live lock stops an update', async () => {
  const fake = await fakeServer(NEW)
  fake.delayMs = 500
  const c = computer(fake.url, OLD)
  try {
    await Promise.all([runHook(c, 'Stop'), runHook(c, 'UserPromptSubmit'), runHook(c, 'Stop')])
    await waitFor(() => versionOf(c) === NEW, 15_000, 'the update to land')
    assert.equal(fake.hits.filter((h) => h === 'GET /install/files/memory-hook').length, 1, 'one update, not three')
    await clean(c)

    // With the lock held by someone else, a hook that sees a newer server starts nothing.
    const held = computer(fake.url, OLD)
    mkdirSync(join(held.dir, 'update.lock'))
    const fetched = files(fake).length
    try {
      await runHook(held, 'Stop')
      await new Promise((r) => setTimeout(r, 800))
      assert.equal(files(fake).length, fetched)
      assert.equal(versionOf(held), OLD)
    } finally {
      rmSync(held.home, { recursive: true, force: true })
    }
  } finally {
    await fake.close()
    rmSync(c.home, { recursive: true, force: true })
  }
})

test('a lock left by a dead update is cleared after 10 minutes', async () => {
  const fake = await fakeServer(NEW)
  const c = computer(fake.url, OLD)
  const lock = join(c.dir, 'update.lock')
  mkdirSync(lock)
  const old = new Date(Date.now() - 11 * 60_000)
  utimesSync(lock, old, old)
  try {
    await runHook(c, 'Stop')
    await waitFor(() => versionOf(c) === NEW, 15_000, 'the update to land')
    await clean(c)
  } finally {
    await fake.close()
    rmSync(c.home, { recursive: true, force: true })
  }
})

test('a client past the server cutoff prints one line on SessionStart and UserPromptSubmit, and nothing on other events', async () => {
  const fake = await fakeServer(NEW)
  fake.status = 'expired'
  const c = computer(fake.url, '20250101.1')
  try {
    const start = await runHook(c, 'SessionStart')
    assert.match(start.stdout, /^memory: this computer's client is out of date\. Rerun `curl -fsSL http:\/\/127\.0\.0\.1:\d+\/install \| sh`/)
    assert.equal(start.stdout.trim().split('\n').length, 1)
    assert.match((await runHook(c, 'UserPromptSubmit')).stdout, /Rerun `curl/)
    assert.equal((await runHook(c, 'Stop')).stdout, '')
    fake.status = 'behind'
    assert.equal((await runHook(c, 'SessionStart')).stdout, '', 'a client inside the cutoff is not nagged')
  } finally {
    await fake.close()
    rmSync(c.home, { recursive: true, force: true })
  }
})

test("a checkout's memory-hook reports dev and never updates itself", async () => {
  const fake = await fakeServer(NEW)
  const c = computer(fake.url, OLD)
  try {
    // Run from the checkout, as a cloud session does, with the URL and token in the environment.
    const ran = await runHook(c, 'Stop', [], join(CLIENT, 'memory-hook'), { MEMORY_URL: fake.url, MEMORY_TOKEN: TOKEN })
    assert.equal(ran.code, 0)
    assert.deepEqual(fake.sent['POST /hooks/Stop'], ['dev'])
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(files(fake).length, 0)
    assert.equal(versionOf(c), OLD)
  } finally {
    await fake.close()
    rmSync(c.home, { recursive: true, force: true })
  }
})

test('install.sh --update from a checkout stamps the hook with the server version, and leaves a computer with no Claude Code alone', async () => {
  const fake = await fakeServer(NEW)
  const c = computer(fake.url, OLD)
  rmSync(c.claude)
  writeFileSync(c.codex, '{}\n')
  try {
    const ran = await new Promise<number | null>((resolve) => {
      const env = { PATH: process.env.PATH ?? '', HOME: c.home, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' }
      spawn('sh', [join(CLIENT, 'install.sh'), '--update'], { env, stdio: 'ignore' }).on('close', resolve)
    })
    assert.equal(ran, 0)
    assert.equal(versionOf(c), NEW)
    assert.equal(existsSync(c.claude), false, 'no settings.json made for a computer that has none')
    assert.equal(readFileSync(c.codex, 'utf8'), '{}\n', 'a hooks file with no memory hook is left alone')
    assert.equal(tokenOf(c), `${TOKEN}\n`)
  } finally {
    await fake.close()
    rmSync(c.home, { recursive: true, force: true })
  }
})

test('every call names the computer, by the installer\'s device name or an id made once and kept', async () => {
  const fake = await fakeServer(NEW)
  const c = computer(fake.url, NEW)
  try {
    await runHook(c, 'Stop')
    await runHook(c, 'UserPromptSubmit')
    assert.deepEqual(fake.devices['POST /hooks/Stop'], ['test-mac'])
    assert.deepEqual(fake.devices['GET /messages/claude'], ['test-mac'], 'the inbox call too')
    // No device-id: the hook makes one, saves it, and keeps using it.
    rmSync(join(c.dir, 'device-id'))
    await runHook(c, 'Stop')
    await runHook(c, 'Stop')
    const [first, second] = fake.devices['POST /hooks/Stop'].slice(1)
    assert.match(first, /^[0-9a-f]{16}$/)
    assert.equal(second, first, 'stable across calls')
    assert.equal(readFileSync(join(c.dir, 'device-id'), 'utf8'), `${first}\n`)
  } finally {
    await fake.close()
    rmSync(c.home, { recursive: true, force: true })
  }
})

test("the server's answer to SessionStart, UserPromptSubmit and Stop reaches stdout untouched, and an empty one prints nothing", async () => {
  const fake = await fakeServer(NEW)
  const c = computer(fake.url, NEW)
  const block = '{"decision":"block","reason":"You committed. remember() what you decided."}'
  try {
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'PostToolUse']) {
      assert.deepEqual((await runHook(c, event)).stdout, '', `${event}: an empty answer prints nothing`)
    }
    fake.answer.Stop = { status: 200, body: block }
    assert.equal((await runHook(c, 'Stop')).stdout, block, 'a Stop decision arrives byte for byte, for Claude Code to act on')
    const odd = '  {"a":"b\\n","z":"é"}\n\n'
    fake.answer.Stop = { status: 200, body: odd }
    assert.equal((await runHook(c, 'Stop')).stdout, odd, 'spacing and trailing newlines survive')
    fake.answer.SessionStart = { status: 200, body: 'Wen prefers oolong at 90C.\n' }
    assert.equal((await runHook(c, 'SessionStart')).stdout, 'Wen prefers oolong at 90C.\n')
    fake.answer.UserPromptSubmit = { status: 200, body: 'context for this prompt\n' }
    assert.equal((await runHook(c, 'UserPromptSubmit')).stdout, 'context for this prompt\n')
    // Other events never print, and neither does an error page.
    fake.answer.PostToolUse = { status: 200, body: 'ignored' }
    assert.equal((await runHook(c, 'PostToolUse')).stdout, '')
    fake.answer.Stop = { status: 500, body: '{"error":"The server hit an error."}' }
    const failed = await runHook(c, 'Stop')
    assert.deepEqual([failed.code, failed.stdout], [0, ''])
  } finally {
    await fake.close()
    rmSync(c.home, { recursive: true, force: true })
  }
})
