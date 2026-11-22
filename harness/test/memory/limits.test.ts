/**
 * Tier 3: R38 (#42), a plan's limits, from its memory.plan row: hard caps on a plan without overage, included limits and
 * metered overage on clyde (Wen, 2026-11-15: one paid plan, pay-per-usage past it at a 50% gross margin), the overage
 * ceiling, the usage report to Polar's meter, blob storage, the burst limit, connected computers, the artifacts flag, the
 * free plan and its 1,000 seats, and the cost each plan can run up. Against the real memory function. The entitlement
 * cache's TTL is 1,500 ms here (MEMORY_ENTITLEMENT_TTL_MS).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { request } from '../../src/request.ts'
import { CEILING, chargeFor, costOf, INVOCATION_MICRO_USD, PLANNED, PROVIDER_RATE } from '../../../memory/supabase/functions/memory/billing/cost.ts'
import { jwt } from './auth.ts'
import { bearer, nonce, note } from './bed.ts'
import { deliver, newPolarSecret, polarSubscription, putSecret, setSetting, signPolar, startFakeProviders } from './billing.ts'
import { SKIP, sql, startRealMemory, startSibling, type RealMemory } from './server.ts'

const TTL = 1500
let memory: RealMemory
let providers: Awaited<ReturnType<typeof startFakeProviders>>
let POLAR: string

before(async () => {
  if (SKIP) return
  providers = await startFakeProviders()
  memory = await startRealMemory({ MEMORY_ENTITLEMENT_TTL_MS: String(TTL), POLAR_API_URL: providers.url })
  POLAR = newPolarSecret()
  setSetting('open_signup', 'on')
  putSecret('polar_webhook_secret', POLAR)
  putSecret('polar_api_token', `test-polar-api-${nonce()}`)
  // A paid plan with overage off and R38's caps, the shape R38's hard-cap criteria describe.
  sql(`insert into memory.plan (id, name, price_micro_usd_month, recalls_month, remembers_month, blob_bytes_total, openai_tokens_month,
      connected_agents, burst_calls, burst_seconds, overage)
    values ('hardcap', 'Hard cap', 10000000, 2000, 500, 52428800, 4000000, 10, 20, 10, false)`)
})

after(async () => {
  await memory?.close()
  await providers?.close()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const lapse = () => sleep(TTL + 200)
type User = { id: string; email: string; oauth: string; plain: string }

function user(email = `l-${nonce()}@example.com`): User {
  const id = randomUUID()
  return { id, email, oauth: jwt({ sub: id, email, client_id: 'claude-test', jti: randomUUID() }), plain: jwt({ sub: id, email, jti: randomUUID() }) }
}

async function rpc(token: string, method: string, params: Record<string, unknown> = {}, base = memory.url) {
  return await request('POST', `${base}/mcp`, { headers: bearer(token), body: { jsonrpc: '2.0', id: 1, method, params }, timeoutMs: 60_000 })
}
const tool = (token: string, name: string, args: Record<string, unknown>, base = memory.url) => rpc(token, 'tools/call', { name, arguments: args }, base)
const recall = (token: string, base = memory.url) => tool(token, 'recall', { query: 'oolong temperature' }, base)
const remember = (token: string, extra: Record<string, unknown> = {}) => tool(token, 'remember', note(`capped ${nonce()}`, extra))
const textOf = (r: { text: string }) => JSON.parse(r.text).result?.content?.[0]?.text as string

/** A signed-in subscriber, on clyde or, by SQL before their first call, another plan. */
async function paid(plan = 'clyde'): Promise<User> {
  const u = user()
  assert.equal((await rpc(u.oauth, 'initialize', { protocolVersion: '2025-06-18' })).status, 200)
  const body = polarSubscription('subscription.active', { owner: u.id })
  const r = await deliver(memory.url, '/billing/polar', body, signPolar(POLAR, body))
  assert.equal(r.status, 200, r.text)
  // The webhook dropped this instance's cached answer, so the next call reads the plan fresh.
  if (plan !== 'clyde') sql(`update memory.entitlement set plan = '${plan}' where owner_id = '${u.id}'`)
  return u
}
const paidOn = (plan: string) => paid(plan)
const overageOf = (u: User) => Number(sql(`select amount from memory.usage where owner_id = '${u.id}' and kind = 'overage_micro_usd_month'`)[0]?.amount ?? 0)

const MONTH = `date_trunc('month', now() at time zone 'utc')::date`
function seed(u: User, kind: string, amount: number) {
  const period = kind === 'blob_bytes_total' ? `'1970-01-01'::date` : MONTH
  sql(`insert into memory.usage (owner_id, period, kind, amount) values ('${u.id}', ${period}, '${kind}', ${amount})
    on conflict (owner_id, period, kind) do update set amount = excluded.amount`)
}

const nextMonth = () => {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10)
}

/** The reads a capped user keeps: get_entry, get_blob and check_messages each answer 200. */
async function readsStillWork(u: User) {
  const seeded = await tool(memory.runtimeToken, 'remember', note(`blob for reads ${nonce()}`, { artifacts: [{ name: 'r.txt', kind: 'document', text: `read ${nonce()}` }] }))
  const blob = /Blob r\.txt: ([0-9a-f]{64})/.exec(textOf(seeded))![1]
  for (const [name, args] of [['get_entry', { id: 'tea-oolong-temp' }], ['get_blob', { sha256: blob }], ['check_messages', {}]] as const) {
    const r = await tool(u.oauth, name, args)
    assert.equal(r.status, 200, `${name}: ${r.text}`)
  }
}

test('paid hard caps: 429 naming the cap and its reset, reads and other users unaffected', { skip: SKIP }, async (t) => {
  const paid = (_?: string) => paidOn('hardcap')
  const other = await paid()
  await t.test('recalls_month', async () => {
    const u = await paid()
    seed(u, 'recalls_month', 1999)
    assert.equal((await recall(u.oauth)).status, 200)
    const r = await recall(u.oauth)
    assert.equal(r.status, 429, r.text)
    assert.match(r.text, /recalls_month/)
    assert.ok(r.text.includes(nextMonth()), r.text)
    await readsStillWork(u)
    assert.equal((await recall(other.oauth)).status, 200)
  })
  await t.test('remembers_month', async () => {
    const u = await paid()
    seed(u, 'remembers_month', 499)
    const first = await remember(u.oauth)
    assert.equal(first.status, 200, first.text)
    const r = await remember(u.oauth)
    assert.equal(r.status, 429, r.text)
    assert.match(r.text, /remembers_month/)
    assert.ok(r.text.includes(nextMonth()))
    await readsStillWork(u)
    assert.equal((await remember(other.oauth)).status, 200)
  })
  await t.test('openai_tokens_month', async () => {
    const u = await paid()
    seed(u, 'openai_tokens_month', 3_999_999)
    // Its own oolong note (R49: an owner recalls only its own), so the degraded recall below has a candidate to filter.
    const first = await remember(u.oauth, { title: `oolong temperature ${nonce()}` })
    assert.equal(first.status, 200, first.text)
    const spent = Number(sql(`select amount from memory.usage where owner_id = '${u.id}' and kind = 'openai_tokens_month'`)[0].amount)
    assert.ok(spent >= 4_000_000, `${spent}`)
    const r = await remember(u.oauth)
    assert.equal(r.status, 429, r.text)
    assert.match(r.text, /openai_tokens_month/)
    assert.ok(r.text.includes(nextMonth()))
    const calls = memory.openai.calls.length
    const degraded = await recall(u.oauth)
    assert.equal(degraded.status, 200, degraded.text)
    assert.equal(memory.openai.calls.length - calls, 0)
    assert.match(textOf(degraded), /Degraded:/)
    await readsStillWork(u)
    assert.equal((await remember(other.oauth)).status, 200)
  })
  await t.test('blob_bytes_total', async () => {
    const u = await paid()
    seed(u, 'blob_bytes_total', 52_428_700)
    const first = await remember(u.oauth, { artifacts: [{ name: 'a.txt', kind: 'document', text: 'b'.repeat(100) }] })
    assert.equal(first.status, 200, first.text)
    assert.ok(!JSON.parse(first.text).result.isError, first.text)
    const r = await remember(u.oauth, { artifacts: [{ name: 'b.txt', kind: 'document', text: 'c' }] })
    assert.equal(r.status, 429, r.text)
    assert.match(r.text, /blob_bytes_total/)
    assert.match(r.text, /52428800/)
    await readsStillWork(u)
  })
})

test('allowlisted owners carry the same hard caps', { skip: SKIP }, async () => {
  const email = `allow-${nonce()}@example.com`
  sql(`insert into memory.allowed_email (email) values ('${email}')`)
  const a = user(email)
  assert.equal((await rpc(a.oauth, 'initialize', { protocolVersion: '2025-06-18' })).status, 200)
  seed(a, 'recalls_month', 2000)
  const r = await recall(a.oauth)
  assert.equal(r.status, 429, r.text)
  assert.match(r.text, /recalls_month/)
})

test("a plan's limits come from its one plan row", { skip: SKIP }, async () => {
  const rows = sql(`select price_micro_usd_month, recalls_month, remembers_month, blob_bytes_total, openai_tokens_month from memory.plan where id = 'clyde'`)
    .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)])))
  assert.equal(rows.length, 1)
  // CLYDE-DESIGN.md's clyde plan (R50 #55, R59 #64).
  assert.deepEqual(rows[0], { price_micro_usd_month: 12990000, recalls_month: 2000, remembers_month: 500, blob_bytes_total: 5368709120, openai_tokens_month: 1500000 })
  const u = await paid('hardcap')
  seed(u, 'recalls_month', 5)
  try {
    sql(`update memory.plan set recalls_month = 5 where id = 'hardcap'`)
    await lapse()
    const r = await recall(u.oauth)
    assert.equal(r.status, 429, r.text)
  } finally {
    sql(`update memory.plan set recalls_month = 2000 where id = 'hardcap'`)
  }
})

test('overage: past clyde\'s included limits the call goes on and its cost is metered, up to the ceiling', { skip: SKIP }, async () => {
  const u = await paid()
  seed(u, 'recalls_month', 2000)
  const first = await recall(u.oauth)
  assert.equal(first.status, 200, first.text)
  assert.ok(overageOf(u) >= INVOCATION_MICRO_USD, `${overageOf(u)}`)
  // Tokens past the included 1.5M cost their price.
  seed(u, 'openai_tokens_month', 1_500_000)
  const before = overageOf(u)
  const wrote = await remember(u.oauth)
  assert.equal(wrote.status, 200, wrote.text)
  assert.ok(overageOf(u) > before + INVOCATION_MICRO_USD - 1, `${before} -> ${overageOf(u)}`)
  // Blobs past the included 5 GiB cost a month of storage.
  seed(u, 'blob_bytes_total', 5_368_709_120)
  const stored = overageOf(u)
  assert.equal((await remember(u.oauth, { artifacts: [{ name: 'o.txt', kind: 'document', text: 'o'.repeat(1000) }] })).status, 200)
  assert.ok(overageOf(u) > stored)
  // The month's ceiling stops it, naming the ceiling and the reset.
  const ceiling = Number(sql(`select overage_ceiling_micro_usd_month from memory.plan where id = 'clyde'`)[0].overage_ceiling_micro_usd_month)
  seed(u, 'overage_micro_usd_month', ceiling)
  const stopped = await recall(u.oauth)
  assert.equal(stopped.status, 429, stopped.text)
  assert.match(stopped.text, /overage_ceiling_micro_usd_month/)
  assert.ok(stopped.text.includes(nextMonth()))
})

test('overage: the hourly report sends new overage to the meter once, billed at a 50% margin net of the provider', { skip: SKIP }, async () => {
  const u = await paid()
  seed(u, 'overage_micro_usd_month', 870_000)
  const cron = (body = {}) => request('POST', `${memory.url}/billing/usage/report`, { headers: bearer(memory.cronSecret), body })
  assert.equal((await request('POST', `${memory.url}/billing/usage/report`, { body: {} })).status, 401)
  const r = await cron()
  assert.equal(r.status, 200, r.text)
  const sent = providers.calls.filter((c) => c.path === '/v1/events/ingest' && c.body?.events?.[0]?.external_customer_id === u.id)
  assert.equal(sent.length, 1)
  const event = sent[0].body.events[0]
  assert.equal(event.name, 'clyde_overage')
  assert.equal(event.metadata.cost_micro_usd, 870_000)
  assert.equal(event.metadata.charge_micro_usd, chargeFor(870_000))
  const charge = event.metadata.charge_micro_usd
  assert.ok((charge - charge * PROVIDER_RATE - 870_000) / charge >= 0.5 - 1e-6)
  assert.equal((await cron()).status, 200)
  assert.equal(providers.calls.filter((c) => c.path === '/v1/events/ingest' && c.body?.events?.[0]?.external_customer_id === u.id).length, 1)
  // An allowlisted owner is never billed: no provider customer, so no overage and nothing to report.
  const email = `free-${nonce()}@example.com`
  sql(`insert into memory.allowed_email (email) values ('${email}')`)
  const a = user(email)
  assert.equal((await rpc(a.oauth, 'initialize', { protocolVersion: '2025-06-18' })).status, 200)
  seed(a, 'recalls_month', 2000)
  assert.equal((await recall(a.oauth)).status, 429)
  assert.equal(overageOf(a), 0)
})

test('burst: the 21st call in 10 s gets 429 with retry-after', { skip: SKIP }, async () => {
  const u = await paid(), u2 = await paid()
  for (let i = 0; i < 10; i++) assert.equal((await rpc(u.oauth, 'initialize', { protocolVersion: '2025-06-18' })).status, 200)
  for (let i = 0; i < 10; i++) assert.equal((await rpc(u.oauth, 'tools/list')).status, 200)
  const statuses: number[] = []
  let last
  for (let i = 0; i < 21; i++) {
    last = await tool(u.oauth, 'check_messages', {})
    statuses.push(last.status)
  }
  assert.deepEqual(statuses, [...Array(20).fill(200), 429])
  const wait = Number(last!.headers['retry-after'])
  assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= 10, `retry-after ${last!.headers['retry-after']}`)
  assert.equal((await tool(u2.oauth, 'check_messages', {})).status, 200)
  await sleep(wait * 1000 + 100)
  assert.equal((await tool(u.oauth, 'check_messages', {})).status, 200)
})

test('burst: shared across instances, hooks and the runtime token not counted', { skip: SKIP }, async () => {
  const b = await startSibling(memory)
  try {
    const u = await paid()
    const statuses: number[] = []
    for (let i = 0; i < 21; i++) statuses.push((await tool(u.oauth, 'check_messages', {}, i % 2 ? b.url : memory.url)).status)
    assert.equal(statuses[20], 429)
    // A device the paid user claimed: its hooks never count.
    const claim = await request('POST', `${memory.url}/devices/claim`, { headers: bearer(u.plain), body: { name: `burst-${nonce()}` } })
    assert.equal(claim.status, 200, claim.text)
    const device = JSON.parse(claim.text).token as string
    for (let i = 0; i < 30; i++) {
      const r = await request('POST', `${memory.url}/hooks/PostToolUse`, { headers: bearer(device), body: { tool_name: 'Bash' } })
      assert.equal(r.status, 200, r.text)
    }
    for (let i = 0; i < 25; i++) assert.equal((await tool(memory.runtimeToken, 'check_messages', {})).status, 200)
  } finally {
    await b.close()
  }
})

test('free plan: the first 1,000 accounts, its limits give 402 with the checkout link, no artifacts, no quests, and 50k tokens', { skip: SKIP }, async () => {
  const p = await paid()
  assert.equal((await tool(p.oauth, 'list_quests', {})).status, 200)
  const u = user()
  assert.equal((await rpc(u.oauth, 'initialize', { protocolVersion: '2025-06-18' })).status, 200)
  assert.equal(sql(`select free_slot from memory.account where owner_id = '${u.id}'`)[0].free_slot, true)
  const quest = await tool(u.oauth, 'list_quests', {})
  assert.equal(quest.status, 402, quest.text)
  assert.match(quest.text, /quest board/)
  seed(u, 'recalls_month', 49)
  assert.equal((await recall(u.oauth)).status, 200)
  const over = await recall(u.oauth)
  assert.equal(over.status, 402, over.text)
  const overBody = JSON.parse(over.text)
  assert.ok(overBody.checkout_url.includes(u.id))
  assert.ok(overBody.starter_checkout_url?.includes('plan=starter'))
  const artifact = await remember(u.oauth, { artifacts: [{ name: 'x.txt', kind: 'document', text: 'x' }] })
  assert.equal(artifact.status, 402, artifact.text)
  assert.match(artifact.text, /artifacts/)
  assert.equal((await remember(u.oauth)).status, 200)
  const tok = user()
  assert.equal((await rpc(tok.oauth, 'initialize', { protocolVersion: '2025-06-18' })).status, 200)
  seed(tok, 'openai_tokens_month', 50_000)
  const tokWrite = await remember(tok.oauth)
  assert.equal(tokWrite.status, 402, tokWrite.text)
  assert.ok(JSON.parse(tokWrite.text).checkout_url.includes(tok.id))
  assert.equal((await recall(tok.oauth)).status, 200)
  try {
    // Once the seats are taken, a new account gets none, and so no plan.
    sql(`update memory.plan set seats = (select count(*) from memory.account where free_slot) where id = 'free'`)
    const late = user()
    assert.equal((await rpc(late.oauth, 'initialize', { protocolVersion: '2025-06-18' })).status, 200)
    assert.equal(sql(`select free_slot from memory.account where owner_id = '${late.id}'`)[0].free_slot, false)
    assert.equal((await recall(late.oauth)).status, 402)
  } finally {
    sql(`update memory.plan set seats = 1000 where id = 'free'`)
  }
})

test('starter plan: hard caps give 429, artifacts work, quests give 402, and no overage is billed', { skip: SKIP }, async () => {
  const s = await paidOn('starter')
  const artifact = await remember(s.oauth, { artifacts: [{ name: 'st.txt', kind: 'document', text: 'starter ok' }] })
  assert.equal(artifact.status, 200, artifact.text)
  assert.equal(overageOf(s), 0)

  const quest = await tool(s.oauth, 'list_quests', {})
  assert.equal(quest.status, 402, quest.text)
  assert.match(quest.text, /\/usage/)

  seed(s, 'recalls_month', 600)
  const capped = await recall(s.oauth)
  assert.equal(capped.status, 429, capped.text)
  assert.match(capped.text, /\/usage/)
  assert.equal(overageOf(s), 0)
  await readsStillWork(s)
})

test('connected agents: a plan caps the computers one owner claims', { skip: SKIP }, async () => {
  const u = await paid()
  try {
    sql(`update memory.plan set connected_agents = 1 where id = 'clyde'`)
    await lapse()
    const claim = (name: string) => request('POST', `${memory.url}/devices/claim`, { headers: bearer(u.plain), body: { name } })
    const first = `box-${nonce()}`
    assert.equal((await claim(first)).status, 200)
    // Reclaiming the same computer rotates its token and takes no new slot.
    assert.equal((await claim(first)).status, 200)
    const second = await claim(`box-${nonce()}`)
    assert.equal(second.status, 429, second.text)
    assert.match(second.text, /connected/)
  } finally {
    sql(`update memory.plan set connected_agents = 10 where id = 'clyde'`)
  }
})

test('worst-case cost at every limit is <= $7.00, and every listed plan keeps its margin', { skip: SKIP }, async () => {
  const plans = sql(`select id, price_micro_usd_month, openai_tokens_month, blob_bytes_total, listed, margin_floor from memory.plan`)
    .map((p) => ({ ...p, price_micro_usd_month: Number(p.price_micro_usd_month), openai_tokens_month: p.openai_tokens_month === null ? null : Number(p.openai_tokens_month), blob_bytes_total: p.blob_bytes_total === null ? null : Number(p.blob_bytes_total) }))
  const paidPlan = plans.find((p) => p.id === 'clyde')!
  const ceiling = costOf(paidPlan, CEILING)
  assert.ok(ceiling.total <= 7, `clyde costs ${ceiling.total.toFixed(2)} at every cap: ${JSON.stringify(ceiling.lines)}`)
  for (const p of plans.filter((p) => p.listed)) {
    const c = costOf(p, PLANNED)
    assert.ok(c.margin >= Number(p.margin_floor), `${p.id} keeps ${(c.margin * 100).toFixed(1)}%, under its floor of ${p.margin_floor}`)
  }
})
