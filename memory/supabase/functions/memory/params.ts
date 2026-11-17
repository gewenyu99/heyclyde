// Parameter sets (R32). Every ranking knob lives in a memory.param_set row, and recall reads the row of the set it serves.
// A set is immutable, so "hybrid.v1" always means the same ranking, and every set carries every knob: a child names only
// what it changes, and the API fills in the rest from its parent. The v1 sets hold the constants the code used to.
import type { Sql } from "./db.ts";

export type Params = {
  /** How many entries each ranker and each arm returns. */
  candidates: number;
  /** The packet's item and token budgets. */
  packetItems: number;
  packetTokens: number;
  /** The filter reads this many of the ranking's top and keeps the ones the judge rates at or above filterThreshold. */
  filterK: number;
  filterThreshold: number;
  /** Confidence tilts a score: score × (tiltBase + (1 - tiltBase) × confidence). An entry the tilt didn't read counts as
   * tiltUnknownConfidence. tiltWindow is how many of the top the tilt reads confidence for, rowWindow how many the filter
   * and the packet load rows for. Under `dormant`, an entry is skipped. */
  tiltBase: number;
  tiltUnknownConfidence: number;
  tiltWindow: number;
  rowWindow: number;
  dormant: number;
  /** Hybrid: reciprocal rank fusion's k, and the vector ranker's weight against the keyword ranker's 1. */
  rrfK: number;
  vecWeight: number;
  /** Index: a draft's score is multiplied by this. Every arm: a scoped recall multiplies its own scope's scores by scopeBoost. */
  indexDraftFactor: number;
  scopeBoost: number;
  /** Every arm, optional and 1 when a set doesn't carry it. A candidate in another run's scope (run:<x>, not the recall's own)
   * has its score multiplied by otherRunFactor, a draft in a non-run scope by globalAgentDraftFactor. Both are in (0, 1]. */
  otherRunFactor?: number;
  globalAgentDraftFactor?: number;
  /** The trial lane (R28), optional and off when a set doesn't carry it. trialItems is how many entries still on trial a
   * recall lists apart, under "On trial", from the settled main list; 0 serves every entry in one list as before. They must
   * rate at or above trialFloor. trialStep and settledStep are how far one outcome moves an entry's confidence while it is
   * in trial and once it has settled (learn.ts step). */
  trialItems?: number;
  trialFloor?: number;
  trialStep?: number;
  settledStep?: number;
  /** Optional and unlimited when a set doesn't carry it: each packet item's body is cut to this many characters, with
   * "… more in get_entry" after it. */
  itemChars?: number;
  /** Spreading: personalized PageRank's restart share and iteration count, what a replaced entry keeps, and each link
   * type's weight, keyed "src_pattern|link_type|dst_pattern" or "*|link_type|*" for any patterns (1 for a type not named, 0 for
   * co_used). */
  restart: number;
  iterations: number;
  supersededFactor: number;
  linkTypeWeights: Record<string, number>;
  /** Weights of the features slice 3 adds: temperature, age and kind. At 0 they change nothing, and under the tilt score form
   * they are never read. */
  wTemperature: number;
  wAge: number;
  wKind: number;
  /** How a candidate's final score is made (R32), optional and "tilt" when a set doesn't carry it. "tilt" is the arm's score
   * tilted by confidence, as v1 always did. "logodds" sums wRelevance·r + wTemperature·h + wAge·ln(1 + age) +
   * wConfidence·logit(confidence), with r the arm's score over the recall's top score. See features.ts finalScore. */
  scoreForm?: "tilt" | "logodds";
  wRelevance?: number;
  wConfidence?: number;
  /** Temperature on the recall clock: ACT-R's base level ln Σ w·(recalls since + 1)^−tempDecay over the events in the last
   * tempWindow recalls, floored at tempFloor and shifted up by it, so it's 0 or more. The events are an agent's used
   * (tempAgentUsed), Wen's confirmation (tempWenConfirm) and a get_entry open (tempOpened). See features.ts TEMPERATURE. */
  tempDecay?: number;
  tempFloor?: number;
  tempWindow?: number;
  tempAgentUsed?: number;
  tempWenConfirm?: number;
  tempOpened?: number;
  /** Best-first spreading (R44), optional. spreadMode picks the expansion: "ppr" (the default) or "bestfirst", which expands
   * the strongest path first. maxHops and minPath stop the initial spread; wPath weighs the best path strength in the score.
   * A set without them spreads as before. See SPREAD for what an absent knob means. */
  spreadMode?: "ppr" | "bestfirst";
  maxHops?: number;
  minPath?: number;
  wPath?: number;
};

/** What a set that doesn't carry the best-first knobs means by them, and the two sizes of the best-first code that no set
 * changes: the phrase lengths seeds are matched in, and how many frontier nodes a recall keeps for recall_more. */
export const SPREAD = { mode: "ppr", maxHops: 3, minPath: 0.05, wPath: 1, phraseWords: [2, 3], frontierCap: 50 } as const;

/** The best-first knobs of a set, with the defaults filled in. */
export function spreadKnobs(p: Params) {
  return {
    mode: p.spreadMode ?? SPREAD.mode, maxHops: p.maxHops ?? SPREAD.maxHops, minPath: p.minPath ?? SPREAD.minPath,
    wPath: p.wPath ?? SPREAD.wPath,
  };
}

type Spec = { min: number; max: number; int?: boolean; above?: boolean };
type OptionalKnob = "otherRunFactor" | "globalAgentDraftFactor" | "trialItems" | "trialFloor" | "trialStep" | "settledStep" | "itemChars" | "maxHops" | "minPath" | "wPath"
  | "wRelevance" | "wConfidence" | "tempDecay" | "tempFloor" | "tempWindow" | "tempAgentUsed" | "tempWenConfirm" | "tempOpened";
const WEIGHT: Spec = { min: -10, max: 10 };
const KNOBS: Record<Exclude<keyof Params, "linkTypeWeights" | "spreadMode" | "scoreForm" | OptionalKnob>, Spec> = {
  candidates: { min: 1, max: 200, int: true }, packetItems: { min: 1, max: 50, int: true }, packetTokens: { min: 100, max: 20000, int: true },
  filterK: { min: 1, max: 50, int: true }, filterThreshold: { min: 0, max: 1 }, tiltBase: { min: 0, max: 1 },
  tiltUnknownConfidence: { min: 0, max: 1 }, tiltWindow: { min: 1, max: 200, int: true }, rowWindow: { min: 1, max: 200, int: true },
  dormant: { min: 0, max: 1 }, rrfK: { min: 1, max: 1000 }, vecWeight: { min: 0, max: 20 }, indexDraftFactor: { min: 0, max: 1 },
  scopeBoost: { min: 0, max: 20 }, restart: { min: 0, max: 1, above: true }, iterations: { min: 1, max: 100, int: true },
  supersededFactor: { min: 0, max: 1 }, wTemperature: WEIGHT, wAge: WEIGHT, wKind: WEIGHT,
};
// Knobs a set may leave out: the v1 sets predate them, and a set without one ranks as before.
const OPTIONAL: Record<OptionalKnob, Spec> = {
  otherRunFactor: { min: 0, max: 1, above: true }, globalAgentDraftFactor: { min: 0, max: 1, above: true },
  trialItems: { min: 0, max: 10, int: true }, trialFloor: { min: 0, max: 1 },
  trialStep: { min: 0, max: 0.5, above: true }, settledStep: { min: 0, max: 0.5, above: true },
  itemChars: { min: 50, max: 4000, int: true },
  maxHops: { min: 1, max: 10, int: true }, minPath: { min: 0, max: 1 }, wPath: { min: 0, max: 10 },
  wRelevance: WEIGHT, wConfidence: WEIGHT, tempDecay: { min: 0, max: 5, above: true }, tempFloor: { min: -10, max: 0 },
  tempWindow: { min: 1, max: 10000, int: true }, tempAgentUsed: { min: 0, max: 100 }, tempWenConfirm: { min: 0, max: 100 },
  tempOpened: { min: 0, max: 100 },
};
// "*|type|*" weighs a link type between any two patterns (search.ts linkTypeWeight), as spreading.v6 does co_used.
const LINK_KEY = /^([a-z][a-z_-]{1,40}\|[a-z_]{2,40}\|[a-z][a-z_-]{1,40}|\*\|[a-z_]{2,40}\|\*)$/;
// The range eval/ants.py keeps link type weights in.
const LINK_WEIGHT = { min: 0.2, max: 5 };

/** A set that can't be made or found. The message says what to fix. */
export class ParamError extends Error {
  override name = "ParamError";
}

/** `overrides` laid over `base`, or on their own when there's no base, then checked: every knob present, a number in its
 * range, and nothing that isn't a knob. */
export function resolveParams(base: Params | null, overrides: unknown): Params {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new ParamError("params must be an object of knobs.");
  const merged: Record<string, unknown> = { ...base, ...overrides };
  for (const name of Object.keys(overrides)) {
    if (name !== "linkTypeWeights" && name !== "spreadMode" && name !== "scoreForm" && !(name in KNOBS) && !(name in OPTIONAL)) throw new ParamError(`unknown knob ${name}.`);
  }
  for (const [name, spec] of [...Object.entries(KNOBS), ...Object.entries(OPTIONAL)]) {
    const v = merged[name];
    if (v === undefined && name in OPTIONAL) continue;
    if (v === undefined) throw new ParamError(`${name} is missing. A set with no parent must say every knob.`);
    const low = spec.above ? (v as number) > spec.min : (v as number) >= spec.min;
    if (typeof v !== "number" || !Number.isFinite(v) || !low || v > spec.max || (spec.int && !Number.isInteger(v))) {
      throw new ParamError(`${name} must be ${spec.int ? "a whole number" : "a number"} ${spec.above ? "above" : "from"} ${spec.min} to ${spec.max}.`);
    }
  }
  if (merged.spreadMode !== undefined && merged.spreadMode !== "ppr" && merged.spreadMode !== "bestfirst") {
    throw new ParamError('spreadMode must be "ppr" or "bestfirst".');
  }
  if (merged.scoreForm !== undefined && merged.scoreForm !== "tilt" && merged.scoreForm !== "logodds") {
    throw new ParamError('scoreForm must be "tilt" or "logodds".');
  }
  const weights = merged.linkTypeWeights;
  if (weights === undefined) throw new ParamError("linkTypeWeights is missing. A set with no parent must say every knob.");
  if (!weights || typeof weights !== "object" || Array.isArray(weights)) throw new ParamError("linkTypeWeights must be an object.");
  for (const [key, w] of Object.entries(weights)) {
    if (!LINK_KEY.test(key)) throw new ParamError(`linkTypeWeights key ${key} must look like src_pattern|link_type|dst_pattern.`);
    if (typeof w !== "number" || !(w >= LINK_WEIGHT.min && w <= LINK_WEIGHT.max)) {
      throw new ParamError(`linkTypeWeights["${key}"] must be a number from ${LINK_WEIGHT.min} to ${LINK_WEIGHT.max}.`);
    }
  }
  return merged as Params;
}

export type ParamSet = { id: string; arm: string; params: Params };

// A set never changes, so an isolate keeps each one it has read for good.
const known = new Map<string, ParamSet>();

/** Drop a cached set. Only an import that restores a backup over a migration-seeded set changes one. */
export const forgetParamSet = (id: string) => void known.delete(id);

/** The set with this id. Throws ParamError when there is none. */
export async function paramSet(db: Sql, id: string): Promise<ParamSet> {
  const hit = known.get(id);
  if (hit) return hit;
  const [row] = await db`select id, arm, params from memory.param_set where id = ${id}`;
  if (!row) throw new ParamError(`No parameter set ${id}.`);
  const set = { id: row.id as string, arm: row.arm as string, params: row.params as Params };
  known.set(id, set);
  return set;
}
