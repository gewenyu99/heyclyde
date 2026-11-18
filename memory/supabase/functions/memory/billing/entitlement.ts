// Who may use Clyde, and on which plan (R38, R50). The rule, checked on every agent and owner request whose principal has an
// owner: a comp entitlement gets its plan (an allowlisted, confirmed email holds one on its allowlist plan, Wen's owner, kept
// in step with the allowlist by triggers); else an active subscription gets its
// plan (clyde); else the free plan, for an account holding one of its seats (the first 1,000); else none. A plan that isn't open gets 402 with a checkout link, or 451 from a blocked country. The answer is cached
// per owner for config.entitlementTtlMs (60 s), so a revoke, a refund or an allowlist removal reaches every instance
// within a minute, and a burst of calls costs one lookup.
import { config } from "../config.ts";
import { root as sql, setting } from "../db.ts";
import { isBlocked, REFUSAL } from "./regions.ts";

export type Plan = {
  id: string; name: string; open: boolean; artifacts: boolean; quests: boolean; price_micro_usd_month: number;
  recalls_month: number | null; remembers_month: number | null; blob_bytes_total: number | null;
  openai_tokens_month: number | null; connected_agents: number | null; entries_total: number | null; burst_calls: number | null; burst_seconds: number | null;
  overage: boolean; overage_ceiling_micro_usd_month: number | null;
  free_per_paid_n: number | null; free_per_paid_m: number | null; pool_spend_cap_micro_usd_month: number | null;
  features: Record<string, unknown>;
};

export type Verdict = {
  owner: string;
  plan: Plan;
  allowlisted: boolean;
  /** The provider's state for this owner, or null with no subscription. */
  state: string | null;
  /** Monthly overage spend cap in cents for paid/past_due accounts, or null when unset. */
  spendLimitCents: number | null;
  /** False on pre-R59 schemas that lack per-owner metering columns and kinds. */
  metered: boolean;
  /** The owner's account was refused for its billing country (a VPN at sign-up, caught at the webhook). */
  blockedAccount: boolean;
  /** Where the answer came from, for the Server-Timing header: db on a lookup, cache on a hit. */
  source: "db" | "cache";
  ms: number;
};

/** A plan nobody may use: what an owner gets with no subscription and no free seat. */
const CLOSED: Plan = {
  id: "none", name: "No", open: false, overage: false, overage_ceiling_micro_usd_month: null, artifacts: false, quests: false, price_micro_usd_month: 0, recalls_month: 0, remembers_month: 0,
  blob_bytes_total: 0, openai_tokens_month: 0, connected_agents: 0, entries_total: 0, burst_calls: 20, burst_seconds: 10,
  free_per_paid_n: null, free_per_paid_m: null, pool_spend_cap_micro_usd_month: null, features: {},
};

const cache = new Map<string, { at: number; v: Omit<Verdict, "source" | "ms"> }>();

/** Forget cached answers in this instance: one owner's, or with none given, everyone's. Other instances catch up within
 * the TTL. */
export function forget(owner?: string) {
  if (owner) cache.delete(owner);
  else cache.clear();
}

/** The owner's verdict. Throws when the lookup fails; the caller fails closed with 503. */
export async function entitled(owner: string): Promise<Verdict> {
  const started = performance.now();
  const hit = cache.get(owner);
  if (hit && Date.now() - hit.at < config.entitlementTtlMs) return { ...hit.v, source: "cache", ms: performance.now() - started };
  const [row] = await sql`
    with o as (select ${owner}::uuid as id),
    who as (
      select a.country, a.region, a.free_slot, case when e.state = 'comp' then e.plan end as allow_plan, e.state, e.plan as paid_plan,
        (to_jsonb(e)->>'spend_limit_cents')::int as spend_limit_cents,
        e.state in ('paid', 'past_due') and (not e.cancel_at_period_end or e.current_period_end is null or e.current_period_end > now()) as paid
      from o
      left join memory.account a on a.owner_id = o.id
      left join memory.entitlement e on e.owner_id = o.id)
    select who.*, to_jsonb(p) as plan,
      exists (select 1 from information_schema.columns where table_schema = 'memory' and table_name = 'usage' and column_name = 'cost_micro_usd') as metered
    from who left join memory.plan p
      on p.id = coalesce(who.allow_plan, case when who.paid then who.paid_plan end, case when who.free_slot then 'free' end)`;
  const plan = row?.plan
    ? { ...row.plan, quests: row.plan.quests !== false, price_micro_usd_month: Number(row.plan.price_micro_usd_month), blob_bytes_total: num(row.plan.blob_bytes_total),
      openai_tokens_month: num(row.plan.openai_tokens_month), overage_ceiling_micro_usd_month: num(row.plan.overage_ceiling_micro_usd_month),
      free_per_paid_n: num(row.plan.free_per_paid_n), free_per_paid_m: num(row.plan.free_per_paid_m),
      pool_spend_cap_micro_usd_month: num(row.plan.pool_spend_cap_micro_usd_month) } as Plan
    : CLOSED;
  const v = {
    owner, plan, allowlisted: Boolean(row?.allow_plan), state: row?.state ?? null,
    spendLimitCents: row?.state === "paid" || row?.state === "past_due" ? num(row?.spend_limit_cents) : null,
    metered: Boolean(row?.metered),
    blockedAccount: row?.state === "blocked" || isBlocked(row?.country, row?.region),
  };
  if (cache.size > 10_000) cache.clear();
  cache.set(owner, { at: Date.now(), v });
  return { ...v, source: "db", ms: performance.now() - started };
}

const num = (v: unknown) => v === null || v === undefined ? null : Number(v);

/** The country and region Cloudflare saw, when the request came through the proxy. A direct request has none. */
export type Geo = { country: string | null; region: string | null } | null;

export function geoOf(req: Request, proxied: boolean): Geo {
  if (!proxied) return null;
  return { country: req.headers.get("cf-ipcountry"), region: req.headers.get("cf-region-code") };
}

/** Whether a proxied request comes from a blocked place. Unknown (XX) and Tor (T1) count as blocked. */
export const geoBlocked = (geo: Geo) => Boolean(geo && isBlocked(geo.country, geo.region, true));

export const refusal451 = () => Response.json({ error: `Clyde: ${REFUSAL}` }, { status: 451 });

/** The link a 402 hands out: the checkout_url setting with the owner's id. */
export async function checkoutLink(owner: string) {
  const base = await setting("checkout_url");
  return `${base}${base.includes("?") ? "&" : "?"}owner=${encodeURIComponent(owner)}`;
}

/** The answer to a principal whose plan isn't open: 451 from a blocked place, else 402 with the checkout link. */
export async function refusal(v: Verdict, geo: Geo): Promise<Response> {
  if (v.blockedAccount || geoBlocked(geo)) return refusal451();
  return payment(v.owner, "Clyde needs a subscription.");
}

/** 402 with the checkout link, for a closed plan or a free plan that ran out. */
export async function payment(owner: string, why: string) {
  const url = await checkoutLink(owner);
  return Response.json({ error: `Clyde: ${why} Subscribe at ${url}`, checkout_url: url }, { status: 402 });
}
