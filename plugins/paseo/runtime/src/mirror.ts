/**
 * Mirrors one representative thread per top-level run and each standalone point-man thread into Paseo.
 * Clyde runs the first turn; after import Paseo owns the session's writer. Only on when clyde up put the point man in Paseo.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { sessionDir } from './backends/pi.ts'
import type { EventLog } from './events.ts'
import * as paseo from './paseo.ts'
import { readJson, writeJson } from './store.ts'
import type { Threads } from './threads.ts'
import type { ClydeEvent, Thread } from './types.ts'
import type { Run } from './flow/types.ts'

const IMPORT_EVERY_MS = 3000
const PROVIDERS: Record<string, string> = { claude: 'claude', codex: 'codex', pi: 'pi' }

type Mirrored = Record<string, string>

/** What paseo import takes: the session id for Claude and Codex, the session file for pi, or null while it isn't on disk. */
function handle(backend: string, session: string | undefined): string | null {
  if (!session) return null
  if (backend !== 'pi') return session
  try {
    const file = readdirSync(sessionDir()).find((f) => f.endsWith(`_${session}.jsonl`))
    return file ? join(sessionDir(), file) : null
  } catch {
    return null
  }
}

function mapPath(home: string): string {
  return join(home, 'paseo-threads.json')
}

/** The run's first task worker or ship planner is its sole sidebar entry. Old runs have no mirrorTitle marker. */
export function mirrorName(t: Thread, home: string): string | null {
  if (t.readOnly || t.parentThreadId) return null
  if (!t.runId) return t.stage ? null : t.title
  const run = readJson<Run>(join(home, 'runs', `${t.runId}.json`))
  if (!run || run.parentThreadId) return null
  if (t.mirrorTitle) return run.title
  const first = run.stages[0]
  if (!first || ((run.flow !== 'task' || first.name !== 'task') && (run.flow !== 'ship' || first.name !== 'plan'))) return null
  return first.attempts[0]?.threadId === t.id ? run.title : null
}

const DEAD_THREAD = new Set(['stopped', 'failed'])
const DEAD_RUN = new Set(['done', 'stopped', 'failed'])
const MAX_IMPORT_TRIES = 20

/** Finished work never goes to the sidebar: a stopped or failed thread, an ended run, or a worktree that's gone. */
export function active(t: Thread, home: string): boolean {
  if (!existsSync(t.cwd) || DEAD_THREAD.has(t.status)) return false
  if (!t.runId) return true
  const run = readJson<Run>(join(home, 'runs', `${t.runId}.json`))
  return !!run && !DEAD_RUN.has(run.status)
}

/** At daemon start only work that is in flight right now gets mirrored, never every thread clyde has ever run. */
export function inFlight(t: Thread, home: string): boolean {
  if (!active(t, home)) return false
  if (t.runId) return true
  return t.status === 'running' || t.status === 'queued'
}

export function startMirror(events: EventLog, threads: Threads, home: string): () => void {
  const agents: Mirrored = readJson<Mirrored>(mapPath(home)) ?? {}
  const pointMan = readJson<{ agentId: string }>(join(home, 'paseo.json'))?.agentId
  for (const [id, agentId] of Object.entries(agents)) {
    const t = threads.threads.get(id)
    if (agentId === pointMan || (t && mirrorName(t, home))) continue
    // Keep the mapping until Paseo confirms the soft delete. A failed archive must not orphan a visible sidebar entry.
    void paseo.archive(agentId).then(() => {
      const latest = readJson<Mirrored>(mapPath(home)) ?? {}
      if (latest[id] !== agentId) return
      delete latest[id]
      delete agents[id]
      writeJson(mapPath(home), latest)
    }, () => { /* Try again on the next daemon start. */ })
  }
  const importing = new Set<string>()
  const retrying = new Set<string>()
  const tries = new Map<string, number>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let closed = false

  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!closed) fn()
    }, ms)
    timers.add(timer)
    return timer
  }

  // A bounded retry: an import that keeps failing stops instead of hammering Paseo every few seconds forever.
  function retry(t: Thread): void {
    if (closed || retrying.has(t.id)) return
    const n = (tries.get(t.id) ?? 0) + 1
    tries.set(t.id, n)
    if (n > MAX_IMPORT_TRIES) return
    retrying.add(t.id)
    later(() => {
      retrying.delete(t.id)
      mirror(t)
    }, IMPORT_EVERY_MS)
  }

  /** Never import while a direct turn owns the writer. Pending imports also gate the next turn. */
  function mirror(t: Thread): void {
    const title = mirrorName(t, home)
    if (closed || !title || agents[t.id] || importing.has(t.id) || threads.live.has(t.id) || !paseo.readState()) return
    if (!active(t, home)) return
    const provider = PROVIDERS[t.rung.backend]
    if (!provider) return
    const session = handle(t.rung.backend, threads.threads.get(t.id)?.session)
    if (!session) {
      retry(t)
      return
    }
    importing.add(t.id)
    const labels = [`clyde-thread=${t.id}`, ...(t.runId ? [`clyde-run=${t.runId}`] : []), ...(t.stage ? [`clyde-stage=${t.stage}`] : [])]
    const pending = paseo.importSession(session, provider, t.cwd, labels, title).then((id) => {
      agents[t.id] = id
      // Another process may have pruned archived agents since this mirror started.
      writeJson(mapPath(home), { ...(readJson<Mirrored>(mapPath(home)) ?? {}), [t.id]: id })
    }, () => {
      retry(t)
    }).finally(() => {
      importing.delete(t.id)
      threads.mirrorImports.delete(t.id)
    })
    threads.mirrorImports.set(t.id, pending)
  }

  const unsubscribe = events.subscribe((e: ClydeEvent) => {
    if (!e.threadId) return
    const t = threads.threads.get(e.threadId)
    if (!t) return
    if (e.type.startsWith('thread.')) mirror(t)
  })
  for (const t of threads.threads.values()) if (inFlight(t, home)) mirror(t)
  return () => {
    closed = true
    unsubscribe()
    for (const timer of timers) clearTimeout(timer)
  }
}
