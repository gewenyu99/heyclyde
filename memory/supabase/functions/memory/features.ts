// What a recall knows about each candidate and how it turns that into a final score (R32). Each candidate has its rank and
// score in every ranker that listed it, its relevance (the arm's score over the recall's top score), the entry's confidence,
// its kind, the judge's probability where the filter asked, its temperature and its age, and the final score ranking used.
// retrieval.context logs at most the top 50, so a row stays small.
//
// Temperature and age run on the recall clock, never calendar time: a recall reads the clock (c_now) when ranking starts, and
// every feature is as of that reading, so a replay of the recall later rebuilds the same values.
import type { Sql } from "./db.ts";
import type { Params } from "./params.ts";
import type { Ranked, Trace } from "./search.ts";
import {
  CONFIDENCE_CLAMP,
  DEFAULT_TEMPERATURE,
  type Feature,
  features,
  finalScore as coreFinalScore,
  logit,
  MAX_CONTEXT_CANDIDATES,
  relevanceOf,
  SCORE,
  scoreForm as coreScoreForm,
  type Clocked,
  type Signals,
} from "./core/features.ts";
import type { Params as CoreParams } from "./core/params.ts";

export { CONFIDENCE_CLAMP, features, logit, MAX_CONTEXT_CANDIDATES, relevanceOf, SCORE };
export type { Clocked, Feature, Signals };

/** What a set that doesn't carry the R32 knobs means by them: the tilt score form, and LEARNING-PLAN.md's temperature (ACT-R's
 * decay 0.5, floored at −3, counting the last 1000 recalls, used and Wen's confirmation at 3 and an open at 1). */
export const TEMPERATURE = {
  decay: DEFAULT_TEMPERATURE.decay,
  floor: DEFAULT_TEMPERATURE.floor,
  window: DEFAULT_TEMPERATURE.window,
  agentUsed: DEFAULT_TEMPERATURE.agentUsed,
  wenConfirm: DEFAULT_TEMPERATURE.ownerConfirm,
  opened: DEFAULT_TEMPERATURE.opened,
} as const;

export const scoreForm = (p: Params) => coreScoreForm(p as CoreParams);

/** A set's temperature knobs, with the defaults filled in. */
export function temperatureKnobs(p: Params) {
  return {
    decay: p.tempDecay ?? TEMPERATURE.decay,
    floor: p.tempFloor ?? TEMPERATURE.floor,
    window: p.tempWindow ?? TEMPERATURE.window,
    agentUsed: p.tempAgentUsed ?? TEMPERATURE.agentUsed,
    wenConfirm: p.tempWenConfirm ?? p.tempOwnerConfirm ?? TEMPERATURE.wenConfirm,
    opened: p.tempOpened ?? TEMPERATURE.opened,
  };
}

/** The final score under a set's score form. tilt: armScore × (tiltBase + (1 − tiltBase) × c), exactly as v1. logodds:
 * wRelevance·relevance + wTemperature·temperature + wAge·ln(1 + age) + wConfidence·logit(c). */
export function finalScore(s: Signals, p: Params): number {
  return coreFinalScore(s, p as CoreParams);
}

/** Every candidate's temperature and age as of `asOf`, or as of the clock now when it's null, in one statement. Throws when
 * the query fails, and the recall then ranks without them. */
export async function clocked(db: Sql, ids: string[], asOf: number | null, p: Params): Promise<Clocked> {
  const t = temperatureKnobs(p);
  const rows = await db`select c.c_now, f.id, f.age, f.temperature
    from (select coalesce(${asOf}::bigint, memory.recall_clock()) as c_now) c
    left join memory.ranking_features(${ids}::text[], c.c_now, ${t.decay}::float8, ${t.floor}::float8, ${t.window}::int,
      ${t.agentUsed}::float8, ${t.wenConfirm}::float8, ${t.opened}::float8) f on true`;
  const out: Clocked = { cNow: Number(rows[0].c_now), temperature: new Map(), age: new Map() };
  for (const r of rows) {
    if (r.id === null) continue;
    out.temperature.set(r.id, r.temperature as number);
    out.age.set(r.id, Number(r.age));
  }
  return out;
}
