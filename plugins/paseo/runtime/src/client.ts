/** A client for the daemon's HTTP API, and ensureDaemon(), which starts a detached daemon when none answers. */
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { clydeBin, clydeHome, readDaemonInfo, type DaemonInfo } from './config.ts'
import { request } from './request.ts'
import type { ClydeEvent, Thread } from './types.ts'

export class DaemonError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type StartThreadBody = {
  title?: string; prompt: string; cwd?: string; role?: string; rung?: object; worktree?: boolean; readOnly?: boolean
  runId?: string; stage?: string; schema?: object; systemAppend?: string; list?: string[]; track?: string; parentThreadId?: string
}

export type ListView = { owner: string; items: object[]; text: string }

export class DaemonClient {
  info: DaemonInfo

  constructor(info: DaemonInfo) {
    this.info = info
  }

  static fromFile(): DaemonClient | null {
    const info = readDaemonInfo()
    return info && new DaemonClient(info)
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.info.port}${path}`
  }

  async call<T = any>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const res = await request(method, this.url(path), { headers: { authorization: `Bearer ${this.info.token}` }, body, timeoutMs })
    let parsed: any
    try {
      parsed = res.text ? JSON.parse(res.text) : null
    } catch {
      parsed = res.text
    }
    if (res.status < 200 || res.status >= 300) throw new DaemonError(res.status, parsed?.error ?? `daemon answered ${res.status}`)
    return parsed as T
  }

  health() { return this.call('GET', '/health', undefined, 3000) }
  threads(): Promise<Thread[]> { return this.call('GET', '/threads') }
  startThread(body: StartThreadBody): Promise<Thread> { return this.call('POST', '/threads', body) }
  thread(id: string): Promise<Thread> { return this.call('GET', `/threads/${enc(id)}`) }
  send(id: string, text: string): Promise<Thread> { return this.call('POST', `/threads/${enc(id)}/messages`, { text }) }
  stop(id: string): Promise<Thread> { return this.call('POST', `/threads/${enc(id)}/stop`, {}) }
  async result(id: string): Promise<unknown> { return (await this.call('GET', `/threads/${enc(id)}/result`)).result }
  postResult(id: string, result: object) { return this.call('POST', `/threads/${enc(id)}/result`, result) }
  progress(id: string, line: string) { return this.call('POST', `/threads/${enc(id)}/progress`, { line }) }
  hook(id: string, event: string, payload: object) { return this.call('POST', `/threads/${enc(id)}/hook`, { event, payload }, 3000) }
  async gate(id: string, event: string, payload: object, timeoutMs = 3000): Promise<string | null> {
    return (await this.call('POST', `/threads/${enc(id)}/gate`, { event, payload }, timeoutMs)).block ?? null
  }
  list(owner: string): Promise<ListView> { return this.call('GET', `/lists/${enc(owner)}`) }
  todo(owner: string, action: 'add' | 'start' | 'done' | 'block', body: object): Promise<ListView> {
    return this.call('POST', `/lists/${enc(owner)}/${action}`, body)
  }
  runs(): Promise<any[]> { return this.call('GET', '/runs') }
  startRun(flow: string, input: unknown, cwd?: string, track?: string, parentThreadId?: string) { return this.call('POST', '/runs', { flow, input, cwd, track, parentThreadId }) }
  run(id: string) { return this.call('GET', `/runs/${enc(id)}`) }
  answer(id: string, text: string) { return this.call('POST', `/runs/${enc(id)}/answer`, { text }) }
  stopRun(id: string) { return this.call('POST', `/runs/${enc(id)}/stop`, {}) }

  /** Polls until the thread has no running turn and nothing queued. */
  async waitIdle(id: string, pollMs = 200): Promise<Thread> {
    for (;;) {
      const t = await this.thread(id)
      if (t.status !== 'running' && t.status !== 'queued') return t
      await sleep(pollMs)
    }
  }

  /** Streams events after `since`, replayed first, then live. Returns a function that closes the stream. */
  events(since: number, onEvent: (e: ClydeEvent) => void, onEnd?: (err?: Error) => void): () => void {
    let buffer = ''
    const req = http.get(this.url(`/events?since=${since}`), { headers: { authorization: `Bearer ${this.info.token}` } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        onEnd?.(new DaemonError(res.statusCode ?? 0, `events answered ${res.statusCode}`))
        return
      }
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buffer += chunk
        let i: number
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, i)
          buffer = buffer.slice(i + 2)
          const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n')
          if (data) {
            try {
              onEvent(JSON.parse(data))
            } catch {
              // A bad frame is skipped rather than ending the stream.
            }
          }
        }
      })
      res.on('end', () => onEnd?.())
      res.on('error', (err) => onEnd?.(err))
    })
    req.on('error', (err) => onEnd?.(err))
    return () => req.destroy()
  }
}

function enc(id: string): string {
  return encodeURIComponent(id)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** True when daemon.json names a daemon that answers /health as that same process. */
export async function healthy(info: DaemonInfo | null): Promise<boolean> {
  if (!info) return false
  try {
    const h = await new DaemonClient(info).health()
    return h?.ok === true && h.pid === info.pid
  } catch {
    return false
  }
}

/** The running daemon's client. Starts `clyde daemon` detached when none answers, and waits for it. */
export async function ensureDaemon(timeoutMs = 15_000): Promise<DaemonClient> {
  const info = readDaemonInfo()
  if (await healthy(info)) return new DaemonClient(info as DaemonInfo)
  mkdirSync(clydeHome(), { recursive: true })
  const logPath = join(clydeHome(), 'daemon.log')
  const log = openSync(logPath, 'a')
  const child = spawn(process.execPath, [clydeBin(), 'daemon'], { detached: true, stdio: ['ignore', log, log], env: process.env })
  closeSync(log)
  child.unref()
  let exited = false
  child.once('exit', () => { exited = true })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const now = readDaemonInfo()
    if (now?.pid === child.pid && (await healthy(now))) return new DaemonClient(now)
    if (exited) break
    await sleep(100)
  }
  throw new Error(`clyde daemon did not start. Last log line: ${tail(logPath)}`)
}

function tail(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').at(-1) ?? ''
  } catch {
    return ''
  }
}
