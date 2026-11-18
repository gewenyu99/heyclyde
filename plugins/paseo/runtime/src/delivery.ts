/** Delivers wake-up events to the point man: in Paseo when clyde up started it there, else through Happier, so they land on every device. */
import type { EventLog } from './events.ts'
import { join } from 'node:path'
import { clydeHome } from './config.ts'
import { available, notify, POINT_MAN_TAG, readState, send } from './happier.ts'
import * as paseo from './paseo.ts'
import { readJson, writeJson } from './store.ts'
import type { ClydeEvent } from './types.ts'

// The same events and batching the point man extension uses when it injects them itself.
const WAKE = new Set(['thread.done', 'thread.failed', 'run.ask', 'run.passed', 'run.failed', 'run.done'])
const BATCH_MS = 2000
const RETRY_MS = 1000
// A failed sign-in check is asked again after this long, so signing in later needs no daemon restart.
const RECHECK_MS = 60_000
const ASK_REMINDER_MS = 6 * 60 * 60 * 1000

export type DeliveryOptions = { batchMs?: number; retryMs?: number; askReminderMs?: number; now?: () => number }
type SentAsk = { text: string; at: number }

/** A flow's own threads report through its run events, so only threads you started wake the point man. */
export function wakes(e: ClydeEvent): boolean {
  return WAKE.has(e.type) && !(e.type.startsWith('thread.') && e.runId)
}

export function message(events: ClydeEvent[]): string {
  if (events.length === 1) return `clyde: ${events[0].summary}`
  return [`clyde: ${events.length} updates.`, ...events.map((e) => `- ${e.summary}`)].join('\n')
}

/**
 * Subscribes for the daemon's life. happier.json is read at each batch, since clyde up writes it after the daemon starts.
 * Without it, or without a signed-in happier, events are left to the extension, which injects them itself.
 */
export function startDelivery(events: EventLog, opts: DeliveryOptions = {}): () => void {
  const batchMs = opts.batchMs ?? BATCH_MS
  const retryMs = opts.retryMs ?? RETRY_MS
  const askReminderMs = opts.askReminderMs ?? ASK_REMINDER_MS
  const now = opts.now ?? Date.now
  const asksPath = join(clydeHome(), 'delivery-asks.json')
  const sentAsks = readJson<Record<string, SentAsk>>(asksPath) ?? {}
  let batch: ClydeEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let checked: { ok: boolean; at: number } | null = null
  // One delivery at a time, so batches reach the phone in order.
  let chain = Promise.resolve()

  async function ready(): Promise<boolean> {
    if (!checked || (!checked.ok && Date.now() - checked.at > RECHECK_MS)) checked = { ok: await available(), at: Date.now() }
    return checked.ok
  }

  async function deliver(events: ClydeEvent[]): Promise<void> {
    const latestAsk = new Map<string, number>()
    events.forEach((event, index) => {
      const key = askKey(event)
      if (key) latestAsk.set(key, index)
    })
    const due = events.filter((event, index) => {
      const key = askKey(event)
      if (!key) return true
      if (latestAsk.get(key) !== index) return false
      const sent = sentAsks[key]
      return !sent || sent.text !== askText(event) || now() - sent.at >= askReminderMs
    })
    if (!due.length) return
    const text = message(due)
    const markSent = () => {
      let changed = false
      for (const event of due) {
        const key = askKey(event)
        if (!key) continue
        sentAsks[key] = { text: askText(event), at: now() }
        changed = true
      }
      if (changed) writeJson(asksPath, sentAsks)
    }
    // paseo.json is written by clyde up, so the newest point man wins without a daemon restart.
    const pm = paseo.readState()
    if (pm) {
      let sent = false
      try {
        await paseo.send(pm.agentId, text)
        sent = true
      } catch {
        await sleep(retryMs)
        try { await paseo.send(pm.agentId, text); sent = true } catch { /* Try again on a later event. */ }
      }
      if (sent) markSent()
      return
    }
    const state = readState()
    if (!state || !(await ready())) return
    const target = state.sessionId || state.tag || POINT_MAN_TAG
    try {
      await send(target, text)
    } catch {
      await sleep(retryMs)
      try {
        await send(target, text)
      } catch {
        // The session is gone or the relay is down. A push still tells you to look.
        try { await notify('clyde', text) } catch { return }
      }
    }
    markSent()
  }

  function flush(): void {
    clearTimeout(timer)
    timer = undefined
    if (!batch.length) return
    const events = batch
    batch = []
    chain = chain.then(() => deliver(events)).catch(() => {})
  }

  const unsubscribe = events.subscribe((e) => {
    if (!wakes(e)) return
    batch.push(e)
    timer ??= setTimeout(flush, batchMs)
  })
  return () => {
    unsubscribe()
    flush()
  }
}

function askKey(event: ClydeEvent): string | null {
  if (event.type !== 'run.ask') return null
  const data = event.data as { key?: string } | undefined
  return JSON.stringify([event.runId ?? '', data?.key ?? event.summary])
}

function askText(event: ClydeEvent): string {
  const data = event.data as { question?: string } | undefined
  return JSON.stringify([event.summary, data?.question ?? null])
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
