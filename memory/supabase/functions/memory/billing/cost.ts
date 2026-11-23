// The worst-case monthly cost of one subscriber who uses every included limit of a plan, and the margin that leaves (R38,
// and the Clyde pricing decisions of 2026-11-15: a 70-80% gross margin on the plan, and overage billed at a fixed 50% gross
// margin over cost, net of the provider's percentage). The limits test runs it over every
// row of memory.plan, so a tier the design adds is held to it the moment it lands. Prices are as checked on 2026-11-15
// (side-session notes, clyde-design-pricing-facts.md).
// No imports and no Deno globals, so the tier 3 tests (node) import this file as it is.

// What OpenAI and Gemini charge per million tokens, in micro-USD, for the models memory calls (checked 2026-11-15). A plan's
// whole token cap is priced at the highest of these.
export const OPENAI_PRICES_MICRO_USD_PER_M: Record<string, number> = {
  "gemini-embedding-001": 150_000,
  "text-embedding-3-large": 130_000,
  "text-embedding-3-small": 20_000,
  "gpt-6-luna": 100_000,
  "gemini-decision-1": 100_000,
};

export type Assumptions = {
  /** Subscribers sharing a month's payout fee. 1 is the worst case. */
  payoutSubscribers: number;
  /** Users sharing Supabase Pro's $25. */
  supabaseUsers: number;
  /** Share of sales on non-US cards, which cost 1.5% more. 1 is the worst case. */
  nonUsShare: number;
  /** Disputes per sale per month, at $15 each. */
  disputeRate: number;
};

/** R38's cost ceiling: the payout fee on one subscriber, Supabase shared by the 20 planned users. */
export const CEILING: Assumptions = { payoutSubscribers: 1, supabaseUsers: 20, nonUsShare: 1, disputeRate: 0.01 };
/** The margin check: the 20 planned users share both. */
export const PLANNED: Assumptions = { payoutSubscribers: 20, supabaseUsers: 20, nonUsShare: 1, disputeRate: 0.01 };

const SUPABASE_PRO_USD = 25;

/** What Supabase Pro includes each month and what it charges past that, per unit (published rates, checked 2026-11-15).
 * The one table of them: the margin math below, overage billing (limits.ts), the cost guard (guard.ts, R74) and R66's margin
 * check all read it. Sizes are bytes; a GB is 1e9 bytes. */
export const SUPABASE_PRO = {
  db_bytes: { included: 8e9, usd_per_unit: 0.125 / 1e9, monthly: false },
  storage_bytes: { included: 100e9, usd_per_unit: 0.0213 / 1e9, monthly: false },
  egress_bytes: { included: 250e9, usd_per_unit: 0.09 / 1e9, monthly: true },
  invocations: { included: 2e6, usd_per_unit: 2 / 1e6, monthly: true },
  mau: { included: 100_000, usd_per_unit: 0.00325, monthly: true },
} as const;
export type ProMetric = keyof typeof SUPABASE_PRO;
/** Micro-USD in a dollar. */
export const MICRO_USD = 1e6;
const DISPUTE_USD = 15;
// Polar: 5% + $0.50 a sale, 1.5% more on non-US cards. A month with a payout costs $2 + 0.25% + $0.25.
const FEE_RATE = 0.05, FEE_FIXED = 0.5, NON_US_RATE = 0.015, PAYOUT_FIXED = 2.25, PAYOUT_RATE = 0.0025;
// Storage beyond Supabase Pro's 100 GB, per GB-month. Below it, blobs cost nothing extra.
const STORAGE_USD_PER_GB = SUPABASE_PRO.storage_bytes.usd_per_unit * 1e9;

export type Plan = { price_micro_usd_month: number; openai_tokens_month: number | null; blob_bytes_total: number | null };

/** Every line of the cost, in USD a month. */
export function costOf(plan: Plan, a: Assumptions) {
  const price = plan.price_micro_usd_month / 1e6;
  const highest = Math.max(...Object.values(OPENAI_PRICES_MICRO_USD_PER_M)) / 1e6;
  const lines = {
    provider_fee: price ? price * (FEE_RATE + NON_US_RATE * a.nonUsShare) + FEE_FIXED : 0,
    payout: price ? PAYOUT_FIXED / a.payoutSubscribers + price * PAYOUT_RATE : 0,
    disputes: price ? DISPUTE_USD * a.disputeRate : 0,
    openai: plan.openai_tokens_month === null ? Infinity : (plan.openai_tokens_month / 1e6) * highest,
    storage: plan.blob_bytes_total === null ? Infinity : (plan.blob_bytes_total / 1e9) * STORAGE_USD_PER_GB,
    supabase: SUPABASE_PRO_USD / a.supabaseUsers,
  };
  const total = Object.values(lines).reduce((s, n) => s + n, 0);
  return { price, lines, total, margin: price ? (price - total) / price : -Infinity };
}

// Unit costs for overage, in micro-USD (checked 2026-11-15): Supabase Edge invocations at $2 a million past Pro's 2M, and
// Storage at $0.0213 a GB-month past Pro's 100 GB.
export const INVOCATION_MICRO_USD = SUPABASE_PRO.invocations.usd_per_unit * 1e6;
export const STORAGE_MICRO_USD_PER_GB_MONTH = SUPABASE_PRO.storage_bytes.usd_per_unit * 1e9 * 1e6;
/** The highest OpenAI price per token, in micro-USD: what an overage token costs. */
export const TOKEN_MICRO_USD = Math.max(...Object.values(OPENAI_PRICES_MICRO_USD_PER_M)) / 1e6;

/** Overage's gross margin, multiplier (2.3 x cost), and the provider's cut of what it bills (Polar: 5% + 1.5% on non-US cards). */
export const OVERAGE_MARGIN = 0.5;
export const OVERAGE_MULTIPLIER = 2.3;
export const PROVIDER_RATE = FEE_RATE + NON_US_RATE;

export const METERED_KINDS = ["ai", "storage_gb_hours", "egress_bytes", "requests", "db_bytes"] as const;
export type MeteredKind = typeof METERED_KINDS[number];
export const EGRESS_MICRO_USD_PER_GB = SUPABASE_PRO.egress_bytes.usd_per_unit * 1e9 * MICRO_USD;
export const DB_MICRO_USD_PER_GB_MONTH = SUPABASE_PRO.db_bytes.usd_per_unit * 1e9 * MICRO_USD;

/** Included monthly cost in micro-USD for a plan and metered kind before overage begins. */
export function includedCostMicroUsd(plan: Plan, kind: MeteredKind): number {
  switch (kind) {
    case "ai": {
      if (plan.openai_tokens_month === null) return Infinity;
      const highestMicroPerM = Math.max(...Object.values(OPENAI_PRICES_MICRO_USD_PER_M));
      return Math.round((plan.openai_tokens_month / 1e6) * highestMicroPerM);
    }
    case "storage_gb_hours":
      return plan.blob_bytes_total === null ? Infinity : Math.round((plan.blob_bytes_total / 1e9) * STORAGE_MICRO_USD_PER_GB_MONTH);
    case "egress_bytes":
      return plan.price_micro_usd_month > 0
        ? Math.round((SUPABASE_PRO.egress_bytes.included / PLANNED.supabaseUsers) * SUPABASE_PRO.egress_bytes.usd_per_unit * MICRO_USD)
        : 0;
    case "requests":
      return plan.price_micro_usd_month > 0
        ? Math.round((SUPABASE_PRO.invocations.included / PLANNED.supabaseUsers) * INVOCATION_MICRO_USD)
        : 0;
    case "db_bytes":
      return plan.price_micro_usd_month > 0
        ? Math.round((SUPABASE_PRO.db_bytes.included / PLANNED.supabaseUsers) * SUPABASE_PRO.db_bytes.usd_per_unit * MICRO_USD)
        : 0;
  }
}

/** What to bill for `cost` micro-USD of overage (2.3 x cost), keeping >= 50% gross margin net of the provider's 6.5% fee. */
export function chargeFor(costMicroUsd: number) {
  return Math.ceil(costMicroUsd * OVERAGE_MULTIPLIER);
}
