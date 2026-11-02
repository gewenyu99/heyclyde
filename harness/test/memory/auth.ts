/**
 * Tier 3 support: a local stand-in for the two Supabase Auth routes the memory function calls without a browser, so CI
 * never reaches Supabase. The function reads its address from SUPABASE_URL. /auth/v1/user answers for any token jwt()
 * made, as the user its email claim names, confirmed. /auth/v1/otp takes every sign-in email and only records it.
 */
import http from 'node:http'

export type FakeAuth = { url: string; calls: { method: string; path: string; body: any }[]; close: () => Promise<void> }

const b64url = (text: string) => Buffer.from(text).toString('base64url')

/** A Supabase Auth access token for these claims. Only the fake reads it, so the signature is made up. Give each test
 * its own jti, since memory caches a token's answer for a minute. */
export function jwt(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.fake-signature`
}

function claimsOf(header: string): Record<string, any> | null {
  try {
    return JSON.parse(Buffer.from(header.replace(/^Bearer /, '').split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

export async function startFakeAuth(): Promise<FakeAuth> {
  const calls: FakeAuth['calls'] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://fake').pathname
      let body: any = null
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
      } catch {
        // Not JSON. Recorded as null.
      }
      calls.push({ method: req.method ?? '', path, body })
      const reply = (status: number, out: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(out))
      }
      if (!req.headers.apikey) return reply(401, { msg: 'No API key found in request' })
      if (req.method === 'GET' && path === '/auth/v1/user') {
        const claims = claimsOf(req.headers.authorization ?? '')
        if (!claims?.email) return reply(401, { msg: 'invalid JWT' })
        return reply(200, { id: claims.sub ?? 'fake-user', email: claims.email, email_confirmed_at: '2026-11-01T00:00:00Z' })
      }
      if (req.method === 'POST' && path === '/auth/v1/otp') return reply(200, {})
      reply(404, { msg: `fake Supabase Auth has no ${req.method} ${path}` })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }) }
}
