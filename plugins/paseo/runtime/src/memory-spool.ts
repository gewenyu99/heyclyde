/** Durable pending memory entries shared by the daemon and worker processes. */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, openSync, closeSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, fsyncSync } from 'node:fs'
import { join } from 'node:path'
import { clydeHome } from './config.ts'

export type Pending = { id: string; payload: Record<string, any>; role: 'agent' | 'runtime'; createdAt: number }
export type SpoolStatus = { depth: number; oldestAgeMs: number }

export function spoolDir(): string { return join(clydeHome(), 'memory-spool') }
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
export function pending(dir = spoolDir()): Pending[] {
  let names: string[]
  try { names = readdirSync(dir).filter((name) => name.endsWith('.json')) } catch { return [] }
  return names.flatMap((name) => {
    try { return [JSON.parse(readFileSync(join(dir, name), 'utf8')) as Pending] } catch { return [] }
  }).sort((a, b) => {
    if (a.payload.project === b.id || a.payload.supersedes?.includes(b.id)) return 1
    if (b.payload.project === a.id || b.payload.supersedes?.includes(a.id)) return -1
    return a.createdAt - b.createdAt || (a.payload.pattern === 'projects' ? -1 : b.payload.pattern === 'projects' ? 1 : 0) || a.id.localeCompare(b.id)
  })
}
export function spoolStatus(dir = spoolDir(), now = Date.now()): SpoolStatus {
  const rows = pending(dir)
  return { depth: rows.length, oldestAgeMs: rows.length ? Math.max(0, now - rows[0].createdAt) : 0 }
}
export function enqueue(payload: Record<string, any>, role: Pending['role'], dir = spoolDir()): Pending {
  const snapshot = JSON.parse(JSON.stringify(payload))
  if (role === 'agent') {
    if (snapshot.authority !== 'draft') throw new Error(`memory refused the entry (400): authority ${snapshot.authority} is above draft`)
    if (!/^run:[A-Za-z0-9._-]+$/.test(snapshot.scope ?? '')) throw new Error('memory refused the entry (400): An agent writes only in a run scope')
    if (snapshot.id) throw new Error('memory refused the entry (400): An agent cannot choose an id')
    if (snapshot.source) throw new Error('memory refused the entry (400): An agent cannot name a source')
  }
  const id = localId(snapshot)
  const path = pathFor(dir, id)
  try {
    const old = JSON.parse(readFileSync(path, 'utf8')) as Pending
    if (canonical(old.payload) !== canonical(snapshot) || old.role !== role) throw new Error(`memory entry ${id} has a different pending payload`)
    return old
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const row = { id, payload: snapshot, role, createdAt: Date.now() }
  const tmp = join(dir, `.${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  const fd = openSync(tmp, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(row)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, path)
  const dirFd = openSync(dir, 'r')
  try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
  return row
}
export function delivered(row: Pending, dir = spoolDir()): void { rmSync(pathFor(dir, row.id), { force: true }) }
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
