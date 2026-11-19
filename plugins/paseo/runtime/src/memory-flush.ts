/** Drain durable entries in dependency order; isolate role failures and quarantine permanent rejections. */
import { delivered, pending, quarantine, validateAgentPayload, type Pending } from './memory-spool.ts'
import { request } from './request.ts'

export type FlushConfig = { url?: string; runtimeToken?: string; agentToken?: string; timeoutMs?: number; dir?: string; send?: typeof request }

const PERMANENT = new Set([400, 403, 404, 413, 415, 422])
const ROLE_BLOCKED = new Set([401, 402])

export async function flushPending(config: FlushConfig): Promise<number> {
  if (!config.url) return 0
  let count = 0
  const blockedRoles = new Set<Pending['role']>()
  const blockedIds = new Set<string>()
  for (const row of pending(config.dir)) {
    if (blockedRoles.has(row.role)) {
      blockedIds.add(row.id)
      continue
    }
    const deps = [row.payload.project, ...(Array.isArray(row.payload.supersedes) ? row.payload.supersedes : [])].filter(Boolean)
    if (deps.some((id) => blockedIds.has(id))) {
      blockedIds.add(row.id)
      continue
    }
    if (row.role === 'agent') {
      try { validateAgentPayload(row.payload) } catch (err) {
        quarantine(row, err instanceof Error ? err.message : String(err), config.dir)
        continue
      }
    }
    const token = row.role === 'agent' ? config.agentToken : config.runtimeToken
    if (!token) {
      blockedRoles.add(row.role)
      blockedIds.add(row.id)
      continue
    }
    let res
    try {
      res = await (config.send ?? request)('POST', `${config.url.replace(/\/+$/, '')}/entries`, {
        headers: { authorization: `Bearer ${token}` }, body: row.payload, timeoutMs: config.timeoutMs ?? 2_000,
      })
    } catch { break }
    if (res.status === 200) {
      try {
        if (JSON.parse(res.text).id === row.id) {
          delivered(row, config.dir)
          count++
          continue
        }
      } catch { /* fall through to transient stop */ }
      blockedIds.add(row.id)
      break
    }
    if (PERMANENT.has(res.status)) {
      quarantine(row, `HTTP ${res.status}: ${String(res.text ?? '').slice(0, 300)}`, config.dir)
      continue
    }
    if (ROLE_BLOCKED.has(res.status)) {
      blockedRoles.add(row.role)
      blockedIds.add(row.id)
      continue
    }
    blockedIds.add(row.id)
    break
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
