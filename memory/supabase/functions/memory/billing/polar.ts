// Polar (polar.sh), the merchant of record. Webhooks follow Standard Webhooks: headers webhook-id, webhook-timestamp and
// webhook-signature ("v1,<base64 HMAC-SHA256>" entries, space separated) over `${id}.${timestamp}.${body}`. The endpoint's
// secret is "whsec_<base64>": an endpoint made on or after 2026-09-08 keys the HMAC with the base64-decoded remainder,
// an older one with the UTF-8 bytes of the whole string. Both keys are tried, as Polar's own SDK does.
// Sources: polar.sh/docs/integrate/webhooks/delivery, standard-webhooks spec, polar.sh/docs/api-reference/2026-10.
import { secret } from "../db.ts";
import {
  type BillingEvent, bytes, fromBase64, hmacSha256, join, ownerId, type Provider, ProviderError, sameBytes,
  type SubscriptionStatus, TOLERANCE_SECONDS, type Verified, when,
} from "./provider.ts";

// POLAR_API_URL is https://sandbox-api.polar.sh for the sandbox, and a fake in tier 3.
const API = () => Deno.env.get("POLAR_API_URL") ?? "https://api.polar.sh";

async function api(method: string, path: string, body?: unknown) {
  const token = await secret("polar_api_token");
  if (!token) throw new ProviderError("no polar_api_token in Vault");
  const r = await fetch(`${API()}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  const out = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: out as Record<string, any> };
}

function keys(whsec: string): Uint8Array[] {
  const out: Uint8Array[] = [bytes(whsec)];
  const decoded = fromBase64(whsec.replace(/^whsec_/, ""));
  if (decoded?.length) out.unshift(decoded);
  return out;
}

async function verify(headers: Headers, body: Uint8Array, whsec: string, now: number): Promise<Verified> {
  const id = headers.get("webhook-id"), ts = headers.get("webhook-timestamp"), sig = headers.get("webhook-signature");
  if (!id || !ts || !sig || !/^\d{1,12}$/.test(ts)) return "bad";
  if (Math.abs(now - Number(ts)) > TOLERANCE_SECONDS) return "stale";
  const signed = join(bytes(`${id}.${ts}.`), body);
  const given = sig.split(" ").map((s) => s.split(",")).filter(([v, b]) => v === "v1" && b).map(([, b]) => fromBase64(b))
    .filter((b) => b !== null) as Uint8Array[];
  for (const key of keys(whsec)) {
    const want = await hmacSha256(key, signed);
    if (given.some((g) => sameBytes(g, want))) return "ok";
  }
  return "bad";
}

const PAID = new Set(["active", "trialing"]);

/** What a subscription's status means for access. past_due keeps included limits without overage while Polar retries
 * the card (dunning); Polar ends it with subscription.revoked. A cancel at period end stays active until period end. */
function status(type: string, s: Record<string, any>): SubscriptionStatus {
  if (type === "subscription.revoked") return "lapsed";
  if (type === "subscription.past_due" || s.status === "past_due") return "past_due";
  if (PAID.has(s.status)) return "paid";
  if (s.status === "canceled" && !s.ended_at && s.cancel_at_period_end && when(s.current_period_end ?? s.ends_at)) return "paid";
  if (s.status === "incomplete") return "pending";
  return "lapsed";
}

const SUBSCRIPTION = new Set(["subscription.created", "subscription.active", "subscription.updated", "subscription.canceled",
  "subscription.uncanceled", "subscription.past_due", "subscription.revoked"]);

function parse(raw: Uint8Array, headers: Headers): BillingEvent | null {
  const e = JSON.parse(new TextDecoder().decode(raw));
  const type = String(e?.type ?? ""), d = e?.data ?? {};
  const id = headers.get("webhook-id") ?? "";
  // The envelope's timestamp when it has one, else the entity's last change, else the delivery's.
  const at = when(e.timestamp) ?? when(d.modified_at) ?? new Date(Number(headers.get("webhook-timestamp")) * 1000);
  if (SUBSCRIPTION.has(type)) {
    const address = d.customer?.billing_address ?? d.billing_address ?? {};
    return {
      id, type, at,
      subscription: {
        id: String(d.id ?? ""),
        customerId: d.customer_id ?? d.customer?.id ?? null,
        owner: ownerId(d.customer?.external_id ?? d.external_customer_id ?? d.metadata?.owner_id),
        status: status(type, d),
        periodEnd: when(d.current_period_end ?? d.ends_at),
        cancelAtPeriodEnd: type === "subscription.uncanceled" ? false : Boolean(d.cancel_at_period_end),
        productId: d.product_id ?? d.product?.id ?? null,
        country: address.country ?? null,
        region: address.state ?? null,
      },
    };
  }
  if (type === "order.refunded" || type === "order.updated") {
    const total = Number(d.total_amount ?? d.amount ?? 0), refunded = Number(d.refunded_amount ?? 0);
    if (type === "order.updated" && !refunded) return null;
    return {
      id, type, at,
      refund: {
        orderId: String(d.id ?? ""), subscriptionId: d.subscription_id ?? null,
        owner: ownerId(d.customer?.external_id ?? d.external_customer_id ?? d.metadata?.owner_id),
        refunded, total,
      },
    };
  }
  return null;
}

export const polar: Provider = {
  name: "polar",
  webhookSecret: "polar_webhook_secret",
  secrets: ["polar_api_token", "polar_webhook_secret"],
  verify,
  parse,
  async cancel(subscriptionId) {
    const r = await api("DELETE", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
    // 404 ResourceNotFound or 403 AlreadyCanceledSubscription: it's gone or already over.
    if (!r.ok && r.status !== 404 && !(r.status === 403 && /cancel/i.test(JSON.stringify(r.body)))) {
      throw new ProviderError(`Polar refused to revoke ${subscriptionId} (${r.status})`);
    }
  },
  async refundable(subscriptionId) {
    const r = await api("GET", `/v1/orders/?subscription_id=${encodeURIComponent(subscriptionId)}&limit=100`);
    if (!r.ok) throw new ProviderError(`Polar didn't list the orders of ${subscriptionId} (${r.status})`);
    return (r.body.items ?? [])
      .filter((o: Record<string, any>) => o.paid !== false && ["paid", "partially_refunded"].includes(o.status ?? "paid"))
      .map((o: Record<string, any>) => ({ orderId: String(o.id), amount: Number(o.refundable_amount ?? (o.total_amount - (o.refunded_amount ?? 0))) }))
      .filter((o: { amount: number }) => o.amount > 0);
  },
  async refund(orderId, amount) {
    const r = await api("POST", "/v1/refunds/", { order_id: orderId, amount, reason: "other", comment: "memory isn't offered in the billing country" });
    // 403 RefundedAlready: done before.
    if (!r.ok && !(r.status === 403 && /refunded/i.test(JSON.stringify(r.body)))) {
      throw new ProviderError(`Polar refused to refund order ${orderId} (${r.status})`);
    }
  },
  async checkout(owner, productId, email, successUrl) {
    // No allowed-countries field exists on Polar's checkout; the webhook enforces the blocked list.
    const r = await api("POST", "/v1/checkouts/", {
      products: [productId], external_customer_id: owner, success_url: successUrl, metadata: { owner_id: owner },
      ...(email ? { customer_email: email } : {}),
    });
    if (!r.ok || typeof r.body.url !== "string") throw new ProviderError(`Polar didn't make a checkout (${r.status})`);
    return r.body.url;
  },
  async upgrade(subscriptionId, productId) {
    const r = await api("PATCH", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      product_id: productId,
      proration_behavior: "invoice",
    });
    if (!r.ok) throw new ProviderError(`Polar refused to upgrade ${subscriptionId} (${r.status})`);
  },
  async reportUsage(owner, charge, cost, period, kind = "ai", hour = new Date().toISOString().slice(0, 13)) {
    // One event per owner, period, kind and UTC hour, idempotent via external_id; metadata.amount is charge_micro_usd.
    const r = await api("POST", "/v1/events/ingest", {
      events: [{
        name: "clyde_overage",
        external_id: `${owner}:${period}:${kind}:${hour}`,
        external_customer_id: owner,
        metadata: { kind, amount: charge, hour, charge_micro_usd: charge, cost_micro_usd: cost, period },
      }],
    });
    if (!r.ok) throw new ProviderError(`Polar didn't take the usage event (${r.status})`);
  },
  configured: async () => Boolean(await secret("polar_api_token")),
};
