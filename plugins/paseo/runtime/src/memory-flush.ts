/** Drain durable entries in dependency order; a failed request keeps its exact payload for retry. */
import { delivered, pending } from './memory-spool.ts'
import { request } from './request.ts'

export type FlushConfig = { url?: string; runtimeToken?: string; agentToken?: string; timeoutMs?: number; send?: typeof request }

export async function flushPending(config: FlushConfig): Promise<number> {
  if (!config.url) return 0
  let count = 0
  for (const row of pending()) {
    const token = row.role === 'agent' ? config.agentToken : config.runtimeToken
    if (!token) break
    let res
    try {
      res = await (config.send ?? request)('POST', `${config.url.replace(/\/+$/, '')}/entries`, {
        headers: { authorization: `Bearer ${token}` }, body: row.payload, timeoutMs: config.timeoutMs ?? 2_000,
      })
    } catch { break }
    if (res.status !== 200) break
    try {
      if (JSON.parse(res.text).id !== row.id) break
    } catch { break }
    delivered(row)
    count++
  }
  return count
}

export function startMemoryFlush(config: () => FlushConfig): () => void {
  let closed = false
  let active = false
  let delay = 100
  let timer: ReturnType<typeof setTimeout>
  const tick = async () => {
    if (closed || active) return
    active = true
    try {
      const before = pending().length
      const count = await flushPending(config())
      delay = before && count === 0 ? Math.min(delay * 2, 30_000) : 100
    } finally {
      active = false
      if (!closed) timer = setTimeout(tick, delay)
    }
  }
  timer = setTimeout(tick, 0)
  return () => { closed = true; clearTimeout(timer) }
}
