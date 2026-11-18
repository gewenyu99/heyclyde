/** Tier 2 plumbing: the real pi binary with the fake model, in json mode or over RPC, plus readers for what came back. */
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Step } from '../fakes/pi-provider.ts'
import { HARNESS } from '../helpers.ts'

export const PI = join(HARNESS, 'node_modules', '.bin', 'pi')
export const EXTENSION = join(HARNESS, 'pi', 'clyde.ts')
export const PROVIDER = join(HARNESS, 'test', 'fakes', 'pi-provider.ts')
export const POINT_MAN_TOOLS = ['clyde_flow_answer', 'clyde_flow_start', 'clyde_plan', 'clyde_recall', 'clyde_remember', 'clyde_runs', 'clyde_status',
  'clyde_thread_read', 'clyde_thread_send', 'clyde_thread_start', 'clyde_thread_stop', 'clyde_threads', 'clyde_todo']
export const WORKER_TOOLS = ['clyde_progress', 'clyde_recall', 'clyde_remember', 'clyde_result', 'clyde_todo']

// pi stays off the network, so a test never waits on a catalog refresh or a version check.
const OFFLINE = { PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' }
const MODE_VARS = ['CLYDE_POINT_MAN', 'CLYDE_THREAD_ID', 'CLYDE_DELIVERY', 'CLYDE_RUN_ID', 'CLYDE_MEMORY_SCOPE']

export type Seen = { call: number; step: Step; lastUser: string; tools: string[]; system: string }
export type Script = { path: string; seen: () => Seen[]; add: (steps: Step[]) => void }
export type Rec = Record<string, any>

/** The test's env with no clyde mode set, pi offline, and extra on top. */
export function piEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !MODE_VARS.includes(k)) env[k] = v
  return { ...env, ...OFFLINE, ...extra }
}

export function writeScript(dir: string, steps: Step[]): Script {
  const path = join(dir, `script-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
  const log = `${path}.log`
  const all = [...steps]
  writeFileSync(path, JSON.stringify({ steps: all, log }))
  return {
    path,
    add: (more) => {
      all.push(...more)
      writeFileSync(path, JSON.stringify({ steps: all, log }))
    },
    seen: () => {
      try {
        return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      } catch {
        return []
      }
    },
  }
}

/** A pi bin the daemon can spawn: the real pi, offline, since the worker env drops PI_OFFLINE. Each call's argv lands in dir. */
export function offlinePi(dir: string): string {
  const path = join(dir, 'pi-offline')
  const vars = Object.entries(OFFLINE).map(([k, v]) => `${k}=${v}`).join(' ')
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\0' "$@" > "${dir}/argv.$$"\nexport ${vars}\nexec "${PI}" "$@"\n`)
  chmodSync(path, 0o755)
  return path
}

/** The argv of every call to an offlinePi bin. */
export function piCalls(dir: string): string[][] {
  return readdirSync(dir).filter((f) => f.startsWith('argv.')).map((f) => readFileSync(join(dir, f), 'utf8').split('\0').slice(0, -1))
}

/** Puts the fake model in the agent dir, where pi finds it without -e, as a daemon-spawned worker needs. */
export function installProvider(agentDir: string): void {
  const dir = join(agentDir, 'extensions', 'clyde-fake-model')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.ts'), `export { default } from ${JSON.stringify(PROVIDER)}\n`)
}

function parseLines(onRecord: (r: Rec) => void): (chunk: Buffer) => void {
  let buffer = ''
  return (chunk) => {
    buffer += chunk.toString('utf8')
    let i: number
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim()
      buffer = buffer.slice(i + 1)
      if (!line) continue
      try {
        onRecord(JSON.parse(line))
      } catch {
        // pi writes only JSON lines to stdout. Anything else is noise.
      }
    }
  }
}

/** pi --mode json -p with the fake model and the clyde extension. stdin is closed, as pi needs. */
export function runJson(args: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs?: number }) {
  const argv = ['--mode', 'json', '--model', 'fake/fake-1', '-e', PROVIDER, '-e', EXTENSION, ...args]
  const child = spawn(PI, argv, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const records: Rec[] = []
  let stderr = ''
  child.stdout.on('data', parseLines((r) => records.push(r)))
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 30_000)
  return new Promise<{ code: number | null; signal: string | null; records: Rec[]; stderr: string }>((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, records, stderr })
    })
  })
}

/** pi --mode rpc with the fake model and the clyde extension, its records kept in order. */
export class Rpc {
  child: ChildProcess
  records: Rec[] = []
  stderr = ''
  exited: Promise<number | null>
  waiters: { from: number; pred: (r: Rec) => boolean; resolve: (r: Rec) => void }[] = []

  constructor(opts: { cwd: string; env: Record<string, string>; args?: string[] }) {
    const argv = ['--mode', 'rpc', '--model', 'fake/fake-1', '--no-session', '-e', PROVIDER, '-e', EXTENSION, ...(opts.args ?? [])]
    this.child = spawn(PI, argv, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout!.on('data', parseLines((r) => this.add(r)))
    this.child.stderr!.on('data', (c: Buffer) => { this.stderr += c.toString('utf8') })
    this.exited = new Promise((resolve) => this.child.on('close', (code) => resolve(code)))
  }

  add(r: Rec): void {
    this.records.push(r)
    const at = this.records.length - 1
    for (const w of [...this.waiters]) {
      if (at >= w.from && w.pred(r)) {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        w.resolve(r)
      }
    }
  }

  send(cmd: object): void {
    this.child.stdin!.write(JSON.stringify(cmd) + '\n')
  }

  /** The first record at or after index from that fits, whether it came already or comes later. */
  waitFor(pred: (r: Rec) => boolean, what: string, opts: { from?: number; timeoutMs?: number } = {}): Promise<Rec> {
    const from = opts.from ?? 0
    const found = this.records.slice(from).find(pred)
    if (found) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done)
        reject(new Error(`timed out waiting for ${what}. stderr: ${this.stderr.slice(-2000)}`))
      }, opts.timeoutMs ?? 15_000)
      const done = (r: Rec) => {
        clearTimeout(timer)
        resolve(r)
      }
      this.waiters.push({ from, pred, resolve: done })
    })
  }

  /** Sends a prompt and waits for its run to settle. Returns where the run's records start. */
  async prompt(message: string): Promise<number> {
    const from = this.records.length
    this.send({ id: `p${from}`, type: 'prompt', message })
    await this.waitFor((r) => r.type === 'agent_settled', 'the prompt to settle', { from })
    return from
  }

  /** Closing stdin makes pi exit, whatever timers an extension left. */
  async close(): Promise<number | null> {
    this.child.stdin!.end()
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 5000)
    const code = await this.exited
    clearTimeout(timer)
    return code
  }
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
}

export function assistantTexts(records: Rec[], from = 0): string[] {
  return records.slice(from).filter((r) => r.type === 'message_end' && r.message?.role === 'assistant').map((r) => textOf(r.message.content))
}

/** The tools pi gave the model, from the system messages in the stream. */
export function toolsGiven(records: Rec[]): string[] {
  const names = new Set<string>()
  for (const r of records) {
    if (r.type !== 'message_end' || r.message?.role !== 'system') continue
    for (const t of r.message.toolsAdded ?? []) names.add(t.name)
    for (const t of r.message.toolsRemoved ?? []) names.delete(t.name)
  }
  return [...names].sort()
}

export function statusUpdate(r: Rec, text?: string): boolean {
  return r.type === 'extension_ui_request' && r.method === 'setStatus' && r.statusKey === 'clyde' && (text === undefined || r.statusText === text)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
