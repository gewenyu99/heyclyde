/** The daemon's HTTP plumbing: routes with :params, bearer auth, JSON bodies up to 1 MiB, and JSON replies. */
import { timingSafeEqual } from 'node:crypto'
import http from 'node:http'

export const MAX_BODY = 1024 * 1024

export type Req = {
  method: string; path: string; params: Record<string, string>; query: URLSearchParams; body: any
  raw: http.IncomingMessage; res: http.ServerResponse
}
export type Reply = { status?: number; body: unknown }
// A handler that returns nothing has taken over the response itself, as the SSE route does.
export type Route = { method: string; path: string; public?: boolean; handle: (req: Req) => Promise<Reply | void> | Reply | void }

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function createServer(routes: Route[], token: string): http.Server {
  const expected = Buffer.from(`Bearer ${token}`)
  return http.createServer((raw, res) => {
    handle(routes, expected, raw, res).catch((err) => send(res, statusOf(err), { error: (err as Error).message }))
  })
}

async function handle(routes: Route[], expected: Buffer, raw: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(raw.url ?? '/', 'http://127.0.0.1')
  const method = raw.method ?? 'GET'
  const found = match(routes, method, url.pathname)
  if (!found) return send(res, 404, { error: `no route ${method} ${url.pathname}` })
  if (!found.route.public && !authorized(raw.headers.authorization, expected)) return send(res, 401, { error: 'unauthorized' })
  const body = method === 'GET' || method === 'HEAD' ? {} : await readBody(raw)
  const reply = await found.route.handle({ method, path: url.pathname, params: found.params, query: url.searchParams, body, raw, res })
  if (reply) send(res, reply.status ?? 200, reply.body)
}

function authorized(header: string | undefined, expected: Buffer): boolean {
  const got = Buffer.from(header ?? '')
  return got.length === expected.length && timingSafeEqual(got, expected)
}

function match(routes: Route[], method: string, path: string): { route: Route; params: Record<string, string> } | null {
  const parts = path.split('/').filter(Boolean)
  for (const route of routes) {
    if (route.method !== method) continue
    const want = route.path.split('/').filter(Boolean)
    if (want.length !== parts.length) continue
    const params: Record<string, string> = {}
    const ok = want.every((w, i) => {
      if (!w.startsWith(':')) return w === parts[i]
      params[w.slice(1)] = decodeURIComponent(parts[i])
      return true
    })
    if (ok) return { route, params }
  }
  return null
}

function readBody(raw: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    raw.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'body is over 1 MiB'))
        raw.resume()
        return
      }
      chunks.push(c)
    })
    raw.on('error', reject)
    raw.on('end', () => {
      if (size > MAX_BODY) return
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new HttpError(400, 'body must be JSON'))
      }
    })
  })
}

function statusOf(err: unknown): number {
  return err instanceof HttpError ? err.status : 500
}

export function send(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}
