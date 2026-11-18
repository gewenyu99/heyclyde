/** An in-process fake of the memory HTTP routes: two tokens, the draft and run-scope rules, keyword recall, and a calls log. */
import { createHash } from 'node:crypto'
import http from 'node:http'

export type Entry = Record<string, any> & { id: string; digest: string; blobShas: { name: string; sha256: string }[] }
export type Call = { method: string; path: string; role: string | null; body: unknown; status: number }
export type FakeMemory = {
  url: string; token: string; runtimeToken: string
  entries: Map<string, Entry>; blobs: Map<string, { text: string; mediaType: string }>
  hooks: { event: string; payload: any }[]; calls: Call[]
  close: () => Promise<void>
}

const PATTERNS = new Set(['projects', 'decisions', 'observations', 'preferences', 'recommendations', 'references', 'reactions'])
const EVIDENCE_KINDS = new Set(['quote', 'assistant', 'summary', 'memory'])
const FIELDS = new Set(['id', 'pattern', 'title', 'body', 'authority', 'scope', 'sensitivity', 'lang', 'valid_from', 'source',
  'evidence_kind', 'evidence', 'project', 'links', 'supersedes', 'blobs'])
const RANK: Record<string, number> = { draft: 0, observed: 1, approved: 2 }
const MAX_FOR: Record<string, string> = { agent: 'draft', runtime: 'approved' }
const SCOPE_RE = /^(global|domain:[a-z0-9-]+|repo:[A-Za-z0-9._/-]+|run:[A-Za-z0-9._-]+)$/
const MAX_CHARS: Record<string, number> = { title: 300, body: 4000, evidence: 20000 }
const MAX_REQUEST = 12 * 1024 * 1024
export const PRIVATE_BLOB = '[private blob: ask Wen]'

function sha(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '')
}

function sortedJson(v: unknown): string {
  const ascii = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(', ')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${ascii(k)}: ${sortedJson((v as any)[k])}`).join(', ')}}`
  return ascii(v)
}

/** The write rules from memory/supabase/functions/memory/write.ts that a test can trip: one problem per line, or the entry to store. */
function validate(p: any, role: string, entries: Map<string, Entry>): string[] | Entry {
  const errs: string[] = []
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['An entry is a JSON object.']
  for (const k of Object.keys(p).sort()) if (!FIELDS.has(k)) errs.push(`Unknown field ${k}.`)
  const agent = role === 'agent'
  const authority = p.authority
  if (!PATTERNS.has(p.pattern)) errs.push(`pattern must be one of ${[...PATTERNS].sort().join(', ')}.`)
  if (!(typeof p.title === 'string' && p.title.trim())) errs.push('title is required.')
  if (!(typeof p.body === 'string' && p.body.trim())) errs.push("body is required. It's the summary recall ranks on.")
  for (const [f, cap] of Object.entries(MAX_CHARS)) {
    if (typeof p[f] === 'string' && p[f].trim().length > cap) errs.push(`${f} is ${p[f].trim().length} characters. The limit is ${cap}, so put long material in a blob.`)
  }
  if (!(authority in RANK)) errs.push('authority must be draft, observed or approved.')
  else if (RANK[authority] > RANK[MAX_FOR[role]]) errs.push(`authority ${authority} is above ${MAX_FOR[role]}, the most this caller may write.`)
  if (!(typeof p.scope === 'string' && SCOPE_RE.test(p.scope))) errs.push(`scope '${p.scope}' must be global, domain:<x>, repo:<x> or run:<id>.`)
  else if (agent && !p.scope.startsWith('run:')) errs.push(`An agent writes only in a run scope, run:<id>, not ${p.scope}. Wen or clyde-flow promotes notes wider.`)
  if (!EVIDENCE_KINDS.has(p.evidence_kind)) errs.push(`evidence_kind must be one of ${[...EVIDENCE_KINDS].sort().join(', ')}.`)
  if (!(typeof p.evidence === 'string' && p.evidence.trim())) errs.push("evidence is required and can't be empty.")
  if (p.evidence_kind === 'quote' && authority === 'draft') errs.push("A quote of Wen can't back a draft.")
  if (p.project == null && p.pattern !== 'projects') errs.push("project is required unless pattern is projects. It's the id of the projects entry this belongs to.")
  if (p.project != null) {
    const proj = entries.get(p.project)
    if (!proj || proj.pattern !== 'projects') errs.push(`project ${p.project} is not a projects entry memory has.`)
  }
  if (agent && 'source' in p) errs.push("An agent can't name a source. memory records the write as an agent session.")
  if (agent && p.id) errs.push("An agent can't choose an id. memory generates one from the payload.")
  if (!agent && !(p.source && typeof p.source === 'object' && (p.source.id || (p.source.kind && p.source.title)))) {
    errs.push('source is required: {kind, title, uri} for a new one, or {id} for one memory already has.')
  }
  const blobs = Array.isArray(p.blobs) ? p.blobs : []
  if (blobs.length > 16) errs.push('An entry takes 16 blobs at most.')
  for (const b of blobs) if (!b?.name || (typeof b.text !== 'string' && typeof b.base64 !== 'string')) errs.push('Every blob needs a name and text or base64.')
  for (const id of p.supersedes ?? []) {
    const old = entries.get(id)
    if (!old) errs.push(`supersedes ${id}, which memory doesn't have.`)
    else if (RANK[old.authority] > RANK[authority]) errs.push(`An entry supersedes only entries at or below its own authority, and ${id} is ${old.authority}.`)
    else if (String(p.scope).startsWith('run:') && old.scope !== p.scope) errs.push(`A run entry supersedes only entries in its own run, and ${id} is in ${old.scope}.`)
  }
  if (errs.length) return errs
  const digest = sha(sortedJson(Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'id'))))
  const head = slug(`${p.scope} ${p.title}`)
  const id = !agent && p.id ? p.id : head ? `${head}-${digest.slice(0, 8)}` : digest.slice(0, 8)
  const taken = entries.get(id)
  if (taken && taken.digest !== digest) return [`id ${id} is taken by a different entry.`]
  return { ...p, id, digest, sensitivity: p.sensitivity ?? 'normal', blobShas: [], source: agent ? { kind: 'session', title: 'An agent session, through remember' } : p.source }
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3))
}

function render(e: Entry): string {
  const lines = [`# ${e.title}`, '', `id: ${e.id}`, `pattern: ${e.pattern}`, `authority: ${e.authority}`, `scope: ${e.scope}`]
  if (e.project) lines.push(`project: ${e.project}`)
  lines.push('', e.body, '', `Evidence (${e.evidence_kind}): ${e.evidence}`)
  if (e.sensitivity === 'private') lines.push('', `Blobs: ${e.blobShas.length}`)
  else for (const b of e.blobShas) lines.push(`Blob ${b.name}: ${b.sha256}`)
  return lines.join('\n')
}

export async function startFakeMemory(opts: { token?: string; runtimeToken?: string } = {}): Promise<FakeMemory> {
  const token = opts.token ?? 'agent-token'
  const runtimeToken = opts.runtimeToken ?? 'runtime-token'
  const entries = new Map<string, Entry>()
  const blobs = new Map<string, { text: string; mediaType: string }>()
  const hooks: { event: string; payload: any }[] = []
  const calls: Call[] = []
  let retrievals = 0

  const roleOf = (h?: string) => (h === `Bearer ${token}` ? 'agent' : h === `Bearer ${runtimeToken}` ? 'runtime' : null)

  function remember(body: any, role: string): [number, unknown] {
    const e = validate(body, role, entries)
    if (Array.isArray(e)) return [400, { error: e.join('\n') }]
    const existing = entries.get(e.id)
    if (existing) return [200, { id: existing.id, blobs: existing.blobShas, embedded: false }]
    for (const b of body.blobs ?? []) {
      const data = typeof b.text === 'string' ? b.text : Buffer.from(b.base64, 'base64').toString('utf8')
      const s = sha(typeof b.text === 'string' ? b.text : Buffer.from(b.base64, 'base64'))
      blobs.set(s, { text: data, mediaType: b.media_type ?? 'text/plain' })
      e.blobShas.push({ name: b.name, sha256: s })
    }
    entries.set(e.id, e)
    return [200, { id: e.id, blobs: e.blobShas, embedded: false }]
  }

  function recall(body: any): [number, unknown] {
    const { query, task = '', scope = '' } = body ?? {}
    if (!(typeof query === 'string' && query.trim()) || typeof task !== 'string' || typeof scope !== 'string') {
      return [400, { error: 'body must be {query, task, scope}, with a non-empty query' }]
    }
    if (scope && !scope.startsWith('run:')) return [400, { error: `scope ${scope} must be run:<id>` }]
    const want = words(`${query} ${task}`)
    const superseded = new Set([...entries.values()].flatMap((e) => e.supersedes ?? []))
    const scored = [...entries.values()]
      .filter((e) => !superseded.has(e.id))
      .filter((e) => !String(e.scope).startsWith('run:') || e.scope === scope)
      .map((e) => {
        const have = words(`${e.title} ${e.body}`)
        const hits = [...want].filter((w) => have.has(w)).length
        return { e, score: hits * (scope && e.scope === scope ? 3 : 1) }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
    const lines = [`retrieval r-${++retrievals}`]
    for (const { e } of scored) lines.push(`- [${e.id}] ${e.title}: ${e.sensitivity === 'private' ? '(private)' : e.body.slice(0, 200)}`)
    if (!scored.length) lines.push('No matching entries.')
    return [200, lines.join('\n')]
  }

  function route(method: string, path: string, body: any, role: string): [number, unknown] {
    if (method === 'POST' && path === '/entries') return remember(body, role)
    if (method === 'POST' && path === '/recall') return recall(body)
    let m = path.match(/^\/entries\/([^/]+)$/)
    if (method === 'GET' && m) {
      const e = entries.get(decodeURIComponent(m[1]))
      return e ? [200, render(e)] : [404, { error: 'no such entry' }]
    }
    m = path.match(/^\/blobs\/([0-9a-f]+)$/)
    if (method === 'GET' && m) {
      const b = blobs.get(m[1])
      if (!b) return [404, { error: 'no such blob' }]
      const holders = [...entries.values()].filter((e) => e.blobShas.some((x) => x.sha256 === m![1]))
      if (holders.every((e) => e.sensitivity === 'private')) return [403, { error: PRIVATE_BLOB }]
      return [200, b.text]
    }
    m = path.match(/^\/hooks\/([^/]+)$/)
    if (method === 'POST' && m) {
      hooks.push({ event: decodeURIComponent(m[1]), payload: body })
      return [200, { ok: true }]
    }
    return [404, { error: `no route ${method} ${path}` }]
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size <= MAX_REQUEST) chunks.push(c)
    })
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      const method = req.method ?? 'GET'
      const reply = (status: number, out: unknown, role: string | null, body: unknown) => {
        calls.push({ method, path, role, body, status })
        const text = typeof out === 'string' ? out : JSON.stringify(out)
        res.writeHead(status, { 'content-type': typeof out === 'string' ? 'text/plain; charset=utf-8' : 'application/json' })
        res.end(text)
      }
      if (path === '/healthz') return reply(200, { ok: true }, null, null)
      const role = roleOf(req.headers.authorization)
      if (!role) return reply(401, { error: 'unauthorized' }, null, null)
      if (size > MAX_REQUEST) return reply(413, { error: 'request body too large' }, role, null)
      let body: any = null
      const text = Buffer.concat(chunks).toString('utf8')
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          return reply(400, { error: 'body must be JSON' }, role, text)
        }
      }
      const [status, out] = route(method, path, body, role)
      reply(status, out, role, body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`, token, runtimeToken, entries, blobs, hooks, calls,
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
