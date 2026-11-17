/** One HTTP request over node:http or node:https. Not fetch, since pi swaps fetch for a proxy-aware one that breaks on localhost. */
import http from 'node:http'
import https from 'node:https'

export type Response = { status: number; text: string; headers: http.IncomingHttpHeaders }

export type RequestOptions = { headers?: Record<string, string>; body?: unknown; timeoutMs?: number }

export function request(method: string, url: string, opts: RequestOptions = {}): Promise<Response> {
  const target = new URL(url)
  const lib = target.protocol === 'https:' ? https : http
  const body = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
  const headers: Record<string, string> = { ...opts.headers }
  if (body !== undefined) {
    headers['content-type'] ??= 'application/json'
    headers['content-length'] = String(Buffer.byteLength(body))
  }
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (fn: () => void) => {
      clearTimeout(timer)
      fn()
    }
    const req = lib.request(target, { method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => done(() => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers })))
      res.on('error', (err) => done(() => reject(err)))
    })
    req.on('error', (err) => done(() => reject(err)))
    // A whole-request deadline, since a server that trickles bytes would dodge an idle timeout.
    if (opts.timeoutMs) {
      timer = setTimeout(() => req.destroy(new Error(`${method} ${target.pathname} timed out after ${opts.timeoutMs} ms`)), opts.timeoutMs)
    }
    req.end(body)
  })
}
