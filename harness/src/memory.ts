/** Standalone HTTP client for the Clyde / memory server used by Tier-3 integration tests. */
import { request, type Response } from './request.ts'

export type Remembered = { id: string; blobs: { name: string; sha256: string }[]; embedded?: boolean }

const HOOK_TIMEOUT_MS = 3000
const TIMEOUT_MS = 30_000
const WRITE_TIMEOUT_MS = 2_000
const OUTAGE_MS = 60_000
const RETRY_BASE_MS = 200

type WriteOptions = { writeTimeoutMs?: number; outageMs?: number; retryBaseMs?: number }

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
    const res = await this.call('POST', '/recall', { query, task: task ?? '', scope: scope ?? '' }, TIMEOUT_MS)
    if (res.status !== 200) throw new Error(`memory recall failed (${res.status}): ${errorText(res)}`)
    return res.text || 'No matching entries.'
  }

  async entry(id: string): Promise<string | null> {
    const res = await this.call('GET', `/entries/${encodeURIComponent(id)}`, undefined, TIMEOUT_MS)
    if (res.status === 404) return null
    if (res.status !== 200) throw new Error(`memory get_entry failed (${res.status}): ${errorText(res)}`)
    return res.text
  }

  async blob(sha: string): Promise<string | null> {
    const res = await this.call('GET', `/blobs/${encodeURIComponent(sha)}`, undefined, TIMEOUT_MS)
    if (res.status === 404) return null
    if (res.status === 403) return errorText(res)
    if (res.status !== 200) throw new Error(`memory get_blob failed (${res.status}): ${errorText(res)}`)
    return res.text
  }

  async hook(event: string, payload: object): Promise<void> {
    try {
      if (!this.url) return
      await this.call('POST', `/hooks/${encodeURIComponent(event)}`, payload, HOOK_TIMEOUT_MS)
    } catch {
      // Dropped on purpose.
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
