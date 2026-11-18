/** The event log: one line per event in events.jsonl, ids that only go up, and live subscribers for SSE. */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { clydeHome } from './config.ts'
import type { ClydeEvent } from './types.ts'

export class EventLog {
  path: string
  events: ClydeEvent[] = []
  listeners = new Set<(e: ClydeEvent) => void>()

  constructor(path = join(clydeHome(), 'events.jsonl')) {
    this.path = path
    mkdirSync(dirname(path), { recursive: true })
    this.events = load(path)
  }

  lastId(): number {
    return this.events.length ? this.events[this.events.length - 1].id : 0
  }

  append(e: Omit<ClydeEvent, 'id' | 'at'>): ClydeEvent {
    const event = { id: this.lastId() + 1, at: new Date().toISOString(), ...e } as ClydeEvent
    appendFileSync(this.path, JSON.stringify(event) + '\n')
    this.events.push(event)
    for (const fn of this.listeners) {
      try {
        fn(event)
      } catch {
        // One broken subscriber must not stop the others or the caller.
      }
    }
    return event
  }

  since(id: number): ClydeEvent[] {
    return this.events.filter((e) => e.id > id)
  }

  subscribe(fn: (e: ClydeEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

function load(path: string): ClydeEvent[] {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out: ClydeEvent[] = []
  for (const line of text.split('\n')) {
    try {
      const e = JSON.parse(line)
      // A torn last line or an out-of-order id would break the monotonic promise, so it's skipped.
      if (typeof e?.id === 'number' && e.id > (out.at(-1)?.id ?? 0)) out.push(e)
    } catch {
      // A torn line from a crash mid-append.
    }
  }
  return out
}
