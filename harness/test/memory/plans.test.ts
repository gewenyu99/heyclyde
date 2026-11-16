/**
 * Tier 3: R50 (#55), Clyde's limits come from one plan table, Wen has no limits, and the allowlist becomes entitlement.
 * Against the real memory function. memory.plan holds every cap, entries_total among them (100 on free). A confirmed account
 * on the allowlist holds a comp entitlement on the allowlist's plan, kept in step by triggers. The entitlement cache's TTL
 * is 1,500 ms here (MEMORY_ENTITLEMENT_TTL_MS), so a change to a plan or the allowlist takes hold after a 1.6 s wait.
 *
 * The migration test rebuilds the schema up to R50's migration, so it runs last.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { request } from '../../src/request.ts'
import { waitFor } from '../helpers.ts'
import { jwt } from './auth.ts'
import { bearer, bedFor, marker, nonce, sha256 } from './bed.ts'
import { apply, exec, resetDatabase, SKIP, sql, startRealMemory, type RealMemory } from './server.ts'
import { WEN_ID } from './tenants.ts'

const PLANS = '20261116030000_plans.sql'
const TTL = 1500
let memory: RealMemory
let bed: ReturnType<typeof bedFor>

before(async () => {
  if (SKIP) return
  memory = await startRealMemory({ MEMORY_ENTITLEMENT_TTL_MS: String(TTL) })
  bed = bedFor(memory)
})

after(async () => {
  await memory?.close()
})

const lapse = () => new Promise((r) => setTimeout(r, TTL + 200))

type Owner = { id: string; email: string; token: string }

/** An owner with a confirmed account and one computer. free: it holds a free seat. plan: an entitlement on that plan. */
function owner(tag: string, o: { free?: boolean; paid?: string; allow?: string } = {}): Owner {
  const id = randomUUID(), email = `${tag}-${nonce()}@example.com`, token = `device-${tag}-${nonce()}${nonce()}`
  exec(`insert into memory.account (owner_id, email, email_confirmed, free_slot) values ('${id}', '${email}', true, ${Boolean(o.free)});
    insert into memory.device (name, token_sha256, owner_id) values ('${tag}-box', '${sha256(token)}', '${id}');
    ${o.paid ? `insert into memory.entitlement (owner_id, provider, plan, state, event_at, current_period_end)
      values ('${id}', 'polar', '${o.paid}', 'paid', now(), now() + interval '20 days');` : ''}
    ${o.allow ? `insert into memory.allowed_email (email, plan) values ('${email}', '${o.allow}');` : ''}`)
  return { id, email, token }
}

/** n entries for owner, written straight into the table. */
function entries(o: Owner, n: number) {
  exec(`begin; select set_config('memory.owner', '${o.id}', true);
    insert into memory.entry (id, pattern, title, body, authority, scope, sensitivity, lang, evidence_kind, evidence, kind)
    select 'held-' || g, 'observations', 'Held ' || g, 'Held.', 'observed', 'global', 'normal', 'en', 'summary', 'held', 'observation'
    from generate_series(1, ${n}) g;
    commit;`)
}

const count = (o: Owner) => Number(sql(`select count(*)::int as n from memory.entry where owner_id = '${o.id}'`)[0].n)
const remember = async (token: string) => {
  const s = await bed.mcp(token)
  return await s.tool('remember', { pattern: 'observations', title: `Plan probe ${marker()}`, body: 'One more.', evidence: 'Tier 3.' })
}

test('R50: plan rows', { skip: SKIP }, () => {
  const rows = sql(`select * from memory.plan order by id`)
  assert.deepEqual(rows.map((r) => r.id), ['clyde', 'free', 'owner'])
  const by = Object.fromEntries(rows.map((r) => [r.id, r]))
  const free = by.free, clyde = by.clyde, own = by.owner
  assert.deepEqual([free.seats, free.recalls_month, free.remembers_month, Number(free.blob_bytes_total), free.artifacts, free.connected_agents, free.overage, free.entries_total],
    [1000, 300, 50, 0, false, 2, false, 100])
  assert.deepEqual([Number(clyde.price_micro_usd_month), Number(clyde.openai_tokens_month), Number(clyde.blob_bytes_total), clyde.recalls_month,
    clyde.remembers_month, clyde.overage, Number(clyde.margin_floor), clyde.entries_total], [12990000, 1500000, 5368709120, 2000, 500, true, 0.75, null])
  const limits = ['recalls_month', 'remembers_month', 'blob_bytes_total', 'openai_tokens_month', 'connected_agents', 'burst_calls',
    'burst_seconds', 'overage_ceiling_micro_usd_month', 'seats', 'entries_total']
  assert.deepEqual(limits.filter((k) => own[k] !== null), [])
})

test('R50: the allowlist and comp move together', { skip: SKIP }, async () => {
  // No free seats, so an owner with no comp and no subscription is refused.
  sql(`update memory.plan set seats = 0 where id = 'free'`)
  try {
    const id = randomUUID(), email = `comp-${nonce()}@example.com`
    exec(`insert into memory.allowed_email (email, plan) values ('${email}', 'clyde');`)
    const token = jwt({ sub: id, email, client_id: 'claude-test', jti: randomUUID() })
    const call = (method: string, params: Record<string, unknown>) =>
      request('POST', `${memory.url}/mcp`, { headers: bearer(token), body: { jsonrpc: '2.0', id: 1, method, params }, timeoutMs: 60_000 })
    assert.equal((await call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-ai' } })).status, 200)
    const comp = () => sql(`select plan, state from memory.entitlement where owner_id = '${id}'`)
    assert.deepEqual(comp(), [{ plan: 'clyde', state: 'comp' }])
    assert.equal((await call('tools/call', { name: 'recall', arguments: { query: 'oolong' } })).status, 200)
    exec(`delete from memory.allowed_email where email = '${email}';`)
    assert.deepEqual(comp(), [])
    await lapse()
    assert.equal((await call('tools/call', { name: 'recall', arguments: { query: 'oolong' } })).status, 402)
  } finally {
    sql(`update memory.plan set seats = 1000 where id = 'free'`)
  }
})

test('R50: free stops at 100 memories', { skip: SKIP }, async () => {
  const f = owner('free100', { free: true }), c = owner('clyde100', { paid: 'clyde' })
  entries(f, 100)
  entries(c, 100)
  const refused = await remember(f.token)
  assert.equal(refused.error, true, refused.text)
  assert.ok(refused.text.includes('100') && refused.text.includes('Upgrade'), refused.text)
  assert.equal(count(f), 100)
  const kept = await remember(c.token)
  assert.equal(kept.error, false, kept.text)
})

test('R50: caps come from memory.plan', { skip: SKIP }, async () => {
  const f = owner('free3', { free: true })
  entries(f, 3)
  sql(`update memory.plan set entries_total = 3 where id = 'free'`)
  try {
    await lapse()
    const refused = await remember(f.token)
    assert.equal(refused.error, true, refused.text)
    assert.ok(refused.text.includes('3'), refused.text)
  } finally {
    sql(`update memory.plan set entries_total = 100 where id = 'free'`)
  }
  await lapse()
  const kept = await remember(f.token)
  assert.equal(kept.error, false, kept.text)
})

test('R50: owner has no caps', { skip: SKIP }, async () => {
  assert.deepEqual(sql(`select plan, state from memory.entitlement where owner_id = '${WEN_ID}'`), [{ plan: 'owner', state: 'comp' }])
  exec(`insert into memory.usage (owner_id, period, kind, amount) values
      ('${WEN_ID}', date_trunc('month', now())::date, 'recalls_month', 5000),
      ('${WEN_ID}', date_trunc('month', now())::date, 'remembers_month', 2000)
    on conflict (owner_id, period, kind) do update set amount = excluded.amount;`)
  const s = await bed.mcp(memory.token)
  const recalled = await s.tool('recall', { query: 'oolong temperature' })
  assert.equal(recalled.error, false, recalled.text)
  const wrote = await s.tool('remember', { pattern: 'observations', title: `Wen past every cap ${marker()}`, body: 'No limits.', evidence: 'Tier 3.' })
  assert.equal(wrote.error, false, wrote.text)
  const http = (path: string, body: unknown) =>
    request('POST', `${memory.url}${path}`, { headers: bearer(memory.runtimeToken), body, timeoutMs: 60_000 })
  assert.equal((await http('/recall', { query: 'oolong' })).status, 200)
  const word = marker()
  const entry = await http('/entries', {
    id: `runtime-cap-${word}`, pattern: 'projects', title: `Runtime past every cap ${word}`, body: 'No limits.', authority: 'observed',
    scope: 'global', evidence_kind: 'summary', evidence: 'Tier 3 made it.', source: { kind: 'run', title: 'clyde run r50', uri: `clyde://runs/${word}` },
  })
  assert.equal(entry.status, 200, entry.text)
})

test("R50: cron embeds within each owner's token cap", { skip: SKIP }, async () => {
  const f = owner('tokfree', { free: true }), c = owner('tokclyde', { paid: 'clyde' })
  const ids: Record<string, string> = {}
  for (const [o, tag] of [[f, 'f'], [c, 'c'], [{ id: WEN_ID } as Owner, 'w']] as const) {
    ids[tag] = `tok-${tag}-${nonce()}`
    exec(`begin; select set_config('memory.owner', '${o.id}', true);
      insert into memory.entry (id, pattern, title, body, authority, scope, sensitivity, lang, evidence_kind, evidence, kind)
      values ('${ids[tag]}', 'observations', 'Token probe ${ids[tag]}', 'Words to embed.', 'observed', 'global', 'normal', 'en', 'summary', 'x', 'observation');
      commit;`)
  }
  exec(`update memory.plan set openai_tokens_month = 10 where id = 'free';
    insert into memory.usage (owner_id, period, kind, amount) values ('${f.id}', date_trunc('month', now())::date, 'openai_tokens_month', 10);`)
  try {
    await lapse()
    const r = await request('POST', `${memory.url}/embeddings/sync`, { headers: bearer(memory.cronSecret), timeoutMs: 30_000 })
    assert.equal(r.status, 202, r.text)
    const embedded = (id: string) => Number(sql(`select count(*)::int as n from memory.entry_embedding where entry_id = '${id}'`)[0].n)
    const status = () => JSON.stringify(sql(`select value from memory.setting where name = 'embed_sync_status'`)[0] ?? null)
    await waitFor(() => (embedded(ids.w) && embedded(ids.c)) || null, 180_000, "Wen's and the clyde owner's embeddings")
      .catch((e) => { throw new Error(`${e.message}; sync status ${status()}`) })
    await waitFor(() => !sql(`select 1 from memory.setting where name = 'embed_sync_status' and value::jsonb->>'running' = 'true'`).length || null, 60_000, 'the sync to finish')
    assert.equal(embedded(ids.f), 0, "the free owner at its cap gets none")
    const [spent] = sql(`select amount from memory.usage where owner_id = '${c.id}' and kind = 'openai_tokens_month' and period = date_trunc('month', now())::date`)
    assert.ok(Number(spent?.amount ?? 0) > 0, `the clyde owner's sync tokens are on its own counter: ${JSON.stringify(spent)}`)
  } finally {
    sql(`update memory.plan set openai_tokens_month = null where id = 'free'`)
  }
})

test('R50: allowlisted addresses become comp', { skip: SKIP }, async () => {
  resetDatabase(PLANS)
  const a = { id: randomUUID(), email: `own-${nonce()}@example.com`, token: `device-own-${nonce()}${nonce()}` }
  const b = { id: randomUUID(), email: `friend-${nonce()}@example.com`, token: `device-friend-${nonce()}${nonce()}` }
  exec(`insert into memory.allowed_email (email, plan) values ('${a.email}', 'owner'), ('${b.email}', 'clyde');
    insert into memory.account (owner_id, email, email_confirmed, free_slot) values ('${a.id}', '${a.email}', true, true), ('${b.id}', '${b.email}', true, false);
    insert into memory.device (name, token_sha256, owner_id) values ('own-box', '${sha256(a.token)}', '${a.id}'), ('friend-box', '${sha256(b.token)}', '${b.id}');`)
  apply(PLANS)
  const rows = sql(`select owner_id, plan, state from memory.entitlement where owner_id in ('${a.id}', '${b.id}') order by plan`)
  assert.deepEqual(rows.map((r) => [r.owner_id, r.plan, r.state]), [[b.id, 'clyde', 'comp'], [a.id, 'owner', 'comp']])
  assert.equal(sql(`select free_slot from memory.account where owner_id = '${a.id}'`)[0].free_slot, false)
  const [check] = sql(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'entitlement_state_check'`)
  assert.match(check.def, /'comp'/)
  for (const o of [a, b]) {
    const s = await bed.mcp(o.token)
    const r = await s.tool('recall', { query: 'anything' })
    assert.equal(r.error, false, r.text)
  }
})
