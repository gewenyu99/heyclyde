/** clyde doctor against scripted CLIs, the fake happier, the fake memory server and a test daemon: one line per check, exit 1 only when broken. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { startDaemon } from '../src/daemon.ts'
import { FLAGS, helpFlags } from '../src/cli/doctor.ts'
import { startFakeMemory } from './fakes/memory.ts'
import { FAKE_BIN, LV, setup, TEST_ROLES } from './helpers.ts'

type Ran = { code: number | null; stdout: string; stderr: string }

function clyde(args: string[], extra: Record<string, string | undefined> = {}): Promise<Ran> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra }
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k]
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LV, ...args], { env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** A CLI that answers each argv, joined by spaces, with fixed text and exit code. Anything else exits 2. */
function script(dir: string, name: string, answers: Record<string, [string, number?]>): string {
  const path = join(dir, name)
  const cases = Object.entries(answers).map(([args, [text, code]]) => `  ${JSON.stringify(args)}) cat <<'EOF'\n${text}\nEOF\n    exit ${code ?? 0};;`)
  writeFileSync(path, `#!/bin/sh\ncase "$*" in\n${cases.join('\n')}\n  *) echo "unknown: $*" >&2; exit 2;;\nesac\n`)
  chmodSync(path, 0o755)
  return path
}

/** Help text naming each flag the way the real CLIs print them. */
function help(flags: readonly string[]): string {
  return ['Usage: x [options]', '', 'Options:', ...flags.map((f) => `  ${f.length === 2 ? `${f}, --long-${f.slice(1)}` : f} <value>   What it does`)].join('\n')
}

/** Scripted pi, claude and codex that pass every check, minus whatever drop removes. */
function clis(dir: string, drop: string[] = []) {
  const keep = (flags: readonly string[]) => flags.filter((f) => !drop.includes(f))
  return {
    CLYDE_PI_BIN: script(dir, 'pi', { '--version': ['1.1.0'], '--help': [help(keep(FLAGS.pi.flags[0]))] }),
    CLYDE_CLAUDE_BIN: script(dir, 'claude', {
      '--version': ['2.1.296 (Claude Code)'], '--help': [help(keep(FLAGS.claude.flags[0]))],
      'auth status': [JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' })],
    }),
    CLYDE_CODEX_BIN: script(dir, 'codex', {
      '--version': ['codex-cli 0.162.1'], 'exec --help': [help(keep(FLAGS.codex.flags[0]))], 'exec resume --help': [help(keep(FLAGS.codex.flags[1]))],
      'login status': ['Logged in using ChatGPT'],
    }),
    CLYDE_HAPPIER_BIN: join(FAKE_BIN, 'happier'),
  }
}

function lines(stdout: string): Record<string, string> {
  return Object.fromEntries(stdout.trim().split('\n').slice(0, -1).map((l) => [l.slice(0, 14).trim(), l.slice(16)]))
}

test('helpFlags reads the flags out of real help layouts', () => {
  const got = helpFlags('  -s, --sandbox <MODE>\n  --extension, -e <path>\n  [--path <path>] [--auth <default|native>]\n  -p <message>    Message\n      --json\n')
  for (const f of ['-s', '--sandbox', '--extension', '-e', '--path', '--auth', '-p', '--json']) assert.ok(got.has(f), f)
  assert.ok(!got.has('--default'), 'a value in angle brackets is not a flag')
})

test('clyde doctor passes when every CLI, login, memory token and the daemon check out', async () => {
  const memory = await startFakeMemory()
  const s = setup([], { MEMORY_URL: memory.url, MEMORY_TOKEN: memory.token, MEMORY_RUNTIME_TOKEN: memory.runtimeToken })
  const bins = clis(s.state)
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR as string, 'auth.json'), JSON.stringify({ openai: {}, xai: {} }))
  const d = await startDaemon({ port: 0 })
  try {
    // The shell has no runtime token, so the daemon is asked for its own.
    const r = await clyde(['doctor'], { ...bins, MEMORY_RUNTIME_TOKEN: undefined })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.deepEqual(Object.keys(lines(r.stdout)), [
      'pi', 'pi login', 'claude', 'claude login', 'codex', 'codex login', 'happier', 'happier login', 'extension', 'daemon', 'memory', 'memory agent', 'memory runtime', 'memory spool',
    ])
    const l = lines(r.stdout)
    assert.equal(l.pi, 'ok      1.1.0. --help lists every flag clyde passes')
    assert.equal(l['claude login'], 'ok      logged in with oauth_token')
    assert.equal(l['codex login'], 'ok      Logged in using ChatGPT')
    assert.equal(l['pi login'], 'ok      auth.json has openai, xai')
    assert.equal(l.happier, 'ok      0.2.16. --help lists every flag clyde passes')
    assert.equal(l['happier login'], 'ok      signed in')
    assert.match(l.extension, /^warn {4}not in .*Run clyde install/)
    assert.match(l.daemon, new RegExp(`^ok {6}pid ${process.pid}, port ${d.port}, version `))
    assert.equal(l['memory agent'], 'ok      MEMORY_TOKEN accepted')
    assert.equal(l['memory runtime'], "ok      the daemon's MEMORY_RUNTIME_TOKEN: accepted")
    assert.match(r.stdout, /\nNothing is broken\.\n$/)
    const json = JSON.parse((await clyde(['doctor', '--json'], bins)).stdout)
    assert.equal(json.broken, 0)
    assert.deepEqual(json.checks.find((c: any) => c.name === 'memory runtime'), { name: 'memory runtime', status: 'ok', detail: 'MEMORY_RUNTIME_TOKEN accepted' })
  } finally {
    await d.close()
    await memory.close()
  }
})

test('clyde doctor exits 1 and names the flag a CLI upgrade dropped, a refused token, and a missing login', async () => {
  const memory = await startFakeMemory()
  const s = setup([], { MEMORY_URL: memory.url, MEMORY_TOKEN: 'wrong-token' })
  const bins = clis(s.state, ['--json-schema', '-C'])
  try {
    const r = await clyde(['doctor'], bins)
    assert.equal(r.code, 1)
    const l = lines(r.stdout)
    assert.match(l.claude, /^broken {2}2\.1\.296 \(Claude Code\)\. \S*claude --help no longer lists --json-schema$/)
    assert.match(l.codex, /^broken {2}codex-cli 0\.162\.1\. \S*codex exec --help no longer lists -C$/)
    assert.match(l['pi login'], /^broken {2}no login for openai, which a role uses\. auth\.json has none\./)
    assert.equal(l['memory agent'], 'broken  MEMORY_TOKEN refused, memory answered 401')
    assert.match(l['memory runtime'], /^warn {4}MEMORY_RUNTIME_TOKEN is not set here and no daemon runs to ask$/)
    assert.match(l.daemon, /^warn {4}not running/)
    assert.match(r.stdout, /\n4 broken\.\n$/)
  } finally {
    await memory.close()
  }
  const dead = await clyde(['doctor'], bins)
  assert.match(lines(dead.stdout).memory, /^broken {2}http:\/\/127\.0\.0\.1:\d+ is unreachable/)
})

test('a CLI no role uses is only a warning when missing, and happier is optional', async () => {
  const s = setup([])
  const bins = clis(s.state)
  // The default judge ladder falls back to codex, so this home judges with claude alone.
  writeFileSync(join(s.home, 'roles.json'), JSON.stringify({ ...TEST_ROLES, judge: [{ backend: 'claude', model: 'sonnet' }] }))
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR as string, 'auth.json'), JSON.stringify({ openai: {}, xai: {} }))
  const r = await clyde(['doctor'], { ...bins, CLYDE_CODEX_BIN: join(s.state, 'no-codex'), CLYDE_HAPPIER_BIN: join(s.state, 'no-happier') })
  assert.equal(r.code, 0, r.stdout)
  const l = lines(r.stdout)
  assert.match(l.codex, /^warn {4}missing, .*no-codex is not on PATH \(no role uses it\)$/)
  assert.match(l.happier, /^warn {4}missing, .* \(optional\. clyde up runs pi in the terminal without it\)$/)
  assert.equal(l.memory, 'warn    MEMORY_URL is not set. Entries remain in the local memory spool')
  writeFileSync(join(s.home, 'roles.json'), JSON.stringify({ worker: [{ backend: 'codex', model: 'gpt-6.1-sol' }] }))
  const used = await clyde(['doctor'], { ...bins, CLYDE_CODEX_BIN: join(s.state, 'no-codex') })
  assert.equal(used.code, 1)
  assert.match(lines(used.stdout).codex, /^broken {2}missing, .*\(a role uses it\)$/)
})
