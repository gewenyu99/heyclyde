// Paddle Billing, the fallback merchant of record. Webhooks carry Paddle-Signature: ts=<unix>;h1=<hex HMAC-SHA256> over
// `${ts}:${body}`, keyed by the notification destination's secret (pdl_ntfset_...). Refunds arrive as adjustment.created or
// adjustment.updated with action refund, and count once approved. A subscription carries no billing address, only an
// address_id, so the blocked-country check at the webhook covers Polar only; Paddle's checkout is where to restrict it.
// Sources: developer.paddle.com/webhooks/about/signature-verification, /webhooks/adjustments, /webhooks/subscriptions.
import { secret } from "../db.ts";
import {
  type BillingEvent, bytes, hmacSha256, join, ownerId, type Provider, ProviderError, sameBytes, type SubscriptionStatus,
  TOLERANCE_SECONDS, type Verified, when,
} from "./provider.ts";

const API = () => Deno.env.get("PADDLE_API_URL") ?? "https://api.paddle.com";

async function api(method: string, path: string, body?: unknown) {
  const key = await secret("paddle_api_key");
  if (!key) throw new ProviderError("no paddle_api_key in Vault");
  const r = await fetch(`${API()}${path}`, {
    method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8_000),
  });
  const out = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: out as Record<string, any> };
}

const hexBytes = (h: string) => /^[0-9a-f]+$/i.test(h) && h.length % 2 === 0
  ? Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16))) : null;

async function verify(headers: Headers, body: Uint8Array, key: string, now: number): Promise<Verified> {
  const header = headers.get("paddle-signature") ?? "";
  const parts = header.split(";").map((p) => p.split("=")).filter((p) => p.length === 2);
  const ts = parts.find(([k]) => k === "ts")?.[1];
  const given = parts.filter(([k]) => k === "h1").map(([, v]) => hexBytes(v)).filter((b) => b !== null) as Uint8Array[];
  if (!ts || !/^\d{1,12}$/.test(ts) || !given.length) return "bad";
  if (Math.abs(now - Number(ts)) > TOLERANCE_SECONDS) return "stale";
  const want = await hmacSha256(bytes(key), join(bytes(`${ts}:`), body));
  return given.some((g) => sameBytes(g, want)) ? "ok" : "bad";
}

function status(type: string, s: Record<string, any>): SubscriptionStatus {
  if (type === "subscription.canceled" || s.status === "canceled" || s.status === "paused") return "lapsed";
  if (type === "subscription.past_due" || s.status === "past_due") return "past_due";
  if (["active", "trialing"].includes(s.status)) return "paid";
  return "pending";
}

const SUBSCRIPTION = new Set(["subscription.created", "subscription.activated", "subscription.updated", "subscription.past_due",
  "subscription.canceled", "subscription.resumed", "subscription.paused", "subscription.trialing"]);

function parse(raw: Uint8Array): BillingEvent | null {
  const e = JSON.parse(new TextDecoder().decode(raw));
  const type = String(e?.event_type ?? ""), d = e?.data ?? {};
  const id = String(e?.event_id ?? ""), at = when(e?.occurred_at) ?? new Date();
  if (SUBSCRIPTION.has(type)) {
    const cancelling = d.scheduled_change?.action === "cancel";
    return {
      id, type, at,
      subscription: {
        id: String(d.id ?? ""), customerId: d.customer_id ?? null, owner: ownerId(d.custom_data?.owner_id),
        status: status(type, d),
        periodEnd: when(cancelling ? d.scheduled_change?.effective_at : d.current_billing_period?.ends_at),
        cancelAtPeriodEnd: cancelling, productId: d.items?.[0]?.price?.product_id ?? null,
        country: null, region: null,
      },
    };
  }
  if ((type === "adjustment.created" || type === "adjustment.updated") && d.action === "refund") {
    if (d.status !== "approved") return null;
    const total = Number(d.totals?.total ?? 0);
    return {
      id, type, at,
      refund: {
        orderId: String(d.transaction_id ?? ""), subscriptionId: d.subscription_id ?? null, owner: ownerId(d.custom_data?.owner_id),
        refunded: d.type === "full" ? Number.MAX_SAFE_INTEGER : total, total: d.type === "full" ? 1 : Number.MAX_SAFE_INTEGER,
      },
    };
  }
  return null;
}

export const paddle: Provider = {
  name: "paddle",
  webhookSecret: "paddle_webhook_secret",
  secrets: ["paddle_api_key", "paddle_webhook_secret"],
  verify,
  parse: (raw) => parse(raw),
  async cancel(subscriptionId) {
    const r = await api("POST", `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, { effective_from: "immediately" });
    if (!r.ok && r.status !== 404 && r.body?.error?.code !== "subscription_locked_canceled") throw new ProviderError(`Paddle refused to cancel ${subscriptionId} (${r.status})`);
  },
  async refundable(subscriptionId) {
    const r = await api("GET", `/transactions?subscription_id=${encodeURIComponent(subscriptionId)}&status=completed`);
    if (!r.ok) throw new ProviderError(`Paddle didn't list the transactions of ${subscriptionId} (${r.status})`);
    return (r.body.data ?? []).map((t: Record<string, any>) => ({ orderId: String(t.id), amount: Number(t.details?.totals?.grand_total ?? 0) }))
      .filter((t: { amount: number }) => t.amount > 0);
  },
  async refund(orderId) {
    const r = await api("POST", "/adjustments", { action: "refund", type: "full", transaction_id: orderId, reason: "memory isn't offered in the billing country" });
    if (!r.ok) throw new ProviderError(`Paddle refused to refund ${orderId} (${r.status})`);
  },
  async checkout(owner, productId, email) {
    // For Paddle, a plan's product id is the price id (pri_...). custom_data carries the owner back on every webhook.
    const r = await api("POST", "/transactions", {
      items: [{ price_id: productId, quantity: 1 }], custom_data: { owner_id: owner }, ...(email ? { customer: { email } } : {}),
    });
    const url = r.body?.data?.checkout?.url;
    if (!r.ok || typeof url !== "string") throw new ProviderError(`Paddle didn't make a checkout (${r.status})`);
    return url;
  },
  async upgrade(subscriptionId, productId) {
    const r = await api("PATCH", `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      items: [{ price_id: productId, quantity: 1 }],
      proration_billing_mode: "prorated_immediately",
    });
    if (!r.ok) throw new ProviderError(`Paddle refused to upgrade ${subscriptionId} (${r.status})`);
  },
  reportUsage() {
    // Paddle bills usage through one-off charges on the subscription, not a meter. Not built: Paddle is the fallback.
    return Promise.reject(new ProviderError("usage-based billing isn't set up for Paddle"));
  },
  configured: async () => Boolean(await secret("paddle_api_key")),
};
