/**
 * Tier 3 support: a local stand-in for the Supabase Storage routes the memory function calls, mounted on the same origin as
 * SUPABASE_URL (the fake Auth server) under /storage/v1, so CI never reaches Supabase. It keeps every object of the bucket
 * memory-blobs in memory, of any size (it does not enforce file_size_limit), with a created_at the test can set, and records
 * every request: method, path, headers and body. It answers 401 to a request without the service role key as its bearer, as
 * the real one does, except the signed upload PUT and the signed download GET, which carry a token instead.
 */
import { randomBytes } from 'node:crypto'
import type http from 'node:http'

export type StoredObject = { bytes: Buffer; contentType: string; createdAt: number; size: number }
export type Recorded = { method: string; path: string; headers: http.IncomingHttpHeaders; body: Buffer }

const BASE = '/storage/v1'
const BUCKET = 'memory-blobs'

export class FakeStorage {
  /** Object name (a sha256, or incoming/<sha256>) to its content. */
  objects = new Map<string, StoredObject>()
  requests: Recorded[] = []
  /** status answers every request with it, as an outage would. hang takes the request and never answers. writeDelayMs holds each object write. */
  mode: { status?: number; hang?: boolean; writeDelayMs?: number } = {}

  serviceKey: string
  syncDb?: (sqlText: string) => void

  constructor(serviceKey: string, syncDb?: (sqlText: string) => void) {
    this.serviceKey = serviceKey
    this.syncDb = syncDb
  }

  private sqlLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`

  private dbPut(name: string, size: number, contentType: string) {
    if (!this.syncDb) return
    const n = this.sqlLiteral(name), m = this.sqlLiteral(contentType)
    this.syncDb(`do $$ begin if to_regclass('storage.objects') is not null then
      delete from storage.objects where bucket_id = 'memory-blobs' and name = ${n};
      insert into storage.objects (bucket_id, name, metadata)
        values ('memory-blobs', ${n}, jsonb_build_object('size', ${Math.trunc(size)}, 'mimetype', ${m}));
    end if; end $$;`)
  }

  private dbMove(sourceKey: string, destinationKey: string) {
    if (!this.syncDb) return
    const src = this.sqlLiteral(sourceKey), dst = this.sqlLiteral(destinationKey)
    this.syncDb(`do $$ begin if to_regclass('storage.objects') is not null then
      update storage.objects set name = ${dst} where bucket_id = 'memory-blobs' and name = ${src};
    end if; end $$;`)
  }

  private dbDelete(prefixes: string[]) {
    if (!this.syncDb || !prefixes.length) return
    const list = prefixes.map(this.sqlLiteral).join(', ')
    this.syncDb(`do $$ begin if to_regclass('storage.objects') is not null then
      delete from storage.objects where bucket_id = 'memory-blobs' and name in (${list});
    end if; end $$;`)
  }

  /** Puts an object directly. size is what its info reports, for an object too big to send. */
  put(name: string, bytes: Buffer, o: { createdAt?: number; size?: number; contentType?: string } = {}) {
    this.objects.set(name, { bytes, contentType: o.contentType ?? 'application/octet-stream', createdAt: o.createdAt ?? Date.now(), size: o.size ?? bytes.length })
  }

  /** The requests since index `from` whose method is one of `methods` (any when none) and whose path contains `part`. */
  count(part: string, methods: string[] = [], from = 0): number {
    return this.requests.slice(from).filter((r) => r.path.includes(part) && (!methods.length || methods.includes(r.method))).length
  }

  /** Names of the objects that are not under incoming/. */
  settled(): string[] {
    return [...this.objects.keys()].filter((n) => !n.startsWith('incoming/'))
  }

  handle = (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): boolean => {
    const url = new URL(req.url ?? '/', 'http://fake')
    if (!url.pathname.startsWith(`${BASE}/`)) return false
    const method = req.method ?? 'GET'
    this.requests.push({ method, path: url.pathname, headers: req.headers, body })
    if (this.mode.hang) return true
    const reply = (status: number, out: unknown, headers: Record<string, string> = {}) => {
      const raw = Buffer.isBuffer(out) ? out : Buffer.from(JSON.stringify(out))
      res.writeHead(status, { 'content-type': Buffer.isBuffer(out) ? (headers['content-type'] ?? 'application/octet-stream') : 'application/json', 'content-length': raw.length, ...headers })
      res.end(raw)
    }
    if (this.mode.status) return reply(this.mode.status, { message: 'fake Storage is down' }), true
    const rest = decodeURIComponent(url.pathname.slice(BASE.length))
    const token = url.searchParams.get('token')
    const authed = req.headers.authorization === `Bearer ${this.serviceKey}` && req.headers.apikey === this.serviceKey
    let m: RegExpExecArray | null
    const store = (name: string, contentType: string) => {
      const write = () => {
        this.put(name, body, { contentType })
        this.dbPut(name, body.length, contentType)
        reply(200, { Key: `${BUCKET}/${name}` })
      }
      if (this.mode.writeDelayMs) setTimeout(write, this.mode.writeDelayMs)
      else write()
    }
    const serve = (name: string) => {
      const o = this.objects.get(name)
      if (!o) return reply(404, { statusCode: '404', error: 'not_found', message: 'Object not found' })
      reply(200, o.bytes, { 'content-type': o.contentType })
    }

    // The signed upload: POST mints it, PUT takes the file with the minted token.
    if ((m = /^\/object\/upload\/sign\/memory-blobs\/(.+)$/.exec(rest))) {
      if (method === 'POST') {
        if (!authed) return reply(401, { message: 'unauthorized' }), true
        return reply(200, { url: `/object/upload/sign/${BUCKET}/${m[1]}?token=up-${randomBytes(6).toString('hex')}` }), true
      }
      if (method === 'PUT' && token?.startsWith('up-')) return store(m[1], String(req.headers['content-type'] ?? 'application/octet-stream')), true
      return reply(400, { message: 'bad signed upload' }), true
    }
    // The signed download: GET with the token memory's sign call made.
    if (method === 'GET' && (m = /^\/object\/sign\/memory-blobs\/(.+)$/.exec(rest)) && token?.startsWith('dl-')) return serve(m[1]), true
    if (!authed) return reply(401, { message: 'unauthorized' }), true

    if (method === 'POST' && (m = /^\/object\/sign\/memory-blobs\/(.+)$/.exec(rest))) {
      if (!this.objects.has(m[1])) return reply(400, { statusCode: '404', error: 'not_found', message: 'Object not found' }), true
      return reply(200, { signedURL: `/object/sign/${BUCKET}/${m[1]}?token=dl-${randomBytes(6).toString('hex')}` }), true
    }
    if (method === 'GET' && (m = /^\/object\/info\/memory-blobs\/(.+)$/.exec(rest))) {
      const o = this.objects.get(m[1])
      return o ? reply(200, { name: m[1], size: o.size, content_type: o.contentType, created_at: new Date(o.createdAt).toISOString() }) : reply(404, { error: 'not_found' }), true
    }
    if (method === 'POST' && rest === '/object/move') {
      const { sourceKey, destinationKey } = JSON.parse(body.toString('utf8'))
      const o = this.objects.get(sourceKey)
      if (!o) return reply(400, { statusCode: '404', error: 'not_found', message: 'Object not found' }), true
      if (this.objects.has(destinationKey)) return reply(409, { error: 'Duplicate' }), true
      this.objects.delete(sourceKey)
      this.objects.set(destinationKey, o)
      this.dbMove(sourceKey, destinationKey)
      return reply(200, { message: 'Successfully moved' }), true
    }
    if (method === 'DELETE' && rest === `/object/${BUCKET}`) {
      const prefixes = JSON.parse(body.toString('utf8')).prefixes as string[]
      for (const p of prefixes) this.objects.delete(p)
      this.dbDelete(prefixes)
      return reply(200, []), true
    }
    if (method === 'POST' && rest === `/object/list/${BUCKET}`) {
      const { prefix = '', limit = 100, offset = 0 } = JSON.parse(body.toString('utf8') || '{}')
      const names = [...this.objects.entries()].filter(([n]) => n.startsWith(prefix ? `${prefix}/` : '') && !n.slice(prefix ? prefix.length + 1 : 0).includes('/'))
        .slice(offset, offset + limit).map(([n, o]) => ({ name: n.slice(prefix ? prefix.length + 1 : 0), created_at: new Date(o.createdAt).toISOString() }))
      return reply(200, names), true
    }
    if (method === 'POST' && (m = new RegExp(`^/object/${BUCKET}/(.+)$`).exec(rest))) return store(m[1], String(req.headers['content-type'] ?? 'application/octet-stream')), true
    if (method === 'GET' && (m = new RegExp(`^/object/${BUCKET}/(.+)$`).exec(rest))) return serve(m[1]), true
    return reply(404, { message: `fake Storage has no ${method} ${rest}` }), true
  }
}
