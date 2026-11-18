/** The clyde pi extension. CLYDE_THREAD_ID turns on worker mode, CLYDE_POINT_MAN=1 point man mode, and anything else registers nothing. */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringEnum, Type } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { runLine, threadLine } from '../src/cli/status.ts'
import { DaemonClient, DaemonError, ensureDaemon } from '../src/client.ts'
import { adoptRenamedEnv, clydeBin } from '../src/config.ts'
import { agentMemory, recallAsAgent } from '../src/memory.ts'
import { editsFiles, POINT_MAN } from '../src/lists.ts'
import type { ClydeEvent, Thread } from '../src/types.ts'

// The events that wake the point man. The rest only refresh the status line.
const WAKE = new Set(['thread.done', 'thread.failed', 'run.ask', 'run.passed', 'run.failed', 'run.done'])
const BATCH_MS = 2000
const STATUS_DEBOUNCE_MS = 250
const STATUS_TIMEOUT_MS = 3000
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000]
const BLOCK_THREADS = 12
const BLOCK_RUNS = 8
const TURN_TEXT = 4000
const HOOK_TEXT = 4000

type Ctx = ExtensionContext
type Timer = ReturnType<typeof setTimeout>

export default function clyde(pi: ExtensionAPI): void {
  adoptRenamedEnv()
  const env = process.env
  if (env.CLYDE_THREAD_ID) return worker(pi, env.CLYDE_THREAD_ID)
  if (env.CLYDE_POINT_MAN === '1') return pointMan(pi)
}

// ---------------------------------------------------------------- shared

function reply(text: string | string[]) {
  return { content: [{ type: 'text' as const, text: Array.isArray(text) ? text.join('\n') : text }], details: undefined }
}

// Concurrent callers share one start, since two daemons racing for the port make the loser's ensureDaemon throw.
let starting: Promise<DaemonClient> | null = null
function daemon(): Promise<DaemonClient> {
  starting ??= ensureDaemon().finally(() => { starting = null })
  return starting
}

/** Runs the clyde CLI, which owns the memory payload rules, and returns what it printed. */
function clydeCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [clydeBin(), ...args], { env: process.env, timeout: 30_000 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim()
      if (err) reject(new Error(out || `clyde ${args[0]} failed: ${err.message}`))
      else resolve(out || `clyde ${args[0]} printed nothing.`)
    })
  })
}

/** A temp file for CLI flags that take a file, removed after the call. */
async function withFile<T>(name: string, text: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'clyde-pi-'))
  const path = join(dir, name)
  writeFileSync(path, text)
  try {
    return await fn(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** clyde_todo: the same commands as clyde todo, on this thread's list or the point man's. Every call returns the whole list. */
function todoTool(owner: string, client: () => Promise<DaemonClient>) {
  return {
    name: 'clyde_todo', label: 'clyde todo',
    description: 'Read or change your work list, which clyde keeps. list, add items, start N with how, done N with evidence, or block N with why. Returns the whole list.',
    promptSnippet: 'Read or change your clyde work list',
    promptGuidelines: [
      'Work from your clyde_todo list. Add your steps, start one with how before you change files, and mark it done with evidence or blocked with why.',
    ],
    parameters: Type.Object({
      action: StringEnum(['list', 'add', 'start', 'done', 'block']),
      items: Type.Optional(Type.Array(Type.String(), { description: 'With add: the new items, in order' })),
      n: Type.Optional(Type.Number({ description: 'With start, done or block: the item number' })),
      how: Type.Optional(Type.String({ description: 'With start: one sentence on how you will do it' })),
      evidence: Type.Optional(Type.String({ description: 'With done: a command and its result, a path:line, or a commit sha' })),
      why: Type.Optional(Type.String({ description: 'With block: why it cannot go on' })),
    }),
    async execute(_id: string, p: { action: string; items?: string[]; n?: number; how?: string; evidence?: string; why?: string }) {
      const c = await client()
      if (p.action === 'list') return reply((await c.list(owner)).text)
      const body = p.action === 'add' ? { items: p.items } : { n: p.n, how: p.how, evidence: p.evidence, why: p.why }
      try {
        return reply((await c.todo(owner, p.action as 'add', body)).text)
      } catch (err) {
        if (!(err instanceof DaemonError)) throw err
        // The model sees the list it has to work from even when its change was refused.
        const list = await c.list(owner).then((l) => l.text, () => '')
        throw new Error([err.message, list].filter(Boolean).join('\n\n'))
      }
    },
  }
}

function recallTool() {
  return {
    name: 'clyde_recall', label: 'clyde recall',
    description: 'Search memory. Scope run:<id> boosts that run\'s notes. The scope defaults to CLYDE_MEMORY_SCOPE.',
    promptSnippet: 'Search memory, optionally in a run scope',
    promptGuidelines: ['Use clyde_recall before you redo work another stage or thread may already have written to memory.'],
    parameters: Type.Object({
      query: Type.String({ description: 'What to look for' }),
      scope: Type.Optional(Type.String({ description: 'run:<id> to search one run. Leave it out for the default.' })),
    }),
    async execute(_id: string, p: { query: string; scope?: string }) {
      return reply(await recallAsAgent(p.query, p.scope ?? process.env.CLYDE_MEMORY_SCOPE))
    },
  }
}

function rememberTool() {
  return {
    name: 'clyde_remember', label: 'clyde remember',
    description: 'Write a draft note to memory in the current run. Long evidence goes in blob.',
    promptSnippet: 'Write a draft note to memory in the current run',
    promptGuidelines: ['Record gate evidence with clyde_remember, pattern observations, so the next stage can recall it.'],
    parameters: Type.Object({
      title: Type.String(),
      pattern: StringEnum(['observations', 'decisions', 'references', 'recommendations'], { description: 'The kind of note' }),
      body: Type.Optional(Type.String({ description: 'The summary recall ranks on' })),
      blob: Type.Optional(Type.String({ description: 'Long evidence, stored as a blob' })),
      scope: Type.Optional(Type.String({ description: 'run:<id>. Defaults to the current run.' })),
    }),
    async execute(_id: string, p: { title: string; pattern: string; body?: string; blob?: string; scope?: string }) {
      // --flag=value keeps a value that starts with - from reading as a flag.
      const args = ['remember', `--title=${p.title}`, `--pattern=${p.pattern}`]
      if (p.body) args.push(`--body=${p.body}`)
      if (p.scope) args.push(`--scope=${p.scope}`)
      if (p.blob === undefined) return reply(await clydeCli(args))
      return reply(await withFile('evidence.md', p.blob, (path) => clydeCli([...args, `--blob-file=${path}`])))
    },
  }
}

// ---------------------------------------------------------------- hooks

const HOOKS = {
  session_start: 'SessionStart', input: 'UserPromptSubmit', tool_result: 'PostToolUse',
  agent_settled: 'Stop', session_before_compact: 'PreCompact', session_shutdown: 'SessionEnd',
} as const

type Send = (event: string, payload: Record<string, unknown>) => void

/** Forwards pi's session events under Claude Code's hook names, so memory logs a pi session like a Claude one. */
function forwardHooks(pi: ExtensionAPI, send: Send): void {
  pi.on('session_start', (e, ctx) => fire(send, HOOKS.session_start, ctx, { source: e.reason }))
  pi.on('input', (e, ctx) => fire(send, HOOKS.input, ctx, { prompt: e.text }))
  pi.on('tool_result', (e, ctx) => fire(send, HOOKS.tool_result, ctx, {
    tool_name: e.toolName, tool_input: e.input, tool_response: textOf(e.content).slice(0, HOOK_TEXT), is_error: e.isError,
  }))
  pi.on('agent_settled', (e, ctx) => fire(send, HOOKS.agent_settled, ctx, { aborted: e.aborted }))
  pi.on('session_before_compact', (e, ctx) => fire(send, HOOKS.session_before_compact, ctx, { trigger: e.reason === 'manual' ? 'manual' : 'auto' }))
  pi.on('session_shutdown', (e, ctx) => fire(send, HOOKS.session_shutdown, ctx, { reason: e.reason }))
}

/** Never awaits and never throws, so a slow memory or daemon can't hold up the agent. */
function fire(send: Send, event: string, ctx: Ctx, extra: Record<string, unknown>): void {
  try {
    const payload: Record<string, unknown> = { session_id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, hook_event_name: event }
    if (process.env.CLYDE_THREAD_ID) payload.thread_id = process.env.CLYDE_THREAD_ID
    if (process.env.CLYDE_RUN_ID) payload.run_id = process.env.CLYDE_RUN_ID
    send(event, { ...payload, ...extra })
  } catch {
    // Bookkeeping only. The agent goes on.
  }
}

function kbHook(event: string, payload: Record<string, unknown>): void {
  void agentMemory()?.hook(event, payload)
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
}

// ---------------------------------------------------------------- worker mode

function worker(pi: ExtensionAPI, threadId: string): void {
  const client = () => {
    const c = DaemonClient.fromFile()
    if (!c) throw new Error('The clyde daemon is not running, so clyde has nowhere to send this.')
    return c
  }
  pi.registerTool({
    name: 'clyde_result', label: 'clyde result',
    description: 'Report this thread\'s result to clyde: done or blocked, a short summary, and evidence for each criterion.',
    promptSnippet: 'Report the thread\'s result to clyde, done or blocked',
    promptGuidelines: [
      'Finish every task with one clyde_result call. Use done only when each criterion has evidence. Otherwise use blocked and say why.',
    ],
    parameters: Type.Object({
      status: StringEnum(['done', 'blocked']),
      summary: Type.String({ description: 'One or two sentences' }),
      evidence: Type.Optional(Type.Array(Type.Object({
        criterion: Type.String(),
        evidence: Type.String({ description: 'A command and its result, a path:line, or a commit sha' }),
      }))),
    }),
    async execute(_id, p) {
      const result: Record<string, unknown> = { status: p.status, summary: p.summary }
      if (p.evidence) result.evidence = p.evidence
      await client().postResult(threadId, result)
      return reply(`Reported ${p.status} to clyde for thread ${threadId}.`)
    },
  })
  pi.registerTool({
    name: 'clyde_progress', label: 'clyde progress',
    description: 'Post a one-line status update that clyde shows next to this thread.',
    promptSnippet: 'Post a one-line progress update to clyde',
    promptGuidelines: ['Post an clyde_progress line when you start each major step, so Wen can see where the thread is.'],
    parameters: Type.Object({ line: Type.String({ description: 'One line, for example "Running the tests"' }) }),
    async execute(_id, p) {
      await client().progress(threadId, p.line)
      return reply('Posted.')
    },
  })
  pi.registerTool(todoTool(`thread:${threadId}`, async () => client()))
  pi.registerTool(recallTool())
  pi.registerTool(rememberTool())
  forwardHooks(pi, (event, payload) => {
    kbHook(event, payload)
    DaemonClient.fromFile()?.hook(threadId, event, payload).catch(() => {})
  })
  holdToList(pi, threadId)
}

/**
 * The work list rules, asked of the daemon as Claude's hooks ask it. A file edit waits until an item is in progress, and
 * the agent goes back to work while items are open and no result is posted. A daemon that can't answer lets it through.
 */
function holdToList(pi: ExtensionAPI, threadId: string): void {
  const gate = async (event: string, payload: Record<string, unknown>) => {
    try {
      return (await DaemonClient.fromFile()?.gate(threadId, event, payload)) ?? null
    } catch {
      return null
    }
  }
  pi.on('tool_call', async (e) => {
    if (!editsFiles(e.toolName, e.input)) return undefined
    const why = await gate('PreToolUse', { tool_name: e.toolName, tool_input: e.input })
    return why ? { block: true, reason: why } : undefined
  })
  pi.on('agent_before_settle', async (e) => {
    // The custom message ends the context on a user turn, which is what lets pi make one more request.
    if (e.outcome !== 'completed') return undefined
    // A fenced result block in the last answer counts as a result, as it does for Claude's Stop hook.
    const last = [...e.context.contextMessages].reverse().find((m: any) => m?.role === 'assistant') as { content?: unknown } | undefined
    const why = await gate('Stop', { last_assistant_message: textOf(last?.content) })
    if (!why) return undefined
    return { entries: [{ type: 'custom_message' as const, customType: 'clyde-todo', content: why, display: true }], continue: true }
  })
}

// ---------------------------------------------------------------- point man mode

const POINT_MAN_RULES = [
  'You\'re Wen\'s point man. Delegate any exploration, code reading, research, design, mockups or coding to a background clyde thread or flow, even small tasks.',
  'Use GPT/Codex workers by default. Give them a brief that stands alone, and use a worktree for code changes. Come straight back to chat. Don\'t wait or poll for completion.',
  'Use only clyde CLI calls, their clyde status/thread/flow tools, and memory recall. You may read one or two files only to brief a worker. Don\'t explore, design, edit files or run checks yourself.',
  'Wen\'s memory lives in the memory server only. Never read, write or rely on Claude Code\'s built-in file memory, including ~/.claude/projects/*/memory and MEMORY.md.',
  'At any skill checkpoint, including code-it-works\' shape pitch, read the full pitch and relay it verbatim. Wait for Wen, then pass his answer unchanged through clyde_thread_send or clyde_flow_answer. Never approve, infer an answer or answer for him.',
  'Clyde events come from the daemon, not Wen. Read the thread or flow when needed. Keep routine updates to two sentences. Verbatim checkpoint pitches have no length limit.',
  'Each prompt comes with a hidden clyde status block. Read it before you call clyde_status.',
]

function pointMan(pi: ExtensionAPI): void {
  const man = new PointMan(pi)
  for (const tool of pointManTools()) pi.registerTool(tool as any)
  pi.on('session_start', (_e, ctx) => man.start(ctx))
  pi.on('before_agent_start', () => man.beforePrompt())
  pi.on('agent_settled', () => man.settled())
  pi.on('session_shutdown', () => man.stop())
  forwardHooks(pi, kbHook)
}

/** The event stream, the batch of wake-ups, and the status line. One per session. */
class PointMan {
  pi: ExtensionAPI
  ctx: Ctx | null = null
  closed = true
  prompted = false
  startedAt = 0
  cursor = 0
  retries = 0
  // Bumped on stop, so a stream or retry from before a restart can't revive itself.
  gen = 0
  batch: ClydeEvent[] = []
  batchTimer: Timer | undefined
  statusTimer: Timer | undefined
  retryTimer: Timer | undefined
  closeStream: (() => void) | null = null
  happier = process.env.CLYDE_DELIVERY === 'happier'

  constructor(pi: ExtensionAPI) {
    this.pi = pi
  }

  start(ctx: Ctx): void {
    this.stop()
    Object.assign(this, { ctx, closed: false, prompted: false, startedAt: Date.now() })
    // A -p or json run takes no later turn, so only the TUI and RPC listen for events.
    if (ctx.mode === 'tui' || ctx.mode === 'rpc') void this.connect()
  }

  stop(): void {
    this.closed = true
    this.gen++
    for (const t of [this.batchTimer, this.statusTimer, this.retryTimer]) clearTimeout(t)
    this.batchTimer = this.statusTimer = this.retryTimer = undefined
    this.closeStream?.()
    this.closeStream = null
    this.batch = []
  }

  async connect(): Promise<void> {
    const gen = this.gen
    try {
      const client = await daemon()
      if (gen !== this.gen) return
      this.refreshStatus()
      // since=0 replays the log once. Anything older than this session only moves the cursor.
      this.closeStream = client.events(this.cursor, (e) => gen === this.gen && this.onEvent(e), () => this.retry(gen))
    } catch {
      this.retry(gen)
    }
  }

  /** Reconnects with backoff. ensureDaemon starts a new daemon when the old one is gone. */
  retry(gen: number): void {
    if (gen !== this.gen || this.closed) return
    this.closeStream = null
    const ms = RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)]
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => void this.connect(), ms)
  }

  onEvent(e: ClydeEvent): void {
    this.retries = 0
    this.cursor = Math.max(this.cursor, e.id)
    this.scheduleStatus()
    if (this.happier || !wakes(e) || Date.parse(e.at) < this.startedAt) return
    this.batch.push(e)
    this.batchTimer ??= setTimeout(() => this.flush(), BATCH_MS)
  }

  /** One message per batch. It waits for the first prompt, since a fresh session's first run has no system prompt yet. */
  flush(): void {
    clearTimeout(this.batchTimer)
    this.batchTimer = undefined
    if (this.closed || !this.prompted || !this.batch.length) return
    const events = this.batch
    this.batch = []
    try {
      this.pi.sendMessage(
        { customType: 'clyde-event', content: eventMessage(events), display: true, details: { ids: events.map((e) => e.id) } },
        { triggerTurn: true },
      )
    } catch {
      // The session was replaced or reloaded. session_shutdown stops this loop.
    }
  }

  settled(): void {
    if (this.batch.length && !this.batchTimer) this.flush()
  }

  async beforePrompt() {
    this.prompted = true
    const block = await statusBlock()
    this.setStatus(block.split('\n')[0])
    return { message: { customType: 'clyde-status', content: block, display: false } }
  }

  scheduleStatus(): void {
    clearTimeout(this.statusTimer)
    this.statusTimer = setTimeout(() => this.refreshStatus(), STATUS_DEBOUNCE_MS)
  }

  refreshStatus(): void {
    statusBlock().then((block) => this.setStatus(block.split('\n')[0]), () => {})
  }

  setStatus(line: string): void {
    if (this.closed || !this.ctx) return
    try {
      this.ctx.ui.setStatus('clyde', line)
    } catch {
      // A stale ctx after a reload.
    }
  }
}

/** A run's own threads report through the run, so only standalone threads wake the point man. */
function wakes(e: ClydeEvent): boolean {
  return WAKE.has(e.type) && !(e.type.startsWith('thread.') && e.runId)
}

function eventMessage(events: ClydeEvent[]): string {
  if (events.length === 1) return `clyde: ${events[0].summary}`
  return [`clyde: ${events.length} updates.`, ...events.map((e) => `- ${e.summary}`)].join('\n')
}

// ---------------------------------------------------------------- status

type Snapshot = { threads: Thread[]; runs: any[]; list?: { items: unknown[]; text: string } }

async function snapshot(timeoutMs = 30_000): Promise<Snapshot> {
  const client = await daemon()
  const threads: Thread[] = await client.call('GET', '/threads', undefined, timeoutMs)
  // A failed runs or list read still leaves the threads worth showing.
  const runs: any[] = await client.call('GET', '/runs', undefined, timeoutMs).catch(() => [])
  const list = await client.call('GET', `/lists/${POINT_MAN}`, undefined, timeoutMs).catch(() => undefined)
  return { threads, runs: Array.isArray(runs) ? runs : [], list }
}

function active(t: Thread): boolean {
  return t.status === 'running' || t.status === 'queued'
}

/** clyde: N running · M asking. A run's threads count as the run. */
function statusLine(s: Snapshot): string {
  const running = s.threads.filter((t) => !t.runId && active(t)).length + s.runs.filter((r) => r.status === 'running').length
  const asking = s.runs.filter((r) => r.status === 'asking').length
  return `clyde: ${running} running · ${asking} asking`
}

/** The status line, then the newest standalone threads and runs, one line each. */
function formatStatus(s: Snapshot): string {
  const threads = newest(s.threads.filter((t) => !t.runId), BLOCK_THREADS)
  const runs = newest(s.runs, BLOCK_RUNS)
  const lines = [statusLine(s), ...threads.shown.map(threadLine), ...runs.shown.map(runLine)]
  if (!threads.shown.length && !runs.shown.length) lines.push('No threads or runs.')
  if (threads.hidden || runs.hidden) lines.push(`${threads.hidden + runs.hidden} older not shown. clyde_threads and clyde_runs list them all.`)
  // The point man's own list, once it has one, so delegated work stays in view every turn.
  if (s.list?.items?.length) lines.push('', s.list.text)
  return lines.join('\n')
}

function newest<T extends { updatedAt?: string }>(items: T[], n: number): { shown: T[]; hidden: number } {
  const sorted = [...items].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  return { shown: sorted.slice(0, n), hidden: Math.max(0, sorted.length - n) }
}

async function statusBlock(): Promise<string> {
  try {
    return formatStatus(await snapshot(STATUS_TIMEOUT_MS))
  } catch (err) {
    return `clyde: the daemon is not answering. ${(err as Error).message}`
  }
}

// ---------------------------------------------------------------- point man tools

function readThread(t: Thread, turns: number): string[] {
  const lines = [threadLine(t)]
  for (const turn of t.turns.slice(-turns)) {
    lines.push('', `turn ${turn.n}: ${turn.prompt.split('\n')[0].slice(0, 200)}`)
    // Checkpoint pitches must reach Wen verbatim, including those longer than the status excerpt.
    if (turn.text) lines.push(turn.text)
    if (turn.error) lines.push(`error: ${turn.error}`)
  }
  const result = t.result as { status?: string; summary?: string } | undefined
  if (result?.status) lines.push('', `result: ${result.status}. ${result.summary ?? ''}`.trim())
  if (t.queue.length) lines.push('', `${t.queue.length} message(s) queued.`)
  return lines
}

function pointManTools() {
  const id = Type.String({ description: 'The thread id, like t-1a2b3c4d' })
  return [
    {
      name: 'clyde_status', label: 'clyde status',
      description: 'Show clyde threads and runs, one line each, with the running and asking counts.',
      promptSnippet: 'Show clyde threads and runs, one line each',
      promptGuidelines: POINT_MAN_RULES,
      parameters: Type.Object({}),
      async execute() {
        return reply(formatStatus(await snapshot()))
      },
    },
    {
      name: 'clyde_threads', label: 'clyde threads',
      description: 'List every clyde thread, one line each.',
      promptSnippet: 'List every clyde thread',
      parameters: Type.Object({}),
      async execute() {
        const threads = await (await daemon()).threads()
        return reply(threads.length ? threads.map(threadLine) : 'No threads.')
      },
    },
    {
      name: 'clyde_thread_start', label: 'clyde thread start',
      description: 'Start a background thread that works on a prompt. It runs on its own, and clyde tells you when it finishes.',
      promptSnippet: 'Start a background clyde thread on a prompt',
      promptGuidelines: [
        'Give clyde_thread_start a prompt that stands alone. The thread sees nothing of this conversation.',
        'Set worktree true when the thread changes code, so it works on its own branch.',
      ],
      parameters: Type.Object({
        prompt: Type.String({ description: 'The full task. The thread sees nothing else.' }),
        title: Type.Optional(Type.String({ description: 'A few words, shown in clyde status' })),
        role: Type.Optional(Type.String({ description: 'thread, planner, worker or reviewer. Defaults to thread.' })),
        backend: Type.Optional(StringEnum(['pi', 'claude', 'codex'], { description: 'Pick the CLI instead of a role' })),
        model: Type.Optional(Type.String({ description: 'With backend: a pi provider/id, or a claude or codex model' })),
        effort: Type.Optional(StringEnum(['low', 'medium', 'high'], { description: 'With backend' })),
        cwd: Type.Optional(Type.String({ description: 'The directory to work in. Defaults to yours.' })),
        worktree: Type.Optional(Type.Boolean({ description: 'Work in a new git worktree and branch' })),
        readOnly: Type.Optional(Type.Boolean({ description: 'Read and search only' })),
      }),
      async execute(_id: string, p: any, _signal: unknown, _update: unknown, ctx: Ctx) {
        const { backend, model, effort, ...rest } = p
        const rung = backend ? { backend, model, effort } : undefined
        // The point man's list gets an item for the thread, which the daemon closes when the thread ends.
        const t = await (await daemon()).startThread({ ...rest, rung, cwd: p.cwd ?? ctx.cwd, track: POINT_MAN })
        const where = t.branch ? `on branch ${t.branch}` : `in ${t.cwd}`
        return reply([`Started thread ${t.id} "${t.title}" ${where}.`, threadLine(t)])
      },
    },
    {
      name: 'clyde_thread_send', label: 'clyde thread send',
      description: 'Send a follow-up message to a thread. It waits its turn when the thread is busy.',
      promptSnippet: 'Send a follow-up message to a clyde thread',
      parameters: Type.Object({ id, text: Type.String() }),
      async execute(_id: string, p: { id: string; text: string }) {
        const t = await (await daemon()).send(p.id, p.text)
        return reply([`Sent to ${t.id}.`, threadLine(t)])
      },
    },
    {
      name: 'clyde_thread_read', label: 'clyde thread read',
      description: 'Read a thread: its status, its last turns with their answers, and its result.',
      promptSnippet: 'Read a clyde thread\'s last turns and result',
      parameters: Type.Object({
        id,
        turns: Type.Optional(Type.Number({ description: 'How many recent turns, 1 to 5. Defaults to 1.' })),
      }),
      async execute(_id: string, p: { id: string; turns?: number }) {
        const t = await (await daemon()).thread(p.id)
        return reply(readThread(t, Math.min(5, Math.max(1, Math.floor(p.turns ?? 1)))))
      },
    },
    {
      name: 'clyde_thread_stop', label: 'clyde thread stop',
      description: 'Stop a thread. Its running turn ends and its queue is dropped.',
      promptSnippet: 'Stop a clyde thread',
      parameters: Type.Object({ id }),
      async execute(_id: string, p: { id: string }) {
        const t = await (await daemon()).stop(p.id)
        return reply([`Stopped ${t.id}.`, threadLine(t)])
      },
    },
    {
      name: 'clyde_flow_start', label: 'clyde flow start',
      description: 'Start a workflow run. ship takes {"prompt"}. task takes {"prompt", "criteria", "checks"}.',
      promptSnippet: 'Start a clyde workflow run, ship or task',
      promptGuidelines: ['Use clyde_flow_start with flow task for judged background work, and ship for a feature from plan to review.'],
      parameters: Type.Object({
        flow: Type.String({ description: 'ship or task' }),
        input: Type.Object({}, { additionalProperties: true, description: 'The flow input' }),
        cwd: Type.Optional(Type.String({ description: 'The repo to cut the run\'s worktree from. Defaults to yours.' })),
      }),
      async execute(_id: string, p: { flow: string; input: unknown; cwd?: string }, _signal: unknown, _update: unknown, ctx: Ctx) {
        // The run's worktree comes from this repo, not the daemon's directory.
        const run = await (await daemon()).startRun(p.flow, p.input, p.cwd ?? ctx.cwd, POINT_MAN)
        return reply([`Started run ${run.id}, flow ${run.flow}, on branch ${run.branch}.`, runLine(run)])
      },
    },
    {
      name: 'clyde_flow_answer', label: 'clyde flow answer',
      description: 'Answer a run that is asking. Pass Wen\'s answer as he gave it.',
      promptSnippet: 'Pass Wen\'s answer to a clyde run that is asking',
      parameters: Type.Object({ run: Type.String({ description: 'The run id' }), text: Type.String({ description: 'Wen\'s answer' }) }),
      async execute(_id: string, p: { run: string; text: string }) {
        const run = await (await daemon()).answer(p.run, p.text)
        return reply([`Answered run ${run.id}.`, runLine(run)])
      },
    },
    {
      name: 'clyde_runs', label: 'clyde runs',
      description: 'List every workflow run, one line each, with the question when one is asking.',
      promptSnippet: 'List clyde workflow runs',
      parameters: Type.Object({}),
      async execute() {
        const runs = await (await daemon()).runs()
        return reply(runs.length ? runs.map(runLine) : 'No runs.')
      },
    },
    todoTool(POINT_MAN, daemon),
    recallTool(),
    rememberTool(),
    {
      name: 'clyde_plan', label: 'clyde plan',
      description: 'Show a run\'s plan, or set it. The daemon keeps the plan in memory as an approved entry.',
      promptSnippet: 'Show or set a run\'s plan',
      promptGuidelines: ['Set a plan with clyde_plan only after Wen approves it.'],
      parameters: Type.Object({
        run: Type.String({ description: 'The run id' }),
        plan: Type.Optional(Type.Object({
          intent: Type.String({ description: 'What the change is for, in a sentence or two' }),
          slices: Type.Array(Type.Object({
            id: Type.String({ description: 'Short, like s1' }),
            title: Type.String(),
            acceptance: Type.Array(Type.String({ description: 'A command that passes when the slice is done' })),
          })),
        }, { description: 'The new plan. Leave it out to show the current one.' })),
      }),
      async execute(_id: string, p: { run: string; plan?: Plan }) {
        const client = await daemon()
        const path = `/runs/${encodeURIComponent(p.run)}/plan`
        if (p.plan === undefined) {
          const { plan, entry } = await client.call('GET', path)
          return reply(plan ? planLines(p.run, plan, entry) : `Run ${p.run} has no plan yet.`)
        }
        const { plan, entry } = await client.call('POST', path, { plan: p.plan })
        return reply(['Plan set.', ...planLines(p.run, plan, entry)])
      },
    },
  ]
}

type Plan = { intent: string; slices: { id: string; title: string; acceptance: string[] }[] }

function planLines(run: string, plan: Plan, entry: string | null): string[] {
  const lines = [`Run ${run} plan${entry ? `, memory entry ${entry}` : ''}.`, `Intent: ${plan.intent}`]
  for (const s of plan.slices ?? []) {
    const acceptance = s.acceptance?.length ? ` Acceptance: ${s.acceptance.join(', ')}` : ''
    lines.push(`- ${s.id} ${s.title}.${acceptance}`)
  }
  return lines
}
