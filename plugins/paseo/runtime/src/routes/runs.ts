/** The /runs routes: start, read, answer and stop flow runs, and the run's plan for clyde plan. */
import type { DaemonCtx } from '../daemon.ts'
import { HttpError, type Route } from '../http.ts'
import { realpathSync } from 'node:fs'
import { setPreference } from '../routing.ts'
import { Runs } from '../flow/runtime.ts'
import { owner } from '../lists.ts'

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} must be a non-empty string`)
  return value
}

/** Mounted once at daemon start, after thread recovery, so resumed runs see settled threads. */
export function runRoutes(ctx: DaemonCtx): Route[] {
  const runs = new Runs(ctx)
  ctx.runCount = () => runs.runs.size
  // Runs stop before threads, so no driver reads a dying thread as a failed attempt.
  ctx.beforeClose.push(() => runs.shutdown())
  setImmediate(() => runs.resume())
  return [
    { method:'POST', path:'/routing/preferences', handle:req => {
      try { setPreference(realpathSync(text(req.body?.repo,'repo')),text(req.body?.key,'key'),text(req.body?.model,'model')) }
      catch (error) { throw new HttpError(400,String(error)) }
      return {body:{ok:true}}
    } },
    { method: 'GET', path: '/runs', handle: () => ({ body: runs.list() }) },
    {
      method: 'POST', path: '/runs',
      handle: async (req) => {
        const b = req.body ?? {}
        const cwd = typeof b.cwd === 'string' && b.cwd ? b.cwd : undefined
        return { body: await runs.start(text(b.flow, 'flow'), b.input ?? {}, cwd, b.track === undefined ? undefined : owner(b.track),
          typeof b.parentThreadId === 'string' && b.parentThreadId ? b.parentThreadId : undefined, b.assignment) }
      },
    },
    { method: 'POST', path: '/runs/:id/steer', handle: req => ({body:runs.steer(req.params.id,text(req.body?.text,'text'))}) },
    { method: 'GET', path: '/runs/:id', handle: (req) => ({ body: runs.view(runs.need(req.params.id)) }) },
    {
      method: 'POST', path: '/runs/:id/answer',
      handle: req => {
        if (req.body?.askKey && !runs.need(req.params.id).asks.some(a => a.key === req.body.askKey && a.answer === undefined)) throw new HttpError(409,'This question has already been answered')
        return {body:runs.answer(req.params.id,text(req.body?.text,'text'),typeof req.body?.via === 'string' ? req.body.via : 'user')}
      },
    },
    { method: 'POST', path: '/runs/:id/stop', handle: (req) => ({ body: runs.stop(req.params.id) }) },
    {
      method: 'GET', path: '/runs/:id/plan',
      handle: (req) => {
        const run = runs.need(req.params.id)
        return { body: { plan: run.plan ?? null, entry: run.planEntry ?? null } }
      },
    },
    { method: 'POST', path: '/runs/:id/plan', handle: async (req) => ({ body: await runs.setPlan(req.params.id, req.body?.plan) }) },
  ]
}
