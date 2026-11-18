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
import { root, sql } from "../db.ts";
import {
  chargeFor, EGRESS_MICRO_USD_PER_GB, includedCostMicroUsd, INVOCATION_MICRO_USD, METERED_KINDS, OPENAI_PRICES_MICRO_USD_PER_M,
  STORAGE_MICRO_USD_PER_GB_MONTH, TOKEN_MICRO_USD,
} from "./cost.ts";
import { checkoutLink, payment, type Plan, type Verdict } from "./entitlement.ts";

export type Metered = "recalls_month" | "remembers_month" | "openai_tokens_month" | "blob_bytes_total";
export const FREE_POOL_OWNER = "00000000-0000-0000-0000-00000000f4ee";
const MONTHLY = new Set<string>([
  "recalls_month", "remembers_month", "openai_tokens_month", "overage_micro_usd_month", "free_pool_micro_usd_month",
  "ai", "storage_gb_hours", "egress_bytes", "requests", "db_bytes",
]);
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

async function isPastIncludedAi(v: Verdict): Promise<boolean> {
  const capTokens = v.plan.openai_tokens_month;
  const incAiCost = includedCostMicroUsd(v.plan, "ai");
  const rows = await sql`select kind, amount, cost_micro_usd from memory.usage
    where owner_id = ${v.owner} and period = date_trunc('month', now() at time zone 'utc')::date
      and kind in ('openai_tokens_month', 'ai')`;
  const byKind = new Map(rows.map((r) => [String(r.kind), r]));
  const tokensUsed = Number(byKind.get("openai_tokens_month")?.amount ?? 0);
  const aiCost = Number(byKind.get("ai")?.cost_micro_usd ?? 0);
  return (capTokens !== null && tokensUsed >= capTokens) || (Number.isFinite(incAiCost) && aiCost >= incAiCost);
}

/** Past-due accounts keep included usage but get HTTP 429 once their included AI allowance is spent. */
async function assertPastDueAi(v: Verdict) {
  if (v.state !== "past_due") return;
  if (await isPastIncludedAi(v)) {
    throw new Limited(Response.json({
      error: `Clyde: your payment is past due and your plan's included AI usage for this month is spent. Update your payment method to continue, or wait until ${nextReset()}.`,
      cap: "ai",
      state: "past_due",
    }, { status: 429 }));
  }
}

/** Throws Limited once the month's overage has reached the owner's spend limit or the plan's ceiling. */
async function assertCeiling(v: Verdict, pastIncluded = false) {
  const limitMicroUsd = v.spendLimitCents !== null ? v.spendLimitCents * 10_000 : v.plan.overage_ceiling_micro_usd_month;
  if (limitMicroUsd === null) return;
  const rows = await sql`select kind, amount, cost_micro_usd, reported_cost_micro_usd from memory.usage
    where owner_id = ${v.owner} and period = date_trunc('month', now() at time zone 'utc')::date`;
  const byKind = new Map(rows.map((r) => [String(r.kind), r]));
  let perKindOverageCost = 0;
  let perKindReportedBilled = 0;
  for (const kind of METERED_KINDS) {
    const r = byKind.get(kind);
    if (!r) continue;
    perKindOverageCost += Math.max(0, Number(r.cost_micro_usd ?? 0) - includedCostMicroUsd(v.plan, kind));
    perKindReportedBilled += chargeFor(Number(r.reported_cost_micro_usd ?? 0));
  }
  const legacyOverageCost = Number(byKind.get("overage_micro_usd_month")?.amount ?? 0);
  const legacyReportedBilled = chargeFor(Number(byKind.get("overage_reported_micro_usd_month")?.amount ?? 0));
  const billedMicroUsd = Math.max(
    chargeFor(perKindOverageCost),
    perKindReportedBilled,
    chargeFor(legacyOverageCost),
    legacyReportedBilled,
    legacyOverageCost,
  );
  const hit = limitMicroUsd === 0
    ? (billedMicroUsd > 0 || pastIncluded || await isPastIncludedAi(v))
    : billedMicroUsd >= limitMicroUsd;
  if (hit) {
    throw new Limited(Response.json({
      error: `Clyde: this month's overage reached your spend limit of $${(limitMicroUsd / 1e6).toFixed(2)}. It resets on ${nextReset()}.`,
      cap: "overage_ceiling_micro_usd_month",
      limit: limitMicroUsd,
    }, { status: 429 }));
  }
}

/** Put cost (micro-USD, rounded up) on the owner's overage for the month. */
async function overage(v: Verdict, costMicroUsd: number) {
  if (costMicroUsd > 0) await add(v.owner, "overage_micro_usd_month", Math.ceil(costMicroUsd));
}

/** Stops free accounts once the shared monthly free-tier budget is spent. Reads via `root` to bypass tenant RLS. */
async function assertPoolSpend(v: Verdict) {
  if (!free(v)) return;
  const cap = v.plan.pool_spend_cap_micro_usd_month;
  if (cap === null) return;
  const [r] = await root`select amount from memory.usage
    where owner_id = ${FREE_POOL_OWNER} and kind = 'free_pool_micro_usd_month'
      and period = date_trunc('month', now() at time zone 'utc')::date`;
  if (Number(r?.amount ?? 0) >= cap) {
    throw new Limited(await payment(v.owner, "Clyde's monthly free-tier budget is spent."));
  }
}

async function chargeFreePool(v: Verdict, costMicroUsd: number) {
  if (!free(v) || costMicroUsd <= 0) return;
  const micro = Math.ceil(costMicroUsd);
  await root`insert into memory.usage as u (owner_id, period, kind, amount)
    values (${FREE_POOL_OWNER}, date_trunc('month', now() at time zone 'utc')::date, 'free_pool_micro_usd_month', ${micro})
    on conflict (owner_id, period, kind) do update set amount = u.amount + excluded.amount`;
}

/** Count one call of this kind, or throw Limited when the plan's cap is reached. Without overage, the count and the check are
 * one statement, so two instances can't both take the last one. With it, a call past the included limit costs one
 * invocation of overage. */
export async function charge(v: Verdict | undefined, kind: "recalls_month" | "remembers_month") {
  if (!v) return;
  await assertPastDueAi(v);
  const cap = v.plan[kind];
  if (cap === null) return;
  if (billsOverage(v)) {
    await assertCeiling(v);
    if (await add(v.owner, kind, 1) > cap) {
      await assertCeiling(v, true);
      await overage(v, INVOCATION_MICRO_USD);
    }
    return;
  }
  await assertPoolSpend(v);
  if (cap <= 0) throw await over(v, kind, cap);
  const rows = await sql`insert into memory.usage as u (owner_id, period, kind, amount)
      values (${v.owner}, ${periodOf(kind)}, ${kind}, 1)
    on conflict (owner_id, period, kind) do update set amount = u.amount + 1 where u.amount < ${cap}
    returning amount`;
  if (!rows.length) throw await over(v, kind, cap);
  await chargeFreePool(v, INVOCATION_MICRO_USD);
}

/** Throws Limited when this owner may not spend OpenAI tokens: at the cap without overage, at the spend limit with it. */
export async function assertTokens(v: Verdict | undefined) {
  if (!v) return;
  await assertPastDueAi(v);
  if (billsOverage(v)) return assertCeiling(v);
  await assertPoolSpend(v);
  const cap = v.plan.openai_tokens_month;
  if (cap === null) return;
  if (await used(v.owner, "openai_tokens_month") >= cap) throw await over(v, "openai_tokens_month", cap);
}

/** Why the owner this request runs for may not spend OpenAI tokens now, or null. budget.ts asks before every call, so a
 * recall at the cap serves keyword ranks, degraded, and spends nothing. */
export async function ownerTokensSpent(): Promise<string | null> {
  const v = current.getStore()?.v;
  if (!v) return null;
  if (v.state !== "past_due" && v.plan.openai_tokens_month === null && (!free(v) || v.plan.pool_spend_cap_micro_usd_month === null)) return null;
  try {
    await assertTokens(v);
    return null;
  } catch (e) {
    if (e instanceof Limited) return "your plan's OpenAI tokens for this month are spent";
    throw e;
  }
}

/** Add AI tokens and cost to the current owner's counters, and overage past included limits when paying. */
export async function meterOwner(tokens: number, model?: string) {
  const v = current.getStore()?.v;
  if (!v || !tokens) return;
  const pricePerM = (model ? OPENAI_PRICES_MICRO_USD_PER_M[model] : undefined) ?? Math.max(...Object.values(OPENAI_PRICES_MICRO_USD_PER_M));
  const callCost = Math.ceil((tokens * pricePerM) / 1_000_000);
  await chargeFreePool(v, callCost);
  const [aiRow] = await sql`insert into memory.usage as u (owner_id, period, kind, amount, quantity, cost_micro_usd)
    values (${v.owner}, date_trunc('month', now() at time zone 'utc')::date, 'ai', ${callCost}, ${tokens}, ${callCost})
    on conflict (owner_id, period, kind) do update set
      amount = u.amount + excluded.amount,
      quantity = u.quantity + excluded.quantity,
      cost_micro_usd = u.cost_micro_usd + excluded.cost_micro_usd
    returning cost_micro_usd`;
  if (v.plan.openai_tokens_month === null) return;
  const totalTokens = await add(v.owner, "openai_tokens_month", tokens);
  if (billsOverage(v)) {
    const newAiCost = Number(aiRow?.cost_micro_usd ?? 0);
    const prevAiCost = Math.max(0, newAiCost - callCost);
    const incCost = includedCostMicroUsd(v.plan, "ai");
    const costDelta = Math.max(0, newAiCost - incCost) - Math.max(0, prevAiCost - incCost);
    const tokenDelta = Math.max(0, Math.min(tokens, totalTokens - v.plan.openai_tokens_month)) * (pricePerM / 1_000_000);
    await overage(v, Math.max(costDelta, tokenDelta));
  }
}

async function addEgressBytes(owner: string, bytes: number) {
  if (bytes <= 0) return;
  const microCost = Math.ceil((bytes / 1e9) * EGRESS_MICRO_USD_PER_GB);
  await root`insert into memory.usage as u (owner_id, period, kind, amount, quantity, cost_micro_usd)
    values (${owner}, date_trunc('month', now() at time zone 'utc')::date, 'egress_bytes', ${bytes}, ${bytes}, ${microCost})
    on conflict (owner_id, period, kind) do update set
      amount = u.amount + excluded.amount,
      quantity = u.quantity + excluded.quantity,
      cost_micro_usd = ceil((((u.quantity + excluded.quantity)::numeric) / 1000000000.0) * ${EGRESS_MICRO_USD_PER_GB})::bigint`;
}

/** Records one request and any HTTP response body egress for the owner outside the tenant transaction. */
export async function meterRequest(v: Verdict | undefined, egressBytes: number) {
  if (!v || !v.plan.open || v.plan.id === "owner") return;
  const reqCost = Math.ceil(INVOCATION_MICRO_USD);
  await root`insert into memory.usage as u (owner_id, period, kind, amount, quantity, cost_micro_usd)
    values (${v.owner}, date_trunc('month', now() at time zone 'utc')::date, 'requests', 1, 1, ${reqCost})
    on conflict (owner_id, period, kind) do update set
      amount = u.amount + excluded.amount,
      quantity = u.quantity + excluded.quantity,
      cost_micro_usd = u.cost_micro_usd + excluded.cost_micro_usd`;
  if (egressBytes > 0) await addEgressBytes(v.owner, Math.ceil(egressBytes));
}

/** Records blob bytes served through a signed Storage URL for the active request owner. */
export async function meterSignedEgress(bytes: number) {
  const v = current.getStore()?.v;
  if (!v || !v.plan.open || v.plan.id === "owner" || bytes <= 0) return;
  await addEgressBytes(v.owner, Math.ceil(bytes));
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

/** The quests flag, for the quest board MCP tools. */
export async function assertQuests(v: Verdict | undefined) {
  if (v && !v.plan.quests) throw new Limited(await payment(v.owner, `the quest board needs the Clyde plan; the ${v.plan.name} plan has none.`));
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
