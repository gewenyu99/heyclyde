/** Runs one CLI process for a turn: stdin closed or fed then closed, stdout split into lines, a deadline, and a clean cancel. */
import { spawn } from 'node:child_process'
import { killGraceMs } from '../config.ts'

export type ProcOptions = {
  bin: string; args: string[]; cwd: string; env: Record<string, string>; stdin?: string
  signal: AbortSignal; timeoutMs: number; onLine: (line: string) => void
}

export type ProcResult = {
  code: number | null; signal: string | null; stderr: string; timedOut: boolean; aborted: boolean; spawnError?: string
}

export type Signal = 'SIGINT' | 'SIGTERM' | 'SIGKILL'
export type Proc = { done: Promise<ProcResult>; kill: (signal?: Signal) => void }

const STDERR_KEEP = 8192
// A worker can leave a grandchild holding stdout open, so exit waits this long for the pipes, then stops waiting.
const CLOSE_WAIT_MS = 2000

export function runProcess(opts: ProcOptions): Proc {
  const state = { timedOut: false, aborted: false, stderr: '' }
  if (opts.signal.aborted) {
    return { done: Promise.resolve({ code: null, signal: null, stderr: '', timedOut: false, aborted: true }), kill: () => {} }
  }
  const child = spawn(opts.bin, opts.args, {
    cwd: opts.cwd, env: opts.env, stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
  if (opts.stdin !== undefined && child.stdin) {
    child.stdin.on('error', () => {})
    child.stdin.end(opts.stdin)
  }

  let partial = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    partial += chunk.toString('utf8')
    // Split on LF alone. readline also splits on U+2028, which JSON strings may hold.
    let i: number
    while ((i = partial.indexOf('\n')) >= 0) {
      const line = partial.slice(0, i)
      partial = partial.slice(i + 1)
      if (line.trim()) opts.onLine(line)
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    state.stderr = (state.stderr + chunk.toString('utf8')).slice(-STDERR_KEEP)
  })

  let killTimer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGINT')
    killTimer ??= setTimeout(() => child.kill('SIGKILL'), killGraceMs())
  }
  const onAbort = () => {
    state.aborted = true
    cancel()
  }
  opts.signal.addEventListener('abort', onAbort, { once: true })
  const deadline = setTimeout(() => {
    state.timedOut = true
    cancel()
  }, opts.timeoutMs)

  const done = new Promise<ProcResult>((resolve) => {
    let settled = false
    const finish = (code: number | null, signal: string | null, spawnError?: string) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(killTimer)
      opts.signal.removeEventListener('abort', onAbort)
      if (partial.trim()) opts.onLine(partial)
      partial = ''
      resolve({ code, signal, stderr: state.stderr, timedOut: state.timedOut, aborted: state.aborted, spawnError })
    }
    child.on('error', (err) => finish(null, null, err.message))
    child.on('close', (code, signal) => finish(code, signal))
    child.on('exit', (code, signal) => {
      setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(code, signal)
      }, CLOSE_WAIT_MS).unref()
    })
  })
  return { done, kill: (signal = 'SIGTERM') => child.kill(signal) }
}

/** One line on why a process ended badly, for TurnOutput.error. */
export function exitReason(name: string, r: ProcResult, timeoutMs: number): string {
  if (r.spawnError) return `${name} could not start: ${r.spawnError}`
  if (r.timedOut) return `${name} timed out after ${timeoutMs} ms`
  if (r.aborted) return `${name} was stopped`
  const how = r.signal ? `was killed by ${r.signal}` : `exited with code ${r.code}`
  const tail = lastLine(r.stderr)
  return tail ? `${name} ${how}: ${tail}` : `${name} ${how}`
}

export function lastLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  return (lines.at(-1) ?? '').slice(0, 500)
}

export function parseLine(line: string): Record<string, any> | null {
  try {
    const v = JSON.parse(line)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/** The last fenced json block in text, or the whole text when it is JSON. The fallback when a CLI has no structured output. */
export function lastJsonBlock(text: string): unknown {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)]
  for (const candidate of [blocks.at(-1)?.[1], text]) {
    if (candidate === undefined) continue
    try {
      return JSON.parse(candidate)
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}
