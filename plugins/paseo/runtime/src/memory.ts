/** The memory server over HTTP. The daemon uses MEMORY_RUNTIME_TOKEN, and the CLI tools inside workers use MEMORY_TOKEN. */
import { request, type Response } from './request.ts'
import { blobRefs, enqueue, localEntry, localRecall, pending, type Pending } from './memory-spool.ts'

export type Remembered = { id: string; blobs: { name: string; sha256: string }[]; embedded?: boolean }

const HOOK_TIMEOUT_MS = 3000
const TIMEOUT_MS = 30_000
const WRITE_TIMEOUT_MS = 2_000
const OUTAGE_MS = 60_000
const RETRY_BASE_MS = 200

type WriteOptions = { writeTimeoutMs?: number; outageMs?: number; retryBaseMs?: number; durable?: boolean; role?: Pending['role'] }

export class Memory {
  url: string
  token: string
  private writeOptions: WriteOptions

  constructor(url: string, token: string, writeOptions: WriteOptions = {}) {
    this.url = url.replace(/\/+$/, '')
    this.token = token
    this.writeOptions = writeOptions
  }

  async call(method: string, path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<Response> {
    return request(method, this.url + path, { headers: { authorization: `Bearer ${this.token}` }, body, timeoutMs })
  }

  async remember(payload: object): Promise<Remembered> {
    if (this.writeOptions.durable) {
      const row = enqueue(payload as Record<string, any>, this.writeOptions.role ?? 'runtime')
      return { id: row.id, blobs: blobRefs(row.payload), embedded: false }
    }
    const started = performance.now()
    const outageMs = this.writeOptions.outageMs ?? OUTAGE_MS
    const timeoutMs = this.writeOptions.writeTimeoutMs ?? WRITE_TIMEOUT_MS
    const retryBaseMs = this.writeOptions.retryBaseMs ?? RETRY_BASE_MS
    let attempt = 0
    let lastError = ''
    for (;;) {
      const remaining = outageMs - (performance.now() - started)
      if (remaining <= 0) {
        throw new Error(`memory write unavailable for at least ${Math.round(performance.now() - started)} ms: ${lastError}`)
      }
      let res: Response | undefined
      try {
        res = await this.call('POST', '/entries', payload, Math.min(timeoutMs, remaining))
      } catch (err) {
        lastError = (err as Error).message
      }
      if (res?.status === 200) return JSON.parse(res.text)
      if (res) {
        if (res.status !== 408 && res.status !== 429 && res.status < 500) {
          throw new Error(`memory refused the entry (${res.status}): ${errorText(res)}`)
        }
        lastError = `HTTP ${res.status}: ${errorText(res)}`
      }
      const waitMs = Math.min(retryBaseMs * 2 ** Math.min(attempt++, 5), 3_000,
        Math.max(0, outageMs - (performance.now() - started)))
      if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
    }
  }

  async recall(query: string, scope?: string, task?: string): Promise<string> {
    const rows = this.writeOptions.durable ? pending() : []
    const local = localRecall(rows, query, scope, task)
    let remote = ''
    try {
      const res = await this.call('POST', '/recall', { query, task: task ?? '', scope: scope ?? '' }, this.writeOptions.durable ? 2_000 : TIMEOUT_MS)
      if (res.status !== 200) throw new Error(`memory recall failed (${res.status}): ${errorText(res)}`)
      remote = res.text
    } catch (err) { if (!this.writeOptions.durable) throw err }
    const superseded = new Set(rows.flatMap((row) => row.payload.supersedes ?? []))
    remote = remote.split('\n').filter((line) => ![...superseded].some((id) => line.includes(`[${id}]`))).join('\n')
    return local ? `${local}\n${remote}`.trimEnd() : remote || 'No matching entries.'
  }

  async entry(id: string): Promise<string | null> {
    if (this.writeOptions.durable) {
      const row = pending().find((item) => item.id === id)
      if (row) return localEntry(row)
    }
    let res: Response
    try { res = await this.call('GET', `/entries/${encodeURIComponent(id)}`, undefined, this.writeOptions.durable ? 2_000 : TIMEOUT_MS) }
    catch (err) { if (this.writeOptions.durable) return null; throw err }
    if (res.status === 404) return null
    if (res.status !== 200) throw new Error(`memory get_entry failed (${res.status}): ${errorText(res)}`)
    return res.text
  }

  /** The blob as text. A private blob comes back as memory's redaction line, never its content. */
  async blob(sha: string): Promise<string | null> {
    if (this.writeOptions.durable) for (const row of pending()) for (const item of row.payload.blobs ?? []) {
      const ref = blobRefs({ blobs: [item] })[0]
      if (ref.sha256 === sha) return row.payload.sensitivity === 'private' ? '[private blob: ask Wen]' : item.text ?? Buffer.from(item.base64, 'base64').toString('utf8')
    }
    let res: Response
    try { res = await this.call('GET', `/blobs/${encodeURIComponent(sha)}`, undefined, this.writeOptions.durable ? 2_000 : TIMEOUT_MS) }
    catch (err) { if (this.writeOptions.durable) return null; throw err }
    if (res.status === 404) return null
    if (res.status === 403) return errorText(res)
    if (res.status !== 200) throw new Error(`memory get_blob failed (${res.status}): ${errorText(res)}`)
    return res.text
  }

  /** Hook rows are bookkeeping, so a slow or missing memory never blocks or fails the caller. */
  async hook(event: string, payload: object): Promise<void> {
    try {
      if (!this.url) return
      await this.call('POST', `/hooks/${encodeURIComponent(event)}`, payload, this.writeOptions.durable ? 50 : HOOK_TIMEOUT_MS)
    } catch {
      // Dropped on purpose. memory is optional for threads.
    }
  }
}

function errorText(res: Response): string {
  try {
    return JSON.parse(res.text).error ?? res.text
  } catch {
    return res.text
  }
}

/** The daemon's memory, with the runtime token, or null when MEMORY_URL is unset. */
export function runtimeMemory(env: Record<string, string | undefined> = process.env): Memory {
  return new Memory(env.MEMORY_URL ?? '', env.MEMORY_RUNTIME_TOKEN ?? '', { durable: true, role: 'runtime' })
}

/** memory as an agent sees it, with MEMORY_TOKEN, or null when MEMORY_URL is unset. */
export function agentMemory(env: Record<string, string | undefined> = process.env): Memory {
  return new Memory(env.MEMORY_URL ?? '', env.MEMORY_TOKEN ?? '', { durable: true, role: 'agent' })
}

function needAgentMemory(): Memory {
  const memory = agentMemory()
  if (!memory) throw new Error('MEMORY_URL is not set, so memory is unreachable')
  return memory
}

export async function recallAsAgent(query: string, scope?: string, task?: string): Promise<string> {
  return needAgentMemory().recall(query, scope, task)
}

export async function rememberAsAgent(payload: object): Promise<Remembered> {
  return needAgentMemory().remember(payload)
}
