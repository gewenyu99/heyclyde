/**
 * Tier 3: R59 (#64, Clyde slice C12): per-owner metering, 2.3 x overage billing to Polar with hourly idempotency,
 * spend_limit_cents cutoff leaving /me reads open, past_due cutoff with 0 Polar events, and owner-prefixed Storage keys.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { request } from '../../src/request.ts'
import {
  chargeFor, costOf, METERED_KINDS, PLANNED, PROVIDER_RATE,
} from '../../../memory/supabase/functions/memory/billing/cost.ts'
import { jwt } from './auth.ts'
import { bearer, nonce, note } from './bed.ts'
import { deliver, newPolarSecret, polarSubscription, putSecret, setSetting, signPolar, startFakeProviders } from './billing.ts'
import { SKIP, sql, startRealMemory, type RealMemory } from './server.ts'

const TTL = 1500
let memory: RealMemory
let providers: Awaited<ReturnType<typeof startFakeProviders>>
let POLAR: string

before(async () => {
  if (SKIP) return
  providers = await startFakeProviders()
  memory = await startRealMemory({ MEMORY_ENTITLEMENT_TTL_MS: String(TTL), POLAR_API_URL: providers.url, RESEND_API_URL: providers.url }, { storage: true })
  POLAR = newPolarSecret()
  setSetting('open_signup', 'on')
  setSetting('embed_budget_tokens', '1000000000')
  setSetting('judge_write_reserve_tokens', '1000000000')
  putSecret('polar_webhook_secret', POLAR)
  putSecret('polar_api_token', `test-polar-api-${nonce()}`)
  putSecret('resend_api_key', `test-resend-${nonce()}`)
})

after(async () => {
  await memory?.close()
  await providers?.close()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const lapse = () => sleep(TTL + 200)
const MONTH = `date_trunc('month', now() at time zone 'utc')::date`
const nextMonth = () => {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10)
}

type User = { id: string; email: string; oauth: string; plain: string }

function user(email = `r59-${nonce()}@example.com`): User {
  const id = randomUUID()
  return {
    id,
    email,
    oauth: jwt({ sub: id, email, client_id: 'claude-test', jti: randomUUID() }),
    plain: jwt({ sub: id, email, jti: randomUUID() }),
  }
}

async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
  return await request('POST', `${memory.url}/mcp`, {
    headers: bearer(token),
    body: { jsonrpc: '2.0', id: 1, method, params },
    timeoutMs: 60_000,
  })
}

const tool = (token: string, name: string, args: Record<string, unknown>) => rpc(token, 'tools/call', { name, arguments: args })
const recall = (token: string) => tool(token, 'recall', { query: 'oolong temperature' })
const remember = (token: string, extra: Record<string, unknown> = {}) => tool(token, 'remember', note(`r59 ${nonce()}`, extra))
function assertRemembered(r: { status: number; text: string }) {
  assert.equal(r.status, 200, r.text)
  const out = JSON.parse(r.text).result
  assert.ok(out && !out.isError, r.text)
}

async function paid(): Promise<{ user: User; subId: string }> {
  const u = user()
  const subId = `sub_${nonce()}`
  assert.equal((await rpc(u.oauth, 'initialize', { protocolVersion: '2025-06-18' })).status, 200)
  const body = polarSubscription('subscription.active', { owner: u.id, id: subId })
  const r = await deliver(memory.url, '/billing/polar', body, signPolar(POLAR, body))
  assert.equal(r.status, 200, r.text)
  return { user: u, subId }
}

async function reportHour(hour: string) {
  const r = await request('POST', `${memory.url}/billing/usage/report`, {
    headers: bearer(memory.cronSecret),
    body: { hour },
    timeoutMs: 60_000,
  })
  assert.equal(r.status, 200, r.text)
  return JSON.parse(r.text)
}

test('every listed plan keeps its margin floor', { skip: SKIP }, () => {
  for (const kind of METERED_KINDS) {
    for (const cost of [1, 100, 100_000, 870_000]) {
      const charge = chargeFor(cost)
      const margin = (charge * (1 - PROVIDER_RATE) - cost) / charge
      assert.ok(margin >= 0.5, `${kind} cost ${cost}: margin ${margin} < 0.5`)
    }
  }
  type PlanRow = {
    id: string
    listed: boolean
    margin_floor: number | string
    price_micro_usd_month: number
    openai_tokens_month: number | null
    blob_bytes_total: number | null
  }
  const load = (): PlanRow[] => sql(`select id, listed, margin_floor, price_micro_usd_month, openai_tokens_month, blob_bytes_total from memory.plan`)
    .map((p): PlanRow => ({
      id: String(p.id),
      listed: Boolean(p.listed),
      margin_floor: p.margin_floor,
      price_micro_usd_month: Number(p.price_micro_usd_month),
      openai_tokens_month: p.openai_tokens_month === null ? null : Number(p.openai_tokens_month),
      blob_bytes_total: p.blob_bytes_total === null ? null : Number(p.blob_bytes_total),
    }))
  const assertListedKeepFloor = (rows: PlanRow[]) => {
    for (const p of rows.filter((r) => r.listed)) {
      const c = costOf(p, PLANNED)
      assert.ok(c.margin >= Number(p.margin_floor), `${p.id} margin ${c.margin} < floor ${p.margin_floor}`)
    }
  }
  const rows = load()
  assertListedKeepFloor(rows)
  const clyde = rows.find((r) => r.id === 'clyde')!
  const clydeCost = costOf(clyde, PLANNED)
  assert.ok(clydeCost.total <= 0.25 * 12.99, `clyde total ${clydeCost.total} > ${0.25 * 12.99}`)
  assert.ok(clydeCost.margin >= 0.75, `clyde margin ${clydeCost.margin} < 0.75`)

  try {
    sql(`update memory.plan set openai_tokens_month = 4000000 where id = 'clyde'`)
    const raised = load()
    assert.throws(() => assertListedKeepFloor(raised), /margin .* < floor/)
  } finally {
    sql(`update memory.plan set openai_tokens_month = 1500000 where id = 'clyde'`)
  }
})

test('overage at 2.3 times cost', { skip: SKIP }, async () => {
  const { user: u } = await paid()
  try {
    // Owner starts at $0.50 (500,000 micro-USD) of AI spend, settled in an earlier hour.
    memory.openai.options.tokens = 5_000_000
    assertRemembered(await remember(u.oauth))
    await reportHour('2026-11-18T01')

    const from = providers.calls.length
    // Then spends $0.10 (100,000 micro-USD) more on AI.
    memory.openai.options.tokens = 1_000_000
    assertRemembered(await remember(u.oauth))
    await reportHour('2026-11-18T02')

    const sent = providers.calls
      .slice(from)
      .filter((c) => c.path === '/v1/events/ingest')
      .flatMap((c) => (c.body?.events ?? []) as Record<string, any>[])
      .filter((e) => e.external_customer_id === u.id)
    assert.equal(sent.length, 1, JSON.stringify(sent))
    assert.equal(sent[0].metadata?.kind, 'ai')
    assert.equal(sent[0].metadata?.amount, 230_000)
  } finally {
    memory.openai.options.tokens = undefined
  }
})

test('ingest is idempotent', { skip: SKIP }, async () => {
  const { user: u } = await paid()
  try {
    memory.openai.options.tokens = 5_000_000
    assertRemembered(await remember(u.oauth))
    await reportHour('2026-11-18T03')

    memory.openai.options.tokens = 1_000_000
    assertRemembered(await remember(u.oauth))
    await reportHour('2026-11-18T04')
    await reportHour('2026-11-18T04')

    const held = [...providers.events.values()].filter(
      (e) => e.external_customer_id === u.id && e.metadata?.kind === 'ai' && e.metadata?.hour === '2026-11-18T04',
    )
    assert.equal(held.length, 1, JSON.stringify(held))
    assert.equal(held[0].metadata?.amount, 230_000)
  } finally {
    memory.openai.options.tokens = undefined
  }
})

test('the spend limit stops metered calls', { skip: SKIP }, async () => {
  const { user: u } = await paid()
  try {
    sql(`update memory.entitlement set spend_limit_cents = 100 where owner_id = '${u.id}'`)
    await lapse()

    // $0.635 total AI cost ($0.44 overage cost -> $1.012 billed at 2.3x >= $1.00).
    memory.openai.options.tokens = 6_350_000
    assertRemembered(await remember(u.oauth))
    await reportHour('2026-11-18T05')

    memory.openai.options.tokens = 100
    const blocked = await remember(u.oauth)
    assert.equal(blocked.status, 429, blocked.text)
    assert.match(blocked.text, /spend limit/i)
    assert.ok(blocked.text.includes(nextMonth()), blocked.text)

    const entries = await request('GET', `${memory.url}/me/entries`, { headers: bearer(u.plain), timeoutMs: 30_000 })
    assert.equal(entries.status, 200, entries.text)
  } finally {
    memory.openai.options.tokens = undefined
  }
})

test('no overage while past due', { skip: SKIP }, async () => {
  const { user: u, subId } = await paid()
  const hookBody = polarSubscription('subscription.past_due', { owner: u.id, id: subId, status: 'past_due' })
  assert.equal((await deliver(memory.url, '/billing/polar', hookBody, signPolar(POLAR, hookBody))).status, 200)
  assert.equal(sql(`select state from memory.entitlement where owner_id = '${u.id}'`)[0]?.state, 'past_due')

  sql(`insert into memory.usage (owner_id, period, kind, amount, quantity, cost_micro_usd)
    values
      ('${u.id}', ${MONTH}, 'openai_tokens_month', 1500000, 1500000, 195000),
      ('${u.id}', ${MONTH}, 'ai', 200000, 1500000, 200000)
    on conflict (owner_id, period, kind) do update set
      amount = excluded.amount, quantity = excluded.quantity, cost_micro_usd = excluded.cost_micro_usd`)

  const from = providers.calls.length
  const r = await recall(u.oauth)
  assert.equal(r.status, 429, r.text)

  await reportHour('2026-11-18T06')
  const eventsForOwner = providers.calls
    .slice(from)
    .filter((c) => c.path === '/v1/events/ingest')
    .flatMap((c) => (c.body?.events ?? []) as Record<string, any>[])
    .filter((e) => e.external_customer_id === u.id)
  assert.equal(eventsForOwner.length, 0, JSON.stringify(eventsForOwner))
})

test('blobs live under the owner', { skip: SKIP }, async () => {
  const { user: a } = await paid()
  const png = randomBytes(512)
  const sha = createHash('sha256').update(png).digest('hex')
  const r = await remember(a.oauth, {
    artifacts: [{ name: 'owner-shot.png', kind: 'image', media_type: 'image/png', base64: png.toString('base64') }],
  })
  assert.equal(r.status, 200, r.text)
  const out = JSON.parse(r.text).result
  assert.ok(!out.isError, r.text)

  const objects = sql(`select name from storage.objects where bucket_id = 'memory-blobs' and name like '%/${sha}'`)
  assert.equal(objects.length, 1, JSON.stringify(objects))
  assert.ok(String(objects[0].name).startsWith(`${a.id}/`), `expected ${a.id}/..., got ${objects[0].name}`)
})

test('lapsed accounts after 90 days', { skip: SKIP }, async () => {
  const { user: old } = await paid()
  const { user: fresh } = await paid()
  for (const [u, sub] of [[old, `sub_old_${nonce()}`], [fresh, `sub_fresh_${nonce()}`]] as const) {
    const hookBody = polarSubscription('subscription.revoked', { owner: u.id, id: sub, status: 'canceled' })
    assert.equal((await deliver(memory.url, '/billing/polar', hookBody, signPolar(POLAR, hookBody))).status, 200)
    exec(`insert into memory.entry (owner_id, id, pattern, kind, title, body, authority, scope, evidence)
      values ('${u.id}', 'lapse-note-${nonce()}', 'observations', 'observation', 'Lapse note', 'Hold on.', 'observed', 'global', 'Test.');`)
  }
  const runLapse = async () => {
    const r = await request('POST', `${memory.url}/billing/lapse`, { headers: bearer(memory.cronSecret), body: {}, timeoutMs: 30_000 })
    assert.equal(r.status, 200, r.text)
    return JSON.parse(r.text)
  }

  // Day 60 for old, day 59 for fresh -> day-60 warning only for old.
  exec(`update memory.entitlement set lapsed_at = now() - interval '60 days', lapse_emails_sent = '{}' where owner_id = '${old.id}';
    update memory.entitlement set lapsed_at = now() - interval '59 days', lapse_emails_sent = '{}' where owner_id = '${fresh.id}';`)
  await runLapse()
  assert.equal(providers.emails.filter((e) => e.to.includes(old.email)).length, 1)
  assert.equal(providers.emails.filter((e) => e.to.includes(fresh.email)).length, 0)
  // Idempotent on re-run within same stage.
  await runLapse()
  assert.equal(providers.emails.filter((e) => e.to.includes(old.email)).length, 1)

  // Day 83 for old, still day 59 for fresh -> day-83 warning for old.
  exec(`update memory.entitlement set lapsed_at = now() - interval '83 days' where owner_id = '${old.id}';`)
  await runLapse()
  assert.equal(providers.emails.filter((e) => e.to.includes(old.email)).length, 2)
  assert.equal(providers.emails.filter((e) => e.to.includes(fresh.email)).length, 0)
  assert.equal(sql(`select count(*)::int as n from memory.account where owner_id = '${old.id}'`)[0].n, 1)

  // Day 91 for old, still day 59 for fresh -> old deleted, fresh kept.
  exec(`update memory.entitlement set lapsed_at = now() - interval '91 days' where owner_id = '${old.id}';`)
  await runLapse()
  assert.equal(providers.emails.filter((e) => e.to.includes(old.email)).length, 2)
  assert.equal(sql(`select count(*)::int as n from memory.account where owner_id = '${old.id}'`)[0].n, 0)
  assert.equal(sql(`select count(*)::int as n from memory.entry where owner_id = '${old.id}'`)[0].n, 0)
  assert.equal(sql(`select count(*)::int as n from memory.entitlement where owner_id = '${old.id}'`)[0].n, 0)
  assert.equal(sql(`select count(*)::int as n from memory.account where owner_id = '${fresh.id}'`)[0].n, 1)
  assert.equal(sql(`select count(*)::int as n from memory.entry where owner_id = '${fresh.id}'`)[0].n, 1)
})
