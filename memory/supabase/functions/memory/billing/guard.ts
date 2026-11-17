// The cost guard (R74). Hourly, from pg_cron (POST /billing/guard), it reads what Supabase Pro bills on and compares each with
// Pro's included quota (SUPABASE_PRO in cost.ts, the one table). When any metric is past WARN of what Pro includes and this
// month's paying revenue doesn't cover the overage projected to the month's end, it closes the free tier (setting free_open =
// off, which memory.claim_free_seat reads) and tells Wen on the message board, once. It never removes a user or a seat, and
// it never reopens free: that's Wen's call. Its last reading is setting cost_guard, which GET /api/v1/billing/guard shows.
import { root } from "../db.ts";
import { MICRO_USD, type ProMetric, SUPABASE_PRO } from "./cost.ts";

/** The share of an included quota past which the guard looks at revenue. */
const WARN = 0.8;

export type Reading = {
  at: string;
  decision: "open" | "closed";
  /** Why, in one line, for the console and Wen's note. */
  why: string;
  revenue_usd: number;
  overage_usd: number;
  free_pool_usd: number;
  free_pool_cap_usd: number | null;
  metrics: Record<ProMetric, { used: number; projected: number; included: number; share: number; overage_usd: number }>;
};

/** Pro's quotas, with any the setting cost_guard_quotas overrides ({"db_bytes": ...}), for a test or a different plan. */
async function quotas(): Promise<Record<ProMetric, number>> {
  const out = Object.fromEntries(Object.entries(SUPABASE_PRO).map(([k, q]) => [k, q.included])) as Record<ProMetric, number>;
  const [row] = await root`select value from memory.setting where name = 'cost_guard_quotas'`;
  if (row) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(row.value))) if (k in out && Number(v) > 0) out[k as ProMetric] = Number(v);
    } catch {
      // A setting that doesn't parse changes nothing.
    }
  }
  return out;
}

export async function run(): Promise<Reading> {
  const [{ r }] = await root`select memory.cost_reading() as r`;
  const included = await quotas();
  const fraction = Math.min(1, Math.max(Number(r.month_fraction) || 1, 1 / 31 / 24));
  const metrics = {} as Reading["metrics"];
  const hot: string[] = [];
  let overage = 0;
  for (const [k, q] of Object.entries(SUPABASE_PRO) as [ProMetric, (typeof SUPABASE_PRO)[ProMetric]][]) {
    const used = Number(r[k] ?? 0);
    // A monthly count grows through the month, so it's projected to the end; a size is what it is.
    const projected = q.monthly ? used / fraction : used;
    const share = projected / included[k];
    const cost = Math.max(0, projected - included[k]) * q.usd_per_unit;
    metrics[k] = { used, projected, included: included[k], share, overage_usd: cost };
    overage += cost;
    if (share > WARN) hot.push(`${k} at ${Math.round(share * 100)}%`);
  }
  // This month's paying revenue: every paid entitlement still in its period, at its plan's price.
  const [{ revenue }] = await root`select coalesce(sum(p.price_micro_usd_month), 0)::bigint as revenue
    from memory.entitlement e join memory.plan p on p.id = e.plan
    where e.state = 'paid' and (e.current_period_end is null or e.current_period_end > now())`;
  const [freePlan] = await root`select pool_spend_cap_micro_usd_month as cap from memory.plan where id = 'free'`;
  const revenue_usd = Number(revenue) / MICRO_USD;
  const free_pool_micro_usd = Number(r.free_pool_micro_usd ?? 0);
  const pool_cap = freePlan?.cap === null || freePlan?.cap === undefined ? null : Number(freePlan.cap);
  const free_pool_usd = free_pool_micro_usd / MICRO_USD;
  const free_pool_cap_usd = pool_cap === null ? null : pool_cap / MICRO_USD;
  const poolHit = pool_cap !== null && free_pool_micro_usd >= pool_cap;
  const infraHit = hot.length > 0 && overage > revenue_usd;
  const close = infraHit || poolHit;
  const why = poolHit
    ? `free pool spent $${free_pool_usd.toFixed(2)} of $${free_pool_cap_usd!.toFixed(2)} cap`
    : infraHit
    ? `${hot.join(", ")} of Supabase Pro, projected overage $${overage.toFixed(2)} against $${revenue_usd.toFixed(2)} of paid revenue`
    : hot.length
    ? `${hot.join(", ")} of Supabase Pro, covered by $${revenue_usd.toFixed(2)} of paid revenue`
    : "every metric under 80% of Supabase Pro";
  const reading: Reading = {
    at: new Date().toISOString(), decision: close ? "closed" : "open", revenue_usd, overage_usd: overage,
    free_pool_usd, free_pool_cap_usd, metrics, why,
  };
  await root`insert into memory.setting (name, value) values ('cost_guard', ${JSON.stringify(reading)})
    on conflict (name) do update set value = excluded.value`;
  if (close) {
    // Only the change from open tells Wen, so an hourly run while closed stays quiet.
    const [was] = await root`select value from memory.setting where name = 'free_open'`;
    if (was?.value !== "off") {
      await root`insert into memory.setting (name, value) values ('free_open', 'off') on conflict (name) do update set value = 'off'`;
      await root`insert into memory.message (owner_id, sender, recipient, body)
        values (memory.wen(), 'memory', 'wen', ${`Clyde's cost guard closed the free tier: ${reading.why}. Nobody lost access; new sign-ups get no free seat until setting free_open is on again.`})`;
    }
  }
  return reading;
}

/** The last reading, or null before the first run. */
export async function last(): Promise<Reading | null> {
  const [row] = await root`select value from memory.setting where name = 'cost_guard'`;
  return row ? JSON.parse(row.value) : null;
}
