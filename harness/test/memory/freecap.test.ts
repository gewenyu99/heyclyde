/**
 * Tier 3: R74 (#79), Clyde's free tier has a hard cap, and a cost guard closes it before Supabase usage outruns what paying
 * users cover. Against the real memory function with sign-in open. The free seats are memory.plan.seats on the free row,
 * claimed under a row lock. The guard (POST /billing/guard, hourly) reads database size, Storage, MAU, invocations and egress
 * against Supabase Pro's quotas (billing/cost.ts SUPABASE_PRO), closes free (setting free_open = off) when a metric passes
 * 80% and revenue doesn't cover the projected overage, and tells Wen. It never removes anyone.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { request } from '../../src/request.ts'
import { jwt, submitAllow } from './auth.ts'
import { bearer, nonce } from './bed.ts'
import { apply, exec, SKIP, sql, startRealMemory, type RealMemory } from './server.ts'
import { WEN_ID } from './tenants.ts'

const TTL = 1500
let memory: RealMemory

before(async () => {
  if (SKIP) return
  memory = await startRealMemory({ MEMORY_ENTITLEMENT_TTL_MS: String(TTL) })
  exec(`insert into memory.setting (name, value) values ('open_signup', 'on') on conflict (name) do update set value = 'on';`)
})

after(async () => {
  await memory?.close()
})

const lapse = () => new Promise((r) => setTimeout(r, TTL + 200))
const seats = () => Number(sql(`select count(*)::int as n from memory.account where free_slot`)[0].n)
const setFree = (n: number) => sql(`update memory.plan set seats = ${n} where id = 'free'`)
const setting = (name: string, value: string | null) => value === null
  ? sql(`delete from memory.setting where name = '${name}'`)
  : sql(`insert into memory.setting (name, value) values ('${name}', '${value}') on conflict (name) do update set value = excluded.value`)

/** A user's first MCP call, which records the account and claims a seat if one is free. */
async function signIn(id = randomUUID(), email = `u-${nonce()}@example.com`) {
  const token = jwt({ sub: id, email, client_id: 'claude-test', jti: randomUUID() })
  const r = await request('POST', `${memory.url}/mcp`, {
    headers: bearer(token), timeoutMs: 60_000,
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-ai' } } },
  })
  assert.equal(r.status, 200, r.text)
  return { id, email, token }
}

/** Accounts that already hold a free seat, straight into the table. */
function heldSeats(n: number) {
  exec(`insert into memory.account (owner_id, email, email_confirmed, free_slot)
    select gen_random_uuid(), 'held-' || g || '-${nonce()}@example.com', true, true from generate_series(1, ${n}) g;`)
}

const guard = async () => {
  const r = await request('POST', `${memory.url}/billing/guard`, { headers: bearer(memory.cronSecret), timeoutMs: 60_000 })
  assert.equal(r.status, 200, r.text)
  return JSON.parse(r.text)
}
const wenNotes = () => Number(sql(`select count(*)::int as n from memory.message where owner_id = '${WEN_ID}' and sender = 'memory' and recipient = 'wen'`)[0].n)

test('R74: free seats never pass the cap', { skip: SKIP }, async () => {
  exec(`update memory.account set free_slot = false;`)
  sql(`update memory.plan set free_per_paid_n = null where id = 'free'`)
  setFree(1000)
  try {
    heldSeats(995 - seats())
    assert.equal(seats(), 995)
    const users = await Promise.all(Array.from({ length: 50 }, () => signIn()))
    const got = Number(sql(`select count(*)::int as n from memory.account where free_slot and owner_id = any(array[${users.map((u) => `'${u.id}'`).join(',')}]::uuid[])`)[0].n)
    assert.equal(got, 5)
    assert.equal(seats(), 1000)
  } finally {
    sql(`update memory.plan set free_per_paid_n = 10, free_per_paid_m = 1 where id = 'free'`)
  }
})

test('R74: a full free tier says so, with the plan', { skip: SKIP }, async () => {
  setFree(seats())
  const email = `late-${nonce()}@example.com`, auth = `auth-${nonce()}`
  memory.auth.signIns[`code-${auth}`] = email
  memory.auth.authorizations[auth] = { redirect_uri: 'https://claude.ai/api/mcp/auth_callback', client: { id: 'claude-client', name: 'Claude' } }
  exec(`insert into memory.oauth_consent (authorization_id, code_verifier) values ('${auth}', 'verifier-${nonce()}');`)
  const prompt = await request('GET', `${memory.url}/oauth/approve?authorization_id=${auth}&code=code-${auth}`)
  assert.equal(prompt.status, 200, prompt.text)
  const r = await submitAllow(memory.url, prompt, auth)
  assert.equal(r.status, 200, r.text)
  assert.match(r.text, /connected/)
  assert.ok(r.text.includes('free tier is full') && r.text.includes('$12.99') && r.text.includes('/billing/checkout'), r.text)
  const [account] = sql(`select free_slot from memory.account where email = '${email}'`)
  assert.equal(account?.free_slot, false)
  setFree(1000)
})

test('R74: free_open off gives no seat', { skip: SKIP }, async () => {
  setFree(100000)
  sql(`update memory.plan set free_per_paid_n = null where id = 'free'`)
  setting('free_open', 'off')
  try {
    const u = await signIn()
    assert.equal(sql(`select free_slot from memory.account where owner_id = '${u.id}'`)[0].free_slot, false)
    await lapse()
    const r = await request('POST', `${memory.url}/mcp`, {
      headers: bearer(u.token), timeoutMs: 60_000,
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recall', arguments: { query: 'oolong' } } },
    })
    assert.equal(r.status, 402, r.text)
  } finally {
    setting('free_open', null)
    sql(`update memory.plan set free_per_paid_n = 10, free_per_paid_m = 1 where id = 'free'`)
    setFree(1000)
  }
})

test('R74: the guard closes free when usage outruns revenue', { skip: SKIP }, async () => {
  // The database is far past 80% of a 1 MB quota, and nobody pays.
  setting('cost_guard_quotas', JSON.stringify({ db_bytes: 1_000_000 }))
  setting('free_open', null)
  exec(`delete from memory.entitlement where state = 'paid';`)
  const accounts = Number(sql(`select count(*)::int as n from memory.account`)[0].n), held = seats(), notes = wenNotes()
  try {
    const out = await guard()
    assert.equal(out.decision, 'closed', JSON.stringify(out))
    assert.equal(sql(`select value from memory.setting where name = 'free_open'`)[0]?.value, 'off')
    assert.equal(wenNotes(), notes + 1)
    assert.equal(Number(sql(`select count(*)::int as n from memory.account`)[0].n), accounts)
    assert.equal(seats(), held)
    // A second run while closed tells Wen nothing new.
    await guard()
    assert.equal(wenNotes(), notes + 1)
  } finally {
    setting('cost_guard_quotas', null)
    setting('free_open', null)
  }
})

test('R74: the guard keeps free open when revenue covers it', { skip: SKIP }, async () => {
  // 90% of the database quota used, so no overage at all, against any revenue.
  const [{ size }] = sql(`select pg_database_size(current_database())::bigint as size`)
  setting('cost_guard_quotas', JSON.stringify({ db_bytes: Math.ceil(Number(size) / 0.9) }))
  exec(`insert into memory.entitlement (owner_id, provider, plan, state, event_at, current_period_end)
    select gen_random_uuid(), 'polar', 'clyde', 'paid', now(), now() + interval '20 days' from generate_series(1, 3);`)
  setting('free_open', null)
  try {
    const out = await guard()
    assert.equal(out.decision, 'open', JSON.stringify(out))
    assert.ok(out.revenue_usd >= 38.97 - 0.01, JSON.stringify(out))
    assert.equal(sql(`select value from memory.setting where name = 'free_open'`)[0]?.value ?? null, null)
  } finally {
    setting('cost_guard_quotas', null)
    exec(`delete from memory.entitlement where provider = 'polar' and state = 'paid';`)
  }
})

test("R74: the guard's reading is in the console", { skip: SKIP }, async () => {
  await guard()
  const r = await request('GET', `${memory.url}/api/v1/billing/guard`, { headers: bearer(memory.adminToken), timeoutMs: 30_000 })
  assert.equal(r.status, 200, r.text)
  const g = JSON.parse(r.text)
  assert.ok(g.decision && g.at, r.text)
  for (const k of ['db_bytes', 'storage_bytes', 'mau', 'invocations', 'egress_bytes']) {
    const m = g.metrics?.[k]
    assert.ok(m && typeof m.used === 'number' && m.included > 0 && typeof m.share === 'number', `${k}: ${JSON.stringify(m)}`)
  }
})

test('R74: the guard runs hourly', { skip: SKIP }, () => {
  apply('20261116040000_free_cap_guard.sql')
  try {
    const [job] = sql(`select schedule from cron.job where jobname = 'memory-cost-guard'`)
    assert.match(job?.schedule ?? '', /^\d{1,2} \* \* \* \*$/)
  } finally {
    sql(`select cron.unschedule('memory-cost-guard')`)
    exec(`delete from memory.usage where kind in ('ai', 'storage_gb_hours', 'egress_bytes', 'requests', 'db_bytes');`)
    apply('20261116050000_free_ratio_and_spend_cap.sql')
    apply('20261117000000_metering_r59.sql')
    sql(`select cron.unschedule('memory-usage-sample') where exists (select 1 from cron.job where jobname = 'memory-usage-sample')`)
  }
})

test('R75: free seats scale as N per M paid users (Clyde is 1st paid user) and stop when full', { skip: SKIP }, async () => {
  exec(`update memory.account set free_slot = false; delete from memory.entitlement where state = 'paid';`)
  sql(`update memory.plan set seats = 1000, free_per_paid_n = 3, free_per_paid_m = 1 where id = 'free'`)
  try {
    // 0 external paid rows + Clyde (1st paid) = 1 paid -> 3 free seats open under concurrency.
    const batch1 = await Promise.all(Array.from({ length: 10 }, () => signIn()))
    const got1 = Number(sql(`select count(*)::int as n from memory.account where free_slot and owner_id = any(array[${batch1.map((u) => `'${u.id}'`).join(',')}]::uuid[])`)[0].n)
    assert.equal(got1, 3)
    assert.equal(seats(), 3)
    const rejected = batch1.find((u) => !sql(`select free_slot from memory.account where owner_id = '${u.id}'`)[0].free_slot)!
    await lapse()
    const denied = await request('POST', `${memory.url}/mcp`, {
      headers: bearer(rejected.token), timeoutMs: 60_000,
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recall', arguments: { query: 'oolong' } } },
    })
    assert.equal(denied.status, 402, denied.text)
    // Adding 1 active starter paid user brings total paid to 2 -> 6 total free seats (3 more open).
    exec(`insert into memory.entitlement (owner_id, provider, plan, state, event_at, current_period_end)
      values (gen_random_uuid(), 'polar', 'starter', 'paid', now(), now() + interval '20 days');`)
    const batch2 = await Promise.all(Array.from({ length: 6 }, () => signIn()))
    const got2 = Number(sql(`select count(*)::int as n from memory.account where free_slot and owner_id = any(array[${batch2.map((u) => `'${u.id}'`).join(',')}]::uuid[])`)[0].n)
    assert.equal(got2, 3)
    assert.equal(seats(), 6)
  } finally {
    exec(`delete from memory.entitlement where provider = 'polar' and state = 'paid';`)
    sql(`update memory.plan set free_per_paid_n = 10, free_per_paid_m = 1 where id = 'free'`)
  }
})

test('R75: free monthly spend pool, 50K per-user token cap, and quest-board gate stop free usage', { skip: SKIP }, async () => {
  exec(`update memory.account set free_slot = false;`)
  sql(`update memory.plan set seats = 1000, free_per_paid_n = 10, free_per_paid_m = 1 where id = 'free'`)
  const month = `date_trunc('month', now() at time zone 'utc')::date`
  try {
    const u = await signIn()
    assert.equal(sql(`select free_slot from memory.account where owner_id = '${u.id}'`)[0].free_slot, true)
    // Quest board is paid-only on free.
    const quest = await request('POST', `${memory.url}/mcp`, {
      headers: bearer(u.token), timeoutMs: 60_000,
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_quests', arguments: {} } },
    })
    assert.equal(quest.status, 402, quest.text)
    assert.match(quest.text, /quest board/)
    const okRecall = await request('POST', `${memory.url}/mcp`, {
      headers: bearer(u.token), timeoutMs: 60_000,
      body: { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'recall', arguments: { query: 'oolong' } } },
    })
    assert.equal(okRecall.status, 200, okRecall.text)
    const [poolRow] = sql(`select amount::bigint as a from memory.usage where owner_id = '00000000-0000-0000-0000-00000000f4ee' and kind = 'free_pool_micro_usd_month'`)
    assert.ok(Number(poolRow?.a ?? 0) >= 2, `expected free pool >= 2 micro-USD, got ${poolRow?.a}`)
    // Hitting the global free pool monthly spend ceiling blocks new calls and closes guard.
    exec(`insert into memory.usage (owner_id, period, kind, amount)
      values ('00000000-0000-0000-0000-00000000f4ee', ${month}, 'free_pool_micro_usd_month', 5000000)
      on conflict (owner_id, period, kind) do update set amount = excluded.amount;`)
    const pooled = await request('POST', `${memory.url}/mcp`, {
      headers: bearer(u.token), timeoutMs: 60_000,
      body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'recall', arguments: { query: 'oolong' } } },
    })
    assert.equal(pooled.status, 402, pooled.text)
    assert.match(pooled.text, /budget/)
    const g = await guard()
    assert.equal(g.decision, 'closed', JSON.stringify(g))
  } finally {
    exec(`delete from memory.usage where owner_id = '00000000-0000-0000-0000-00000000f4ee';`)
    setting('free_open', null)
  }
})
