/**
 * Tier 3's unit tests of R38's billing (#42), run with `deno test`: the blocked list, both providers' signatures and event
 * mapping, which credential each billing path takes, and the entitlement cache's default TTL. No database.
 */
import assert from 'node:assert/strict'
import { credentialFor } from '../../../memory/supabase/functions/memory/auth.ts'
import { config } from '../../../memory/supabase/functions/memory/config.ts'
import { paddle } from '../../../memory/supabase/functions/memory/billing/paddle.ts'
import { polar } from '../../../memory/supabase/functions/memory/billing/polar.ts'
import { chargeFor, includedCostMicroUsd } from '../../../memory/supabase/functions/memory/billing/cost.ts'
import { BLOCKED_REGIONS, isBlocked } from '../../../memory/supabase/functions/memory/billing/regions.ts'

const enc = new TextEncoder()
async function hmac(key: Uint8Array, data: string) {
  const k = await crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)))
}
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const now = () => Math.floor(Date.now() / 1000)
const KEY = crypto.getRandomValues(new Uint8Array(24))
const WHSEC = 'whsec_' + b64(KEY)

Deno.test('geo: the blocked list is the EU 27, Iceland, Liechtenstein, Norway, the UK and Switzerland, plus Quebec', () => {
  const eu = 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(' ')
  assert.deepEqual([...BLOCKED_REGIONS.countries].sort(), [...eu, 'IS', 'LI', 'NO', 'GB', 'CH'].sort())
  assert.equal(BLOCKED_REGIONS.countries.size, 32)
  assert.deepEqual([...BLOCKED_REGIONS.regions], ['CA-QC'])
  for (const c of BLOCKED_REGIONS.countries) assert.equal(isBlocked(c), true, c)
  assert.equal(isBlocked('CA', 'QC'), true)
  assert.equal(isBlocked('CA', 'CA-QC'), true)
  assert.equal(isBlocked('ca', 'qc'), true)
  assert.equal(isBlocked('CA', 'ON'), false)
  assert.equal(isBlocked('CA', 'BC'), false)
  assert.equal(isBlocked('US', 'QC'), false)
  assert.equal(isBlocked(null), false)
  assert.equal(isBlocked('XX'), false)
  assert.equal(isBlocked('XX', null, true), true)
  assert.equal(isBlocked('T1', null, true), true)
})

async function polarHeaders(body: string, opts: { key?: Uint8Array; ts?: number; id?: string } = {}) {
  const id = opts.id ?? 'msg_1', ts = String(opts.ts ?? now())
  const sig = b64(await hmac(opts.key ?? KEY, `${id}.${ts}.${body}`))
  return new Headers({ 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` })
}

Deno.test('polar: Standard Webhooks signatures verify, with the decoded key or the legacy whole-secret key', async () => {
  const body = '{"type":"subscription.active","data":{}}'
  assert.equal(await polar.verify(await polarHeaders(body), enc.encode(body), WHSEC, now()), 'ok')
  assert.equal(await polar.verify(await polarHeaders(body, { key: enc.encode(WHSEC) }), enc.encode(body), WHSEC, now()), 'ok')
  assert.equal(await polar.verify(await polarHeaders(body), enc.encode(body + ' '), WHSEC, now()), 'bad')
  assert.equal(await polar.verify(await polarHeaders(body, { key: crypto.getRandomValues(new Uint8Array(24)) }), enc.encode(body), WHSEC, now()), 'bad')
  assert.equal(await polar.verify(await polarHeaders(body, { ts: now() - 301 }), enc.encode(body), WHSEC, now()), 'stale')
  assert.equal(await polar.verify(await polarHeaders(body, { ts: now() + 301 }), enc.encode(body), WHSEC, now()), 'stale')
  assert.equal(await polar.verify(await polarHeaders(body, { ts: now() - 299 }), enc.encode(body), WHSEC, now()), 'ok')
  assert.equal(await polar.verify(new Headers({ 'webhook-id': 'x', 'webhook-timestamp': String(now()) }), enc.encode(body), WHSEC, now()), 'bad')
  // Several signatures, space separated, during a key rotation.
  const h = await polarHeaders(body)
  h.set('webhook-signature', `v1,${b64(new Uint8Array(32))} ${h.get('webhook-signature')}`)
  assert.equal(await polar.verify(h, enc.encode(body), WHSEC, now()), 'ok')
})

Deno.test('polar: subscription and refund events map to access', () => {
  const owner = crypto.randomUUID()
  const h = new Headers({ 'webhook-id': 'msg_2', 'webhook-timestamp': String(now()) })
  const sub = (type: string, data: Record<string, unknown>) =>
    polar.parse(enc.encode(JSON.stringify({ type, timestamp: '2026-11-15T00:00:00Z', data: { id: 'sub_1', customer: { external_id: owner, billing_address: { country: 'CA', state: 'QC' } }, ...data } })), h)!
  const active = sub('subscription.active', { status: 'active', current_period_end: '2026-12-15T00:00:00Z' })
  assert.equal(active.id, 'msg_2')
  assert.equal(active.subscription!.owner, owner)
  assert.equal(active.subscription!.status, 'paid')
  assert.equal(active.subscription!.country, 'CA')
  assert.equal(active.subscription!.region, 'QC')
  assert.equal(sub('subscription.past_due', { status: 'past_due' }).subscription!.status, 'past_due')
  assert.equal(sub('subscription.revoked', { status: 'canceled' }).subscription!.status, 'lapsed')
  assert.equal(sub('subscription.canceled', { status: 'active', cancel_at_period_end: true }).subscription!.cancelAtPeriodEnd, true)
  assert.equal(sub('subscription.uncanceled', { status: 'active', cancel_at_period_end: true }).subscription!.cancelAtPeriodEnd, false)
  assert.equal(sub('subscription.created', { status: 'incomplete' }).subscription!.status, 'pending')
  assert.equal(sub('subscription.active', { status: 'active', customer: { external_id: 'not-a-uuid' } }).subscription!.owner, null)
  const refund = polar.parse(enc.encode(JSON.stringify({ type: 'order.refunded', data: { id: 'ord_1', subscription_id: 'sub_1', total_amount: 1000, refunded_amount: 1000, customer: { external_id: owner } } })), h)!
  assert.deepEqual(refund.refund, { orderId: 'ord_1', subscriptionId: 'sub_1', owner, refunded: 1000, total: 1000 })
  assert.equal(polar.parse(enc.encode(JSON.stringify({ type: 'checkout.created', data: {} })), h), null)
})

Deno.test('paddle: Paddle-Signature ts;h1 verifies, and events map to access', async () => {
  const secret = 'pdl_ntfset_unit_' + hex(crypto.getRandomValues(new Uint8Array(8)))
  const body = '{"event_type":"subscription.activated"}'
  const sign = async (ts: number, key = secret) => new Headers({ 'paddle-signature': `ts=${ts};h1=${hex(await hmac(enc.encode(key), `${ts}:${body}`))}` })
  assert.equal(await paddle.verify(await sign(now()), enc.encode(body), secret, now()), 'ok')
  assert.equal(await paddle.verify(await sign(now(), 'other'), enc.encode(body), secret, now()), 'bad')
  assert.equal(await paddle.verify(await sign(now() - 301), enc.encode(body), secret, now()), 'stale')
  assert.equal(await paddle.verify(new Headers(), enc.encode(body), secret, now()), 'bad')
  const owner = crypto.randomUUID()
  const e = paddle.parse(enc.encode(JSON.stringify({ event_id: 'evt_1', event_type: 'subscription.activated', occurred_at: '2026-11-15T00:00:00Z', data: { id: 'sub_1', status: 'active', custom_data: { owner_id: owner } } })), new Headers())!
  assert.equal(e.id, 'evt_1')
  assert.equal(e.subscription!.owner, owner)
  assert.equal(e.subscription!.status, 'paid')
  const full = paddle.parse(enc.encode(JSON.stringify({ event_id: 'evt_2', event_type: 'adjustment.updated', data: { action: 'refund', type: 'full', status: 'approved', transaction_id: 'txn_1', subscription_id: 'sub_1', totals: { total: '1000' } } })), new Headers())!
  assert.ok(full.refund!.refunded >= full.refund!.total)
  const partial = paddle.parse(enc.encode(JSON.stringify({ event_id: 'evt_3', event_type: 'adjustment.updated', data: { action: 'refund', type: 'partial', status: 'approved', transaction_id: 'txn_1', subscription_id: 'sub_1', totals: { total: '500' } } })), new Headers())!
  assert.ok(partial.refund!.refunded < partial.refund!.total)
  assert.equal(paddle.parse(enc.encode(JSON.stringify({ event_id: 'evt_4', event_type: 'adjustment.created', data: { action: 'refund', status: 'pending_approval' } })), new Headers()), null)
  assert.equal(paddle.parse(enc.encode(JSON.stringify({ event_id: 'evt_5', event_type: 'subscription.past_due', data: { id: 'sub_1', status: 'past_due', custom_data: { owner_id: owner } } })), new Headers())!.subscription!.status, 'past_due')
})

Deno.test('cost: overage is 2.3x cost and includedCostMicroUsd matches clyde included limits', () => {
  assert.equal(chargeFor(100_000), 230_000)
  const clyde = { price_micro_usd_month: 12_990_000, openai_tokens_month: 1_500_000, blob_bytes_total: 5_368_709_120 }
  assert.equal(includedCostMicroUsd(clyde, 'ai'), 195_000)
})

Deno.test('entitlement: webhooks take no bearer token, checkout is open, and the cache lasts 60 s by default', () => {
  for (const p of ['/billing/polar', '/billing/paddle', '/billing/polar/webhook']) assert.equal(credentialFor(p), 'webhook', p)
  assert.equal(credentialFor('/billing/checkout'), 'open')
  assert.equal(credentialFor('/billing/thanks'), 'open')
  assert.equal(credentialFor('/billing/usage/report'), 'cron')
  assert.equal(credentialFor('/mcp'), 'agent')
  assert.equal(credentialFor('/devices/claim'), 'owner')
  assert.equal(credentialFor('/billing/nope/deeper'), null)
  if (!Deno.env.get('MEMORY_ENTITLEMENT_TTL_MS')) assert.equal(config.entitlementTtlMs, 60_000)
})
