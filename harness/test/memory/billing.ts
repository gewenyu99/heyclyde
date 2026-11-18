/**
 * Tier 3 support for R38 (#42): signed Polar (Standard Webhooks) and Paddle fixtures, and a fake of both providers' APIs, so
 * CI never reaches either. The function reads the fake's address from POLAR_API_URL and PADDLE_API_URL.
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import http from 'node:http'
import { request } from '../../src/request.ts'
import { sql } from './server.ts'

/** A Polar endpoint secret in Polar's shape: whsec_ and base64 bytes. Made here, so it is a test value. */
export const newPolarSecret = () => 'whsec_' + randomBytes(24).toString('base64')
export const newPaddleSecret = () => 'pdl_ntfset_test_' + randomBytes(16).toString('hex')

/** The Standard Webhooks headers for a body: HMAC-SHA256 keyed by the base64 after whsec_, over id.timestamp.body. */
export function signPolar(secret: string, body: string, opts: { id?: string; ts?: number } = {}) {
  const id = opts.id ?? `msg_${randomUUID()}`
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000))
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')
  return { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}`, 'content-type': 'application/json' }
}

export function signPaddle(secret: string, body: string, ts = Math.floor(Date.now() / 1000)) {
  const h1 = createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex')
  return { 'paddle-signature': `ts=${ts};h1=${h1}`, 'content-type': 'application/json' }
}

export type Sub = {
  owner: string | null; id?: string; status?: string; cancelAtPeriodEnd?: boolean; periodEnd?: Date
  country?: string; state?: string | null; productId?: string
}

/** A Polar subscription event, as its webhook sends it. */
export function polarSubscription(type: string, s: Sub, at = new Date()) {
  return JSON.stringify({
    type, timestamp: at.toISOString(),
    data: {
      id: s.id ?? `sub_${randomUUID()}`, status: s.status ?? 'active', amount: 1000, currency: 'usd', recurring_interval: 'month',
      cancel_at_period_end: s.cancelAtPeriodEnd ?? false, current_period_end: (s.periodEnd ?? new Date(Date.now() + 30 * 86_400_000)).toISOString(),
      ended_at: null, product_id: s.productId ?? 'prod_test', customer_id: 'cus_test', modified_at: at.toISOString(),
      customer: { id: 'cus_test', external_id: s.owner, billing_address: { country: s.country ?? 'US', state: s.state ?? null } },
    },
  })
}

export function polarRefund(owner: string | null, subscription: string, refunded: number, total = 1000, at = new Date()) {
  return JSON.stringify({
    type: 'order.refunded', timestamp: at.toISOString(),
    data: { id: `ord_${randomUUID()}`, subscription_id: subscription, total_amount: total, refunded_amount: refunded, status: refunded >= total ? 'refunded' : 'partially_refunded', customer: { external_id: owner } },
  })
}

/** Paddle's subscription events carry the owner in custom_data, which checkout set. */
export function paddleSubscription(type: string, s: Sub, at = new Date()) {
  return JSON.stringify({
    event_id: `evt_${randomUUID()}`, event_type: type, occurred_at: at.toISOString(), notification_id: `ntf_${randomUUID()}`,
    data: {
      id: s.id ?? `sub_${randomUUID()}`, status: s.status ?? 'active', customer_id: 'ctm_test', custom_data: { owner_id: s.owner },
      current_billing_period: { starts_at: at.toISOString(), ends_at: new Date(Date.now() + 30 * 86_400_000).toISOString() },
      items: [{ price: { id: 'pri_test', product_id: 'pro_test' } }], scheduled_change: null,
    },
  })
}

export function paddleRefund(subscription: string, full = true, at = new Date()) {
  return JSON.stringify({
    event_id: `evt_${randomUUID()}`, event_type: 'adjustment.updated', occurred_at: at.toISOString(),
    data: { id: `adj_${randomUUID()}`, action: 'refund', type: full ? 'full' : 'partial', status: 'approved', transaction_id: `txn_${randomUUID()}`, subscription_id: subscription, totals: { total: '1000' } },
  })
}

export type ProviderCall = { method: string; path: string; body: any; status: number }

/** A fake of the provider APIs memory calls. `failing` answers 500 to cancels and refunds while it is true. `orders` lists a
 * subscription's paid orders. */
export async function startFakeProviders() {
  const calls: ProviderCall[] = []
  const emails: { from: string; to: string[]; subject: string; text: string }[] = []
  const events = new Map<string, any>()
  const state = { failing: false, orders: new Map<string, { id: string; amount: number }[]>() }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake')
      let body: any = null
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
      } catch {
        // Not JSON.
      }
      const reply = (status: number, out: unknown) => {
        calls.push({ method: req.method ?? '', path: url.pathname + url.search, body, status })
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(out))
      }
      if (!/^Bearer \S+/.test(String(req.headers.authorization ?? ''))) return reply(401, { error: 'no token' })
      const p = url.pathname
      if (req.method === 'DELETE' && /^\/v1\/subscriptions\/[^/]+$/.test(p)) return state.failing ? reply(500, {}) : reply(200, { id: p.split('/').pop(), status: 'canceled' })
      if (req.method === 'GET' && p === '/v1/orders/') {
        const items = (state.orders.get(url.searchParams.get('subscription_id') ?? '') ?? []).map((o) => ({ id: o.id, status: 'paid', paid: true, total_amount: o.amount, refunded_amount: 0, refundable_amount: o.amount }))
        return reply(200, { items, pagination: { total_count: items.length, max_page: 1 } })
      }
      if (req.method === 'POST' && p === '/v1/refunds/') return state.failing ? reply(500, {}) : reply(201, { id: `ref_${randomUUID()}`, order_id: body?.order_id, amount: body?.amount })
      if (req.method === 'POST' && p === '/v1/events/ingest') {
        if (state.failing) return reply(500, {})
        let inserted = 0
        for (const ev of (body?.events ?? []) as Record<string, any>[]) {
          const key = typeof ev?.external_id === 'string' && ev.external_id ? ev.external_id : randomUUID()
          if (!events.has(key)) {
            events.set(key, ev)
            inserted++
          }
        }
        return reply(200, { inserted })
      }
      if (req.method === 'POST' && p === '/v1/checkouts/') return reply(201, { id: 'chk_test', url: `https://sandbox.polar.test/checkout/${body?.external_customer_id}` })
      if (req.method === 'POST' && /^\/subscriptions\/[^/]+\/cancel$/.test(p)) return state.failing ? reply(500, {}) : reply(200, { data: { status: 'canceled' } })
      if (req.method === 'GET' && p === '/transactions') return reply(200, { data: [] })
      if (req.method === 'POST' && p === '/adjustments') return state.failing ? reply(500, {}) : reply(201, { data: { id: 'adj_test' } })
      if (req.method === 'POST' && p === '/transactions') return reply(201, { data: { checkout: { url: `https://sandbox.paddle.test/checkout/${body?.custom_data?.owner_id}` } } })
      if (req.method === 'POST' && p === '/emails') {
        emails.push({
          from: String(body?.from ?? ''),
          to: Array.isArray(body?.to) ? body.to.map(String) : [],
          subject: String(body?.subject ?? ''),
          text: String(body?.text ?? ''),
        })
        return reply(200, { id: `email_${randomUUID()}` })
      }
      reply(404, { error: `fake providers have no ${req.method} ${p}` })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`, calls, emails, events, state,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

export const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** Stores a Vault secret on the test database. */
export function putSecret(name: string, value: string) {
  sql(`do $$ declare old uuid; begin select id into old from vault.secrets where name = '${name}';
    if old is null then perform vault.create_secret('${value}', '${name}'); else perform vault.update_secret(old, '${value}'); end if; end $$`)
}

export function setSetting(name: string, value: string) {
  sql(`insert into memory.setting (name, value) values ('${name}', '${value}') on conflict (name) do update set value = excluded.value`)
}

/** The row count of every table in schema memory, by table. */
export function tableCounts(): Record<string, number> {
  const tables = sql(`select table_name from information_schema.tables where table_schema = 'memory' and table_type = 'BASE TABLE' order by 1`)
    .map((r) => r.table_name as string)
  const rows = sql(tables.map((t) => `select '${t}' as t, count(*)::int as n from memory."${t}"`).join(' union all '))
  return Object.fromEntries(rows.map((r) => [r.t, r.n]))
}

/** POST a body to a webhook route as raw text, so the signature covers exactly what is sent. */
export async function deliver(base: string, path: string, body: string, headers: Record<string, string>) {
  return await request('POST', `${base}${path}`, { headers, body, timeoutMs: 30_000 })
}
