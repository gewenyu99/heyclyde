// Pure learner update math: confidence steps, link reinforcement/decay, and co-use pair discovery.
import { CO_USE_SESSIONS } from "./ranking.ts";

export const WAIT_MINUTES = 30;
export const REINFORCE = 0.03;
export const CAP = 0.99;
export const MISS_FREE = 5;
export const MISS_EASE = 0.98;
export const LINK_UP = 0.2;
export const LINK_CAP = 5;
export const LINK_DOWN = 0.9;
export const LINK_FLOOR = 0.2;
export const DORMANT = 0.15;

export const CO_USE = {
  step: 0.1,
  cap: 1,
  topEntries: 4,
  maxPairs: 6,
  sessions: CO_USE_SESSIONS,
  fadeEvery: 200,
  fade: 0.05,
} as const;

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
export const coUsed = (w: number) => round6(Math.min(CO_USE.cap, w + CO_USE.step));
export const faded = (w: number) => round6(Math.max(0, w - CO_USE.fade));

/** Ordered distinct ID pairs from up to topEntries used results of a recall. */
export function coPairs(used: string[]): [string, string][] {
  const top = [...new Set(used)].slice(0, CO_USE.topEntries);
  const out: [string, string][] = [];
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) out.push(top[i] < top[j] ? [top[i], top[j]] : [top[j], top[i]]);
  }
  return out.slice(0, CO_USE.maxPairs);
}

export type Outcome = "used" | "irrelevant" | "wrong" | "opened" | "ignored";
export type Steps = { trialStep: number; settledStep: number };
export const STEPS: Steps = { trialStep: 0.12, settledStep: 0.02 };

const WEIGHT: Record<Exclude<Outcome, "ignored">, number> = { used: 1, irrelevant: -0.3, wrong: -1, opened: 0.2 };
const IGNORED = { trial: -0.05, settled: -0.01 };
const FLOOR = 0.01;
const CEILING = 0.99;

/** Updates entry confidence after one outcome, clamped to [0.01, 0.99]. */
export function step(entry: { confidence: number; trial: boolean }, outcome: Outcome, sizes: Steps = STEPS): number {
  const delta = outcome === "ignored"
    ? (entry.trial ? IGNORED.trial : IGNORED.settled)
    : WEIGHT[outcome] * (entry.trial ? sizes.trialStep : sizes.settledStep);
  return Math.round(Math.min(CEILING, Math.max(FLOOR, entry.confidence + delta)) * 1e6) / 1e6;
}

export type CardVote = "helpful" | "nothing_useful" | null;

/** Reduces explicit feedback, opens, blame, and card votes into one outcome per shown entry. */
export function outcomesOf(
  { shown, named, opened, blamed, cardVote = null }: {
    shown: string[];
    named: Map<string, Outcome>;
    opened: Set<string>;
    blamed: string | null;
    cardVote?: CardVote;
  },
): Map<string, Outcome> {
  const out = new Map<string, Outcome>();
  for (const id of shown) {
    const signals: Exclude<Outcome, "ignored">[] = [];
    if (id === blamed) signals.push("wrong");
    const said = named.get(id);
    if (said && said !== "ignored" && said !== "opened") signals.push(said);
    if (opened.has(id)) signals.push("opened");
    if (signals.length) {
      signals.sort((a, b) => Math.abs(WEIGHT[b]) - Math.abs(WEIGHT[a]) || WEIGHT[a] - WEIGHT[b]);
      out.set(id, signals[0]);
    } else if (cardVote === "helpful") {
      out.set(id, "used");
    } else if (cardVote === "nothing_useful") {
      out.set(id, "irrelevant");
    } else if (named.size) out.set(id, "ignored");
  }
  return out;
}

export const OUTCOME_WHY: Record<Outcome, string> = {
  used: "the agent used it",
  irrelevant: "the agent found it irrelevant",
  wrong: "named wrong",
  opened: "the agent opened it",
  ignored: "shown, not used",
};
