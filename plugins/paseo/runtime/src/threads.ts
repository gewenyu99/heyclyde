/** Threads: one in-flight turn each, a queue per thread, a global cap on running turns, and a JSON file per thread. */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { backend as backendByName } from './backends/index.ts'
import { lastJsonBlock } from './backends/spawn.ts'
import type { Backend, TurnInput, TurnOutput } from './backends/types.ts'
import { clydeBin, clydeHome, maxTurns, repoRoot } from './config.ts'
import { workerEnv } from './env.ts'
import type { EventLog } from './events.ts'
import { HttpError } from './http.ts'
import { workListEntry } from './flow/memory.ts'
import { parseResult } from './flow/verdict.ts'
import { runtimeMemory, type Memory } from './memory.ts'
import { runPaseoTurn } from './paseo-turn.ts'
import { mirrorName } from './mirror.ts'
import { editBlock, editsFiles, formatList, Lists, nudgePrompt, open, resultBlock, stopBlock } from './lists.ts'
import { readJson, readJsonDir, writeJson } from './store.ts'
import type { Rung, Thread, Turn } from './types.ts'
import { createWorktree } from './worktree.ts'

export type StartOptions = {
  title: string; prompt: string; cwd: string; rung: Rung; worktree?: boolean; readOnly?: boolean
  runId?: string; stage?: string; schema?: object; systemAppend?: string
  mirrorTitle?: string; parentThreadId?: string
  // list seeds the thread's work list. track names a list, like pointman, that gets an item linked to this thread.
  list?: string[]; track?: string
}

export type ThreadsOptions = {
  events: EventLog; memory?: Memory | null; maxTurns?: number; backend?: (name: string) => Backend; lists?: Lists
}

// Follow-up turns in a row for open items, and Stop hook refusals per turn. Both stop there, so a stuck model can end.
export const MAX_NUDGES = 3
export const MAX_STOP_BLOCKS = 3

export class NotFound extends HttpError {
  constructor(message: string) {
    super(404, message)
  }
}

const EXCERPT = 4000

export class Threads {
  events: EventLog
  memory: Memory | null
  dir: string
  cap: number
  backend: (name: string) => Backend
  threads = new Map<string, Thread>()
  live = new Map<string, { abort: AbortController; done: Promise<void> }>()
  waiting: string[] = []
  waiters = new Map<string, ((t: Thread) => void)[]>()
  lists: Lists
  // One memory write at a time per run, so each work list version supersedes the one before it and the record keeps both.
  handoffs = new Map<string, Promise<void>>()
  mirrorImports = new Map<string, Promise<void>>()
  closing = false

  constructor(opts: ThreadsOptions) {
    this.events = opts.events
    this.memory = opts.memory ?? null
    this.dir = join(clydeHome(), 'threads')
    this.cap = opts.maxTurns ?? maxTurns()
    this.backend = opts.backend ?? backendByName
    for (const t of readJsonDir<Thread>(this.dir)) if (t?.id) this.threads.set(t.id, t)
    this.lists = opts.lists ?? new Lists(this.events, (id) => this.threads.get(id)?.runId)
  }

  /** After a restart: a turn that was in flight is lost, so its thread fails and keeps its session for a later send. */
  recover(): void {
    for (const t of this.threads.values()) {
      const open = t.turns.at(-1)
      if (open && !open.endedAt && t.status === 'stopped') {
        Object.assign(open, { endedAt: now(), ok: false, error: 'stopped' })
        this.save(t)
      } else if (open && !open.endedAt) {
        Object.assign(open, { endedAt: now(), ok: false, error: 'daemon restarted' })
        t.status = 'failed'
        this.save(t)
        this.emit('thread.failed', t, `Thread ${t.id} "${t.title}" failed: daemon restarted.`, { turn: open.n, error: 'daemon restarted' })
      } else if (t.status === 'running' || t.status === 'queued') {
        this.pump(t)
      }
    }
  }

  start(opts: StartOptions): Thread {
    if (opts.rung?.model?.toLowerCase().includes('fable') && !opts.readOnly) throw new HttpError(400,'Fable can only run a read-only review')
    this.backend(opts.rung?.backend)
    const id = this.newId()
    const at = now()
    const t: Thread = {
      id, title: opts.title || opts.prompt.trim().split('\n')[0].slice(0, 60), rung: opts.rung, cwd: opts.cwd, status: 'queued',
      queue: [opts.prompt], turns: [], createdAt: at, updatedAt: at,
    }
    for (const k of ['runId', 'stage', 'readOnly', 'schema', 'systemAppend', 'mirrorTitle', 'parentThreadId'] as const) {
      if (opts[k] !== undefined) (t as any)[k] = opts[k]
    }
    if (opts.worktree) {
      const wt = createWorktree(opts.cwd, id, t.title, !opts.runId && !opts.stage && !opts.parentThreadId && !opts.readOnly)
      Object.assign(t, { cwd: wt.path, worktree: wt.path, branch: wt.branch, base: wt.base })
    }
    this.threads.set(id, t)
    this.save(t)
    this.emit('thread.started', t, `Started thread ${id} "${t.title}" on ${rungLabel(t.rung)}.`, { rung: t.rung, cwd: t.cwd })
    // Seeded before the first turn, since that turn's prompt starts with the list.
    if (opts.list?.length) this.lists.add(`thread:${id}`, opts.list)
    if (opts.track) this.lists.add(opts.track, [`Thread ${id}: ${t.title}`], { threadId: id })
    this.pump(t)
    return this.view(t)
  }

  send(id: string, text: string): Thread {
    const t = this.need(id)
    t.queue.push(text)
    // A message from outside starts a fresh count of follow-ups.
    t.nudges = 0
    this.save(t)
    this.pump(t)
    return this.view(t)
  }

  stop(id: string): Thread {
    const t = this.need(id)
    t.queue = []
    this.waiting = this.waiting.filter((w) => w !== id)
    const wasActive = t.status === 'running' || t.status === 'queued'
    t.status = 'stopped'
    this.save(t)
    if (wasActive) {
      this.emit('thread.stopped', t, `Thread ${t.id} "${t.title}" stopped.`)
      this.lists.settle({ threadId: t.id }, 'blocked', 'The thread was stopped.')
    }
    const live = this.live.get(id)
    if (live) live.abort.abort()
    else this.release(t)
    return this.view(t)
  }

  get(id: string): Thread | undefined {
    const t = this.threads.get(id)
    return t && this.view(t)
  }

  list(): Thread[] {
    return [...this.threads.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((t) => this.view(t))
  }

  /** Resolves once the queue is empty and no turn runs. A stopped thread resolves when its process has exited. */
  waitIdle(id: string): Promise<Thread> {
    const t = this.need(id)
    if (this.idle(t)) return Promise.resolve(this.view(t))
    return new Promise((resolve) => this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]))
  }

  result(id: string): unknown {
    return this.need(id).result
  }

  /** clyde result. done is refused while list items are open, and blocked needs a blocked item. */
  setResult(id: string, value: unknown): Thread {
    const t = this.need(id)
    if (!t.readOnly) {
      const list = this.lists.get(`thread:${id}`)
      const why = resultBlock(list, (value as { status?: unknown })?.status)
      if (why) throw new HttpError(409, `${why}\n\n${formatList(list)}`)
    }
    t.result = value
    t.resultAt = now()
    this.save(t)
    return this.view(t)
  }

  progress(id: string, line: string): Thread {
    const t = this.need(id)
    t.progress = line.slice(0, 300)
    this.save(t)
    this.emit('thread.progress', t, `Thread ${t.id}: ${t.progress}`)
    return this.view(t)
  }

  /** A hook row from `clyde hook` inside a worker. It only updates what the thread is doing, since memory keeps the row. */
  hook(id: string, event: string, payload: Record<string, unknown>): Thread {
    const t = this.need(id)
    const tool = typeof payload?.tool_name === 'string' ? ` ${payload.tool_name}` : ''
    t.progress = `${event}${tool}`
    return this.view(t)
  }

  /**
   * A blocking hook's question, asked by clyde hook in Claude workers and by the extension in pi workers. Returns why the call
   * must wait, or null. PreToolUse holds file edits until an item is in progress. Stop sends the model back while items
   * are open and no result is posted, at most MAX_STOP_BLOCKS times per turn.
   */
  gate(id: string, event: string, payload: Record<string, unknown>): string | null {
    const t = this.need(id)
    if (t.readOnly) return null
    const list = this.lists.get(`thread:${id}`)
    if (event === 'PreToolUse') {
      return editsFiles(payload?.tool_name, payload?.tool_input) ? editBlock(list, String(payload.tool_name)) : null
    }
    if (event !== 'Stop' || !open(list).length || this.reported(t) || hasResult(payload?.last_assistant_message)) return null
    if ((t.stopBlocks ?? 0) >= MAX_STOP_BLOCKS) return null
    t.stopBlocks = (t.stopBlocks ?? 0) + 1
    this.save(t)
    return stopBlock(list)
  }

  /** Whether clyde result was posted during the current or last turn. */
  reported(t: Thread): boolean {
    const turn = t.turns.at(-1)
    return Boolean(turn && t.resultAt && t.resultAt >= turn.startedAt)
  }

  /** Stops every running turn and waits for the processes. Queued threads stay queued and run after the next start. */
  async shutdown(): Promise<void> {
    this.closing = true
    for (const live of this.live.values()) live.abort.abort()
    await Promise.all([...this.live.values()].map((l) => l.done))
    await Promise.all([...this.handoffs.values()])
  }

  // ---------------------------------------------------------------- the turn loop
  pump(t: Thread): void {
    if (this.closing || this.live.has(t.id)) return
    if (!t.queue.length) return this.release(t)
    if (this.live.size >= this.cap) {
      if (!this.waiting.includes(t.id)) this.waiting.push(t.id)
      if (t.status !== 'queued') {
        t.status = 'queued'
        this.save(t)
      }
      return
    }
    this.waiting = this.waiting.filter((w) => w !== t.id)
    const prompt = t.queue.shift() as string
    // The slot is taken before the turn starts, since a turn that fails at once releases it synchronously.
    const live = { abort: new AbortController(), done: Promise.resolve() }
    this.live.set(t.id, live)
    live.done = this.runTurn(t, prompt, live.abort.signal)
  }

  async runTurn(t: Thread, prompt: string, signal: AbortSignal): Promise<void> {
    const turn: Turn = { n: t.turns.length + 1, prompt, startedAt: now() }
    t.turns.push(turn)
    t.status = 'running'
    t.stopBlocks = 0
    this.save(t)
    let out: TurnOutput
    try {
      await this.mirrorImports.get(t.id)
      const agent = mirrorName(t, clydeHome()) ? readJson<Record<string, string>>(join(clydeHome(), 'paseo-threads.json'))?.[t.id] : undefined
      const run = agent && !t.readOnly ? (input: TurnInput) => runPaseoTurn(agent, input) : (input: TurnInput) => this.backend(t.rung.backend).runTurn(input)
      out = await run({
        rung: t.rung, cwd: t.cwd, session: t.session, prompt: this.withList(t, prompt), readOnly: t.readOnly, systemAppend: t.systemAppend,
        env: this.envFor(t), schema: t.schema, signal,
        onProgress: (line) => { t.progress = line },
        onSession: (session) => this.onSession(t, session),
      })
    } catch (err) {
      out = { ok: false, text: '', error: (err as Error).message }
    }
    if (this.live.get(t.id)?.abort.signal === signal) this.live.delete(t.id)
    this.finish(t, turn, out, signal.aborted)
    this.next(t)
  }

  finish(t: Thread, turn: Turn, out: TurnOutput, stopped: boolean): void {
    Object.assign(turn, { endedAt: now(), ok: out.ok, text: out.text })
    if (out.error) turn.error = out.error
    if (out.json !== undefined) turn.json = out.json
    if (out.usage !== undefined) turn.usage = out.usage
    if (out.session) t.session = out.session
    if (stopped && !this.closing) {
      // stop() already posted thread.stopped. A message sent since then still runs.
      turn.ok = false
      turn.error ??= 'stopped'
      t.status = t.queue.length ? 'queued' : 'stopped'
    } else if (this.closing) {
      turn.ok = false
      turn.error = 'daemon stopped'
      t.status = 'failed'
      // Logged so the event history never shows a thread that started and simply went quiet.
      this.emit('thread.failed', t, `Thread ${t.id} "${t.title}" failed: the daemon stopped mid-turn.`, { turn: turn.n, error: turn.error })
    } else if (out.ok && this.nudge(t, out)) {
      const n = open(this.lists.get(`thread:${t.id}`)).length
      t.status = 'queued'
      this.emit('thread.nudged', t, `Thread ${t.id} "${t.title}" stopped with ${n} open item${n === 1 ? '' : 's'}, so clyde sent it back (${t.nudges} of ${MAX_NUDGES}).`, { turn: turn.n, open: n })
    } else if (out.ok) {
      t.status = t.queue.length ? 'queued' : 'idle'
      this.emit('thread.done', t, `Thread ${t.id} "${t.title}" is done: ${doneLine(out)}`, { turn: turn.n, text: out.text.slice(0, EXCERPT) })
      const result = t.result as { summary?: unknown } | undefined
      this.lists.settle({ threadId: t.id }, 'done', this.reported(t) && typeof result?.summary === 'string' ? result.summary : doneLine(out))
    } else {
      t.status = 'failed'
      this.emit('thread.failed', t, `Thread ${t.id} "${t.title}" failed: ${firstLine(out.error ?? 'unknown error')}`, { turn: turn.n, error: out.error })
      this.lists.settle({ threadId: t.id }, 'blocked', `The thread failed: ${firstLine(out.error ?? 'unknown error')}`)
    }
    this.save(t)
    this.handoff(t)
  }

  // ---------------------------------------------------------------- work lists
  /** Every turn of a thread that has a list starts with it, so the model never works from memory. */
  withList(t: Thread, prompt: string): string {
    if (t.readOnly) return prompt
    const list = this.lists.get(`thread:${t.id}`)
    return list.items.length ? `${formatList(list)}\n\n${prompt}` : prompt
  }

  /**
   * Queues a follow-up when a turn ends with open items and no result, posted or in a fenced block. That holds every
   * backend to its list, Codex too, which has no per-process hooks. A queued message from outside goes first instead.
   */
  nudge(t: Thread, out: TurnOutput): boolean {
    if (t.readOnly || t.queue.length || (t.nudges ?? 0) >= MAX_NUDGES) return false
    const list = this.lists.get(`thread:${t.id}`)
    if (!open(list).length || this.reported(t) || hasResult(out.text)) return false
    t.nudges = (t.nudges ?? 0) + 1
    t.queue.push(nudgePrompt(list))
    return true
  }

  /**
   * A run thread's changed list goes to memory as a draft, "Work list, <stage>", superseding the stage's last version, so the
   * next stage or a resumed thread can recall it. It never reaches the judge, since it's the worker's own claim.
   */
  handoff(t: Thread): void {
    if (!t.runId || t.readOnly) return
    const list = this.lists.get(`thread:${t.id}`)
    const memory = this.memory ?? runtimeMemory()
    if (!list.items.length || !memory) return
    const runId = t.runId
    const stage = t.stage ?? t.id
    const snapshot = structuredClone(list)
    const digest = createHash('sha256').update(JSON.stringify(snapshot.items.map(({ updatedAt, ...rest }) => rest))).digest('hex')
    const key = runId
    const path = join(clydeHome(), 'lists', 'handoff', `${runId}.json`)
    const write = async () => {
      const record = readJson<Record<string, { entry: string; digest: string }>>(path) ?? {}
      const last = record[stage]
      if (last?.digest === digest) return
      try {
        const r = await memory.remember(workListEntry(runId, stage, t.id, snapshot, formatList(snapshot), last?.entry))
        record[stage] = { entry: r.id, digest }
        writeJson(path, record)
      } catch {
        // memory is down or refused it. The next turn's end tries again, since the digest didn't move.
      }
    }
    const next = (this.handoffs.get(key) ?? Promise.resolve()).then(write)
    this.handoffs.set(key, next)
    void next.finally(() => {
      if (this.handoffs.get(key) === next) this.handoffs.delete(key)
    })
  }

  /** A freed slot goes to the thread that has waited longest. A thread with more queued goes to the back. */
  next(t: Thread): void {
    if (this.closing) return this.release(t)
    if (t.queue.length && t.status !== 'stopped') {
      t.status = 'queued'
      this.save(t)
      this.waiting.push(t.id)
    } else this.release(t)
    while (this.live.size < this.cap && this.waiting.length) {
      const w = this.threads.get(this.waiting[0])
      if (!w || this.live.has(w.id) || !w.queue.length) {
        this.waiting.shift()
        if (w) this.release(w)
        continue
      }
      this.pump(w)
    }
  }

  idle(t: Thread): boolean {
    return !this.live.has(t.id) && (!t.queue.length || t.status === 'stopped')
  }

  /** Marks a drained thread idle and wakes waitIdle callers. */
  release(t: Thread): void {
    if (!this.idle(t)) return
    if (t.status === 'running' || t.status === 'queued') {
      t.status = 'idle'
      this.save(t)
    }
    const waiting = this.waiters.get(t.id) ?? []
    this.waiters.delete(t.id)
    for (const resolve of waiting) resolve(this.view(t))
  }

  onSession(t: Thread, session: string): void {
    if (t.session === session) return
    t.session = session
    this.save(t)
    // memory joins hook rows to threads by session id, so it hears about each new session once.
    void this.memory?.hook('ClydeThread', { session_id: session, thread_id: t.id, run_id: t.runId ?? null })
  }

  envFor(t: Thread): Record<string, string> {
    return workerEnv({
      CLYDE_HOME: clydeHome(), CLYDE_BIN: clydeBin(), CLYDE_THREAD_ID: t.id, CLYDE_RUN_ID: t.runId,
      CLYDE_MEMORY_SCOPE: t.runId ? `run:${t.runId}` : undefined, CLAUDE_PLUGIN_ROOT: repoRoot(),
      // The daemon may run under the point man. Its mode switches must not turn a worker into a second point man.
      CLYDE_POINT_MAN: undefined, CLYDE_DELIVERY: undefined,
    })
  }

  // ---------------------------------------------------------------- plumbing
  need(id: string): Thread {
    const t = this.threads.get(id)
    if (!t) throw new NotFound(`no thread ${id}`)
    return t
  }

  newId(): string {
    let id: string
    do id = `t-${randomBytes(4).toString('hex')}`
    while (this.threads.has(id) || existsSync(join(clydeHome(), 'worktrees', id)))
    return id
  }

  save(t: Thread): void {
    t.updatedAt = now()
    writeJson(join(this.dir, `${t.id}.json`), t)
  }

  view(t: Thread): Thread {
    return structuredClone(t)
  }

  emit(type: string, t: Thread, summary: string, data?: unknown): void {
    const e: Record<string, unknown> = { type, threadId: t.id, summary }
    if (t.runId) e.runId = t.runId
    if (data !== undefined) e.data = data
    this.events.append(e as any)
  }
}

export function rungLabel(r: Rung): string {
  return [r.backend, r.model, r.effort].filter(Boolean).join(' ')
}

/** A verdict reads as its outcome and notes, since a judge's raw JSON makes a poor summary line. */
function doneLine(out: { text: string; json?: unknown }): string {
  const j = out.json as { verdict?: unknown; notes?: unknown } | undefined
  if (j && typeof j.verdict === 'string') return firstLine(`verdict ${j.verdict}. ${typeof j.notes === 'string' ? j.notes : ''}`)
  return firstLine(out.text)
}

/** A fenced result block in the text counts as a posted result, since it's the fallback when clyde result can't run. */
function hasResult(text: unknown): boolean {
  return typeof text === 'string' && parseResult(lastJsonBlock(text)) !== null
}

function firstLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '(no text)'
  return line.length > 140 ? `${line.slice(0, 137)}...` : line
}

function now(): string {
  return new Date().toISOString()
}
