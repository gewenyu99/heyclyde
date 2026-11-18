/** Shell work in a run's worktree: acceptance checks, and the git facts the judge reads. Async, so the daemon keeps serving. */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type ShellResult = { code: number; output: string; stderr?: string }
// merge puts stderr in output, as a person reading a check wants. Git calls keep it apart, so a warning never lands in a diff.
type RunOptions = { env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; max?: number; head?: boolean; merge?: boolean }

// A check's verdict is in its last lines. A diff reads from the top, and memory takes a blob up to 4 MiB.
const CHECK_KEEP = 20_000
const DIFF_KEEP = 4 * 1024 * 1024 - 1024

export function checkTimeoutMs(): number {
  const n = Number(process.env.CLYDE_CHECK_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : 10 * 60 * 1000
}

/** Runs a check with sh. It gets its own process group, so a timeout or a stop also kills what it started. */
export function sh(cmd: string, cwd: string, opts: RunOptions = {}): Promise<ShellResult> {
  return run('sh', ['-c', cmd], cwd, { max: CHECK_KEEP, merge: true, ...opts })
}

function run(bin: string, args: string[], cwd: string, opts: RunOptions): Promise<ShellResult> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) return resolve({ code: 130, output: 'stopped before it started' })
    const max = opts.max ?? CHECK_KEEP
    let output = ''
    let stderr = ''
    let cut = false
    const keep = (c: Buffer | string) => {
      output += c.toString()
      if (output.length <= max) return
      cut = true
      output = opts.head ? output.slice(0, max) : output.slice(-max)
    }
    const child = spawn(bin, args, { cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    child.stdout.on('data', keep)
    child.stderr.on('data', opts.merge ? keep : (c: Buffer) => { stderr = (stderr + c.toString()).slice(-4000) })
    let why = ''
    const kill = (reason: string) => {
      why ||= reason
      try {
        process.kill(-(child.pid as number), 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    const timeoutMs = opts.timeoutMs ?? checkTimeoutMs()
    const timer = setTimeout(() => kill(`timed out after ${timeoutMs} ms`), timeoutMs)
    const onAbort = () => kill('stopped')
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    let settled = false
    const done = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (cut && opts.head) output += '\n[cut here, the output goes on]'
      resolve({ code, output: why ? `${output}\n${why}`.trim() : output, stderr: why ? `${stderr}\n${why}`.trim() : stderr })
    }
    child.on('error', (err) => {
      if (opts.merge) keep(err.message)
      else stderr += err.message
      done(127)
    })
    child.on('close', (code, signal) => done(code ?? (signal ? 137 : 1)))
  })
}

function git(cwd: string, args: string[], opts: RunOptions = {}): Promise<ShellResult> {
  return run('git', ['-C', cwd, ...args], cwd, { timeoutMs: 60_000, ...opts })
}

export async function headSha(cwd: string): Promise<string> {
  const r = await git(cwd, ['rev-parse', 'HEAD'])
  if (r.code !== 0) throw new Error(`git rev-parse HEAD failed in ${cwd}: ${r.stderr?.trim()}`)
  return r.output.trim()
}

/**
 * Everything that changed since base: commits, staged and unstaged edits, and new files a worker forgot to add.
 * A throwaway index takes the `git add -A`, so the worktree's own index is never touched.
 */
export async function diffSince(cwd: string, base: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'clyde-index-'))
  const index = join(dir, 'index')
  const env = { ...process.env, GIT_INDEX_FILE: index } as Record<string, string>
  try {
    for (const args of [['read-tree', 'HEAD'], ['add', '-A']]) {
      const r = await git(cwd, args, { env })
      if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr?.trim()}`)
    }
    const diff = await git(cwd, ['diff', '--cached', '--no-color', '--no-ext-diff', base], { env, max: DIFF_KEEP, head: true })
    if (diff.code !== 0) throw new Error(`git diff ${base} failed in ${cwd}: ${diff.stderr?.trim()}`)
    return diff.output
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function commitsSince(cwd: string, base: string): Promise<string> {
  const r = await git(cwd, ['log', '--oneline', '--no-color', `${base}..HEAD`])
  return r.code === 0 ? r.output.trim() : ''
}

/** Auditors compare immutable revisions, including when a run resumes mid-repair. */
export async function committedDiff(cwd: string, base: string, head: string): Promise<string> {
  const result = await git(cwd, ['diff', '--no-color', '--no-ext-diff', base, head], { max: DIFF_KEEP, head: true })
  if (result.code) throw new Error('Cannot read the audit diff: ' + result.stderr)
  return result.output
}
