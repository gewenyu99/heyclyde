// A provider's webhook, at POST /billing/<provider>. Signed, or 400. Applied once per event id, and an event older than the
// newest one applied for its owner never changes access. A subscription billed in a blocked country is cancelled and
// refunded through the provider's API, and a fully refunded one is cancelled. Those calls run before the event is recorded,
// each remembered once it succeeds, so a failure answers 500, the provider redelivers, and only what failed runs again.
// An event for an owner memory doesn't know (no account) is acknowledged and stores nothing.
import { type Sql, sql } from "../db.ts";
import { secret } from "../db.ts";
import { forget } from "./entitlement.ts";
import type { BillingEvent, Provider } from "./provider.ts";
import { isBlocked } from "./regions.ts";

export const MAX_WEBHOOK_BODY = 2_000_000;

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function readCapped(req: Request): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_WEBHOOK_BODY) return null;
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_WEBHOOK_BODY) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The owner an event is for: the id memory gave at checkout, or the owner already holding that subscription. Null when
 * memory has no account for it. */
async function ownerOf(p: Provider, e: BillingEvent): Promise<string | null> {
  const given = e.subscription?.owner ?? e.refund?.owner ?? null;
  const sub = e.subscription?.id ?? e.refund?.subscriptionId ?? null;
  const [row] = given
    ? await sql`select owner_id from memory.account where owner_id = ${given}`
    : sub
    ? await sql`select owner_id from memory.entitlement where provider = ${p.name} and subscription_id = ${sub}`
    : [];
  return row?.owner_id ?? null;
}

/** Run an action against the provider unless it already succeeded once. */
async function once(p: Provider, action: "cancel" | "refund", target: string, run: () => Promise<void>) {
  const [done] = await sql`select 1 from memory.billing_action where provider = ${p.name} and action = ${action} and target = ${target}`;
  if (done) return;
  await run();
  await sql`insert into memory.billing_action (provider, action, target) values (${p.name}, ${action}, ${target}) on conflict do nothing`;
}

async function planFor(tx: Sql, p: Provider, productId: string | null) {
  if (productId) {
    const [r] = await tx`select id from memory.plan where product_ids ->> ${p.name} = ${productId}`;
    if (r) return r.id as string;
  }
  const [d] = await tx`select value from memory.setting where name = 'checkout_plan'`;
  return (d?.value as string) || "clyde";
}

async function apply(tx: Sql, p: Provider, e: BillingEvent, owner: string, blocked: boolean, hasLapse: boolean) {
  const s = e.subscription;
  if (s) {
    const state = blocked ? "blocked" : s.status;
    const plan = await planFor(tx, p, s.productId);
    if (hasLapse) {
      await tx`insert into memory.entitlement as en (owner_id, provider, customer_id, subscription_id, plan, state, current_period_end,
          cancel_at_period_end, billing_country, billing_region, event_at, lapsed_at, lapse_emails_sent)
        values (${owner}, ${p.name}, ${s.customerId}, ${s.id}, ${plan}, ${state}, ${s.periodEnd}, ${s.cancelAtPeriodEnd},
          ${s.country}, ${s.region}, ${e.at}, ${state === "lapsed" ? e.at : null}, '{}'::int[])
        on conflict (owner_id) do update set
          provider = excluded.provider, customer_id = coalesce(excluded.customer_id, en.customer_id),
          subscription_id = excluded.subscription_id, plan = excluded.plan,
          -- A refunded or blocked subscription stays that way; only a new subscription starts over.
          state = case when en.subscription_id = excluded.subscription_id and en.state in ('refunded', 'blocked') then en.state
                       else excluded.state end,
          refunded = en.refunded and en.subscription_id = excluded.subscription_id,
          current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
          billing_country = coalesce(excluded.billing_country, en.billing_country),
          billing_region = coalesce(excluded.billing_region, en.billing_region),
          lapsed_at = case when excluded.state = 'lapsed' then coalesce(en.lapsed_at, excluded.event_at)
                           when excluded.state in ('paid', 'past_due', 'comp') then null
                           else en.lapsed_at end,
          lapse_emails_sent = case when excluded.state in ('paid', 'past_due', 'comp') then '{}'::int[]
                                   else en.lapse_emails_sent end,
          event_at = excluded.event_at, updated_at = now()
        where en.event_at <= excluded.event_at`;
    } else {
      await tx`insert into memory.entitlement as en (owner_id, provider, customer_id, subscription_id, plan, state, current_period_end,
          cancel_at_period_end, billing_country, billing_region, event_at)
        values (${owner}, ${p.name}, ${s.customerId}, ${s.id}, ${plan}, ${state}, ${s.periodEnd}, ${s.cancelAtPeriodEnd},
          ${s.country}, ${s.region}, ${e.at})
        on conflict (owner_id) do update set
          provider = excluded.provider, customer_id = coalesce(excluded.customer_id, en.customer_id),
          subscription_id = excluded.subscription_id, plan = excluded.plan,
          -- A refunded or blocked subscription stays that way; only a new subscription starts over.
          state = case when en.subscription_id = excluded.subscription_id and en.state in ('refunded', 'blocked') then en.state
                       else excluded.state end,
          refunded = en.refunded and en.subscription_id = excluded.subscription_id,
          current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
          billing_country = coalesce(excluded.billing_country, en.billing_country),
          billing_region = coalesce(excluded.billing_region, en.billing_region),
          event_at = excluded.event_at, updated_at = now()
        where en.event_at <= excluded.event_at`;
    }
    if (blocked) {
      // Nothing of theirs stays: the account is marked with the billing country, and its computers lose their tokens.
      // Tenancy (R25) adds the owner's entries, blobs, messages, retrievals and events to this delete.
      await tx`update memory.account set country = ${s.country}, region = ${s.region} where owner_id = ${owner}`;
      await tx`delete from memory.device where owner_id = ${owner}`;
    }
  }
  const r = e.refund;
  if (r && r.total > 0 && r.refunded >= r.total) {
    await tx`update memory.entitlement set state = 'refunded', refunded = true, updated_at = now(), event_at = greatest(event_at, ${e.at})
      where owner_id = ${owner} and provider = ${p.name} and (${r.subscriptionId}::text is null or subscription_id = ${r.subscriptionId})`;
  }
}

export async function receive(req: Request, p: Provider): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const body = await readCapped(req);
  if (!body) return json({ error: `The body is over ${MAX_WEBHOOK_BODY} bytes.` }, 413);
  const key = await secret(p.webhookSecret);
  if (!key) return json({ error: "Billing isn't set up: no webhook secret in Vault." }, 503);
  const verdict = await p.verify(req.headers, body, key, Math.floor(Date.now() / 1000));
  if (verdict !== "ok") return json({ error: verdict === "stale" ? "The webhook's timestamp is too far from now." : "Bad signature." }, 400);
  let e: BillingEvent | null;
  try {
    e = p.parse(body, req.headers);
  } catch {
    return json({ error: "The body isn't an event." }, 400);
  }
  if (!e) return json({ ignored: true });
  if (!e.id) return json({ error: "The event has no id." }, 400);
  if ((await sql`select 1 from memory.billing_event where provider = ${p.name} and event_id = ${e.id}`).length) {
    return json({ duplicate: true });
  }
  const owner = await ownerOf(p, e);
  if (!owner) return json({ unknown: true });

  const s = e.subscription;
  const blocked = Boolean(s && s.status !== "lapsed" && isBlocked(s.country, s.region));
  if (blocked && s) {
    await once(p, "cancel", s.id, () => p.cancel(s.id));
    for (const o of await p.refundable(s.id)) await once(p, "refund", o.orderId, () => p.refund(o.orderId, o.amount));
  }
  const r = e.refund;
  // A refund alone leaves the subscription billing, so a full one ends it too, once the API token is set.
  if (r && r.total > 0 && r.refunded >= r.total && r.subscriptionId && await p.configured()) {
    const sub = r.subscriptionId;
    await once(p, "cancel", sub, () => p.cancel(sub));
  }
  const [{ hasLapse }] = await sql`select exists (
    select 1 from information_schema.columns
    where table_schema = 'memory' and table_name = 'entitlement' and column_name = 'lapsed_at'
  ) as "hasLapse"`;
  await sql.begin(async (tx) => {
    const [fresh] = await tx`insert into memory.billing_event (provider, event_id, type, owner_id) values (${p.name}, ${e.id}, ${e.type}, ${owner})
      on conflict do nothing returning 1`;
    if (fresh) await apply(tx, p, e, owner, blocked, Boolean(hasLapse));
  });
  // This instance answers the owner's next call from the new state at once; the others within the cache's minute.
  forget(owner);
  return json({ ok: true });
}
