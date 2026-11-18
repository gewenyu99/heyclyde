/**
 * Tier 3 support: a local stand-in for the two Supabase Auth routes the memory function calls without a browser, so CI
 * never reaches Supabase. The function reads its address from SUPABASE_URL. /auth/v1/user answers for any token jwt()
 * made, as the user its email claim names, confirmed. /auth/v1/otp takes every sign-in email and only records it.
 * For /oauth/approve (R45): /auth/v1/token?grant_type=pkce trades a code in `signIns` for a session as that email, and
 * /auth/v1/oauth/authorizations/<id> describes the request in `authorizations`, whose /consent answers with a redirect to
 * its redirect_uri carrying a code (approve) or error=access_denied (deny).
 */
import { createHash } from 'node:crypto'
import http from 'node:http'

export type FakeAuth = {
  url: string
  calls: { method: string; path: string; body: any }[]
  /** A PKCE auth code and the email it signs in. */
  signIns: Record<string, string>
  /** An email and its password, for password sign-in (R55). */
  passwords: Record<string, string>
  /** An authorization request by id: where its code goes and the client that asked. */
  authorizations: Record<string, { redirect_uri: string; client: { id: string; name: string } }>
  /** When non-null, POST /auth/v1/otp replies with this status and JSON body instead of 200. */
  otpFailure: { status: number; body: unknown } | null
  close: () => Promise<void>
}

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

/** extra answers first: a route table mounted on the same origin, like the fake Storage under /storage/v1. */
export async function startFakeAuth(extra?: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => boolean): Promise<FakeAuth> {
  const calls: FakeAuth['calls'] = []
  const signIns: FakeAuth['signIns'] = {}
  const passwords: FakeAuth['passwords'] = {}
  const authorizations: FakeAuth['authorizations'] = {}
  const state: FakeAuth = {
    url: '',
    calls,
    signIns,
    passwords,
    authorizations,
    otpFailure: null,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      if (extra?.(req, res, Buffer.concat(chunks))) return
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
        // A token with unconfirmed: true is a user who never clicked their confirmation link.
        return reply(200, { id: claims.sub ?? 'fake-user', email: claims.email, email_confirmed_at: claims.unconfirmed ? null : '2026-11-01T00:00:00Z' })
      }
      if (req.method === 'POST' && path === '/auth/v1/otp') {
        if (state.otpFailure) return reply(state.otpFailure.status, state.otpFailure.body)
        return reply(200, {})
      }
      if (req.method === 'POST' && path === '/auth/v1/token' && new URL(req.url ?? '/', 'http://fake').searchParams.get('grant_type') === 'password') {
        const email = String(body?.email ?? '')
        if (!email || passwords[email] === undefined || passwords[email] !== body?.password) return reply(400, { msg: 'Invalid login credentials' })
        const h = createHash('sha256').update(email).digest('hex')
        const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
        return reply(200, { access_token: jwt({ sub: id, email }), user: { id, email, email_confirmed_at: '2026-11-01T00:00:00Z', factors: [] } })
      }
      if (req.method === 'POST' && path === '/auth/v1/token') {
        const email = signIns[body?.auth_code]
        if (!email || !body?.code_verifier) return reply(400, { msg: 'invalid flow state' })
        // A stable uuid per email, as Supabase Auth gives each user one.
        const h = createHash('sha256').update(email).digest('hex')
        const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
        return reply(200, { access_token: jwt({ sub: id, email }), user: { id, email, email_confirmed_at: '2026-11-01T00:00:00Z' } })
      }
      const oauth = /^\/auth\/v1\/oauth\/authorizations\/([^/]+)(\/consent)?$/.exec(path)
      if (oauth) {
        const found = authorizations[decodeURIComponent(oauth[1])]
        if (!claimsOf(req.headers.authorization ?? '')?.email) return reply(401, { msg: 'invalid JWT' })
        if (!found) return reply(404, { msg: 'authorization not found' })
        if (req.method === 'GET' && !oauth[2]) return reply(200, { authorization_id: oauth[1], ...found })
        if (req.method === 'POST' && oauth[2]) {
          const to = new URL(found.redirect_uri)
          if (body?.action === 'approve') to.searchParams.set('code', `code-${oauth[1]}`)
          else to.searchParams.set('error', 'access_denied')
          return reply(200, { redirect_url: to.toString() })
        }
      }
      reply(404, { msg: `fake Supabase Auth has no ${req.method} ${path}` })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  state.url = `http://127.0.0.1:${port}`
  return state
}
