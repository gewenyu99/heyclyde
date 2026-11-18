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
    const direct = await request('GET', `${sibling.url}/oauth/approve?authorization_id=${authId}&direct=1&code=code-${authId}`, {
      headers: { ...proxied('US'), accept: 'application/json' }, timeoutMs: 30_000,
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
