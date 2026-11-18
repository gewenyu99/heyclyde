/** Work lists: what's done, what's in progress and how, and what's next, kept by the daemon so no model has to remember it. */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { clydeHome } from './config.ts'
import type { EventLog } from './events.ts'
import { HttpError } from './http.ts'
import { readJson, writeJson } from './store.ts'

export type ItemStatus = 'todo' | 'doing' | 'done' | 'blocked'
export type WorkItem = {
  id: number; text: string; status: ItemStatus
  how?: string; evidence?: string; why?: string; threadId?: string; runId?: string; updatedAt: string
}
export type WorkList = { owner: string; items: WorkItem[] }
export type Link = { threadId?: string; runId?: string }

export const POINT_MAN = 'pointman'

const OWNER = /^(thread|run):[A-Za-z0-9._-]{1,64}$/
const TEXT_MAX = 500
const NOTE_MAX = 1000
const MARK: Record<ItemStatus, string> = { done: '[x]', doing: '[>]', todo: '[ ]', blocked: '[!]' }
const NOTE: Partial<Record<ItemStatus, 'evidence' | 'how' | 'why'>> = { done: 'evidence', doing: 'how', blocked: 'why' }
const LABEL = { evidence: 'Evidence', how: 'How', why: 'Why' }

/** thread:<id>, run:<id> or pointman. Throws a 400 for anything else, since the owner becomes a file name. */
export function owner(value: unknown): string {
  if (typeof value === 'string' && (value === POINT_MAN || OWNER.test(value))) return value
  throw new HttpError(400, 'a list owner is thread:<id>, run:<id> or pointman')
}

export function open(list: WorkList): WorkItem[] {
  return list.items.filter((i) => i.status === 'todo' || i.status === 'doing')
}

export function doing(list: WorkList): WorkItem | undefined {
  return list.items.find((i) => i.status === 'doing')
}

/** The fixed format every clyde todo call prints: a count line, one line per item, and what to do next. */
export function formatList(list: WorkList): string {
  const who = list.owner === POINT_MAN ? 'point man' : list.owner.replace(':', ' ')
  if (!list.items.length) return `Work list, ${who}: empty\nNext: add your steps, then start the first one and say how.`
  const count = (s: ItemStatus) => list.items.filter((i) => i.status === s).length
  const counts = [`${count('done')} done`, `${count('doing')} doing`, `${count('todo')} todo`]
  if (count('blocked')) counts.push(`${count('blocked')} blocked`)
  const lines = [`Work list, ${who}: ${counts.join(', ')}`]
  for (const item of list.items) {
    const field = NOTE[item.status]
    const note = field && item[field] ? ` ${LABEL[field]}: ${oneLine(item[field] as string)}` : ''
    lines.push(`${MARK[item.status]} ${item.id} ${note ? `${sentence(item.text)}${note}` : oneLine(item.text)}`)
  }
  lines.push(nextLine(list))
  return lines.join('\n')
}

function nextLine(list: WorkList): string {
  const now = doing(list)
  if (now) return `Next: finish ${now.id}, or mark it done with evidence.`
  const todo = list.items.find((i) => i.status === 'todo')
  if (todo) return `Next: start ${todo.id}, and say how.`
  return 'Next: nothing is open. Report your result.'
}

/** Text with a note after it ends in a period, so "Read the gate" reads "Read the gate. Evidence: ...". */
function sentence(text: string): string {
  const t = oneLine(text)
  return /[.!?:]$/.test(t) ? t : `${t}.`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clean(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} must be a non-empty string`)
  const t = oneLine(value)
  return t.length > max ? `${t.slice(0, max - 3)}...` : t
}

/** The lists, one JSON file per owner under <CLYDE_HOME>/lists. Every rule of PLAN "Work lists" is checked here. */
export class Lists {
  dir: string
  events: EventLog
  // A thread list's events carry the thread's run, so a run's event history holds its workers' lists too.
  runOf: (threadId: string) => string | undefined
  cache = new Map<string, WorkList>()
  // Which list holds the item linked to a thread or run, so thread.done can find it.
  links = new Map<string, string>()

  constructor(events: EventLog, runOf: (threadId: string) => string | undefined = () => undefined) {
    this.events = events
    this.runOf = runOf
    this.dir = join(clydeHome(), 'lists')
    let names: string[] = []
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json'))
    } catch {
      // No lists yet.
    }
    for (const name of names) {
      const list = this.get(name.slice(0, -'.json'.length))
      for (const item of list.items) for (const key of linkKeys(item)) this.links.set(key, list.owner)
    }
  }

  get(who: string): WorkList {
    const id = owner(who)
    let list = this.cache.get(id)
    if (!list) {
      const saved = readJson<WorkList>(this.path(id))
      list = { owner: id, items: Array.isArray(saved?.items) ? saved.items : [] }
      this.cache.set(id, list)
    }
    return list
  }

  view(who: string): WorkList & { text: string } {
    const list = structuredClone(this.get(who))
    return { ...list, text: formatList(list) }
  }

  add(who: string, texts: unknown, link: Link = {}): WorkList & { text: string } {
    if (!Array.isArray(texts) || !texts.length) throw new HttpError(400, 'items must be a non-empty list of strings')
    const cleaned = texts.map((t) => clean(t, 'each item', TEXT_MAX))
    const list = this.get(who)
    const added: number[] = []
    for (const text of cleaned) {
      const item: WorkItem = { id: (list.items.at(-1)?.id ?? 0) + 1, text, status: 'todo', updatedAt: now() }
      if (link.threadId) item.threadId = link.threadId
      if (link.runId) item.runId = link.runId
      list.items.push(item)
      for (const key of linkKeys(item)) this.links.set(key, list.owner)
      added.push(item.id)
    }
    this.save(list, `added ${plural(added)}`)
    return this.view(who)
  }

  /** Start says how, and only one item is in progress, so any other doing item goes back to todo. */
  start(who: string, n: unknown, how: unknown): WorkList & { text: string } {
    const list = this.get(who)
    const item = this.item(list, n)
    const said = clean(how, 'how', NOTE_MAX)
    if (item.status === 'doing') throw new HttpError(409, `item ${item.id} is already in progress`)
    if (item.status !== 'todo') throw new HttpError(409, `item ${item.id} is ${item.status}, and history stays. Add a new item instead`)
    for (const other of list.items) {
      if (other.status === 'doing') Object.assign(other, { status: 'todo', updatedAt: now() })
    }
    Object.assign(item, { status: 'doing', how: said, updatedAt: now() })
    this.save(list, `started ${item.id}`)
    return this.view(who)
  }

  done(who: string, n: unknown, evidence: unknown): WorkList & { text: string } {
    const list = this.get(who)
    const item = this.item(list, n)
    const said = clean(evidence, 'evidence', NOTE_MAX)
    this.closable(item)
    Object.assign(item, { status: 'done', evidence: said, updatedAt: now() })
    this.save(list, `finished ${item.id}`)
    return this.view(who)
  }

  block(who: string, n: unknown, why: unknown): WorkList & { text: string } {
    const list = this.get(who)
    const item = this.item(list, n)
    const said = clean(why, 'why', NOTE_MAX)
    this.closable(item)
    Object.assign(item, { status: 'blocked', why: said, updatedAt: now() })
    this.save(list, `blocked ${item.id}`)
    return this.view(who)
  }

  /**
   * The point man's item for a thread or run it delegated. A done item stays done. A blocked one can still finish, since a
   * failed thread that gets another message may succeed.
   */
  settle(link: Link, status: 'done' | 'blocked', note: string): void {
    const key = link.threadId ? `thread:${link.threadId}` : link.runId ? `run:${link.runId}` : ''
    const who = this.links.get(key)
    if (!who) return
    const list = this.get(who)
    const item = list.items.find((i) => (link.threadId ? i.threadId === link.threadId : i.runId === link.runId))
    if (!item || item.status === 'done' || item.status === status) return
    const field = status === 'done' ? 'evidence' : 'why'
    Object.assign(item, { status, [field]: clean(note || status, field, NOTE_MAX), updatedAt: now() })
    this.save(list, `${status === 'done' ? 'finished' : 'blocked'} ${item.id}`)
  }

  item(list: WorkList, n: unknown): WorkItem {
    const id = typeof n === 'string' ? Number(n) : n
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) throw new HttpError(400, 'n must be an item number, like 3')
    const item = list.items.find((i) => i.id === id)
    if (!item) throw new HttpError(404, `the work list has no item ${id}`)
    return item
  }

  closable(item: WorkItem): void {
    if (item.status === 'done' || item.status === 'blocked') {
      throw new HttpError(409, `item ${item.id} is already ${item.status}, and history stays. Add a new item instead`)
    }
  }

  path(who: string): string {
    return join(this.dir, `${who}.json`)
  }

  save(list: WorkList, what: string): void {
    writeJson(this.path(list.owner), list)
    const e: Record<string, unknown> = { type: 'list.updated', summary: `Work list ${list.owner}: ${what}.`, data: { owner: list.owner } }
    if (list.owner.startsWith('thread:')) {
      const id = list.owner.slice('thread:'.length)
      e.threadId = id
      const run = this.runOf(id)
      if (run) e.runId = run
    } else if (list.owner.startsWith('run:')) {
      e.runId = list.owner.slice('run:'.length)
    }
    this.events.append(e as any)
  }
}

function linkKeys(item: WorkItem): string[] {
  return [item.threadId && `thread:${item.threadId}`, item.runId && `run:${item.runId}`].filter(Boolean) as string[]
}

function plural(ids: number[]): string {
  return ids.length === 1 ? `item ${ids[0]}` : `items ${ids[0]} to ${ids.at(-1)}`
}

// ---------------------------------------------------------------- enforcement

const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit'])
// What a shell command does to files: redirects, in-place edits, moves and deletes, installs, and git writes.
const WRITES = [
  /(^|[^0-9&<>])>>?\s*(?!&|\/dev\/null\b)\S/,
  /(^|[\s;&|(])(tee|rm|rmdir|mv|cp|mkdir|touch|truncate|ln|chmod|chown|install|patch|dd|unzip|tar)\s/,
  /(^|[\s;&|(])(sed|perl)\s+(-\w*i|--in-place)/,
  /(^|[\s;&|(])git\s+(add|commit|apply|am|checkout|switch|restore|reset|rm|mv|stash|merge|rebase|cherry-pick|revert|clean|tag|branch|worktree)\b/,
  /(^|[\s;&|(])(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|ci|update|run\s+fix)\b/,
  /(^|[\s;&|(])pip3?\s+install\b/,
]

/** A single clyde todo call is always allowed through the edit hook, even if its text mentions a write. */
function todoRecovery(command: string): boolean {
  if (/\$\(|`|\n|\r/.test(command)) return false
  const bare = command.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""')
  return /^\s*clyde\s+todo\s+(?:list|add|start|done|block)\b[^;&|<>]*$/.test(bare)
}

/** True when a shell command may change files. Quoted text is dropped first, so clyde todo add "a > b" is not a write. */
export function changesFiles(command: unknown): boolean {
  if (typeof command !== 'string') return false
  if (todoRecovery(command)) return false
  const bare = command.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""')
  return WRITES.some((re) => re.test(bare))
}

/** Whether a tool call edits files, by Claude Code's names or pi's. */
export function editsFiles(tool: unknown, input: unknown): boolean {
  if (typeof tool !== 'string') return false
  const name = tool.toLowerCase()
  if (EDIT_TOOLS.has(name)) return true
  return name === 'bash' && changesFiles((input as { command?: unknown })?.command)
}

/** Why a file edit must wait, or null when the list allows it: something is in progress. */
export function editBlock(list: WorkList, tool: string): string | null {
  if (doing(list)) return null
  const lead = list.items.length
    ? `Nothing on your work list is in progress, so clyde blocked this ${tool} call. Start an item with clyde todo start N --how "<how>" first, or add one with clyde todo add "<step>".`
    : `Your work list is empty, so clyde blocked this ${tool} call. Add your steps with clyde todo add "<step>"..., then clyde todo start N --how "<how>", and try again.`
  const next = list.items.find((i) => i.status === 'todo')
  const added = (list.items.at(-1)?.id ?? 0) + 1
  const recovery = next
    ? `Run exactly: clyde todo start ${next.id} --how "Complete item ${next.id}"`
    : `Run exactly: clyde todo add "Prepare the requested edit"\nThen run: clyde todo start ${added} --how "Complete item ${added}"`
  return `${lead}\n${recovery}\n\n${formatList(list)}`
}

/** Why a worker may not stop yet: items are open and no result is posted. */
export function stopBlock(list: WorkList): string {
  const n = open(list).length
  return `Your work list has ${n} open item${n === 1 ? '' : 's'} and no result is posted. Continue with the next one, or block it with why. Then report with clyde result.\n\n${formatList(list)}`
}

/** The follow-up turn the daemon queues when a turn ends with open items and no result. */
export function nudgePrompt(list: WorkList): string {
  const n = open(list).length
  return `Your list has ${n} open item${n === 1 ? '' : 's'}. Continue with the next one, or block it with why.`
}

/** Why clyde result is refused, or null. done needs nothing open. blocked needs a blocked item. An empty list gates nothing. */
export function resultBlock(list: WorkList, status: unknown): string | null {
  if (!list.items.length) return null
  if (status === 'done') {
    const n = open(list).length
    if (n) return `Your work list has ${n} open item${n === 1 ? '' : 's'}, so clyde refused done. Mark each done with evidence, or block it with why.`
  }
  if (status === 'blocked' && !list.items.some((i) => i.status === 'blocked')) {
    return 'blocked needs a blocked item. Block the item you can\'t finish with clyde todo block N --why "<why>" first.'
  }
  return null
}

function now(): string {
  return new Date().toISOString()
}
