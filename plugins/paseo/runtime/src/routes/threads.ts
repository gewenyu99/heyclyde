/** The /threads routes: the point man's and the CLI's view of threads, plus the calls clyde tools make from inside workers. */
import type { DaemonCtx } from '../daemon.ts'
import { HttpError, type Req, type Route } from '../http.ts'
import { owner } from '../lists.ts'
import { isRung, ladder } from '../roles.ts'
import type { Rung, Thread } from '../types.ts'

const LAST_TURNS = 5

/** GET /threads leaves turn text out, since a long thread's answers would make the list heavy. */
export function summary(t: Thread): Thread {
  return { ...t, turns: t.turns.map(({ text, json, usage, ...rest }) => rest) }
}

export function detail(t: Thread): Thread {
  return { ...t, turns: t.turns.slice(-LAST_TURNS) }
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} must be a non-empty string`)
  return value
}

function rungFor(body: any): Rung {
  if (body.rung !== undefined) {
    if (!isRung(body.rung)) throw new HttpError(400, 'rung must be {backend: pi|claude|codex, model?, effort?}')
    return body.rung
  }
  try {
    return ladder(typeof body.role === 'string' ? body.role : 'thread')[0]
  } catch (err) {
    throw new HttpError(400, (err as Error).message)
  }
}

function start(ctx: DaemonCtx, req: Req) {
  const b = req.body ?? {}
  const prompt = text(b.prompt, 'prompt')
  const opts = {
    title: typeof b.title === 'string' ? b.title : '', prompt, cwd: typeof b.cwd === 'string' && b.cwd ? b.cwd : process.cwd(),
    rung: rungFor(b), worktree: b.worktree === true, readOnly: b.readOnly === true,
    runId: optional(b.runId), stage: optional(b.stage), parentThreadId: optional(b.parentThreadId), systemAppend: optional(b.systemAppend),
    schema: b.schema && typeof b.schema === 'object' ? b.schema : undefined,
    list: seed(b.list), track: b.track === undefined ? undefined : owner(b.track),
  }
  try {
    return { body: detail(ctx.threads.start(opts)) }
  } catch (err) {
    throw err instanceof HttpError ? err : new HttpError(400, (err as Error).message)
  }
}

function seed(v: unknown): string[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.trim())) throw new HttpError(400, 'list must be a list of non-empty strings')
  return v
}

function optional(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

export function threadRoutes(ctx: DaemonCtx): Route[] {
  const t = ctx.threads
  return [
    { method: 'GET', path: '/threads', handle: () => ({ body: t.list().map(summary) }) },
    { method: 'POST', path: '/threads', handle: (req) => start(ctx, req) },
    { method: 'GET', path: '/threads/:id', handle: (req) => ({ body: detail(t.view(t.need(req.params.id))) }) },
    { method: 'POST', path: '/threads/:id/messages', handle: (req) => ({ body: detail(t.send(req.params.id, text(req.body?.text, 'text'))) }) },
    { method: 'POST', path: '/threads/:id/stop', handle: (req) => ({ body: detail(t.stop(req.params.id)) }) },
    { method: 'GET', path: '/threads/:id/result', handle: (req) => ({ body: { result: t.result(req.params.id) ?? null } }) },
    {
      method: 'POST', path: '/threads/:id/result',
      handle: (req) => {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, 'a result is a JSON object')
        t.setResult(req.params.id, req.body)
        return { body: { ok: true } }
      },
    },
    {
      method: 'POST', path: '/threads/:id/progress',
      handle: (req) => {
        t.progress(req.params.id, text(req.body?.line, 'line'))
        return { body: { ok: true } }
      },
    },
    {
      method: 'POST', path: '/threads/:id/gate',
      handle: (req) => ({ body: { block: t.gate(req.params.id, text(req.body?.event, 'event'), req.body?.payload ?? {}) } }),
    },
    {
      method: 'POST', path: '/threads/:id/hook',
      handle: (req) => {
        t.hook(req.params.id, text(req.body?.event, 'event'), req.body?.payload ?? {})
        return { body: { ok: true } }
      },
    },
  ]
}
