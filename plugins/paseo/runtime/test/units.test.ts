/** Small pieces: the env allowlist, roles and families, the event log, atomic JSON writes, and pi's prompt guard. */
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { extensionPath, piArgs, safePrompt } from '../src/backends/pi.ts'
import { lastJsonBlock } from '../src/backends/spawn.ts'
import { visible } from '../src/cli/status.ts'
import { workerEnv } from '../src/env.ts'
import { EventLog } from '../src/events.ts'
import { DEFAULT_ROLES, family, ladder, roles } from '../src/roles.ts'
import { readJson, writeJson } from '../src/store.ts'
import type { Thread } from '../src/types.ts'
import { setup, tempDir } from './helpers.ts'

test('workerEnv keeps the allowlist and CLYDE_*, passes PI_OFFLINE, and drops CLAUDE_CODE_*, MEMORY_RUNTIME_TOKEN and the rest', () => {
  const base = {
    HOME: '/h', PATH: '/bin', HTTPS_PROXY: 'http://p', NODE_EXTRA_CA_CERTS: '/ca', OPENAI_API_KEY: 'k', MEMORY_TOKEN: 'a',
    MEMORY_RUNTIME_TOKEN: 'r', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_REMOTE_SESSION_ID: 'cse', CLAUDECODE: '1', AWS_SECRET_ACCESS_KEY: 's',
    CLYDE_FAKE_SCENARIO: '/s', CLYDE_RUN_ID: 'stale', GITHUB_TOKEN: 'g', PI_OFFLINE: '1',
  }
  const env = workerEnv({ CLYDE_THREAD_ID: 't-1', CLYDE_RUN_ID: undefined, CLAUDE_CODE_FOO: 'no', MEMORY_RUNTIME_TOKEN: 'no' }, base)
  const { PASEO_HOME, ...rest } = env
  assert.match(PASEO_HOME, /paseo-sandbox$/)
  assert.deepEqual(rest, { HOME: '/h', PATH: '/bin', HTTPS_PROXY: 'http://p', NODE_EXTRA_CA_CERTS: '/ca', OPENAI_API_KEY: 'k', MEMORY_TOKEN: 'a', CLYDE_FAKE_SCENARIO: '/s', PI_OFFLINE: '1', CLYDE_THREAD_ID: 't-1' })
})

test('roles.json overrides one role and keeps the other defaults', () => {
  const s = setup([])
  writeFileSync(join(s.home, 'roles.json'), JSON.stringify({ judge: [{ backend: 'codex', model: 'gpt-6.1-sol' }], broken: [{ backend: 'nope' }] }))
  assert.deepEqual(ladder('judge'), [{ backend: 'codex', model: 'gpt-6.1-sol' }])
  assert.deepEqual(ladder('worker'), DEFAULT_ROLES.worker)
  assert.equal(roles().broken, undefined, 'a ladder with a bad rung is ignored')
  assert.throws(() => ladder('nobody'), /unknown role nobody/)
  assert.equal(DEFAULT_ROLES.worker.length, 3)
  assert.deepEqual(DEFAULT_ROLES.worker.map((r) => [r.effort, r.notes ?? false]), [['high', false], ['high', true], ['high', true]])
})

test('family groups claude with anthropic and codex with openai', () => {
  assert.equal(family({ backend: 'claude', model: 'opus' }), 'anthropic')
  assert.equal(family({ backend: 'pi', model: 'anthropic/claude-opus-5-5' }), 'anthropic')
  assert.equal(family({ backend: 'codex' }), 'openai')
  assert.equal(family({ backend: 'pi', model: 'openai/gpt-6' }), 'openai')
  assert.equal(family({ backend: 'pi', model: 'openai-codex/gpt-6.1-sol' }), 'openai')
  assert.equal(family({ backend: 'pi', model: 'xai/grok-4.7' }), 'xai')
  assert.equal(family({ backend: 'pi', model: 'kimi-coding/k2' }), 'kimi-coding')
  assert.notEqual(family(DEFAULT_ROLES.judge[0]), family(DEFAULT_ROLES.worker[0]))
})

test('the event log keeps ids monotonic across reloads and skips a torn last line', () => {
  const path = join(tempDir('events'), 'events.jsonl')
  const log = new EventLog(path)
  const seen: number[] = []
  const unsubscribe = log.subscribe((e) => seen.push(e.id))
  log.append({ type: 'thread.started', summary: 'one' })
  log.append({ type: 'thread.done', summary: 'two' })
  unsubscribe()
  log.append({ type: 'thread.done', summary: 'three' })
  assert.deepEqual(seen, [1, 2])
  appendFileSync(path, '{"id": 4, "type": "torn')
  const again = new EventLog(path)
  assert.deepEqual(again.since(1).map((e) => e.id), [2, 3])
  assert.equal(again.append({ type: 'x', summary: 'four' }).id, 4)
})

test('writeJson replaces the file whole and leaves no temp file', () => {
  const dir = tempDir('store')
  const path = join(dir, 'a.json')
  writeJson(path, { n: 1 })
  writeJson(path, { n: 2 }, 0o600)
  assert.deepEqual(readJson(path), { n: 2 })
  assert.deepEqual(readdirSync(dir), ['a.json'])
  assert.equal(readJson(join(dir, 'missing.json')), null)
})

test('a pi prompt never starts with - or @', () => {
  assert.equal(safePrompt('-rf everything'), ' -rf everything')
  assert.equal(safePrompt('@file.ts'), ' @file.ts')
  assert.equal(safePrompt('plain'), 'plain')
})

test('lastJsonBlock takes the last fenced json block, or the whole text', () => {
  assert.deepEqual(lastJsonBlock('a\n```json\n{"x":1}\n```\nb\n```json\n{"x":2}\n```'), { x: 2 })
  assert.deepEqual(lastJsonBlock('{"y":3}'), { y: 3 })
  assert.equal(lastJsonBlock('no json here'), undefined)
})

test('pi gets -e only while clyde install has not linked the extension into the agent dir', () => {
  const s = setup([])
  const agentDir = tempDir('agent')
  const input = { rung: { backend: 'pi' as const, model: 'xai/grok-4.7' }, cwd: s.repo, prompt: 'p', env: { PI_CODING_AGENT_DIR: agentDir }, signal: new AbortController().signal }
  assert.equal(piArgs(input, 's').includes('-e'), existsSync(extensionPath()), 'loaded by path when it exists and is not installed')
  mkdirSync(join(agentDir, 'extensions', 'clyde'), { recursive: true })
  writeFileSync(join(agentDir, 'extensions', 'clyde', 'index.ts'), '')
  assert.ok(!piArgs(input, 's').includes('-e'), 'pi refuses the same extension loaded twice')
})

test('clyde status hides the threads of finished runs and keeps live runs and plain threads', () => {
  const t = (id: string, runId?: string) => ({ id, runId }) as Thread
  const threads = [t('t-plain'), t('t-live', 'r-live'), t('t-ask', 'r-ask'), t('t-done', 'r-done'), t('t-gone', 'r-missing')]
  const runs = [{ id: 'r-live', status: 'running' }, { id: 'r-ask', status: 'asking' }, { id: 'r-done', status: 'done' }]
  assert.deepEqual(visible(threads, runs).map((x) => x.id), ['t-plain', 't-live', 't-ask'])
})

test('claude gets bypassPermissions in a clyde worktree Paseo placed outside CLYDE_HOME, and not in the main checkout', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, realpathSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { permissionMode } = await import('../src/backends/claude.ts')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clyde-perm-')))
  const repo = join(root, 'repo')
  const git = (...a: string[]) => execFileSync('git', a, { stdio: 'ignore' })
  git('init', '-q', '-b', 'main', repo)
  git('-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init')
  const wt = join(root, 'paseo-worktrees', 'r-1')
  git('-C', repo, 'worktree', 'add', '-q', '-b', 'clyde/r-1', wt)
  const rung = { backend: 'claude' as const }
  assert.equal(permissionMode({ rung, cwd: wt } as never), 'bypassPermissions')
  assert.equal(permissionMode({ rung, cwd: repo } as never), 'acceptEdits')
  git('-C', repo, 'checkout', '-q', '-b', 'clyde/main-checkout')
  assert.equal(permissionMode({ rung, cwd: repo } as never), 'acceptEdits')
})

test('a codex worker in a linked worktree can write the main repo git dir, and a plain checkout adds nothing', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, realpathSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { gitDirsOutside } = await import('../src/backends/codex.ts')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clyde-gitdir-')))
  const repo = join(root, 'repo')
  const git = (...a: string[]) => execFileSync('git', a, { stdio: 'ignore' })
  git('init', '-q', '-b', 'main', repo)
  git('-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init')
  const wt = join(root, 'wt')
  git('-C', repo, 'worktree', 'add', '-q', '-b', 'clyde/t-1', wt)
  assert.deepEqual(gitDirsOutside(wt).sort(), [join(repo, '.git'), join(repo, '.git', 'worktrees', 'wt')].sort())
  assert.deepEqual(gitDirsOutside(repo), [])
})

test('a top-level task worktree is a Paseo workspace in the repo project under its title; a worker worktree never is', async () => {
  const { execFileSync } = await import('node:child_process')
  const { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clyde-ws-')))
  const repo = join(root, 'like-vincent')
  const git = (...a: string[]) => execFileSync('git', a, { stdio: 'ignore' })
  git('init', '-q', '-b', 'main', repo)
  git('-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init')
  const home = join(root, 'clyde')
  const log = join(root, 'paseo.log')
  const bin = join(root, 'paseo')
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${log}\nslug=""\nwhile [ $# -gt 0 ]; do [ "$1" = "--worktree-slug" ] && slug="$2"; shift; done\nd=${root}/paseo-worktrees/$slug\ngit -C ${repo} worktree add -q -b clyde/$slug $d >/dev/null 2>&1\necho "{\\"workspaceId\\":\\"wks_1\\",\\"cwd\\":\\"$d\\"}"\n`)
  chmodSync(bin, 0o755)
  const prev = { home: process.env.CLYDE_HOME, bin: process.env.CLYDE_PASEO_BIN }
  process.env.CLYDE_HOME = home
  process.env.CLYDE_PASEO_BIN = bin
  try {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'paseo.json'), JSON.stringify({ agentId: 'pm', cwd: root, createdAt: '' }))
    const { createWorktree } = await import('../src/worktree.ts')
    const top = createWorktree(repo, 'r-top', 'Make every request a judged plan', true)
    assert.equal(top.path, join(root, 'paseo-worktrees', 'r-top'))
    assert.equal(top.workspace, 'wks_1')
    assert.match(readFileSync(log, 'utf8'), new RegExp(`--path ${repo} .*--title Make every request a judged plan`))
    const worker = createWorktree(repo, 'r-worker', 'worker', false)
    assert.equal(worker.path, join(home, 'worktrees', 'r-worker'))
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1)
  } finally {
    process.env.CLYDE_HOME = prev.home
    process.env.CLYDE_PASEO_BIN = prev.bin
    if (prev.home === undefined) delete process.env.CLYDE_HOME
    if (prev.bin === undefined) delete process.env.CLYDE_PASEO_BIN
  }
})

test("a worker's paseo commands point at an empty sandbox home, never Wen's Paseo", async () => {
  const { workerEnv } = await import('../src/env.ts')
  const env = workerEnv({}, { HOME: '/Users/w', PASEO_HOME: '/Users/w/.paseo', PATH: '/bin' })
  assert.match(env.PASEO_HOME, /paseo-sandbox$/)
  assert.notEqual(env.PASEO_HOME, '/Users/w/.paseo')
})
