/** The /memory routes: what only the daemon can tell, since it alone holds MEMORY_RUNTIME_TOKEN. clyde doctor asks here. */
import type { DaemonCtx } from '../daemon.ts'
import type { Route } from '../http.ts'
import type { Memory } from '../memory.ts'

const PROBE_MS = 5000

export type TokenCheck = { ok: boolean; detail: string }

/** Whether memory answers and accepts the token. A made-up entry id reads as a 404 with a good token and a 401 with a bad one. */
export async function probe(memory: Memory): Promise<TokenCheck> {
  try {
    const res = await memory.call('GET', '/entries/clyde-doctor-probe', undefined, PROBE_MS)
    if (res.status === 404 || res.status === 200) return { ok: true, detail: 'accepted' }
    if (res.status === 401) return { ok: false, detail: 'refused, memory answered 401' }
    return { ok: false, detail: `memory answered ${res.status}` }
  } catch (err) {
    return { ok: false, detail: `unreachable: ${(err as Error).message}` }
  }
}

export function memoryRoutes(ctx: DaemonCtx): Route[] {
  return [
    {
      method: 'GET', path: '/memory/check',
      handle: async () => {
        if (!ctx.memory) return { body: { configured: false, ok: false, detail: 'MEMORY_URL is not set in the daemon' } }
        if (!ctx.memory.token) return { body: { configured: true, url: ctx.memory.url, ok: false, detail: 'MEMORY_RUNTIME_TOKEN is not set in the daemon' } }
        return { body: { configured: true, url: ctx.memory.url, ...(await probe(ctx.memory)) } }
      },
    },
  ]
}
