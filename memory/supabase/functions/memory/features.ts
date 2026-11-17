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

export const MAX_CONTEXT_CANDIDATES = 50;

/** What a set that doesn't carry the R32 knobs means by them: the tilt score form, and LEARNING-PLAN.md's temperature (ACT-R's
 * decay 0.5, floored at −3, counting the last 1000 recalls, used and Wen's confirmation at 3 and an open at 1). */
export const SCORE = { form: "tilt", wRelevance: 1, wConfidence: 1 } as const;
export const TEMPERATURE = { decay: 0.5, floor: -3, window: 1000, agentUsed: 3, wenConfirm: 3, opened: 1 } as const;
/** logit is read at confidence clamped to this, so 0 and 1 give finite scores (±4.59512). */
export const CONFIDENCE_CLAMP = [0.01, 0.99] as const;

export const scoreForm = (p: Params) => p.scoreForm ?? SCORE.form;

/** A set's temperature knobs, with the defaults filled in. */
export function temperatureKnobs(p: Params) {
  return {
    decay: p.tempDecay ?? TEMPERATURE.decay, floor: p.tempFloor ?? TEMPERATURE.floor, window: p.tempWindow ?? TEMPERATURE.window,
    agentUsed: p.tempAgentUsed ?? TEMPERATURE.agentUsed, wenConfirm: p.tempWenConfirm ?? TEMPERATURE.wenConfirm,
    opened: p.tempOpened ?? TEMPERATURE.opened,
  };
}

export function logit(c: number) {
  const x = Math.min(CONFIDENCE_CLAMP[1], Math.max(CONFIDENCE_CLAMP[0], c));
  return Math.log(x / (1 - x));
}

/** One candidate's inputs to its final score. temperature and age are null when the feature query failed, and their terms
 * are then 0. confidence is null when the tilt didn't read it, and the set's tiltUnknownConfidence stands in. */
export type Signals = { armScore: number; relevance: number; confidence: number | null; temperature: number | null; age: number | null };

/** The final score under a set's score form. tilt: armScore × (tiltBase + (1 − tiltBase) × c), exactly as v1. logodds:
 * wRelevance·relevance + wTemperature·temperature + wAge·ln(1 + age) + wConfidence·logit(c). */
export function finalScore(s: Signals, p: Params): number {
  const c = s.confidence ?? p.tiltUnknownConfidence;
  if (scoreForm(p) !== "logodds") return s.armScore * (p.tiltBase + (1 - p.tiltBase) * c);
  return (p.wRelevance ?? SCORE.wRelevance) * s.relevance + p.wTemperature * (s.temperature ?? 0) +
    p.wAge * (s.age === null ? 0 : Math.log1p(s.age)) + (p.wConfidence ?? SCORE.wConfidence) * logit(c);
}

/** relevance is the arm's score over the best score the arm gave this recall, so the top candidate is 1. */
export function relevanceOf(ranked: Ranked[]): Map<string, number> {
  const top = ranked.reduce((a, [, s]) => Math.max(a, s), 0);
  return new Map(ranked.map(([id, s]) => [id, top > 0 ? s / top : 0]));
}

export type Clocked = { cNow: number; temperature: Map<string, number>; age: Map<string, number> };

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

export type Feature = {
  id: string;
  arms: Record<string, { rank: number; score: number | null }>;
  relevance: number | null;
  confidence: number | null;
  /** null until entries carry a kind. */
  kind: string | null;
  judge: number | null;
  temperature: number | null;
  age: number | null;
  score: number;
};

/** `ranked` is the final ranking. `trace` has each ranker's own list. confidence, judged, relevance and the clocked features
 * hold only the entries they were read for. */
export function features(ranked: Ranked[], trace: Trace, confidence: Map<string, number>, judged: Map<string, number>,
  relevance: Map<string, number> = new Map(), clock: Clocked | null = null): Feature[] {
  const lists = Object.entries(trace).map(([name, list]) => [name, new Map(list.map(([id, score], i) => [id, { rank: i + 1, score }]))] as const);
  return ranked.slice(0, MAX_CONTEXT_CANDIDATES).map(([id, score]): Feature => ({
    id,
    arms: Object.fromEntries(lists.flatMap(([name, found]) => found.has(id) ? [[name, found.get(id)!]] : [])),
    relevance: relevance.get(id) ?? null, confidence: confidence.get(id) ?? null, kind: null, judge: judged.get(id) ?? null,
    temperature: clock?.temperature.get(id) ?? null, age: clock?.age.get(id) ?? null, score,
  }));
}
