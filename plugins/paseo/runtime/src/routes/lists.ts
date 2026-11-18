/** The /lists routes: read a work list, and add, start, finish or block its items. clyde todo and the clyde_todo tool call these. */
import type { DaemonCtx } from '../daemon.ts'
import type { Route } from '../http.ts'
import { owner } from '../lists.ts'

export function listRoutes(ctx: DaemonCtx): Route[] {
  const lists = ctx.threads.lists
  /** A thread's list needs the thread, so a mistyped id is a 404 rather than a new empty list. */
  const who = (raw: string) => {
    const id = owner(raw)
    if (id.startsWith('thread:')) ctx.threads.need(id.slice('thread:'.length))
    return id
  }
  return [
    { method: 'GET', path: '/lists/:owner', handle: (req) => ({ body: lists.view(who(req.params.owner)) }) },
    { method: 'POST', path: '/lists/:owner/add', handle: (req) => ({ body: lists.add(who(req.params.owner), req.body?.items) }) },
    { method: 'POST', path: '/lists/:owner/start', handle: (req) => ({ body: lists.start(who(req.params.owner), req.body?.n, req.body?.how) }) },
    { method: 'POST', path: '/lists/:owner/done', handle: (req) => ({ body: lists.done(who(req.params.owner), req.body?.n, req.body?.evidence) }) },
    { method: 'POST', path: '/lists/:owner/block', handle: (req) => ({ body: lists.block(who(req.params.owner), req.body?.n, req.body?.why) }) },
  ]
}
