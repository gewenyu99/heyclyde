// What memory spends at OpenAI, metered by kind. embed, judge_recall, shadow and research share the general budget. The judge
// that screens writes (judge_write) has a reserve of its own that nothing else spends, so when the general budget is gone
// recall serves keyword ranks and degraded, and remember still screens.
import { setting, sql } from "./db.ts";

export type Kind = "embed" | "judge_write" | "judge_recall" | "shadow" | "research";
export const KINDS: Kind[] = ["embed", "judge_write", "judge_recall", "shadow", "research"];
export type Usage = Record<Kind, number>;
export type Caps = { general: number; reserve: number };

/** The month's spend passed a cap. Recall serves keyword ranks until the month turns. */
export class OverBudget extends Error {
  override name = "OverBudget";
}

/** $5 a month at text-embedding-3-large's $0.13 per million tokens, unless the setting says otherwise. */
const DEFAULT_GENERAL_TOKENS = 38_000_000;
const DEFAULT_RESERVE_TOKENS = 5_000_000;

/** Why this kind of call may not spend now, or null when it may. The write judge answers to its reserve alone and every
 * other kind to the general budget, which the write judge never draws on. */
export function verdict(kind: Kind, usage: Usage, caps: Caps): string | null {
  if (kind === "judge_write") {
    return usage.judge_write >= caps.reserve
      ? `its reserve for screening writes is spent (${usage.judge_write} of ${caps.reserve} tokens)` : null;
  }
  const general = KINDS.filter((k) => k !== "judge_write").reduce((sum, k) => sum + usage[k], 0);
  return general >= caps.general ? `${general} of ${caps.general} OpenAI tokens spent this month` : null;
}

async function caps(): Promise<Caps> {
  return {
    general: Number(await setting("embed_budget_tokens")) || DEFAULT_GENERAL_TOKENS,
    reserve: Number(await setting("judge_write_reserve_tokens")) || DEFAULT_RESERVE_TOKENS,
  };
}

export async function usage(): Promise<Usage> {
  const rows = await sql`select kind, tokens from memory.openai_usage where month = date_trunc('month', now())::date`;
  const out = Object.fromEntries(KINDS.map((k) => [k, 0])) as Usage;
  for (const r of rows) out[r.kind as Kind] = r.tokens as number;
  return out;
}

/** The month's spend against both budgets: `used` and `cap` for the general one, as the console reads them. */
export async function budget() {
  const [kinds, c] = await Promise.all([usage(), caps()]);
  const used = KINDS.filter((k) => k !== "judge_write").reduce((sum, k) => sum + kinds[k], 0);
  return { used, cap: c.general, reserve: { used: kinds.judge_write, cap: c.reserve }, kinds };
}

/** Throws OverBudget unless this kind of call may spend now. */
export async function assertBudget(kind: Kind) {
  const why = verdict(kind, await usage(), await caps());
  if (why) throw new OverBudget(why);
}

export async function meter(kind: Kind, tokens: number) {
  if (!tokens) return;
  await sql`insert into memory.openai_usage (month, kind, tokens) values (date_trunc('month', now())::date, ${kind}, ${tokens})
    on conflict (month, kind) do update set tokens = memory.openai_usage.tokens + excluded.tokens`;
}
