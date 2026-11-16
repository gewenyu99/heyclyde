// What memory spends at OpenAI, metered by kind. embed, judge_recall, shadow and research share the general budget. The judge
// that screens writes (judge_write) has a reserve of its own that nothing else spends, so when the general budget is gone
// recall serves keyword ranks and degraded, and remember still screens.
import { AsyncLocalStorage } from "node:async_hooks";
import { meterOwner, ownerTokensSpent } from "./billing/limits.ts";
import { setting, sql } from "./db.ts";

export type Kind = "embed" | "judge_write" | "judge_recall" | "shadow" | "research";
export const KINDS: Kind[] = ["embed", "judge_write", "judge_recall", "shadow", "research"];
export type Usage = Record<Kind, number>;
/** research, when set, caps shadow and research together, inside the general budget (setting research_budget_tokens). */
export type Caps = { general: number; reserve: number; research?: number };

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
  if (general >= caps.general) return `${general} of ${caps.general} OpenAI tokens spent this month`;
  const research = usage.shadow + usage.research;
  if ((kind === "shadow" || kind === "research") && caps.research && research >= caps.research) {
    return `its research budget is spent (${research} of ${caps.research} tokens on shadows and research)`;
  }
  return null;
}

async function caps(kind: Kind): Promise<Caps> {
  const out: Caps = {
    general: Number(await setting("embed_budget_tokens")) || DEFAULT_GENERAL_TOKENS,
    reserve: Number(await setting("judge_write_reserve_tokens")) || DEFAULT_RESERVE_TOKENS,
  };
  // Read fresh, not from the minute's settings cache, so lowering it stops the next shadow.
  if (kind === "shadow" || kind === "research") {
    out.research = Number((await sql`select value from memory.setting where name = 'research_budget_tokens'`)[0]?.value) || undefined;
  }
  return out;
}

export async function usage(): Promise<Usage> {
  const rows = await sql`select kind, tokens from memory.openai_usage where month = date_trunc('month', now())::date`;
  const out = Object.fromEntries(KINDS.map((k) => [k, 0])) as Usage;
  for (const r of rows) out[r.kind as Kind] = r.tokens as number;
  return out;
}

/** The month's spend against both budgets: `used` and `cap` for the general one, as the console reads them. */
export async function budget() {
  const [kinds, c] = await Promise.all([usage(), caps("embed")]);
  const used = KINDS.filter((k) => k !== "judge_write").reduce((sum, k) => sum + kinds[k], 0);
  return { used, cap: c.general, reserve: { used: kinds.judge_write, cap: c.reserve }, kinds };
}

/** Throws OverBudget unless this kind of call may spend now. */
export async function assertBudget(kind: Kind) {
  const why = verdict(kind, await usage(), await caps(kind));
  if (why) throw new OverBudget(why);
  // The plan of the owner this request runs for has its own cap (R38). Shadows and research are memory's spend, not theirs.
  if (kind !== "shadow" && kind !== "research") {
    const mine = await ownerTokensSpent();
    if (mine) throw new OverBudget(mine);
  }
}

// What one recall spends at OpenAI, for its retrieval row's openai_tokens and the cost guardrail (R34). Shadow and research
// calls are someone else's spend, so they never count, even from work a recall started.
const tally = new AsyncLocalStorage<{ tokens: number }>();

/** Runs `work` with a fresh count of the OpenAI tokens metered inside it, embed and judge calls alike. */
export function tallied<T>(work: (spent: { tokens: number }) => Promise<T>): Promise<T> {
  const spent = { tokens: 0 };
  return tally.run(spent, () => work(spent));
}

export async function meter(kind: Kind, tokens: number, _model?: string) {
  if (!tokens) return;
  const spent = kind === "shadow" || kind === "research" ? undefined : tally.getStore();
  if (spent) spent.tokens += tokens;
  if (kind !== "shadow" && kind !== "research") await meterOwner(tokens);
  await sql`insert into memory.openai_usage (month, kind, tokens) values (date_trunc('month', now())::date, ${kind}, ${tokens})
    on conflict (month, kind) do update set tokens = memory.openai_usage.tokens + excluded.tokens`;
}
