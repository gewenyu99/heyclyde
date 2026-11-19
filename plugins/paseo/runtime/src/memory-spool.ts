/** Durable pending memory entries shared by the daemon and worker processes. */
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { clydeHome } from './config.ts'

export type Pending = { id: string; payload: Record<string, any>; role: 'agent' | 'runtime'; createdAt: number }
export type DeadLetter = Pending & { failedAt: number; reason: string }
export type SpoolStatus = { depth: number; oldestAgeMs: number; deadLetterDepth: number }

const ROLES: readonly Pending['role'][] = ['runtime', 'agent']
const DEAD_LETTER_DIR = 'dead-letter'

export function spoolDir(): string { return join(clydeHome(), 'memory-spool') }
function roleDir(dir: string, role: Pending['role']): string { return join(dir, role) }
function deadLetterDir(dir: string): string { return join(dir, DEAD_LETTER_DIR) }
function hash(data: string | Buffer): string { return createHash('sha256').update(data).digest('hex') }
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(', ')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${ascii(key)}: ${canonical(value[key])}`).join(', ')}}`
  return ascii(value)
}
function ascii(value: any): string { return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`) }
export function localId(payload: Record<string, any>): string {
  if (payload.id) return payload.id
  const withoutId = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'id'))
  const digest = hash(canonical(withoutId))
  const head = `${payload.scope ?? ''} ${payload.title ?? ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '')
  return head ? `${head}-${digest.slice(0, 8)}` : digest.slice(0, 8)
}
function pathFor(dir: string, id: string): string { return join(dir, `${encodeURIComponent(id)}.json`) }

function ownsUid(uid: number): boolean {
  return typeof process.getuid === 'function' ? uid === process.getuid() : true
}

function isSafeDir(dir: string): boolean {
  try {
    const st = lstatSync(dir)
    return st.isDirectory() && !st.isSymbolicLink() && ownsUid(st.uid) && (st.mode & 0o077) === 0
  } catch {
    return false
  }
}

function isSafeFile(path: string): boolean {
  try {
    const st = lstatSync(path)
    return st.isFile() && !st.isSymbolicLink() && ownsUid(st.uid) && (st.mode & 0o077) === 0
  } catch {
    return false
  }
}

function ensureSecureDir(target: string, stopAt?: string): void {
  const chain: string[] = []
  let cur = target
  while (!existsSync(cur)) {
    chain.push(cur)
    const parent = dirname(cur)
    if (parent === cur || cur === stopAt) break
    cur = parent
  }
  if (existsSync(cur) && !isSafeDir(cur)) {
    throw new Error(`Unsafe memory spool directory permissions or symlink at ${cur}`)
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    const d = chain[i]
    mkdirSync(d, { mode: 0o700 })
    chmodSync(d, 0o700)
  }
  if (!isSafeDir(target)) {
    throw new Error(`Unsafe memory spool directory permissions or symlink at ${target}`)
  }
}

function atomicWritePrivate(path: string, data: unknown): void {
  const dir = dirname(path)
  const tmp = join(dir, `.${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  const fd = openSync(tmp, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(data)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, path)
  const dirFd = openSync(dir, 'r')
  try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
}

export function validateAgentPayload(payload: Record<string, any>): void {
  if (!payload || typeof payload !== 'object') throw new Error('memory refused the entry (400): payload must be an object')
  if (payload.authority !== 'draft') throw new Error(`memory refused the entry (400): authority ${payload.authority} is above draft`)
  if (!/^run:[A-Za-z0-9._-]+$/.test(payload.scope ?? '')) throw new Error('memory refused the entry (400): An agent writes only in a run scope')
  if (payload.id) throw new Error('memory refused the entry (400): An agent cannot choose an id')
  if (payload.source) throw new Error('memory refused the entry (400): An agent cannot name a source')
}

export function pending(dir = spoolDir()): Pending[] {
  if (existsSync(dir) && !isSafeDir(dir)) return []
  const rows: Pending[] = []
  for (const dirRole of ROLES) {
    const sub = roleDir(dir, dirRole)
    if (!existsSync(sub) || !isSafeDir(sub)) continue
    let names: string[]
    try { names = readdirSync(sub).filter((name) => name.endsWith('.json')) } catch { continue }
    for (const name of names) {
      const file = join(sub, name)
      if (!isSafeFile(file)) continue
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Pending
        if (!parsed || typeof parsed.id !== 'string' || !parsed.payload || typeof parsed.payload !== 'object') continue
        if (name !== `${encodeURIComponent(parsed.id)}.json`) continue
        rows.push({ ...parsed, role: dirRole })
      } catch {
        // Skip corrupt/partial files.
      }
    }
  }
  return rows.sort((a, b) => {
    if (a.payload.project === b.id || a.payload.supersedes?.includes(b.id)) return 1
    if (b.payload.project === a.id || b.payload.supersedes?.includes(a.id)) return -1
    return a.createdAt - b.createdAt || (a.payload.pattern === 'projects' ? -1 : b.payload.pattern === 'projects' ? 1 : 0) || a.id.localeCompare(b.id)
  })
}

export function deadLetters(dir = spoolDir()): DeadLetter[] {
  const sub = deadLetterDir(dir)
  if (!existsSync(sub) || !isSafeDir(sub)) return []
  let names: string[]
  try { names = readdirSync(sub).filter((name) => name.endsWith('.json')) } catch { return [] }
  const rows: DeadLetter[] = []
  for (const name of names) {
    const file = join(sub, name)
    if (!isSafeFile(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as DeadLetter
      if (parsed && typeof parsed.id === 'string') rows.push(parsed)
    } catch { /* ignore corrupt */ }
  }
  return rows.sort((a, b) => a.failedAt - b.failedAt)
}

export function spoolStatus(dir = spoolDir(), now = Date.now()): SpoolStatus {
  const rows = pending(dir)
  return { depth: rows.length, oldestAgeMs: rows.length ? Math.max(0, now - rows[0].createdAt) : 0, deadLetterDepth: deadLetters(dir).length }
}

export function enqueue(payload: Record<string, any>, role: Pending['role'], dir = spoolDir()): Pending {
  const snapshot = JSON.parse(JSON.stringify(payload))
  if (role === 'agent') validateAgentPayload(snapshot)
  const id = localId(snapshot)
  const sub = roleDir(dir, role)
  ensureSecureDir(sub, dir)
  const path = pathFor(sub, id)
  if (existsSync(path)) {
    if (!isSafeFile(path)) throw new Error(`Unsafe spool entry at ${path}`)
    const old = JSON.parse(readFileSync(path, 'utf8')) as Pending
    if (canonical(old.payload) !== canonical(snapshot)) throw new Error(`memory entry ${id} has a different pending payload`)
    return { ...old, role }
  }
  const row: Pending = { id, payload: snapshot, role, createdAt: Date.now() }
  atomicWritePrivate(path, row)
  return row
}

export function quarantine(row: Pending, reason: string, dir = spoolDir()): DeadLetter {
  const sub = deadLetterDir(dir)
  ensureSecureDir(sub, dir)
  const dead: DeadLetter = { ...row, failedAt: Date.now(), reason }
  atomicWritePrivate(join(sub, `${row.role}-${encodeURIComponent(row.id)}.json`), dead)
  delivered(row, dir)
  return dead
}

export function delivered(row: Pending, dir = spoolDir()): void { rmSync(pathFor(roleDir(dir, row.role), row.id), { force: true }) }
export function blobRefs(payload: Record<string, any>): { name: string; sha256: string }[] {
  return (payload.blobs ?? []).map((blob: any) => ({ name: blob.name, sha256: hash(blob.text === undefined ? Buffer.from(blob.base64, 'base64') : blob.text) }))
}
export function localEntry(row: Pending): string {
  const e = row.payload
  const lines = [`# ${e.title}`, '', `id: ${row.id}`, `pattern: ${e.pattern}`, `authority: ${e.authority}`, `scope: ${e.scope}`]
  if (e.project) lines.push(`project: ${e.project}`)
  lines.push('', e.body, '', `Evidence (${e.evidence_kind}): ${e.evidence}`)
  if (e.sensitivity === 'private') lines.push('', `Blobs: ${blobRefs(e).length}`)
  else for (const blob of blobRefs(e)) lines.push(`Blob ${blob.name}: ${blob.sha256}`)
  return lines.join('\n')
}
export function localRecall(rows: Pending[], query: string, scope = '', task = ''): string {
  const words = (value: string) => new Set(value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3))
  const wanted = words(`${query} ${task}`)
  const superseded = new Set(rows.flatMap((row) => row.payload.supersedes ?? []))
  const hits = rows.filter((row) => !superseded.has(row.id) && (!String(row.payload.scope).startsWith('run:') || row.payload.scope === scope))
    .map((row) => ({ row, score: [...wanted].filter((word) => words(`${row.payload.title} ${row.payload.body}`).has(word)).length }))
    .filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).slice(0, 8)
  return hits.map(({ row }) => `- [${row.id}] ${row.payload.title}: ${row.payload.sensitivity === 'private' ? '(private)' : String(row.payload.body).slice(0, 200)}`).join('\n')
}
