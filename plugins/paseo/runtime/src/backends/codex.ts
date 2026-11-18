/** Codex as a backend: codex exec --json with the prompt on stdin, resumed by thread id with every setting passed again. */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { clydeHome, turnTimeoutMs } from '../config.ts'
import { family } from '../roles.ts'
import { exitReason, parseLine, runProcess } from './spawn.ts'
import type { Backend, TurnInput, TurnOutput } from './types.ts'

type Files = { out: string; schema?: string }

// The Codex CLI the ChatGPT and Codex desktop apps ship, for a Mac where codex isn't on PATH.
const APP_BINS = ['/Applications/Codex.app/Contents/Resources/codex', '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex']

/** CLYDE_CODEX_BIN, else codex on PATH, else the one inside a desktop app. */
export function codexBin(): string {
  if (process.env.CLYDE_CODEX_BIN) return process.env.CLYDE_CODEX_BIN
  if ((process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, 'codex')))) return 'codex'
  return APP_BINS.find((b) => existsSync(b)) ?? 'codex'
}

function tempFiles(schema?: object): Files {
  const dir = join(clydeHome(), 'tmp')
  mkdirSync(dir, { recursive: true })
  const stem = join(dir, `codex-${randomBytes(6).toString('hex')}`)
  const files: Files = { out: `${stem}.last.txt` }
  if (schema) {
    files.schema = `${stem}.schema.json`
    writeFileSync(files.schema, JSON.stringify(schema))
  }
  return files
}

/** -s and -C aren't global, so on resume they go before `resume`. Resume restores no settings, so the rest repeat. */
/** A linked worktree keeps its git metadata in the main repo's .git, outside the sandbox, so commits need it writable. */
export function gitDirsOutside(cwd: string): string[] {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-dir', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const dirs = [...new Set(out.trim().split('\n').map((d) => resolve(cwd, d)))]
    return dirs.filter((d) => { const rel = relative(cwd, d); return rel.startsWith('..') || isAbsolute(rel) })
  } catch {
    return []
  }
}

export function codexArgs(input: TurnInput, files: Files, session?: string): string[] {
  const settings = ['--json', '--skip-git-repo-check']
  if (input.rung.model) settings.push('-m', input.rung.model)
  if (input.rung.effort) settings.push('-c', `model_reasoning_effort=${input.rung.effort}`)
  if (input.readOnly) settings.push('--ephemeral')
  else settings.push(
    '--ignore-user-config',
    '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([input.env.CLYDE_HOME || clydeHome(), ...gitDirsOutside(input.cwd)])}`,
    '-c', 'sandbox_workspace_write.network_access=true',
    '-c', 'features.network_proxy.enabled=true',
    '-c', 'features.network_proxy.domains={"127.0.0.1"="allow"}',
    '-c', 'approval_policy="never"',
  )
  if (files.schema) settings.push('--output-schema', files.schema)
  const sandbox = ['-s', input.readOnly ? 'read-only' : 'workspace-write', '-C', input.cwd]
  const tail = ['-o', files.out, '-']
  return session ? ['exec', ...sandbox, 'resume', session, ...settings, ...tail] : ['exec', ...settings, ...sandbox, ...tail]
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

export async function runTurn(input: TurnInput): Promise<TurnOutput> {
  const timeoutMs = turnTimeoutMs()
  const deadline = Date.now() + timeoutMs
  const delays = [250, 500, 1000]
  for (let attempt = 0; ; attempt++) {
    const { out, resumeBusy } = await runAttempt(input, Math.max(1, deadline - Date.now()))
    // Only a rejected resume is safe to repeat. Never replay a turn that started doing work.
    if (!resumeBusy || attempt === delays.length || input.signal.aborted) return out
    const delay = delays[attempt]
    if (Date.now() + delay >= deadline) return out
    input.onProgress?.('codex resume is waiting for the active writer to exit')
    try {
      await sleep(delay, undefined, { signal: input.signal })
    } catch {
      return { ok: false, text: '', session: input.session, error: 'codex was stopped' }
    }
  }
}

async function runAttempt(input: TurnInput, timeoutMs: number): Promise<{ out: TurnOutput; resumeBusy: boolean }> {
  // An ephemeral thread writes no rollout, so a read-only turn can never resume and always starts fresh.
  const session = input.readOnly ? undefined : input.session
  const files = tempFiles(input.schema)
  const s: { thread?: string; text?: string; started: boolean; done: boolean; failed?: string; notice?: string; usage?: unknown; mismatch?: string } = { started: false, done: false }
  const proc = runProcess({
    bin: codexBin(), args: codexArgs(input, files, session), cwd: input.cwd, env: input.env,
    stdin: input.prompt, signal: input.signal, timeoutMs,
    onLine: (line) => {
      const e = parseLine(line)
      if (!e) return
      if (e.type === 'thread.started') {
        s.thread = e.thread_id
        // A resume id that matches nothing can silently start a new thread, so the id must come back unchanged.
        if (session && e.thread_id !== session) {
          s.mismatch = `codex started thread ${e.thread_id} instead of resuming ${session}`
          proc.kill('SIGINT')
        } else if (!session && !input.readOnly) input.onSession?.(e.thread_id)
      } else if (e.type === 'turn.started' || e.type === 'item.started') {
        s.started = true
        if (e.item?.type === 'command_execution') input.onProgress?.(`codex ran ${e.item.command}`)
      } else if (e.type === 'item.completed') {
        s.started = true
        if (e.item?.type === 'agent_message') s.text = e.item.text
      } else if (e.type === 'turn.completed') {
        s.done = true
        s.usage = e.usage
      } else if (e.type === 'turn.failed') s.failed = e.error?.message ?? 'turn failed'
      // error events include retry notices, so they're only the cause when the turn fails.
      else if (e.type === 'error') s.notice = e.message
    },
  })
  const r = await proc.done
  const text = s.text ?? readText(files.out) ?? ''
  rmSync(files.out, { force: true })
  if (files.schema) rmSync(files.schema, { force: true })
  const out: TurnOutput = { ok: false, text, session: input.readOnly ? undefined : session ?? s.thread, usage: s.usage }
  if (s.mismatch) out.error = s.mismatch
  else if (s.done) out.ok = true
  else if (r.timedOut || r.aborted) out.error = exitReason('codex', r, timeoutMs)
  else out.error = s.failed ?? (s.notice ? `codex failed: ${s.notice}` : exitReason('codex', r, timeoutMs))
  if (out.ok && input.schema) {
    try {
      out.json = JSON.parse(text)
    } catch {
      out.ok = false
      out.error = 'codex answered with text that is not JSON despite --output-schema'
    }
  }
  const resumeBusy = Boolean(session && !out.ok && !s.started && !s.mismatch && !r.timedOut && !r.aborted &&
    /thread\/resume failed:[^\n]*already has an active writer \(code -32600\)/.test(out.error ?? ''))
  return { out, resumeBusy }
}

export const codex: Backend = { name: 'codex', family, runTurn }
