/**
 * Tier 3: R38 (#42), access is allowlist, a paid plan, or the free plan's limits, checked on every request. Against the real
 * memory function, a fake Supabase Auth, a fake OpenAI and a fake of the Polar and Paddle APIs. Sign-in is opened
 * (setting open_signup = on), as it will be once tenancy (R25) lands. The entitlement cache's TTL is 1,500 ms here, set by
 * MEMORY_ENTITLEMENT_TTL_MS, so the "within 60 s" criteria wait 1.6 s rather than 61; the default of 60,000 ms is checked
 * by billing_test.ts.
 */
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { repoRoot } from '../../src/config.ts'
import { request } from '../../src/request.ts'
import { jwt } from './auth.ts'
import { bearer, bedFor, nonce, note } from './bed.ts'
import {
  deliver, newPaddleSecret, newPolarSecret, paddleRefund, paddleSubscription, polarRefund, polarSubscription, putSecret, setSetting,
  sha, signPaddle, signPolar, startFakeProviders, type Sub, tableCounts,
} from './billing.ts'
import { SKIP, sql, startRealMemory, startSibling, type RealMemory } from './server.ts'

const TTL = 1500
const PROXY = `proxy-${nonce()}`
let memory: RealMemory
let bed: ReturnType<typeof bedFor>
let providers: Awaited<ReturnType<typeof startFakeProviders>>
let POLAR: string, PADDLE: string
let CHECKOUT: string

before(async () => {
  if (SKIP) return
  providers = await startFakeProviders()
  memory = await startRealMemory({ MEMORY_ENTITLEMENT_TTL_MS: String(TTL), POLAR_API_URL: providers.url, PADDLE_API_URL: providers.url })
  bed = bedFor(memory)
  POLAR = newPolarSecret()
  PADDLE = newPaddleSecret()
  // Before any call reads them, since the function caches settings and secrets for a minute.
  setSetting('open_signup', 'on')
  setSetting('proxy_secret_sha256', sha(PROXY))
  putSecret('polar_webhook_secret', POLAR)
  putSecret('paddle_webhook_secret', PADDLE)
  putSecret('polar_api_token', `test-polar-api-${nonce()}`)
  putSecret('paddle_api_key', `test-paddle-api-${nonce()}`)
  sql(`update memory.plan set product_ids = '{"polar": "prod_test", "paddle": "pro_test"}' where id = 'clyde'`)
  // The free plan's 1,000 seats are open. R38's unpaid criteria are about an account that holds none, so here none are left.
  sql(`update memory.plan set seats = 0 where id = 'free'`)
  CHECKOUT = sql(`select value from memory.setting where name = 'checkout_url'`)[0].value
})

after(async () => {
  await memory?.close()
  await providers?.close()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const lapse = () => sleep(TTL + 200)

type User = { id: string; email: string; oauth: string; plain: string }

/** A Supabase Auth user: an OAuth client's token (with client_id) and a plain sign-in token (without). */
function user(email = `u-${nonce()}@example.com`, extra: Record<string, unknown> = {}): User {
  const id = randomUUID()
  return {
    id, email,
    oauth: jwt({ sub: id, email, client_id: 'claude-test', jti: randomUUID(), ...extra }),
    plain: jwt({ sub: id, email, jti: randomUUID(), ...extra }),
  }
}

async function rpc(token: string, method: string, params: Record<string, unknown> = {}, base = memory.url, headers: Record<string, string> = {}) {
  return await request('POST', `${base}/mcp`, { headers: { ...bearer(token), ...headers }, body: { jsonrpc: '2.0', id: 1, method, params }, timeoutMs: 60_000 })
}
const init = (token: string, base = memory.url) => rpc(token, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-ai' } }, base)
const tool = (token: string, name: string, args: Record<string, unknown>, base = memory.url, headers: Record<string, string> = {}) =>
  rpc(token, 'tools/call', { name, arguments: args }, base, headers)
const recall = (token: string, base = memory.url) => tool(token, 'recall', { query: 'oolong temperature' }, base)

/** Signs the user in once, which records their account (the owner a checkout names). */
async function signIn(u: User) {
  const r = await init(u.oauth)
  assert.equal(r.status, 200, r.text)
}

async function polarDeliver(body: string, opts: { id?: string; ts?: number; secret?: string; headers?: Record<string, string> } = {}) {
  return await deliver(memory.url, '/billing/polar', body, { ...signPolar(opts.secret ?? POLAR, body, opts), ...opts.headers })
}

/** Makes u paid through a signed subscription.active, and returns the subscription id. */
async function pay(u: User, extra: Partial<Sub> = {}) {
  const id = extra.id ?? `sub_${nonce()}`
  const r = await polarDeliver(polarSubscription('subscription.active', { owner: u.id, id, ...extra }))
  assert.equal(r.status, 200, r.text)
  return id
}

const stateOf = (u: User) => sql(`select state from memory.entitlement where owner_id = '${u.id}'`)[0]?.state ?? null
const proxied = (country: string, region?: string) =>
  ({ 'x-memory-proxy': PROXY, 'cf-ipcountry': country, ...(region ? { 'cf-region-code': region } : {}), 'x-memory-client': `198.51.100.${Math.floor(Math.random() * 200) + 1}` })

test('entitlement: unpaid gets 402 on every tool, with a checkout link, touching nothing', { skip: SKIP }, async () => {
  const u = user()
  await signIn(u)
  const before = tableCounts(), calls = memory.openai.calls.length
  const tools: [string, Record<string, unknown>][] = [
    ['recall', { query: 'oolong' }], ['get_entry', { id: 'tea-oolong-temp' }], ['get_blob', { sha256: 'a'.repeat(64) }],
    ['remember', note(`unpaid ${nonce()}`)], ['feedback', { retrieval_id: randomUUID(), nothing_useful: true }],
    ['post_message', { to: 'claude', body: 'hello' }], ['check_messages', {}],
  ]
  for (const [name, args] of tools) {
    const r = await tool(u.oauth, name, args)
    assert.equal(r.status, 402, `${name}: ${r.text}`)
    const url = JSON.parse(r.text).checkout_url as string
    assert.ok(url.startsWith(CHECKOUT) && url.includes(u.id), `${name}: ${r.text}`)
  }
  assert.deepEqual(tableCounts(), before)
  assert.equal(memory.openai.calls.length - calls, 0)
})

test('entitlement: unpaid gets 402 on every agent, hook and claim route, 0 writes, 0 OpenAI calls', { skip: SKIP }, async () => {
  const seeded = await bed.mcp(memory.runtimeToken)
  const reply = await seeded.tool('remember', note(`public blob ${nonce()}`, { artifacts: [{ name: 'p.txt', kind: 'document', text: `public ${nonce()}` }] }))
  assert.equal(reply.error, false, reply.text)
  const blob = /Blob p\.txt: ([0-9a-f]{64})/.exec(reply.text)![1]
  const u = user()
  await signIn(u)
  const before = tableCounts(), calls = memory.openai.calls.length
  const ids = sql(`select id from memory.entry`).map((r) => r.id as string)
  const answers = [
    await request('POST', `${memory.url}/entries`, { headers: bearer(u.oauth), body: note(`x ${nonce()}`) }),
    await request('GET', `${memory.url}/entries/tea-oolong-temp`, { headers: bearer(u.oauth) }),
    await request('POST', `${memory.url}/recall`, { headers: bearer(u.oauth), body: { query: 'oolong' } }),
    await request('POST', `${memory.url}/hooks/UserPromptSubmit`, { headers: bearer(u.oauth), body: { prompt: 'hi' } }),
    await request('GET', `${memory.url}/messages/claude`, { headers: bearer(u.oauth) }),
    await request('GET', `${memory.url}/blobs/${blob}`, { headers: bearer(u.oauth) }),
    await request('POST', `${memory.url}/devices/claim`, { headers: bearer(u.plain), body: { name: `box-${nonce()}` } }),
  ]
  assert.deepEqual(answers.map((a) => a.status), [402, 402, 402, 402, 402, 402, 402], answers.map((a) => a.text).join('\n'))
  for (const a of answers) for (const id of ids) assert.ok(!a.text.includes(id), `${id} leaked: ${a.text}`)
  assert.deepEqual(tableCounts(), before)
  assert.equal(memory.openai.calls.length - calls, 0)
})

test("entitlement: a lapsed user's device token gets 402", { skip: SKIP }, async () => {
  const u = user()
  await signIn(u)
  const sub = await pay(u)
  const name = `box-${nonce()}`
  const claim = await request('POST', `${memory.url}/devices/claim`, { headers: bearer(u.plain), body: { name } })
  assert.equal(claim.status, 200, claim.text)
  const device = JSON.parse(claim.text).token as string
  assert.equal(sql(`select owner_id from memory.device where name = '${name}'`)[0].owner_id, u.id)
  assert.equal((await request('POST', `${memory.url}/recall`, { headers: bearer(device), body: { query: 'oolong' } })).status, 200)
  const revoked = await polarDeliver(polarSubscription('subscription.revoked', { owner: u.id, id: sub, status: 'canceled' }))
  assert.equal(revoked.status, 200, revoked.text)
  await lapse()
  const events = tableCounts().event
  const answers = [
    await request('POST', `${memory.url}/hooks/UserPromptSubmit`, { headers: bearer(device), body: { prompt: 'hi' } }),
    await request('GET', `${memory.url}/messages/claude`, { headers: bearer(device) }),
    await request('POST', `${memory.url}/recall`, { headers: bearer(device), body: { query: 'oolong' } }),
  ]
  assert.deepEqual(answers.map((a) => a.status), [402, 402, 402])
  assert.equal(tableCounts().event, events)
})

test('entitlement: a stranger signs in and connects, and only tools/call is refused', { skip: SKIP }, async () => {
  const email = `stranger-${nonce()}@example.com`, auth = `auth-${nonce()}`
  const consent = `${memory.url}/oauth/consent?authorization_id=${auth}`
  const form = await request('GET', consent, { headers: proxied('US') })
  assert.equal(form.status, 200, form.text)
  assert.match(form.text, /email/)
  const otps = memory.auth.calls.filter((c) => c.path === '/auth/v1/otp').length
  const sent = await request('POST', consent, { headers: { ...proxied('US'), 'content-type': 'application/x-www-form-urlencoded' }, body: `email=${encodeURIComponent(email)}&cf-turnstile-response=pass` })
  assert.equal(sent.status, 200, sent.text)
  const otp = memory.auth.calls.filter((c) => c.path === '/auth/v1/otp')
  assert.equal(otp.length - otps, 1)
  assert.equal(otp.at(-1)!.body.email, email)
  assert.equal(otp.at(-1)!.body.create_user, true)
  memory.auth.signIns[`code-${auth}`] = email
  memory.auth.authorizations[auth] = { redirect_uri: 'https://claude.ai/api/mcp/auth_callback', client: { id: 'claude-client', name: 'Claude' } }
  const approved = await request('GET', `${memory.url}/oauth/approve?authorization_id=${auth}&code=code-${auth}`)
  assert.equal(approved.status, 200, approved.text)
  assert.match(approved.text, /connected/)
  assert.ok(sql(`select redirect_url from memory.oauth_consent where authorization_id = '${auth}'`)[0].redirect_url)
  const u = user(email)
  assert.equal((await init(u.oauth)).status, 200)
  const listed = await rpc(u.oauth, 'tools/list')
  const own = await rpc(memory.runtimeToken, 'tools/list')
  assert.equal(listed.status, 200)
  assert.equal(JSON.parse(listed.text).result.tools.length, JSON.parse(own.text).result.tools.length)
  assert.equal((await recall(u.oauth)).status, 402)
})

test('sign-ins: the 4th email to one address in an hour gets 429 from any address', { skip: SKIP }, async () => {
  const victim = `victim-${nonce()}@example.com`
  const start = (email: string, ip: string) => request('POST', `${memory.url}/oauth/consent?authorization_id=auth-${nonce()}`,
    { headers: { ...proxied('US'), 'x-memory-client': ip, 'content-type': 'application/x-www-form-urlencoded' }, body: `email=${encodeURIComponent(email)}&cf-turnstile-response=pass` })
  const otps = () => memory.auth.calls.filter((c) => c.path === '/auth/v1/otp').length
  for (const ip of ['203.0.113.31', '203.0.113.32', '203.0.113.33']) assert.equal((await start(victim, ip)).status, 200)
  const n = otps()
  assert.equal((await start(victim, '203.0.113.34')).status, 429)
  assert.equal(otps() - n, 0)
  assert.equal((await start(`other-${nonce()}@example.com`, '203.0.113.34')).status, 200)
  assert.equal(otps() - n, 1)
})

test('sign-ins: the 6th from one address in an hour gets 429 and sends no email', { skip: SKIP }, async () => {
  const start = (ip: string) => request('POST', `${memory.url}/oauth/consent?authorization_id=auth-${nonce()}`,
    { headers: { ...proxied('US'), 'x-memory-client': ip, 'content-type': 'application/x-www-form-urlencoded' }, body: `email=s-${nonce()}@example.com&cf-turnstile-response=pass` })
  for (let i = 0; i < 5; i++) assert.equal((await start('203.0.113.21')).status, 200)
  const n = memory.auth.calls.filter((c) => c.path === '/auth/v1/otp').length
  assert.equal((await start('203.0.113.21')).status, 429)
  assert.equal(memory.auth.calls.filter((c) => c.path === '/auth/v1/otp').length - n, 0)
  assert.equal((await start('198.51.100.30')).status, 200)
})

test('sign-ins: a direct, unproxied sign-up is refused unless the email is allowlisted', { skip: SKIP }, async () => {
  const otps = () => memory.auth.calls.filter((c) => c.path === '/auth/v1/otp').length
  const n = otps()
  for (let i = 0; i < 6; i++) {
    const r = await request('POST', `${memory.url}/oauth/consent?authorization_id=auth-${nonce()}`,
      { headers: { 'x-forwarded-for': `192.0.2.${i + 1}`, 'content-type': 'application/x-www-form-urlencoded' }, body: `email=d-${nonce()}@example.com&cf-turnstile-response=pass` })
    assert.equal(r.status, 403, r.text)
    assert.match(r.text, /https:\/\/memory\.heyclyde\.me/)
  }
  assert.equal(otps() - n, 0)
  const allowed = `allowed-${nonce()}@example.com`
  sql(`insert into memory.allowed_email (email) values ('${allowed}')`)
  const ok = await request('POST', `${memory.url}/oauth/consent?authorization_id=auth-${nonce()}`,
    { headers: { 'x-forwarded-for': '192.0.2.99', 'content-type': 'application/x-www-form-urlencoded' }, body: `email=${allowed}&cf-turnstile-response=pass` })
  assert.equal(ok.status, 200, ok.text)
  assert.equal(otps() - n, 1)
})

test('entitlement: a signed subscription.active webhook makes U paid on the next call', { skip: SKIP }, async () => {
  const u = user()
  await signIn(u)
  assert.equal((await recall(u.oauth)).status, 402)
  await pay(u)
  assert.equal(stateOf(u), 'paid')
  const r = await recall(u.oauth)
  assert.equal(r.status, 200, r.text)
})

test('entitlement: forged, stale, future and oversized webhooks refused', { skip: SKIP }, async () => {
  const u = user()
  await signIn(u)
  const before = sql(`select * from memory.entitlement order by owner_id`)
  const body = polarSubscription('subscription.active', { owner: u.id })
  const good = signPolar(POLAR, body)
  const now = Math.floor(Date.now() / 1000)
  const statuses = [
    (await deliver(memory.url, '/billing/polar', body, { ...good, 'webhook-signature': `v1,${Buffer.from('nope').toString('base64')}` })).status,
    (await deliver(memory.url, '/billing/polar', body, { 'webhook-id': good['webhook-id'], 'webhook-timestamp': good['webhook-timestamp'] })).status,
    (await polarDeliver(body, { secret: newPolarSecret() })).status,
    (await polarDeliver(body, { ts: now - 301 })).status,
    (await polarDeliver(body, { ts: now + 301 })).status,
    (await deliver(memory.url, '/billing/polar', 'x'.repeat(2_000_001), signPolar(POLAR, 'x'.repeat(2_000_001)))).status,
  ]
  assert.deepEqual(statuses, [400, 400, 400, 400, 400, 413])
  assert.deepEqual(sql(`select * from memory.entitlement order by owner_id`), before)
  assert.equal((await recall(u.oauth)).status, 402)
})

test('entitlement: a signed event for an unknown customer is acknowledged and stores nothing', { skip: SKIP }, async () => {
  const n = tableCounts().entitlement
  for (const owner of [randomUUID(), null]) {
    const r = await polarDeliver(polarSubscription('subscription.active', { owner }))
    assert.equal(r.status, 200, r.text)
  }
  assert.equal(tableCounts().entitlement, n)
})

test('entitlement: a revoked or fully refunded subscription gets 402, a partial refund keeps access', { skip: SKIP }, async (t) => {
  await t.test('revoked', async () => {
    const u = user()
    await signIn(u)
    const sub = await pay(u)
    assert.equal((await polarDeliver(polarSubscription('subscription.revoked', { owner: u.id, id: sub, status: 'canceled' }))).status, 200)
    assert.notEqual(stateOf(u), 'paid')
    assert.equal((await recall(u.oauth)).status, 402)
  })
  await t.test('full refund', async () => {
    const u = user()
    await signIn(u)
    const sub = await pay(u)
    const cancels = providers.calls.filter((c) => c.method === 'DELETE' && c.path.includes(sub)).length
    assert.equal((await polarDeliver(polarRefund(u.id, sub, 1000))).status, 200)
    assert.notEqual(stateOf(u), 'paid')
    assert.equal((await recall(u.oauth)).status, 402)
    // A refund alone leaves the subscription billing, so memory revokes it.
    assert.equal(providers.calls.filter((c) => c.method === 'DELETE' && c.path.includes(sub)).length - cancels, 1)
  })
  await t.test('partial refund', async () => {
    const u = user()
    await signIn(u)
    const sub = await pay(u)
    assert.equal((await polarDeliver(polarRefund(u.id, sub, 500))).status, 200)
    assert.equal(stateOf(u), 'paid')
    assert.equal((await recall(u.oauth)).status, 200)
  })
})

test('entitlement: past_due keeps access until the provider revokes', { skip: SKIP }, async () => {
  const u = user()
  await signIn(u)
  const sub = await pay(u)
  assert.equal((await polarDeliver(polarSubscription('subscription.past_due', { owner: u.id, id: sub, status: 'past_due' }))).status, 200)
  assert.equal(stateOf(u), 'past_due')
  assert.equal((await recall(u.oauth)).status, 200)
  assert.equal((await polarDeliver(polarSubscription('subscription.revoked', { owner: u.id, id: sub, status: 'canceled' }))).status, 200)
  assert.equal((await recall(u.oauth)).status, 402)
})

test('entitlement: a cancelled subscription keeps access until its period ends, and uncancel keeps it after', { skip: SKIP }, async (t) => {
  const cancel = async (u: User, sub: string) => {
    const r = await polarDeliver(polarSubscription('subscription.canceled', { owner: u.id, id: sub, cancelAtPeriodEnd: true, periodEnd: new Date(Date.now() + 86_400_000) }))
    assert.equal(r.status, 200, r.text)
  }
  await t.test('cancelled', async () => {
    const u = user()
    await signIn(u)
    const sub = await pay(u)
    await cancel(u, sub)
    assert.equal((await recall(u.oauth)).status, 200)
    sql(`update memory.entitlement set current_period_end = now() - interval '1 minute' where owner_id = '${u.id}'`)
    await lapse()
    assert.equal((await recall(u.oauth)).status, 402)
  })
  await t.test('uncancelled', async () => {
    const u = user()
    await signIn(u)
    const sub = await pay(u)
    await cancel(u, sub)
    assert.equal((await polarDeliver(polarSubscription('subscription.uncanceled', { owner: u.id, id: sub }, new Date(Date.now() + 1000)))).status, 200)
    sql(`update memory.entitlement set current_period_end = now() - interval '1 minute' where owner_id = '${u.id}'`)
    await lapse()
    assert.equal((await recall(u.oauth)).status, 200)
  })
})

test('entitlement: a revoke reaches every instance within 60 s', { skip: SKIP }, async () => {
  const b = await startSibling(memory)
  try {
    const u = user()
    await signIn(u)
    const sub = await pay(u)
    assert.equal((await recall(u.oauth, b.url)).status, 200)
    assert.equal((await polarDeliver(polarSubscription('subscription.revoked', { owner: u.id, id: sub, status: 'canceled' }))).status, 200)
    await lapse()
    assert.equal((await recall(u.oauth, b.url)).status, 402)
  } finally {
    await b.close()
  }
})

test('entitlement: allowlisted is free, and removal is 402 within 60 s', { skip: SKIP }, async () => {
  const email = `listed-${nonce()}@example.com`
  sql(`insert into memory.allowed_email (email) values ('${email}')`)
  const u = user(email)
  const s = await init(u.oauth)
  assert.equal(s.status, 200, s.text)
  const session = String(s.headers['mcp-session-id'])
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await rpc(u.oauth, 'tools/call', { name, arguments: args }, memory.url, { 'mcp-session-id': session })
    assert.equal(r.status, 200, `${name}: ${r.text}`)
    const out = JSON.parse(r.text).result
    assert.ok(!out.isError, `${name}: ${out.content[0].text}`)
    return out.content[0].text as string
  }
  const title = `Listed ${nonce()} kettle`
  const remembered = await call('remember', note(title, { artifacts: [{ name: 'k.txt', kind: 'document', text: `kettle ${nonce()}` }] }))
  const id = /^Remembered (\S+)\./.exec(remembered)![1], blob = /Blob k\.txt: ([0-9a-f]{64})/.exec(remembered)![1]
  const found = await call('recall', { query: title })
  const retrieval = /^retrieval ([0-9a-f-]{36})/.exec(found)?.[1]
  assert.match(await call('get_entry', { id }), new RegExp(title))
  assert.match(await call('get_blob', { sha256: blob }), new RegExp(blob))
  if (retrieval) await call('feedback', { retrieval_id: retrieval, nothing_useful: true })
  await call('post_message', { to: 'claude', body: `hello ${nonce()}` })
  await call('check_messages', {})
  // The email's letter case doesn't matter.
  const upper = user(email.toUpperCase())
  assert.equal((await recall(upper.oauth)).status, 200)
  sql(`delete from memory.allowed_email where email = '${email}'`)
  await lapse()
  assert.equal((await recall(u.oauth)).status, 402)
})

test('entitlement: an unconfirmed email is not allowlisted', { skip: SKIP }, async () => {
  const email = `unconfirmed-${nonce()}@example.com`
  sql(`insert into memory.allowed_email (email) values ('${email}')`)
  const u = user(email, { unconfirmed: true })
  const calls = memory.openai.calls.length
  assert.equal((await recall(u.oauth)).status, 402)
  assert.equal(memory.openai.calls.length - calls, 0)
})

const timing = (r: { headers: Record<string, any> }) => {
  const m = /entitlement;dur=([\d.]+);desc="(db|cache)"/.exec(String(r.headers['server-timing'] ?? ''))
  assert.ok(m, `no entitlement Server-Timing: ${r.headers['server-timing']}`)
  return { ms: Number(m[1]), desc: m[2] }
}
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]

/** A plan like paid, with no burst limit, so a benchmark of the check isn't cut short by the limiter. */
function benchPlan() {
  sql(`insert into memory.plan (id, name, price_micro_usd_month, recalls_month, remembers_month, blob_bytes_total, openai_tokens_month)
    values ('bench', 'Bench', 10000000, 100000, 100000, 52428800, 4000000000) on conflict (id) do nothing`)
}

test('entitlement: the cached check adds at most 5 ms p95 over 100 calls', { skip: SKIP }, async () => {
  benchPlan()
  const u = user()
  await signIn(u)
  await pay(u)
  sql(`update memory.entitlement set plan = 'bench' where owner_id = '${u.id}'`)
  const started = Date.now(), ms: number[] = []
  for (let i = 0; i < 100; i++) {
    const r = await recall(u.oauth)
    assert.equal(r.status, 200, r.text)
    const t = timing(r)
    if (t.desc === 'cache') ms.push(t.ms)
  }
  assert.ok(Date.now() - started < 60_000)
  assert.ok(ms.length >= 90, `${ms.length} cache hits`)
  assert.ok(p95(ms) <= 5, `p95 ${p95(ms)} ms`)
})

test('entitlement: an uncached lookup takes at most 20 ms p95', { skip: SKIP }, async () => {
  benchPlan()
  const ms: number[] = []
  for (let i = 0; i < 20; i++) {
    const u = user()
    sql(`insert into memory.account (owner_id, email, email_confirmed) values ('${u.id}', '${u.email}', true)`)
    sql(`insert into memory.entitlement (owner_id, provider, plan, state, event_at) values ('${u.id}', 'polar', 'bench', 'paid', now())`)
    const r = await recall(u.oauth)
    assert.equal(r.status, 200, r.text)
    const t = timing(r)
    assert.equal(t.desc, 'db')
    ms.push(t.ms)
  }
  assert.ok(p95(ms) <= 20, `p95 ${p95(ms)} ms`)
  const plan = sql(`explain select * from memory.entitlement where owner_id = '${randomUUID()}'`).map((r) => r['QUERY PLAN']).join('\n')
  assert.match(plan, /entitlement_pkey|Seq Scan on entitlement/)
})

test('entitlement: a failed lookup fails closed with 503', { skip: SKIP }, async () => {
  const u = user()
  await signIn(u)
  await pay(u)
  await lapse()
  const before = tableCounts(), calls = memory.openai.calls.length
  sql(`alter table memory.entitlement rename to entitlement_off`)
  let r
  try {
    r = await recall(u.oauth)
  } finally {
    sql(`alter table memory.entitlement_off rename to entitlement`)
  }
  assert.equal(r.status, 503, r.text)
  assert.equal(memory.openai.calls.length - calls, 0)
  assert.deepEqual(tableCounts(), before)
})

test('entitlement: webhooks are idempotent and a stale event never re-grants', { skip: SKIP }, async () => {
  const u = user()
  await signIn(u)
  const sub = `sub_${nonce()}`, body = polarSubscription('subscription.active', { owner: u.id, id: sub }), id = `msg_${nonce()}`
  assert.equal((await polarDeliver(body, { id })).status, 200)
  const first = sql(`select updated_at from memory.entitlement where owner_id = '${u.id}'`)[0].updated_at
  await sleep(50)
  assert.equal((await polarDeliver(body, { id })).status, 200)
  assert.equal(sql(`select updated_at from memory.entitlement where owner_id = '${u.id}'`)[0].updated_at, first)
  assert.equal((await polarDeliver(polarSubscription('subscription.revoked', { owner: u.id, id: sub, status: 'canceled' }))).status, 200)
  const stale = await polarDeliver(polarSubscription('subscription.active', { owner: u.id, id: sub }, new Date(Date.now() - 3_600_000)))
  assert.equal(stale.status, 200)
  assert.equal((await recall(u.oauth)).status, 402)
})

test("entitlement: a webhook that can't be stored returns 500 and succeeds on redelivery", { skip: SKIP }, async () => {
  const u = user()
  await signIn(u)
  const body = polarSubscription('subscription.active', { owner: u.id }), id = `msg_${nonce()}`
  sql(`create or replace function memory.test_refuse() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$`)
  sql(`create trigger test_refuse before insert or update on memory.entitlement for each row execute function memory.test_refuse()`)
  let first
  try {
    first = await polarDeliver(body, { id })
  } finally {
    sql(`drop trigger if exists test_refuse on memory.entitlement`)
  }
  assert.equal(first.status, 500)
  assert.equal((await recall(u.oauth)).status, 402)
  assert.equal((await polarDeliver(body, { id })).status, 200)
  assert.equal((await recall(u.oauth)).status, 200)
})

test('entitlement: Polar and Paddle adapters give identical outcomes', { skip: SKIP }, async () => {
  const outcomes = async (provider: 'polar' | 'paddle') => {
    const send = (body: string) => provider === 'polar' ? polarDeliver(body) : deliver(memory.url, '/billing/paddle', body, signPaddle(PADDLE, body))
    const active = (u: User, id: string) => provider === 'polar' ? polarSubscription('subscription.active', { owner: u.id, id }) : paddleSubscription('subscription.activated', { owner: u.id, id })
    const out: string[] = []
    const a = user()
    await signIn(a)
    out.push(`${(await send(active(a, `sub_${nonce()}`))).status} ${stateOf(a)} ${(await recall(a.oauth)).status}`)
    const r = user()
    await signIn(r)
    const rs = `sub_${nonce()}`
    await send(active(r, rs))
    const revoke = provider === 'polar' ? polarSubscription('subscription.revoked', { owner: r.id, id: rs, status: 'canceled' }) : paddleSubscription('subscription.canceled', { owner: r.id, id: rs, status: 'canceled' })
    out.push(`${(await send(revoke)).status} ${(await recall(r.oauth)).status}`)
    const f = user()
    await signIn(f)
    const fs = `sub_${nonce()}`
    await send(active(f, fs))
    out.push(`${(await send(provider === 'polar' ? polarRefund(f.id, fs, 1000) : paddleRefund(fs))).status} ${(await recall(f.oauth)).status}`)
    const x = user()
    await signIn(x)
    const before = sql(`select * from memory.entitlement order by owner_id`)
    const forged = active(x, `sub_${nonce()}`)
    const status = provider === 'polar'
      ? (await polarDeliver(forged, { secret: newPolarSecret() })).status
      : (await deliver(memory.url, '/billing/paddle', forged, signPaddle(newPaddleSecret(), forged))).status
    out.push(`${status} ${JSON.stringify(sql(`select * from memory.entitlement order by owner_id`)) === JSON.stringify(before)}`)
    return out
  }
  const polar = await outcomes('polar'), paddle = await outcomes('paddle')
  assert.deepEqual(polar, ['200 paid 200', '200 402', '200 402', '400 true'])
  assert.deepEqual(paddle, polar)
  const outside = execSync(`grep -rliE 'polar|paddle' memory/supabase/functions/memory --include=*.ts | grep -v '/billing/' | wc -l`, { cwd: repoRoot(), encoding: 'utf8' })
  assert.equal(outside.trim(), '0')
})

test('entitlement: one check in authenticate for agent and owner routes, webhooks take no token', { skip: SKIP }, async () => {
  for (const p of ['/billing/polar', '/billing/paddle', '/billing/polar/webhook']) {
    assert.equal((await request('GET', `${memory.url}${p}`)).status, 405, p)
  }
  // A signed webhook needs no bearer token, at /billing/polar and at /billing/polar/webhook alike.
  const u = user()
  await signIn(u)
  const body = polarSubscription('subscription.active', { owner: u.id })
  assert.equal((await deliver(memory.url, '/billing/polar/webhook', body, signPolar(POLAR, body))).status, 200)
  const sites = execSync(`grep -n 'entitled(' memory/supabase/functions/memory/*.ts | grep -v 'export' | wc -l`, { cwd: repoRoot(), encoding: 'utf8' })
  assert.equal(sites.trim(), '1')
})

test('entitlement: no table holds a billing secret, and the source holds none', { skip: SKIP }, async () => {
  const values = sql(`select decrypted_secret as v from vault.decrypted_secrets where name in ('polar_webhook_secret', 'paddle_webhook_secret', 'polar_api_token', 'paddle_api_key')`).map((r) => r.v as string)
  assert.equal(values.length, 4)
  const columns = sql(`select table_name, column_name from information_schema.columns where table_schema = 'memory'
    and data_type in ('text', 'jsonb', 'character varying') and table_name in (select table_name from information_schema.tables where table_schema = 'memory' and table_type = 'BASE TABLE')`)
  for (const v of values) {
    const hits = sql(columns.map((c) => `select count(*)::int as n from memory."${c.table_name}" where "${c.column_name}"::text like '%${v.replace(/'/g, "''")}%'`).join(' union all '))
    assert.equal(hits.reduce((s, r) => s + r.n, 0), 0)
  }
  const grep = execSync(`grep -rnE 'whsec_[A-Za-z0-9+/=]{16,}|pdl_ntfset_[a-z0-9_]{16,}|polar_oat_[A-Za-z0-9]{16,}' memory/supabase/functions/memory | wc -l`, { cwd: repoRoot(), encoding: 'utf8' })
  assert.equal(grep.trim(), '0')
})

test("entitlement: Wen's runtime, device, admin, backup and cron credentials never get 402", { skip: SKIP }, async () => {
  const backup = `backup-${nonce()}`
  setSetting('backup_token_sha256', sha(backup))
  const answers = [
    await request('POST', `${memory.url}/recall`, { headers: bearer(memory.runtimeToken), body: { query: 'oolong' } }),
    await recall(memory.runtimeToken),
    await request('POST', `${memory.url}/hooks/UserPromptSubmit`, { headers: bearer(memory.token), body: { prompt: 'hi' } }),
    await request('GET', `${memory.url}/messages/claude`, { headers: bearer(memory.token) }),
    await request('GET', `${memory.url}/api/v1/entries`, { headers: bearer(memory.adminToken) }),
    await request('POST', `${memory.url}/learn`, { headers: bearer(memory.cronSecret) }),
  ]
  assert.equal(answers.filter((a) => a.status === 402).length, 0, answers.map((a) => `${a.status} ${a.text.slice(0, 80)}`).join('\n'))
})

test('entitlement: unpaid initialize writes no mcp_client rows', { skip: SKIP }, async () => {
  const u = user()
  await signIn(u)
  const n = tableCounts().mcp_client
  for (let i = 0; i < 100; i++) assert.equal((await init(u.oauth)).status, 200)
  assert.equal(tableCounts().mcp_client, n)
})

const signUp = (headers: Record<string, string>, email = `geo-${nonce()}@example.com`) =>
  request('POST', `${memory.url}/oauth/consent?authorization_id=auth-${nonce()}`,
    { headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: `email=${encodeURIComponent(email)}&cf-turnstile-response=pass` })
const geoCounts = () => { const c = tableCounts(); return [c.oauth_consent, c.account, c.entitlement] }
const otpCount = () => memory.auth.calls.filter((c) => c.path === '/auth/v1/otp').length

test('geo: DE, FR, GB, CH, XX and T1 sign-ups refused, CA and US allowed', { skip: SKIP }, async () => {
  for (const country of ['DE', 'FR', 'GB', 'CH', 'XX', 'T1']) {
    const before = geoCounts(), otps = otpCount()
    const r = await signUp(proxied(country))
    assert.equal(r.status, 451, `${country}: ${r.text}`)
    assert.match(r.text, /Clyde isn't available in your country/)
    assert.equal(otpCount() - otps, 0)
    assert.deepEqual(geoCounts(), before)
  }
  for (const [country, region] of [['CA', 'ON'], ['US', undefined]] as const) {
    const otps = otpCount()
    assert.equal((await signUp(proxied(country, region))).status, 200, country)
    assert.equal(otpCount() - otps, 1)
  }
})

test('geo: Quebec refused, Ontario and BC allowed', { skip: SKIP }, async () => {
  const before = geoCounts(), otps = otpCount()
  const r = await signUp(proxied('CA', 'QC'))
  assert.equal(r.status, 451)
  assert.match(r.text, /Clyde isn't available in your country/)
  assert.equal(otpCount() - otps, 0)
  assert.deepEqual(geoCounts(), before)
  for (const region of ['ON', 'BC']) {
    const n = otpCount()
    assert.equal((await signUp(proxied('CA', region))).status, 200, region)
    assert.equal(otpCount() - n, 1)
  }
})

test('geo: no checkout link for a blocked country', { skip: SKIP }, async () => {
  const u = user()
  await signIn(u)
  for (const [country, region] of [['DE', undefined], ['CA', 'QC']] as const) {
    const r = await tool(u.oauth, 'recall', { query: 'oolong' }, memory.url, proxied(country, region))
    assert.equal(r.status, 451, r.text)
    assert.match(r.text, /Clyde isn't available in your country/)
    assert.ok(!r.text.includes(CHECKOUT))
  }
})

test('geo: a subscription billed in DE or QC is cancelled and refunded', { skip: SKIP }, async (t) => {
  for (const [label, country, state] of [['DE', 'DE', null], ['CA with QC', 'CA', 'QC'], ['CA-QC', 'CA', 'CA-QC']] as const) {
    await t.test(label, async () => {
      const u = user()
      await signIn(u)
      await pay(u, { country: 'US' })
      const claim = await request('POST', `${memory.url}/devices/claim`, { headers: bearer(u.plain), body: { name: `box-${nonce()}` } })
      assert.equal(claim.status, 200, claim.text)
      const sub = `sub_${nonce()}`, order = `ord_${nonce()}`
      providers.state.orders.set(sub, [{ id: order, amount: 1000 }])
      const r = await polarDeliver(polarSubscription('subscription.active', { owner: u.id, id: sub, country, state }))
      assert.equal(r.status, 200, r.text)
      assert.equal(providers.calls.filter((c) => c.method === 'DELETE' && c.path === `/v1/subscriptions/${sub}` && c.status === 200).length, 1)
      assert.equal(providers.calls.filter((c) => c.method === 'POST' && c.path === '/v1/refunds/' && c.body?.order_id === order).length, 1)
      assert.notEqual(stateOf(u), 'paid')
      const next = await recall(u.oauth)
      assert.equal(next.status, 451, next.text)
      assert.equal(sql(`select count(*)::int as n from memory.device where owner_id = '${u.id}'`)[0].n, 0)
    })
  }
})

test('geo: a failed cancel or refund is retried on redelivery, once', { skip: SKIP }, async () => {
  const u = user()
  await signIn(u)
  const sub = `sub_${nonce()}`, order = `ord_${nonce()}`, id = `msg_${nonce()}`
  providers.state.orders.set(sub, [{ id: order, amount: 1000 }])
  const body = polarSubscription('subscription.active', { owner: u.id, id: sub, country: 'DE' })
  providers.state.failing = true
  try {
    assert.equal((await polarDeliver(body, { id })).status, 500)
  } finally {
    providers.state.failing = false
  }
  assert.notEqual(stateOf(u), 'paid')
  assert.equal((await polarDeliver(body, { id })).status, 200)
  assert.equal((await polarDeliver(body, { id })).status, 200)
  const ok = (c: { status: number }) => c.status < 300
  assert.equal(providers.calls.filter((c) => c.method === 'DELETE' && c.path === `/v1/subscriptions/${sub}` && ok(c)).length, 1)
  assert.equal(providers.calls.filter((c) => c.path === '/v1/refunds/' && c.body?.order_id === order && ok(c)).length, 1)
  assert.notEqual(stateOf(u), 'paid')
})

test('geo: one blocked list feeds sign-up and webhook', { skip: SKIP }, async () => {
  const count = (cmd: string) => execSync(cmd, { cwd: repoRoot(), encoding: 'utf8' }).trim()
  // Only regions.ts names the list, or a country code.
  assert.equal(count(`grep -rln 'BLOCKED_REGIONS' memory/supabase/functions/memory --include=*.ts`), 'memory/supabase/functions/memory/billing/regions.ts')
  assert.equal(count(`grep -rlE "[\\"'](DE|LI|CH)[\\"']" memory/supabase/functions/memory --include=*.ts | wc -l`), '1')
  // Sign-up, the tool-call refusal, checkout and the webhook all ask isBlocked().
  assert.equal(count(`grep -rlE 'isBlocked\\(|geoBlocked\\(' memory/supabase/functions/memory --include=*.ts | sort | tr '\\n' ' '`),
    'memory/supabase/functions/memory/billing/entitlement.ts memory/supabase/functions/memory/billing/index.ts memory/supabase/functions/memory/billing/regions.ts memory/supabase/functions/memory/billing/webhooks.ts memory/supabase/functions/memory/oauth.ts')
  // No checkout restriction goes to the provider.
  assert.equal(count(`grep -cE 'allowed_countries|allowed_billing_countries' memory/supabase/functions/memory/billing/polar.ts || true`), '0')
})

test('geo: country headers count only through the proxy', { skip: SKIP }, async () => {
  const email = `direct-${nonce()}@example.com`
  sql(`insert into memory.allowed_email (email) values ('${email}')`)
  const n = otpCount()
  const r = await signUp({ 'x-memory-proxy': 'wrong', 'cf-ipcountry': 'DE', 'x-forwarded-for': '192.0.2.50' }, email)
  assert.equal(r.status, 200, r.text)
  assert.equal(otpCount() - n, 1)
})

test('checkout: the 402 link sends a known owner to the provider, and refuses a blocked country or a stranger', { skip: SKIP }, async () => {
  const u = user()
  await signIn(u)
  const link = JSON.parse((await recall(u.oauth)).text).checkout_url as string
  const local = link.replace(CHECKOUT, `${memory.url}/billing/checkout`)
  const go = await request('GET', local)
  assert.equal(go.status, 302, go.text)
  assert.equal(go.headers.location, `https://sandbox.polar.test/checkout/${u.id}`)
  const made = providers.calls.filter((c) => c.path === '/v1/checkouts/').at(-1)!
  assert.deepEqual(made.body.products, ['prod_test'])
  assert.equal(made.body.external_customer_id, u.id)
  assert.equal((await request('GET', local, { headers: proxied('FR') })).status, 451)
  assert.equal((await request('GET', `${memory.url}/billing/checkout?owner=${randomUUID()}`)).status, 404)
})

test('admin: plans and entitlements are readable, and a plan is changed by data', { skip: SKIP }, async () => {
  const admin = (method: string, path: string, body?: unknown) =>
    request(method, `${memory.url}/api/v1${path}`, { headers: bearer(memory.adminToken), body, timeoutMs: 30_000 })
  const plans = JSON.parse((await admin('GET', '/billing/plans')).text).plans as Record<string, any>[]
  // One paid plan, a comp plan for Wen, and the free allocation (Wen, 2026-11-15).
  // bench is this file's own plan for the timing tests.
  assert.deepEqual(plans.map((p) => p.id).filter((id) => id !== 'bench').sort(), ['clyde', 'free', 'owner'])
  const owner = plans.find((p) => p.id === 'owner')!
  assert.deepEqual([owner.open, owner.recalls_month, owner.remembers_month, owner.openai_tokens_month, owner.burst_calls], [true, null, null, null, null])
  const freePlan = plans.find((p) => p.id === 'free')!
  assert.deepEqual([freePlan.open, freePlan.recalls_month, freePlan.remembers_month, freePlan.artifacts, freePlan.connected_agents], [true, 300, 50, false, 2])
  assert.equal(plans.find((p) => p.id === 'clyde')!.overage, true)
  assert.equal(sql(`select plan from memory.allowed_email where email = 'gewenyu99@gmail.com'`)[0]?.plan ?? 'owner', 'owner')
  const u = user()
  await signIn(u)
  await pay(u)
  const list = JSON.parse((await admin('GET', '/billing/entitlements?state=paid')).text).entitlements as Record<string, any>[]
  assert.ok(list.some((e) => e.owner_id === u.id && e.state === 'paid'))
  const put = await admin('PUT', '/billing/plans/probe', { name: 'Probe', price_micro_usd_month: 19990000, recalls_month: 5000, listed: false })
  assert.equal(put.status, 200, put.text)
  assert.equal(sql(`select recalls_month from memory.plan where id = 'probe'`)[0].recalls_month, 5000)
  sql(`delete from memory.plan where id = 'probe'`)
  assert.equal((await admin('PUT', '/secrets/polar_api_token', { value: `test-${nonce()}` })).status, 200)
  assert.equal((await admin('PUT', '/secrets/gemini_key', { value: `test-gemini-${nonce()}` })).status, 200)
  assert.equal((await admin('DELETE', '/secrets/gemini_key')).status, 200)
  assert.equal((await admin('PUT', '/secrets/not_a_secret', { value: 'x' })).status, 404)
  assert.equal((await admin('DELETE', '/secrets/not_a_secret')).status, 404)
  assert.equal(sql(`select count(*)::int as n from memory.admin_audit where action = 'plan.create' and target = 'plan:probe'`)[0].n, 1)
})
