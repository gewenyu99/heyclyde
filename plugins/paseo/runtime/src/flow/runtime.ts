/** clyde-flow's runtime: runs as JSON files, one driver per live run, asks, memory writes, and resume after a restart. */
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { lastJsonBlock } from '../backends/spawn.ts'
import { harnessRoot, clydeHome, repoRoot } from '../config.ts'
import type { DaemonCtx } from '../daemon.ts'
import { workerEnv } from '../env.ts'
import { HttpError } from '../http.ts'
import { runtimeMemory, type Memory } from '../memory.ts'
import { paseo } from '../paseo.ts'
import { carbonAuditor, preferences, profiles, select, inferRouting, usage, validateRouting, type Routing, type Model, type Stage } from '../routing.ts'
import { ladder } from '../roles.ts'
import { readJson,readJsonDir, writeJson } from '../store.ts'
import type { Rung, Thread } from '../types.ts'
import { createWorktree } from '../worktree.ts'
import { gate } from './gate.ts'
import { answerEntry, entry, parsePlan, planEntry, projectEntry, refused, type Plan } from './memory.ts'
import { firstLine } from './prompts.ts'
import { sh } from './shell.ts'
import { runStage } from './stage.ts'
import type { AgentResult, AskKind, AskRecord, FlowCtx, FlowModule, Run, RunStatus } from './types.ts'

export type { Run } from './types.ts'

/** The user stopped the run, by clyde flow stop or by answering stop. */
export class Stopped extends Error {}
/** The daemon is closing. The run keeps its state and resumes on the next start. */
export class Shutdown extends Error {}

type Live = { abort: AbortController; done: Promise<void>; reason?: 'stop' | 'shutdown'; answered?: () => void }

const TERMINAL: RunStatus[] = ['done', 'failed', 'stopped']
const LOG_KEEP = 200

let active: Runs | null = null

/** Starts a run on this process's daemon. The routes and clyde flow go through Runs directly. */
export async function startRun(flow: string, input: unknown): Promise<Run> {
  if (!active) throw new Error('no clyde daemon runs in this process')
  return active.start(flow, input)
}

export function flowsDir(): string {
  return join(harnessRoot(), 'flows')
}

export function flowNames(): string[] {
  try {
    return readdirSync(flowsDir()).filter((n) => n.endsWith('.ts')).map((n) => n.slice(0, -3)).sort()
  } catch {
    return []
  }
}

export async function loadFlow(name: string): Promise<FlowModule> {
  const path = join(flowsDir(), `${name}.ts`)
  if (!/^[a-z][a-z0-9-]*$/.test(name) || !existsSync(path)) {
    throw new HttpError(400, `no flow ${name}. Flows: ${flowNames().join(', ') || 'none'}`)
  }
  const mod = await import(pathToFileURL(path).href)
  if (typeof mod.run !== 'function' || !mod.meta) throw new HttpError(400, `flow ${name} exports no meta and run(ctx, input)`)
  return mod as FlowModule
}


export class Runs {
  ctx: DaemonCtx
  dir: string
  runs = new Map<string, Run>()
  live = new Map<string, Live>()
  closing = false

  constructor(ctx: DaemonCtx) {
    this.ctx = ctx
    this.dir = join(clydeHome(), 'runs')
    for (const r of readJsonDir<Run>(this.dir)) if (r?.id) this.runs.set(r.id, r)
    active = this
  }

  /** track names a work list, like pointman, that gets an item linked to the run. */
  async start(flowName: string, input: unknown, cwd?: string, track?: string, parentThreadId?: string, assignment?: string,paseoParentId?:string): Promise<Run> {
    if (this.closing) throw new HttpError(503, 'the daemon is closing')
    const flow = await loadFlow(flowName)
    try {
      flow.validate?.(input)
      validateRouting((input as { routing?: Routing })?.routing)
    } catch (err) {
      throw new HttpError(400, `bad input for flow ${flowName}: ${(err as Error).message}`)
    }
    const fromInput = (input as { cwd?: unknown })?.cwd
    const repoDir = typeof fromInput === 'string' && fromInput ? fromInput : cwd || process.cwd()
    if (assignment && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(assignment)) throw new HttpError(400, 'Invalid assignment UUID')
    const id = assignment ? 'r-' + assignment : this.newId()
    const existing = this.runs.get(id)
    if (existing) return this.view(existing)
    let wt
    try {
      wt = createWorktree(repoDir, id, titleOf(input, flowName), !parentThreadId && !paseoParentId)
    } catch (err) {
      throw new HttpError(400, `can't cut a worktree from ${repoDir}: ${firstLine((err as Error).message)}`)
    }
    const at = now()
    const run: Run = {
      id, flow: flowName, title: titleOf(input, flowName), status: 'running', input, cwd: wt.path, repo: wt.repo, branch: wt.branch,
      base: wt.base, stages: [], answers: [], asks: [], entries: [], plans: [], agents: {}, log: [], firstEvent: 0, createdAt: at, updatedAt: at,
      ...((flowName === 'ship' || flowName === 'task') && ((input as { routing?: Routing }).routing || !existsSync(join(clydeHome(), 'roles.json'))) ? { routes: {} } : {}),
      ...(paseoParentId ? {paseoParentId} : {}),
      ...(parentThreadId ? { parentThreadId } : {}),
    }
    this.runs.set(id, run)
    run.firstEvent = this.emit(run, 'run.started', `Started run ${id} (${flowName}) "${run.title}" on branch ${run.branch}.`, { flow: flowName, branch: run.branch }).id
    this.save(run)
    if (track) this.ctx.threads.lists.add(track, [`Run ${id} (${flowName}): ${run.title}`], { runId: id })
    this.drive(run, flow)
    return this.view(run)
  }

  list(): Run[] {
    return [...this.runs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((r) => this.view(r))
  }

  /** Answers the open question. With no driver waiting yet, as just after a restart, the driver finds it when it replays. */
  answer(id: string, text: string, via = 'user', allowAntigravityFullAccess = false): Run {
    const run = this.need(id)
    const open = [...run.asks].reverse().find((a) => a.answer === undefined)
    if (run.status !== 'asking' || !open) throw new HttpError(409, `run ${id} isn't asking anything`)
    if(open.kind==='provider' && open.question.includes('allow Antigravity full access for this run') && (allowAntigravityFullAccess || /^allow full access(?: for this run)?$/i.test(text.trim())))run.allowAntigravityFullAccess=true
    Object.assign(open, { answer: text, via, answeredAt: now() })
    run.answers.push(text)
    run.status = 'running'
    delete run.question
    this.save(run)
    this.live.get(id)?.answered?.()
    return this.view(run)
  }

  archive(id:string):Run {
    const run=this.need(id)
    if(!run.archivedAt){
      this.stop(id)
      run.archivedAt=now()
      this.save(run)
      this.emit(run,'run.archived','Removed task from the board')
    }
    return this.view(run)
  }

  stop(id: string): Run {
    const run = this.need(id)
    if (TERMINAL.includes(run.status)) return this.view(run)
    const live = this.live.get(id)
    if (live) {
      live.reason = 'stop'
      // Aborting stops the run's thread first, so thread.stopped lands before run.stopped.
      live.abort.abort()
    }
    this.finish(run, 'stopped', 'stopped by the user')
    return this.view(run)
  }

  /** After a restart: every run that was running or asking replays its flow. Passed stages and answered asks come back from the record. */
  resume(): void {
    for (const run of this.runs.values()) {
      if (run.status !== 'running' && run.status !== 'asking') continue
      // Recovery may have restarted a worker that was only queued. The stage reruns, so that worker must not run beside it.
      for (const t of this.ctx.threads.list()) {
        if (t.runId === run.id && (t.status === 'running' || t.status === 'queued')) this.ctx.threads.stop(t.id)
      }
      // A memory ask needs no answer after a restart, since the run tries memory again on its own.
      const open = run.asks.find((a) => a.answer === undefined)
      if (open?.kind === 'memory') {
        Object.assign(open, { answer: 'retry', via: 'resume', answeredAt: now() })
        run.status = 'running'
        delete run.question
      }
      // A native worker can survive an abrupt companion exit. Cancel that exact owned turn
      // before replaying its stage, or a second worker could mutate the same worktree.
      const reconcile=async()=>{
        const native=this.ctx.threads.list().filter(t=>t.runId===run.id && t.paseoAgentId && t.turns.at(-1)?.error==='daemon restarted')
        for(const t of native){
          const id=t.paseoAgentId!
          const state=await paseo(['inspect',id],5000)
          if(state.code!==0){
            if(/not found|no (such )?agent/i.test(state.stderr+' '+JSON.stringify(state.json)))continue
            throw Error('Cannot check prior Paseo worker '+id)
          }
          if(['running','initializing'].includes(state.json?.Status)||state.json?.PendingPermissions?.length){
            const stop=await paseo(['stop',id],10000)
            if(stop.code!==0)throw Error('Cannot stop prior Paseo worker '+id)
            const checked=await paseo(['inspect',id],5000)
            if(checked.code!==0||['running','initializing'].includes(checked.json?.Status))throw Error('Prior Paseo worker is still active: '+id)
          }
        }
        this.log(run,'Resumed after a daemon restart.')
        const flow=await loadFlow(run.flow)
        if(!this.closing && !TERMINAL.includes(run.status))this.drive(run,flow)
      }
      void reconcile().catch(err=>this.finish(run,'failed','Could not safely resume: '+String(err)))

    }
  }

  /** Stops every driver without touching run state, so each run resumes on the next start. */
  async shutdown(): Promise<void> {
    this.closing = true
    for (const live of this.live.values()) {
      live.reason ??= 'shutdown'
      live.abort.abort()
    }
    await Promise.all([...this.live.values()].map((l) => l.done))
  }

  memory(): Memory | null {
    return this.ctx.memory ?? runtimeMemory()
  }

  /** Store an approved plan locally before returning its stable entry id. */
  async setPlan(id: string, value: unknown): Promise<{ entry: string; plan: Plan }> {
    const run = this.need(id)
    const plan = parsePlan(value)
    if (!plan) throw new HttpError(400, 'a plan is {intent, slices: [{id, title, acceptance: [cmd]}]} with at least one slice')
    const memory = this.memory()
    if (!memory) throw new HttpError(503, 'MEMORY_URL is not set, so the plan has nowhere to go')
    let entryId: string
    try {
      entryId = (await memory.remember(planEntry(run, plan, run.planEntry))).id
    } catch (err) {
      throw new HttpError(refused(err) ? 400 : 502, (err as Error).message)
    }
    Object.assign(run, { plan, planEntry: entryId })
    run.plans.push({ entry: entryId, plan })
    if (!run.entries.includes(entryId)) run.entries.push(entryId)
    this.save(run)
    return { entry: entryId, plan }
  }

  // ---------------------------------------------------------------- the driver
  drive(run: Run, flow: FlowModule): void {
    if (this.closing) return
    const live: Live = { abort: new AbortController(), done: Promise.resolve() }
    this.live.set(run.id, live)
    live.done = this.execute(new Driver(this, run, live), flow).finally(() => {
      if (this.live.get(run.id) === live) this.live.delete(run.id)
    })
  }

  async execute(d: Driver, flow: FlowModule): Promise<void> {
    try {
      await d.ensureProject()
      await flow.run(d.flowCtx(), d.run.input)
      this.finish(d.run, 'done')
    } catch (err) {
      // A closing daemon leaves the run as it was, so the next start resumes it.
      if (err instanceof Shutdown || d.live.reason === 'shutdown' || this.closing) return
      if (err instanceof Stopped || d.live.reason === 'stop') return this.finish(d.run, 'stopped', (err as Error).message)
      this.finish(d.run, 'failed', (err as Error).message)
    }
  }

  finish(run: Run, status: 'done' | 'failed' | 'stopped', why?: string): void {
    if (TERMINAL.includes(run.status)) return
    run.status = status
    run.endedAt = now()
    delete run.question
    if (why && status !== 'done') run.error = why
    this.save(run)
    if (status === 'done') {
      this.emit(run, 'run.done', `Run ${run.id} (${run.flow}) is done on branch ${run.branch}.`, { branch: run.branch })
      this.ctx.threads.lists.settle({ runId: run.id }, 'done', `Run ${run.id} is done on branch ${run.branch}.`)
    } else {
      this.emit(run, `run.${status}`, `Run ${run.id} (${run.flow}) ${status === 'failed' ? 'failed' : 'stopped'}: ${firstLine(why ?? '')}`, { error: why })
      this.ctx.threads.lists.settle({ runId: run.id }, 'blocked', `The run ${status === 'failed' ? 'failed' : 'stopped'}: ${firstLine(why ?? '') || status}`)
    }
  }

  // ---------------------------------------------------------------- plumbing
  need(id: string): Run {
    const run = this.runs.get(id)
    if (!run) throw new HttpError(404, `no run ${id}`)
    return run
  }

  steer(id: string, note: string) {
    const run = this.need(id)
    if (TERMINAL.includes(run.status)) throw new HttpError(409, 'Run has finished')
    const override = /^\/route\s+(planner|worker|specReview|audit|verify)\s+(\S+)\s*$/.exec(note)
    if (override) {
      if (!run.routes) throw new HttpError(409,'This run uses legacy role ladders')
      const stage = override[1] as Stage
      const model = override[2] as Model
      const input = run.input as {routing?:Routing}
      const routing = {...input.routing, overrides:{...input.routing?.overrides,[stage]:model}}
      try { validateRouting(routing) } catch (err) { throw new HttpError(400,String(err)) }
      input.routing = routing
      run.routes[stage] = {model, pinned:true, reason:'Requested during this run'}
      this.save(run)
      this.emit(run, 'run.routed', 'Pinned ' + model + ' for ' + stage)
      return this.view(run)
    }
    if (run.status === 'asking') return this.answer(id, note, 'paseo')
    run.steering ??= []
    run.steering.push(note)
    this.save(run)
    const active = this.ctx.threads.list().find(t => t.runId === id && !t.readOnly && t.status === 'running')
    if (active) this.ctx.threads.send(active.id, note)
    this.emit(run, 'run.steered', 'User updated the run instructions')
    return this.view(run)
  }

  newId(): string {
    let id: string
    do id = `r-${randomBytes(4).toString('hex')}`
    while (this.runs.has(id) || existsSync(join(clydeHome(), 'worktrees', id)))
    return id
  }

  save(run: Run): void {
    run.updatedAt = now()
    writeJson(join(this.dir, `${run.id}.json`), run)
  }

  view(run: Run): Run {
    const copy=structuredClone(run)
    const notes=readJsonDir<{id:string;title:string;sources:string[]}>(join(clydeHome(),'note-receipts',run.id)).filter(n=>n.id && Array.isArray(n.sources)).map(({id,title,sources})=>({id,title,sources}))
    if(notes.length)copy.verifiedNotes=notes
    return copy
  }

  emit(run: Run, type: string, summary: string, data?: unknown) {
    return this.ctx.events.append({ type, runId: run.id, summary, ...(data === undefined ? {} : { data }) })
  }

  log(run: Run, line: string): void {
    run.log.push(`${now()} ${line}`)
    if (run.log.length > LOG_KEEP) run.log.splice(0, run.log.length - LOG_KEEP)
    this.save(run)
  }
}

/** One execution of a run's flow. A resumed run gets a fresh Driver that replays from the record. */
export class Driver {
  runs: Runs
  run: Run
  live: Live
  asked = 0

  constructor(runs: Runs, run: Run, live: Live) {
    this.runs = runs
    this.run = run
    this.live = live
  }

  get threads() {
    return this.runs.ctx.threads
  }

  get signal(): AbortSignal {
    return this.live.abort.signal
  }

  flowCtx(): FlowCtx {
    const run = this.run
    return {
      run, cwd: run.cwd, scope: `run:${run.id}`,
      stage: (spec) => runStage(this, spec),
      agent: (opts) => this.agent(opts),
      check: (cmd) => this.check(cmd),
      ask: (question) => this.ask(`ask:${++this.asked}`, 'approve', question),
      remember: (fields) => this.remember(entry(run, fields as Record<string, unknown>)),
      setPlan: (plan) => this.setPlan(plan),
      gate: (skill, section) => gate(skill, section),
      persist: () => this.save(),
      log: (line) => this.runs.log(run, line),
    }
  }

  stopped(why: string): Error {
    return new Stopped(why)
  }

  halt(): Error {
    return this.live.reason === 'stop' ? new Stopped('stopped by the user') : new Shutdown('the daemon is closing')
  }

  guard(): void {
    if (this.signal.aborted || this.runs.closing) throw this.halt()
  }

  /** Waits for p unless the run stops or the daemon closes first. */
  race<T>(p: Promise<T>): Promise<T> {
    this.guard()
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(this.halt())
      this.signal.addEventListener('abort', onAbort, { once: true })
      p.finally(() => this.signal.removeEventListener('abort', onAbort)).then(resolve, reject)
    })
  }

  log(line: string): void {
    this.runs.log(this.run, line)
  }

  save(): void {
    this.runs.save(this.run)
  }

  emit(type: string, summary: string, data?: unknown): void {
    this.runs.emit(this.run, type, summary, data)
  }

  startThread(opts: { title: string; prompt: string; rung: Rung; stage?: string; readOnly?: boolean; schema?: object; list?: string[]; mirrorTitle?: string }): Thread {
    this.guard()
    const steering = this.run.steering?.join('\n')
    const prompt = steering ? opts.prompt + '\nUser steering for this run:\n' + steering : opts.prompt
    const origin=this.run.paseoParentId ?? readJson<Record<string,{agent:string}>>(join(clydeHome(),'chat-runs.json'))?.[this.run.id]?.agent
    return this.threads.start({ ...opts, prompt, paseoParentId:origin, cwd: this.run.cwd, runId: this.run.id })
  }

  /** Waits for a thread to go idle. A stop stops the thread too. A shutdown leaves it to the daemon. */
  waitThread(id: string): Promise<Thread> {
    this.guard()
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (this.live.reason === 'stop') {
          try {
            this.threads.stop(id)
          } catch {
            // Already gone.
          }
        }
        reject(this.halt())
      }
      this.signal.addEventListener('abort', onAbort, { once: true })
      this.threads.waitIdle(id).then((t) => {
        this.signal.removeEventListener('abort', onAbort)
        if (this.signal.aborted || this.runs.closing) reject(this.halt())
        else resolve(t)
      })
    })
  }

  async check(cmd: string): Promise<{ code: number; output: string }> {
    this.guard()
    const env = workerEnv({ CLYDE_HOME: clydeHome(), CLYDE_RUN_ID: this.run.id, CLYDE_MEMORY_SCOPE: `run:${this.run.id}`, CLAUDE_PLUGIN_ROOT: repoRoot(), CLYDE_THREAD_ID: undefined })
    const r = await sh(cmd, this.run.cwd, { env, signal: this.signal })
    this.guard()
    return { code: r.code, output: r.output }
  }

  async route(stage: Stage) {
    const routes = this.run.routes!
    if (!routes[stage]) {
      const input = this.run.input as { routing?: Routing; prompt?: string; intent?: string }
      const policy = {...inferRouting(input.prompt ?? input.intent ?? ''), ...input.routing}
      for (;;) {
        try {
          const reports = stage === 'worker' && !policy.overrides?.worker && policy.complexity !== 'complex' ? await usage() : []
          const selection = stage === 'audit' && !policy.overrides?.audit
            ? carbonAuditor((await paseo(['provider','models','antigravity'],5000)).json)
            : select(stage, policy, preferences(this.run.repo), reports)
          routes[stage] ??= selection
          this.save()
          break
        } catch (err) {
          const answer = await this.ask('quota:' + this.run.asks.length, 'limit', String(err) + '. Reply to retry, or stop.')
          if (/^stop\b/i.test(answer.trim())) throw this.stopped(String(err))
          if (routes[stage]) break
        }
      }
    }
    return profiles[routes[stage]!.model]
  }

  async agent(opts: { route?: Stage; role: string; prompt: string; readOnly?: boolean; title: string }): Promise<AgentResult> {
    const cached = this.run.agents[opts.title]
    if (cached) return cached
    const t = this.startThread({ title: `${this.run.id} ${opts.title}`, prompt: opts.prompt, rung: opts.route && this.run.routes ? await this.route(opts.route) : ladder(opts.role)[0], readOnly: opts.readOnly })
    const turn = (await this.waitThread(t.id)).turns.at(-1)
    const parsed = turn?.json ?? lastJsonBlock(turn?.text ?? '')
    const invalidAudit = opts.route === 'audit' && !Array.isArray((parsed as {findings?:unknown})?.findings)
    if ((!turn?.ok || invalidAudit) && opts.route && this.run.routes) {
      const why = turn?.error || (invalidAudit ? 'The audit did not return findings' : 'No response')
      const auditor = this.run.routes.audit
      if (opts.route === 'audit' && auditor?.model === 'orchestrator' && !auditor.pinned) {
        this.run.routes.audit = { model:'carbon', pinned:false, reason:'Carbon Orchestrator could not finish this audit; retrying with Carbon High' }
        this.save()
        return this.agent(opts)
      }
      const answer = await this.ask('retry:' + opts.title + ':' + t.id, 'limit', opts.title + ' could not finish: ' + why + '. Reply to retry or stop.')
      if (/^stop\b/i.test(answer.trim())) throw this.stopped(why)
      return this.agent(opts)
    }
    const text = turn?.text ?? ''
    const out: AgentResult = { ok: turn?.ok === true, text, json: turn?.json ?? lastJsonBlock(text) }
    if (out.ok) {
      this.run.agents[opts.title] = out
      this.save()
    }
    return out
  }

  /**
   * One question for the user. An ask the run already answered, before a restart or while the driver was replaying, returns
   * that answer. Every answer but a memory one lands in memory as approved, as a quote.
   */
  async ask(key: string, kind: AskKind, question: string): Promise<string> {
    this.guard()
    const run = this.run
    let rec = run.asks.find((a) => a.key === key)
    if (!rec) {
      rec = { key, kind, question, askedAt: now() }
      run.asks.push(rec)
    }
    if (rec.answer === undefined) {
      rec.question = question
      run.status = 'asking'
      run.question = question
      this.save()
      this.emit('run.ask', `Run ${run.id} asks: ${firstLine(question)}`, { question, kind, key })
      await this.waitAnswer(rec)
    }
    if (kind !== 'memory' && !rec.entry) {
      rec.entry = await this.remember(answerEntry(run, rec))
      this.save()
    }
    return rec.answer as string
  }

  waitAnswer(rec: AskRecord): Promise<void> {
    return this.race(new Promise<void>((resolve) => {
      const check = () => {
        if (rec.answer === undefined) return
        this.live.answered = undefined
        resolve()
      }
      this.live.answered = check
      check()
    }))
  }

  /** A runtime write is durable once it reaches the local spool. */
  async remember(payload: Record<string, unknown>): Promise<string> {
    const service = this.runs.memory()
    if (!service) throw new Error('memory spool unavailable')
    const result = await this.race(service.remember(payload))
    if (!this.run.entries.includes(result.id)) this.run.entries.push(result.id)
    this.save()
    return result.id
  }

  async ensureProject(): Promise<void> {
    if (this.run.project) return
    this.run.project = await this.remember(projectEntry(this.run))
    this.save()
  }

  /** Records the plan in memory as approved, with the plan as a blob, superseding the last plan. */
  async setPlan(value: unknown): Promise<string> {
    const plan = parsePlan(value)
    if (!plan) throw new Error('a plan is {intent, slices: [{id, title, acceptance: [cmd]}]} with at least one slice')
    const run = this.run
    // A replay passes every earlier plan again. Each went to memory once, so it comes back from the record.
    const known = run.plans.find((p) => JSON.stringify(p.plan) === JSON.stringify(plan))
    const id = known?.entry ?? (await this.remember(planEntry(run, plan, run.planEntry)))
    if (!known) run.plans.push({ entry: id, plan })
    Object.assign(run, { plan, planEntry: id })
    this.save()
    return id
  }
}

function titleOf(input: unknown, flow: string): string {
  const i = input as Record<string, unknown>
  const text = [i?.title, i?.intent, i?.prompt].find((v) => typeof v === 'string' && v.trim()) as string | undefined
  const line = text ? firstLine(text) : flow
  return line.length > 80 ? `${line.slice(0, 77)}...` : line
}

function now(): string {
  return new Date().toISOString()
}
