// A plan's limits, enforced per owner (R38). The burst limit counts tools/call, POST /entries and POST /recall in one
// counter every instance shares. The monthly counters (recalls, remembers, OpenAI tokens) reset on the first of the month,
// UTC; blob_bytes_total is a running total. Reads (get_entry, get_blob, check_messages) never count.
//
// On a plan without overage a limit is a hard cap: past it a paid plan gets 429 naming the cap and when it resets, a free
// plan 402 with the checkout link. On a plan with overage (clyde) a limit is what the price includes: past it the call goes
// on and its cost lands on overage_micro_usd_month (invocations, OpenAI tokens, storage), which /billing/usage/report sends
// to the provider's usage meter, billed at a 50% gross margin (cost.ts). Only overage_ceiling_micro_usd_month stops it.
// Principals with no owner (Wen's runtime, admin, backup and cron credentials, and devices from before R38) have no limits.
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "../db.ts";
import { INVOCATION_MICRO_USD, STORAGE_MICRO_USD_PER_GB_MONTH, TOKEN_MICRO_USD } from "./cost.ts";
import { checkoutLink, payment, type Plan, type Verdict } from "./entitlement.ts";

export type Metered = "recalls_month" | "remembers_month" | "openai_tokens_month" | "blob_bytes_total";
const MONTHLY = new Set<string>(["recalls_month", "remembers_month", "openai_tokens_month", "overage_micro_usd_month"]);
const TOTAL_PERIOD = "1970-01-01";

/** A refusal to hand back as the HTTP answer: 429 for a cap, the overage ceiling or the burst limit, 402 for a free plan. */
export class Limited extends Error {
  constructor(public response: Response) {
    super("limited");
  }
}

// The owner a request runs for, so every OpenAI token it spends, embeds and judges alike, lands on that owner's counter.
const current = new AsyncLocalStorage<{ v: Verdict } | null>();

export function within<T>(v: Verdict | undefined, work: () => Promise<T>): Promise<T> {
  return current.run(v ? { v } : null, work);
}

/** The first of next month (UTC), as YYYY-MM-DD. */
export function nextReset(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

const periodOf = (kind: string) => MONTHLY.has(kind) ? sql`date_trunc('month', now() at time zone 'utc')::date` : sql`${TOTAL_PERIOD}::date`;

async function used(owner: string, kind: string): Promise<number> {
  const [r] = await sql`select amount from memory.usage where owner_id = ${owner} and kind = ${kind} and period = ${periodOf(kind)}`;
  return Number(r?.amount ?? 0);
}

async function add(owner: string, kind: string, n: number) {
  const [r] = await sql`insert into memory.usage as u (owner_id, period, kind, amount) values (${owner}, ${periodOf(kind)}, ${kind}, ${n})
    on conflict (owner_id, period, kind) do update set amount = u.amount + excluded.amount returning amount`;
  return Number(r.amount);
}

const free = (v: Verdict) => !v.plan.price_micro_usd_month && !v.allowlisted;
/** Whether this owner pays for use past the plan's included limits. Only a subscriber does: an allowlisted owner has no
 * provider customer to bill, so for them every limit is a hard cap. */
const billsOverage = (v: Verdict) => v.plan.overage && !v.allowlisted && v.state === "paid";

async function over(v: Verdict, kind: Metered, cap: number) {
  if (free(v)) return new Limited(await payment(v.owner, `the ${v.plan.name} plan's ${kind} limit (${cap}) is used up.`));
  const reset = MONTHLY.has(kind) ? ` It resets on ${nextReset()}.` : " Delete artifacts you no longer need to free space.";
  return new Limited(Response.json({ error: `Clyde: you've reached your plan's ${kind} cap of ${cap}.${reset}`, cap: kind, limit: cap },
    { status: 429 }));
}

/** Throws Limited once the month's overage has reached the plan's ceiling. */
async function assertCeiling(v: Verdict) {
  const ceiling = v.plan.overage_ceiling_micro_usd_month;
  if (ceiling === null) return;
  const spent = await used(v.owner, "overage_micro_usd_month");
  if (spent >= ceiling) {
    throw new Limited(Response.json({
      error: `Clyde: this month's usage past your plan reached its ceiling of $${(ceiling / 1e6).toFixed(2)}. It resets on ${nextReset()}.`,
      cap: "overage_ceiling_micro_usd_month", limit: ceiling,
    }, { status: 429 }));
  }
}

/** Put cost (micro-USD, rounded up) on the owner's overage for the month. */
async function overage(v: Verdict, costMicroUsd: number) {
  if (costMicroUsd > 0) await add(v.owner, "overage_micro_usd_month", Math.ceil(costMicroUsd));
}

/** Count one call of this kind, or throw Limited when the plan's cap is reached. Without overage, the count and the check are
 * one statement, so two instances can't both take the last one. With it, a call past the included limit costs one
 * invocation of overage. */
export async function charge(v: Verdict | undefined, kind: "recalls_month" | "remembers_month") {
  if (!v) return;
  const cap = v.plan[kind];
  if (cap === null) return;
  if (billsOverage(v)) {
    await assertCeiling(v);
    if (await add(v.owner, kind, 1) > cap) await overage(v, INVOCATION_MICRO_USD);
    return;
  }
  if (cap <= 0) throw await over(v, kind, cap);
  const rows = await sql`insert into memory.usage as u (owner_id, period, kind, amount)
      values (${v.owner}, ${periodOf(kind)}, ${kind}, 1)
    on conflict (owner_id, period, kind) do update set amount = u.amount + 1 where u.amount < ${cap}
    returning amount`;
  if (!rows.length) throw await over(v, kind, cap);
}

/** Throws Limited when this owner may not spend OpenAI tokens: at the cap without overage, at the ceiling with it. */
export async function assertTokens(v: Verdict | undefined) {
  if (!v || v.plan.openai_tokens_month === null) return;
  if (billsOverage(v)) return assertCeiling(v);
  const cap = v.plan.openai_tokens_month;
  if (await used(v.owner, "openai_tokens_month") >= cap) throw await over(v, "openai_tokens_month", cap);
}

/** Why the owner this request runs for may not spend OpenAI tokens now, or null. budget.ts asks before every call, so a
 * recall at the cap serves keyword ranks, degraded, and spends nothing. */
export async function ownerTokensSpent(): Promise<string | null> {
  const v = current.getStore()?.v;
  if (!v || v.plan.openai_tokens_month === null) return null;
  try {
    await assertTokens(v);
    return null;
  } catch (e) {
    if (e instanceof Limited) return "your plan's OpenAI tokens for this month are spent";
    throw e;
  }
}

/** Add tokens to the current owner's counter, and the cost of any past the included limit to their overage. */
export async function meterOwner(tokens: number) {
  const v = current.getStore()?.v;
  if (!v || !tokens || v.plan.openai_tokens_month === null) return;
  const total = await add(v.owner, "openai_tokens_month", tokens);
  if (billsOverage(v)) await overage(v, Math.min(tokens, total - v.plan.openai_tokens_month) * TOKEN_MICRO_USD);
}

/** The bytes of the artifacts a remember carries inline: text as UTF-8, base64 decoded. A sha256 reference is counted after. */
export function inlineBytes(payload: Record<string, unknown>) {
  const list = [payload.artifacts, payload.blobs].flatMap((x) => Array.isArray(x) ? x : x ? [x] : []) as Record<string, unknown>[];
  let n = 0;
  for (const b of list) {
    if (typeof b?.text === "string") n += new TextEncoder().encode(b.text).length;
    else if (typeof b?.base64 === "string") n += Math.floor(b.base64.replace(/=+$/, "").length * 3 / 4);
  }
  return n;
}

const carries = (payload: Record<string, unknown>) =>
  [payload.artifacts, payload.blobs].some((x) => Array.isArray(x) ? x.length > 0 : Boolean(x));

/** Before a remember: the plan allows artifacts, its blob storage has room (or overage pays for it), and its tokens aren't
 * spent. */
export async function assertRemember(v: Verdict | undefined, payload: Record<string, unknown>) {
  if (!v) return;
  if (carries(payload)) {
    await assertArtifacts(v);
    const cap = v.plan.blob_bytes_total;
    if (cap !== null && !billsOverage(v) && await used(v.owner, "blob_bytes_total") + inlineBytes(payload) > cap) {
      throw await over(v, "blob_bytes_total", cap);
    }
  }
  await assertTokens(v);
}

/** Before a remember (R50): why the owner's plan holds no more memories, or null. The plan's entries_total caps every
 * entry the owner holds, counted inside its tenant. A refusal is the tool's answer, with the way to upgrade. */
export async function entriesFull(v: Verdict | undefined): Promise<string | null> {
  const cap = v?.plan.entries_total ?? null;
  if (!v || cap === null) return null;
  const [r] = await sql`select count(*)::int as n from memory.entry where owner_id = ${v.owner}`;
  if (r.n < cap) return null;
  return `Not remembered: Clyde's ${v.plan.name} plan holds ${cap} memories, and you have ${r.n}. ` +
    `Upgrade at ${await checkoutLink(v.owner)} for more, or delete some you no longer need.`;
}

/** After a remember: count the bytes of the blobs it stored, and a month of storage for any past the included limit. */
export async function countBlobs(v: Verdict | undefined, blobs: { size: number }[]) {
  if (!v || v.plan.blob_bytes_total === null || !blobs.length) return;
  const bytes = blobs.reduce((n, b) => n + Number(b.size ?? 0), 0);
  const total = await add(v.owner, "blob_bytes_total", bytes);
  if (billsOverage(v)) await overage(v, Math.min(bytes, total - v.plan.blob_bytes_total) / 1e9 * STORAGE_MICRO_USD_PER_GB_MONTH);
}

/** The artifacts flag, for remember with artifacts, get_blob, upload_blob and GET /blobs. */
export async function assertArtifacts(v: Verdict | undefined) {
  if (v && !v.plan.artifacts) throw new Limited(await payment(v.owner, `artifacts need the Clyde plan; the ${v.plan.name} plan has none.`));
}

/** The burst limit: at most burst_calls in burst_seconds per owner. The window slides, and the row lock makes it exact across
 * instances. Throws Limited with a retry-after of whole seconds until the oldest call leaves the window. */
export async function burst(v: Verdict | undefined) {
  if (!v || v.plan.burst_calls === null || v.plan.burst_seconds === null) return;
  const cap = v.plan.burst_calls, secs = v.plan.burst_seconds;
  const rows = await sql`insert into memory.burst as b (owner_id, hits) values (${v.owner}, array[clock_timestamp()])
    on conflict (owner_id) do update
      set hits = array(select h from unnest(b.hits) h where h > clock_timestamp() - make_interval(secs => ${secs}) order by h) || clock_timestamp()
      where (select count(*) from unnest(b.hits) h where h > clock_timestamp() - make_interval(secs => ${secs})) < ${cap}
    returning 1`;
  if (rows.length) return;
  const [r] = await sql`select greatest(1, least(${secs}, ceil(extract(epoch from
      (select min(h) from unnest(hits) h where h > clock_timestamp() - make_interval(secs => ${secs})) + make_interval(secs => ${secs}) - clock_timestamp()))))::int as wait
    from memory.burst where owner_id = ${v.owner}`;
  const wait = r?.wait ?? secs;
  throw new Limited(Response.json({ error: `Clyde: more than ${cap} calls in ${secs} seconds. Try again in ${wait} second${wait === 1 ? "" : "s"}.` },
    { status: 429, headers: { "retry-after": String(wait) } }));
}

/** How many computers this owner has claimed and not revoked, against connected_agents. */
export async function assertAgentSlot(v: Verdict | undefined, name: string) {
  if (!v || v.plan.connected_agents === null) return;
  const [r] = await sql`select count(*)::int as n from memory.device where owner_id = ${v.owner} and revoked_at is null and name <> ${name}`;
  if (r.n >= v.plan.connected_agents) {
    throw new Limited(Response.json({ error: `Clyde: your plan connects at most ${v.plan.connected_agents} computers. Revoke one first.`, cap: "connected_agents" }, { status: 429 }));
  }
}

// Re-exported for the plan type's users.
export type { Plan };
