// One interface every merchant of record implements (R38: Polar first, Paddle the fallback). An adapter turns its webhook
// into a BillingEvent and carries out cancels, refunds and checkouts against its API. webhooks.ts and entitlement.ts never
// learn which provider they talk to.

/** What a subscription event says about access. pending: started, not paid yet. paid: access. lapsed: no access. */
export type SubscriptionStatus = "pending" | "paid" | "lapsed";

export type SubscriptionChange = {
  id: string;
  customerId: string | null;
  /** The Supabase Auth user id memory gave the provider at checkout, if the payload carries it. */
  owner: string | null;
  status: SubscriptionStatus;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  productId: string | null;
  country: string | null;
  region: string | null;
};

export type Refund = {
  orderId: string;
  subscriptionId: string | null;
  owner: string | null;
  /** In the order's minor units (cents). */
  refunded: number;
  total: number;
};

export type BillingEvent = {
  id: string;
  type: string;
  /** When the provider says it happened. An event older than the newest one applied for an owner never changes access. */
  at: Date;
  subscription?: SubscriptionChange;
  refund?: Refund;
};

export type Verified = "ok" | "bad" | "stale";

export interface Provider {
  name: string;
  /** The Vault secret that signs its webhooks. */
  webhookSecret: string;
  /** The Vault secrets the console may set for it (PUT /api/v1/secrets/<name>). */
  secrets: string[];
  verify(headers: Headers, body: Uint8Array, secret: string, nowSeconds: number): Promise<Verified>;
  /** The event, or null for a type memory doesn't act on. Throws on a body it can't read. */
  parse(body: Uint8Array, headers: Headers): BillingEvent | null;
  /** End a subscription now. Resolves once the provider has, throws otherwise. */
  cancel(subscriptionId: string): Promise<void>;
  /** The paid orders of a subscription that can still be refunded, with how much. */
  refundable(subscriptionId: string): Promise<{ orderId: string; amount: number }[]>;
  refund(orderId: string, amount: number): Promise<void>;
  /** A checkout URL for this owner and product. */
  checkout(owner: string, productId: string, email: string | null, successUrl: string): Promise<string>;
  /** Report an owner's overage to the provider's usage meter: what to bill (charge) and what it cost memory, both in
   * micro-USD. Resolves once the provider has it. */
  reportUsage(owner: string, chargeMicroUsd: number, costMicroUsd: number, period: string): Promise<void>;
  /** Whether its API token is in Vault, so checkout, cancel and refund can run. */
  configured(): Promise<boolean>;
}

/** A provider's API answered with something other than success. The webhook answers 500, so the provider redelivers. */
export class ProviderError extends Error {
  override name = "ProviderError";
}

const enc = new TextEncoder();

async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey("raw", new Uint8Array(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new Uint8Array(data)));
}

export function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const hmacSha256 = hmac;
export const bytes = (s: string) => enc.encode(s);
export const join = concat;

export function fromBase64(s: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export const toBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
export const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** How far a webhook's timestamp may sit from the server's clock, either way. */
export const TOLERANCE_SECONDS = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An owner id, or null when it isn't one. */
export const ownerId = (v: unknown) => typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null;

/** A provider timestamp as a Date, or null. */
export function when(v: unknown): Date | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
