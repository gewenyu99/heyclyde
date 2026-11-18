/** Test setup: a fresh CLYDE_HOME, a temp git repo, a scenario for the fake CLIs, and readers for what the fakes saw. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FakeTurn } from './fakes/common.ts'

export const HARNESS = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const LV = join(HARNESS, 'bin', 'clyde.ts')
export const FAKE_BIN = join(HARNESS, 'test', 'fakes', 'bin')

export type Setup = { home: string; state: string; repo: string; scenario: string }
export type ArgvLine = { bin: string; argv: string[]; cwd: string; env: Record<string, string | undefined>; envKeys: string[] }

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `clyde-test-${prefix}-`))
}

export function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@clyde', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@clyde' }
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim()
}

export function makeRepo(): string {
  const repo = tempDir('repo')
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), '# test repo\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  return repo
}

/** The scenarios script pi workers, so tests pin threads and workers to pi. The shipped defaults run them on codex. */
export const TEST_ROLES = {
  thread: [{ backend: 'pi', model: 'openai/gpt-6.1-sol', effort: 'medium' }],
  worker: [
    { backend: 'pi', model: 'openai/gpt-6.1-sol', effort: 'medium' },
    { backend: 'pi', model: 'openai/gpt-6.1-sol', effort: 'medium', notes: true },
    { backend: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high', notes: true },
  ],
}

/** Points the backends at the fakes and every path at fresh temp dirs. Tests in one file run in order, so env is safe to set. */
export function setup(turns: FakeTurn[], extra: Record<string, string> = {}): Setup {
  const s = { home: tempDir('home'), state: tempDir('state'), repo: makeRepo(), scenario: '' }
  s.scenario = join(s.state, 'scenario.json')
  writeFileSync(s.scenario, JSON.stringify({ turns }))
  writeFileSync(join(s.home, 'roles.json'), JSON.stringify(TEST_ROLES))
  for (const k of Object.keys(process.env)) if (/^(CLYDE_|MEMORY_|KB_)/.test(k)) delete process.env[k]
  Object.assign(process.env, {
    CLYDE_HOME: s.home, CLYDE_FAKE_STATE_DIR: s.state, CLYDE_FAKE_SCENARIO: s.scenario, CLYDE_PORT: '0',
    CLYDE_PI_BIN: join(FAKE_BIN, 'pi'), CLYDE_CLAUDE_BIN: join(FAKE_BIN, 'claude'), CLYDE_CODEX_BIN: join(FAKE_BIN, 'codex'),
    PI_CODING_AGENT_DIR: tempDir('pi-agent'), IS_SANDBOX: '1', CLYDE_KILL_GRACE_MS: '500',
    ...extra,
  })
  return s
}

export function argvLog(state: string): ArgvLine[] {
  try {
    return readFileSync(join(state, 'argv.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 5000, what = 'condition'): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** How many scenario turns the fakes have taken. A fake takes its turn after saving its session, so this is a safe point to kill it. */
export function turnsTaken(state: string): number {
  try {
    return JSON.parse(readFileSync(join(state, 'consumed.json'), 'utf8')).length
  } catch {
    return 0
  }
}
