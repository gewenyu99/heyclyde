/**
 * Tier 3: R54 (#59), anyone outside the blocked regions signs up for Clyde, and the first 1,000 get the free allocation.
 * Against the real memory function with sign-in open (setting open_signup), behind the Worker's proxy secret, with a fake
 * Supabase Auth and server.ts's fake Turnstile siteverify: the token "pass" with the test secret is a person, nothing else is.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { request } from '../../src/request.ts'
import { jwt } from './auth.ts'
import { bearer, nonce } from './bed.ts'
import { putSecret, setSetting, sha } from './billing.ts'
import { exec, SKIP, sql, startRealMemory, TURNSTILE_SECRET, type RealMemory } from './server.ts'

const PROXY = `proxy-${nonce()}`
let memory: RealMemory

before(async () => {
  if (SKIP) return
  memory = await startRealMemory()
  setSetting('open_signup', 'on')
  setSetting('proxy_secret_sha256', sha(PROXY))
})

after(async () => {
  await memory?.close()
})

const proxied = (country: string, region?: string) =>
  ({ 'x-memory-proxy': PROXY, 'cf-ipcountry': country, ...(region ? { 'cf-region-code': region } : {}), 'x-memory-client': `198.51.100.${Math.floor(Math.random() * 200) + 1}` })
const otps = () => memory.auth.calls.filter((c) => c.path === '/auth/v1/otp').length
const signUp = (headers: Record<string, string>, form: Record<string, string>) =>
  request('POST', `${memory.url}/oauth/consent?authorization_id=auth-${nonce()}`, {
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(), timeoutMs: 30_000,
  })
const email = () => `s-${nonce()}@example.com`

test('R54: region block', { skip: SKIP }, async () => {
  for (const [c, r] of [['DE'], ['GB'], ['CH'], ['CA', 'QC']] as [string, string?][]) {
    const n = otps()
    const res = await signUp(proxied(c, r), { email: email(), 'cf-turnstile-response': 'pass' })
    assert.equal(res.status, 451, `${c} ${r ?? ''}: ${res.text}`)
    assert.ok(res.text.includes("Clyde isn't available in your country"), res.text)
    assert.equal(otps(), n, `${c}: no email`)
  }
  for (const [c, r] of [['US'], ['CA', 'ON']] as [string, string?][]) {
    const n = otps()
    const res = await signUp(proxied(c, r), { email: email(), 'cf-turnstile-response': 'pass' })
    assert.equal(res.status, 200, `${c}: ${res.text}`)
    assert.equal(otps(), n + 1)
  }
})

test('R54: slot 1,000 is taken once', { skip: SKIP }, async () => {
  exec(`update memory.account set free_slot = false;
    insert into memory.account (owner_id, email, email_confirmed, free_slot)
    select gen_random_uuid(), 'held-' || g || '-${nonce()}@example.com', true, true from generate_series(1, 2) g;
    update memory.plan set seats = 3 where id = 'free';`)
  try {
    const ids = Array.from({ length: 5 }, () => randomUUID())
    await Promise.all(ids.map(async (id) => {
      const r = await request('POST', `${memory.url}/mcp`, {
        headers: bearer(jwt({ sub: id, email: email(), client_id: 'claude-test', jti: randomUUID() })), timeoutMs: 60_000,
        body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-ai' } } },
      })
      assert.equal(r.status, 200, r.text)
    }))
    const got = Number(sql(`select count(*)::int as n from memory.account where free_slot and owner_id = any(array[${ids.map((i) => `'${i}'`).join(',')}]::uuid[])`)[0].n)
    assert.equal(got, 1)
    assert.equal(Number(sql(`select count(*)::int as n from memory.account where free_slot`)[0].n), 3)
  } finally {
    sql(`update memory.plan set seats = 1000 where id = 'free'`)
  }
})

// R80 (like-vincent #85): a failed check puts the form back, with the address and an error, and sends nothing.
test('R80: a failed check asks again', { skip: SKIP }, async () => {
  const n = otps()
  const plain = await request('GET', `${memory.url}/oauth/consent?authorization_id=auth-${nonce()}`, { headers: { ...proxied('US'), accept: 'application/json' }, timeoutMs: 30_000 })
  const key = JSON.parse(plain.text).turnstile_site_key
  for (const form of [{ email: email(), 'cf-turnstile-response': 'bot' }, { email: email() }]) {
    const r = await request('POST', `${memory.url}/oauth/consent?authorization_id=auth-${nonce()}`, {
      headers: { ...proxied('US'), accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(), timeoutMs: 30_000,
    })
    assert.equal(r.status, 400, r.text)
    const body = JSON.parse(r.text)
    assert.equal(body.state, 'ask_email', r.text)
    assert.equal(body.email, form.email)
    assert.ok(typeof body.error === 'string' && body.error.length > 0, r.text)
    assert.equal(body.turnstile_site_key, key)
  }
  assert.equal(otps(), n)
})

test('R54: turnstile required', { skip: SKIP }, async () => {
  const n = otps()
  const missing = await signUp(proxied('US'), { email: email() })
  assert.equal(missing.status, 400, missing.text)
  const failing = await signUp(proxied('US'), { email: email(), 'cf-turnstile-response': 'bot' })
  assert.equal(failing.status, 400, failing.text)
  assert.equal(otps(), n)
  assert.ok(memory.turnstile.calls.some((v) => v.response === 'bot' && v.secret === TURNSTILE_SECRET), 'siteverify heard the token with the secret')
  sql(`delete from vault.secrets where name = 'turnstile_secret'`)
  // The function caches Vault for a minute, so a second instance on the same database reads it fresh.
  try {
    const { startSibling } = await import('./server.ts')
    const sibling = await startSibling(memory)
    try {
      const unset = await request('POST', `${sibling.url}/oauth/consent?authorization_id=auth-${nonce()}`, {
        headers: { ...proxied('US'), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: email(), 'cf-turnstile-response': 'pass' }).toString(), timeoutMs: 30_000,
      })
      assert.equal(unset.status, 503, unset.text)
      assert.equal(otps(), n)
    } finally {
      await sibling.close()
    }
  } finally {
    putSecret('turnstile_secret', TURNSTILE_SECRET)
  }
})

test('R54: store callbacks', { skip: SKIP }, async () => {
  const approve = async (redirect_uri: string) => {
    const auth = `auth-${nonce()}`, who = email()
    memory.auth.signIns[`code-${auth}`] = who
    memory.auth.authorizations[auth] = { redirect_uri, client: { id: `client-${nonce()}`, name: 'App' } }
    exec(`insert into memory.oauth_consent (authorization_id, code_verifier) values ('${auth}', 'verifier-${nonce()}');`)
    return await request('GET', `${memory.url}/oauth/approve?authorization_id=${auth}&code=code-${auth}`, { timeoutMs: 30_000 })
  }
  for (const uri of ['https://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1:53111/callback',
    'https://chatgpt.com/connector_platform_oauth_redirect', 'https://chat.openai.com/connector_platform_oauth_redirect',
    'https://platform.openai.com/oauth/callback', 'https://openai.com/oauth/callback',
    'https://antigravity.google/oauth-callback', 'https://grok.com/callback', 'https://gemini.google.com/callback']) {
    const r = await approve(uri)
    assert.equal(r.status, 200, `${uri}: ${r.text}`)
    assert.match(r.text, /connected/)
  }
  const denies = () => Number(sql(`select count(*)::int as n from memory.admin_audit where action = 'oauth_deny'`)[0].n)
  const before = denies()
  for (const uri of ['https://evil.example/cb', 'https://chatgpt.com.evil.example/cb']) {
    const r = await approve(uri)
    assert.equal(r.status, 403, `${uri}: ${r.text}`)
    assert.match(r.text, /refused/)
  }
  assert.equal(denies(), before + 2)
})

test('R54: a closed door says so', { skip: SKIP }, async () => {
  setSetting('open_signup', 'off')
  try {
    // Settings are cached for a minute per instance, so a fresh instance reads the door shut.
    const { startSibling } = await import('./server.ts')
    const sibling = await startSibling(memory)
    try {
      const n = otps()
      const r = await request('POST', `${sibling.url}/oauth/consent?authorization_id=auth-${nonce()}`, {
        headers: { ...proxied('US'), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: email(), 'cf-turnstile-response': 'pass' }).toString(), timeoutMs: 30_000,
      })
      assert.equal(r.status, 403, r.text)
      assert.ok(r.text.includes('Sign-ups are closed'), r.text)
      assert.equal(otps(), n)
    } finally {
      await sibling.close()
    }
  } finally {
    setSetting('open_signup', 'on')
  }
})

/** The bind and the cookie /oauth/provider gave this browser, read off its 302. */
function bound(res: { headers: Record<string, any> }) {
  const set = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0] ?? ''
  const cookie = /^(__Host-clyde_oauth=[^;]+)/.exec(set)?.[1] ?? ''
  const to = new URL(String(res.headers.location))
  const bind = new URL(String(to.searchParams.get('redirect_to'))).searchParams.get('bind') ?? ''
  return { bind, cookie, set }
}

test('R54/R55: /oauth/provider and CSP-safe 303 direct wait redirect', { skip: SKIP }, async () => {
  const { startSibling } = await import('./server.ts')
  const sibling = await startSibling(memory, { MEMORY_OAUTH_PROVIDERS: 'google' })
  try {
    const authId = `auth-${nonce()}`
    const ok = await request('GET', `${sibling.url}/oauth/provider?authorization_id=${authId}&provider=google`, {
      headers: proxied('US'), timeoutMs: 30_000,
    })
    assert.equal(ok.status, 302, ok.text)
    assert.match(String(ok.headers.location), /\/auth\/v1\/authorize\?provider=google&redirect_to=.*direct%3D1/)

    const bad = await request('GET', `${sibling.url}/oauth/provider?authorization_id=${authId}&provider=twitter`, {
      headers: proxied('US'), timeoutMs: 30_000,
    })
    assert.equal(bad.status, 400, bad.text)

    const disabled = await request('GET', `${sibling.url}/oauth/provider?authorization_id=${authId}&provider=github`, {
      headers: proxied('US'), timeoutMs: 30_000,
    })
    assert.equal(disabled.status, 400, disabled.text)

    const blocked = await request('GET', `${sibling.url}/oauth/provider?authorization_id=${authId}&provider=google`, {
      headers: proxied('DE'), timeoutMs: 30_000,
    })
    assert.equal(blocked.status, 451, blocked.text)

    const who = email()
    memory.auth.signIns[`code-${authId}`] = who
    memory.auth.authorizations[authId] = { redirect_uri: 'https://platform.openai.com/oauth/callback', client: { id: 'openai-test', name: 'ChatGPT' } }
    const { bind, cookie } = bound(ok)
    const direct = await request('GET', `${sibling.url}/oauth/approve?authorization_id=${authId}&direct=1&bind=${bind}&code=code-${authId}`, {
      headers: { ...proxied('US'), accept: 'application/json', cookie }, timeoutMs: 30_000,
    })
    assert.equal(direct.status, 303, direct.text)
    assert.equal(direct.headers.location, `/oauth/wait?authorization_id=${authId}`)

    const waited = await request('GET', `${sibling.url}/oauth/wait?authorization_id=${authId}`, { timeoutMs: 30_000 })
    assert.equal(waited.status, 302, waited.text)
    assert.match(String(waited.headers.location), /^https:\/\/platform\.openai\.com\/oauth\/callback\?code=/)
  } finally {
    await sibling.close()
  }
})

// Google and GitHub on the consent page: the callback has to come back to the browser that started it, a cancelled or
// failed one goes back to this request's sign-in, and nothing reaches a callback Clyde doesn't approve.
test('provider sign-in: bound to the starting browser, with denial, expiry, mismatch and open-redirect cases', { skip: SKIP }, async () => {
  const { startSibling } = await import('./server.ts')
  const sibling = await startSibling(memory, { MEMORY_OAUTH_PROVIDERS: 'google,github' })
  const exchanges = () => memory.auth.calls.filter((c) => c.path === '/auth/v1/token' && c.body?.auth_code).length
  const begin = async (provider = 'github') => {
    const id = `auth-${nonce()}`
    const r = await request('GET', `${sibling.url}/oauth/provider?authorization_id=${id}&provider=${provider}`, { headers: proxied('US'), timeoutMs: 30_000 })
    assert.equal(r.status, 302, r.text)
    return { id, ...bound(r), location: String(r.headers.location) }
  }
  const back = (id: string, query: string, cookie = '') => request('GET', `${sibling.url}/oauth/approve?authorization_id=${id}&direct=1&${query}`, {
    headers: { ...proxied('US'), accept: 'application/json', ...(cookie ? { cookie } : {}) }, timeoutMs: 30_000,
  })
  const cleared = (r: { headers: Record<string, any> }) =>
    ([] as string[]).concat(r.headers['set-cookie'] ?? []).some((c) => /^__Host-clyde_oauth=;.*Max-Age=0/.test(c))
  try {
    // The start: PKCE to Supabase Auth, and a cookie only this host, over https, can read.
    const a = await begin('github')
    const to = new URL(a.location)
    assert.equal(to.searchParams.get('provider'), 'github')
    assert.equal(to.searchParams.get('code_challenge_method'), 's256')
    assert.ok((to.searchParams.get('code_challenge') ?? '').length >= 43)
    assert.match(a.bind, /^[A-Za-z0-9_-]{16,64}$/)
    assert.equal(a.cookie, `__Host-clyde_oauth=${a.id}.${a.bind}`)
    for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=900']) assert.ok(a.set.includes(attr), `${attr} in ${a.set}`)
    assert.ok(!a.set.includes('Domain='), 'no Domain, so the cookie stays on this host')

    // Success: the code is spent once, with the stored verifier, and the window goes on to the app.
    memory.auth.signIns[`code-${a.id}`] = email()
    memory.auth.authorizations[a.id] = { redirect_uri: 'https://claude.ai/api/mcp/auth_callback', client: { id: `c-${nonce()}`, name: 'Claude' } }
    let n = exchanges()
    const ok = await back(a.id, `bind=${a.bind}&code=code-${a.id}`, a.cookie)
    assert.equal(ok.status, 303, ok.text)
    assert.equal(ok.headers.location, `/oauth/wait?authorization_id=${a.id}`)
    assert.ok(cleared(ok), 'the binding is spent')
    assert.equal(exchanges(), n + 1)
    const verifier = sql(`select code_verifier from memory.oauth_consent where authorization_id = '${a.id}'`)
    assert.equal(verifier[0]?.code_verifier, '', 'the verifier is gone once used')
    const went = await request('GET', `${sibling.url}/oauth/wait?authorization_id=${a.id}`, { timeoutMs: 30_000 })
    assert.equal(went.status, 302)
    assert.match(String(went.headers.location), /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?code=/)

    // Another browser (no cookie), a cookie for another request, and a bind that doesn't match: refused, nothing spent.
    const b = await begin('google')
    memory.auth.signIns[`code-${b.id}`] = email()
    memory.auth.authorizations[b.id] = { redirect_uri: 'https://claude.ai/api/mcp/auth_callback', client: { id: `c-${nonce()}`, name: 'Claude' } }
    n = exchanges()
    for (const [query, cookie] of [
      [`bind=${b.bind}&code=code-${b.id}`, ''],
      [`bind=${b.bind}&code=code-${b.id}`, a.cookie],
      [`bind=${a.bind}&code=code-${b.id}`, b.cookie],
      [`code=code-${b.id}`, b.cookie],
      [`bind=${b.bind}&code=code-${b.id}`, `__Host-clyde_oauth=${b.id}.${b.bind}x`],
    ]) {
      const r = await back(b.id, query, cookie)
      assert.equal(r.status, 403, `${query} ${cookie}: ${r.text}`)
      const body = JSON.parse(r.text)
      assert.equal(body.state, 'error')
      assert.equal(body.retry, true)
      assert.match(body.message, /didn't start in this browser/)
      assert.ok(cleared(r))
    }
    assert.equal(exchanges(), n, 'no code was spent')

    // Cancelled at the provider, or a provider error: back to this request's sign-in, nothing spent.
    const denied = await back(b.id, 'error=access_denied&error_description=The+user+denied+access', b.cookie)
    assert.equal(denied.status, 400, denied.text)
    assert.deepEqual([JSON.parse(denied.text).state, JSON.parse(denied.text).retry], ['denied', true])
    const broken = await back(b.id, 'error=server_error&error_description=Unable+to+exchange+external+code', b.cookie)
    assert.equal(broken.status, 400)
    assert.equal(JSON.parse(broken.text).state, 'error')
    assert.match(JSON.parse(broken.text).message, /Unable to exchange external code/)
    assert.equal(exchanges(), n)

    // Expired: 15 minutes after the start, even the right browser gets the expired page.
    exec(`update memory.oauth_consent set created_at = now() - interval '16 minutes' where authorization_id = '${b.id}'`)
    const late = await back(b.id, `bind=${b.bind}&code=code-${b.id}`, b.cookie)
    assert.equal(late.status, 410, late.text)
    assert.equal(JSON.parse(late.text).state, 'expired')
    assert.equal(exchanges(), n)

    // A code Supabase Auth refuses offers the sign-in page again.
    const c = await begin('google')
    const refused = await back(c.id, `bind=${c.bind}&code=not-a-code`, c.cookie)
    assert.equal(refused.status, 400, refused.text)
    assert.equal(JSON.parse(refused.text).retry, true)

    // A provider account with no verified email gets no grant.
    const d = await begin('github')
    memory.auth.signIns[`code-${d.id}`] = email()
    memory.auth.unverified.add(`code-${d.id}`)
    memory.auth.authorizations[d.id] = { redirect_uri: 'https://claude.ai/api/mcp/auth_callback', client: { id: `c-${nonce()}`, name: 'Claude' } }
    const unverified = await back(d.id, `bind=${d.bind}&code=code-${d.id}`, d.cookie)
    assert.equal(unverified.status, 403, unverified.text)
    assert.match(JSON.parse(unverified.text).message, /no verified email/)

    // Open redirect: a client whose callback isn't an approved app is refused, and the window never goes there.
    const e = await begin('google')
    memory.auth.signIns[`code-${e.id}`] = email()
    memory.auth.authorizations[e.id] = { redirect_uri: 'https://evil.example/cb', client: { id: `c-${nonce()}`, name: 'Evil' } }
    const evil = await back(e.id, `bind=${e.bind}&code=code-${e.id}`, e.cookie)
    assert.equal(evil.status, 403, evil.text)
    assert.equal(JSON.parse(evil.text).state, 'refused')
    assert.equal(evil.headers.location, undefined)
    const after = await request('GET', `${sibling.url}/oauth/wait?authorization_id=${e.id}`, { timeoutMs: 30_000 })
    assert.ok(!String(after.headers.location ?? '').startsWith('https://evil.example'), String(after.headers.location))
  } finally {
    await sibling.close()
  }
})
