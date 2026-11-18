/** Mounts every route: health, the event stream, threads, runs, memory and work lists. */
import { VERSION } from '../config.ts'
import type { DaemonCtx } from '../daemon.ts'
import type { Req, Route } from '../http.ts'
import type { ClydeEvent } from '../types.ts'
import { memoryRoutes } from './memory.ts'
import { listRoutes } from './lists.ts'
import { runRoutes } from './runs.ts'
import { threadRoutes } from './threads.ts'

const HEARTBEAT_MS = 15_000

export function routes(ctx: DaemonCtx): Route[] {
  return [
    {
      method: 'GET', path: '/health', public: true,
      handle: () => ({ body: { ok: true, version: VERSION, pid: process.pid, threads: ctx.threads.threads.size, runs: ctx.runCount() } }),
    },
    { method: 'GET', path: '/events', handle: (req) => streamEvents(ctx, req) },
    ...threadRoutes(ctx),
    ...runRoutes(ctx),
    ...memoryRoutes(ctx),
    ...listRoutes(ctx),
  ]
}

/** SSE: replay everything after `since` (or Last-Event-ID), then stream live events, with a heartbeat comment. */
function streamEvents(ctx: DaemonCtx, req: Req): void {
  const since = Number(req.query.get('since') ?? req.raw.headers['last-event-id'] ?? 0) || 0
  const res = req.res
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  res.write(': clyde events\n\n')
  const write = (e: ClydeEvent) => res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`)
  // Replay and subscribe in the same tick, so no event falls between them.
  for (const e of ctx.events.since(since)) write(e)
  const unsubscribe = ctx.events.subscribe(write)
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS)
  const stop = () => {
    clearInterval(heartbeat)
    unsubscribe()
  }
  req.raw.on('close', stop)
  res.on('close', stop)
}
