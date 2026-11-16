/**
 * Tier 3: R54 (#59), anyone outside the blocked regions signs up for Clyde, and the first 1,000 get the free allocation.
 * Against the real memory function with sign-in open (setting open_signup), behind the Worker's proxy secret, with a fake
 * Supabase Auth and a fake Turnstile siteverify (MEMORY_TURNSTILE_URL): a token of "pass" is human, anything else isn't.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { after, before, test } from 'node:test'
import { request } from '../../src/request.ts'
import { jwt } from './auth.ts'
import { bearer, nonce } from './bed.ts'
import { putSecret, setSetting, sha } from './billing.ts'
import { exec, SKIP, sql, startRealMemory, type RealMemory } from './server.ts'

const PROXY = `proxy-${nonce()}`
let memory: RealMemory
let fake: http.Server
const verified: { response: string | null; secret: string | null }[] = []

before(async () => {
  if (SKIP) return
  fake = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      verified.push({ response: form.get('response'), secret: form.get('secret') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: form.get('response') === 'pass' && form.get('secret') === 'turnstile-test-secret' }))
    })
  })
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()))
  const port = (fake.address() as { port: number }).port
  memory = await startRealMemory({ MEMORY_TURNSTILE_URL: `http://127.0.0.1:${port}/siteverify` })
  setSetting('open_signup', 'on')
  setSetting('proxy_secret_sha256', sha(PROXY))
  putSecret('turnstile_secret', 'turnstile-test-secret')
})

after(async () => {
  await memory?.close()
  await new Promise((r) => fake?.close(r))
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

test('R54: turnstile required', { skip: SKIP }, async () => {
  const n = otps()
  const missing = await signUp(proxied('US'), { email: email() })
  assert.equal(missing.status, 400, missing.text)
  const failing = await signUp(proxied('US'), { email: email(), 'cf-turnstile-response': 'bot' })
  assert.equal(failing.status, 400, failing.text)
  assert.equal(otps(), n)
  assert.ok(verified.some((v) => v.response === 'bot' && v.secret === 'turnstile-test-secret'), 'siteverify heard the token with the secret')
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
    putSecret('turnstile_secret', 'turnstile-test-secret')
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
    'https://chatgpt.com/connector_platform_oauth_redirect', 'https://antigravity.google/oauth-callback']) {
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
