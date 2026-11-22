// Parameter sets and validation rules. Every ranking knob lives in a parameter set, so a named set
// such as "hybrid.v1" or "spreading.v1" produces reproducible rankings.

export type Params = {
  /** How many entries each ranker and each arm returns. */
  candidates: number;
  /** The packet's item and token budgets. */
  packetItems: number;
  packetTokens: number;
  /** The filter reads this many of the ranking's top and keeps those at or above filterThreshold. */
  filterK: number;
  filterThreshold: number;
  /** Confidence tilts a score: score * (tiltBase + (1 - tiltBase) * confidence). An entry without read
   * confidence uses tiltUnknownConfidence. Under `dormant`, an entry is skipped. */
  tiltBase: number;
  tiltUnknownConfidence: number;
  tiltWindow: number;
  rowWindow: number;
  dormant: number;
  /** Hybrid: reciprocal rank fusion k, and vector weight relative to keyword weight 1. */
  rrfK: number;
  vecWeight: number;
  /** Index: draft multiplier. Every arm: own scope multiplier. */
  indexDraftFactor: number;
  scopeBoost: number;
  /** Optional multipliers in (0, 1] for entries from other runs or un-scoped drafts. */
  otherRunFactor?: number;
  globalAgentDraftFactor?: number;
  /** Trial lane settings: items still on trial listed separately under "On trial". */
  trialItems?: number;
  trialFloor?: number;
  trialStep?: number;
  settledStep?: number;
  /** Optional per-item character clip length in the main packet. */
  itemChars?: number;
  /** Spreading: PPR restart share, iterations, replaced-entry attenuation, and link type weights. */
  restart: number;
  iterations: number;
  supersededFactor: number;
  linkTypeWeights: Record<string, number>;
  /** Weights of learned features: temperature, age, and kind. */
  wTemperature: number;
  wAge: number;
  wKind: number;
  /** Score combination form: "tilt" (default) or "logodds". */
  scoreForm?: "tilt" | "logodds";
  wRelevance?: number;
  wConfidence?: number;
  /** Temperature ACT-R decay parameters on the recall clock. */
  tempDecay?: number;
  tempFloor?: number;
  tempWindow?: number;
  tempAgentUsed?: number;
  tempOwnerConfirm?: number;
  tempOpened?: number;
  /** Best-first spreading knobs. */
  spreadMode?: "ppr" | "bestfirst";
  maxHops?: number;
  minPath?: number;
  wPath?: number;
};

/** Default best-first spreading constants. */
export const SPREAD = { mode: "ppr", maxHops: 3, minPath: 0.05, wPath: 1, phraseWords: [2, 3], frontierCap: 50 } as const;

export function spreadKnobs(p: Params) {
  return {
    mode: p.spreadMode ?? SPREAD.mode,
    maxHops: p.maxHops ?? SPREAD.maxHops,
    minPath: p.minPath ?? SPREAD.minPath,
    wPath: p.wPath ?? SPREAD.wPath,
  };
}

type Spec = { min: number; max: number; int?: boolean; above?: boolean };
type OptionalKnob =
  | "otherRunFactor"
  | "globalAgentDraftFactor"
  | "trialItems"
  | "trialFloor"
  | "trialStep"
  | "settledStep"
  | "itemChars"
  | "maxHops"
  | "minPath"
  | "wPath"
  | "wRelevance"
  | "wConfidence"
  | "tempDecay"
  | "tempFloor"
  | "tempWindow"
  | "tempAgentUsed"
  | "tempOwnerConfirm"
  | "tempOpened";

const WEIGHT: Spec = { min: -10, max: 10 };
const KNOBS: Record<Exclude<keyof Params, "linkTypeWeights" | "spreadMode" | "scoreForm" | OptionalKnob>, Spec> = {
  candidates: { min: 1, max: 200, int: true },
  packetItems: { min: 1, max: 50, int: true },
  packetTokens: { min: 100, max: 20000, int: true },
  filterK: { min: 1, max: 50, int: true },
  filterThreshold: { min: 0, max: 1 },
  tiltBase: { min: 0, max: 1 },
  tiltUnknownConfidence: { min: 0, max: 1 },
  tiltWindow: { min: 1, max: 200, int: true },
  rowWindow: { min: 1, max: 200, int: true },
  dormant: { min: 0, max: 1 },
  rrfK: { min: 1, max: 1000 },
  vecWeight: { min: 0, max: 20 },
  indexDraftFactor: { min: 0, max: 1 },
  scopeBoost: { min: 0, max: 20 },
  restart: { min: 0, max: 1, above: true },
  iterations: { min: 1, max: 100, int: true },
  supersededFactor: { min: 0, max: 1 },
  wTemperature: WEIGHT,
  wAge: WEIGHT,
  wKind: WEIGHT,
};

const OPTIONAL: Record<OptionalKnob, Spec> = {
  otherRunFactor: { min: 0, max: 1, above: true },
  globalAgentDraftFactor: { min: 0, max: 1, above: true },
  trialItems: { min: 0, max: 10, int: true },
  trialFloor: { min: 0, max: 1 },
  trialStep: { min: 0, max: 0.5, above: true },
  settledStep: { min: 0, max: 0.5, above: true },
  itemChars: { min: 50, max: 4000, int: true },
  maxHops: { min: 1, max: 10, int: true },
  minPath: { min: 0, max: 1 },
  wPath: { min: 0, max: 10 },
  wRelevance: WEIGHT,
  wConfidence: WEIGHT,
  tempDecay: { min: 0, max: 5, above: true },
  tempFloor: { min: -10, max: 0 },
  tempWindow: { min: 1, max: 10000, int: true },
  tempAgentUsed: { min: 0, max: 100 },
  tempOwnerConfirm: { min: 0, max: 100 },
  tempOpened: { min: 0, max: 100 },
};

const LINK_KEY = /^([a-z][a-z_-]{1,40}\|[a-z_]{2,40}\|[a-z][a-z_-]{1,40}|\*\|[a-z_]{2,40}\|\*)$/;
const LINK_WEIGHT = { min: 0.2, max: 5 };

export class ParamError extends Error {
  override name = "ParamError";
}

export type ParamAlias = { confirmKey?: string };

/** Merges `overrides` over `base` (when provided) and validates every knob name, type, and bound. */
export function resolveParams(base: Params | null, overrides: unknown, alias: ParamAlias = {}): Params {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new ParamError("params must be an object of knobs.");
  }
  const rawOverrides = overrides as Record<string, unknown>;
  const confirmKey = alias.confirmKey ?? "tempOwnerConfirm";
  const merged: Record<string, unknown> = { ...base, ...rawOverrides };
  for (const name of Object.keys(rawOverrides)) {
    const canonicalName = name === confirmKey ? "tempOwnerConfirm" : name;
    if (
      canonicalName !== "linkTypeWeights" &&
      canonicalName !== "spreadMode" &&
      canonicalName !== "scoreForm" &&
      !(canonicalName in KNOBS) &&
      !(canonicalName in OPTIONAL)
    ) {
      throw new ParamError(`unknown knob ${name}.`);
    }
  }
  if (confirmKey !== "tempOwnerConfirm" && confirmKey in rawOverrides) {
    merged.tempOwnerConfirm = rawOverrides[confirmKey];
  }
  for (const [name, spec] of [...Object.entries(KNOBS), ...Object.entries(OPTIONAL)]) {
    const externalName = name === "tempOwnerConfirm" ? confirmKey : name;
    const v = merged[name];
    if (v === undefined && name in OPTIONAL) continue;
    if (v === undefined) throw new ParamError(`${externalName} is missing. A set with no parent must say every knob.`);
    const low = spec.above ? (v as number) > spec.min : (v as number) >= spec.min;
    if (typeof v !== "number" || !Number.isFinite(v) || !low || v > spec.max || (spec.int && !Number.isInteger(v))) {
      throw new ParamError(`${externalName} must be ${spec.int ? "a whole number" : "a number"} ${spec.above ? "above" : "from"} ${spec.min} to ${spec.max}.`);
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
  if (!weights || typeof weights !== "object" || Array.isArray(weights)) {
    throw new ParamError("linkTypeWeights must be an object.");
  }
  for (const [key, w] of Object.entries(weights)) {
    if (!LINK_KEY.test(key)) throw new ParamError(`linkTypeWeights key ${key} must look like src_pattern|link_type|dst_pattern.`);
    if (typeof w !== "number" || !(w >= LINK_WEIGHT.min && w <= LINK_WEIGHT.max)) {
      throw new ParamError(`linkTypeWeights["${key}"] must be a number from ${LINK_WEIGHT.min} to ${LINK_WEIGHT.max}.`);
    }
  }
  return merged as Params;
}

export type ParamSet = { id: string; arm: string; params: Params };

const BASE_PARAMS: Params = {
  candidates: 50,
  packetItems: 8,
  packetTokens: 1500,
  filterK: 12,
  filterThreshold: 0.5,
  tiltBase: 0.9,
  tiltUnknownConfidence: 0.7,
  tiltWindow: 48,
  rowWindow: 24,
  dormant: 0.15,
  rrfK: 10,
  vecWeight: 1.5,
  indexDraftFactor: 0.5,
  scopeBoost: 3,
  restart: 0.5,
  iterations: 20,
  supersededFactor: 0.3,
  linkTypeWeights: {},
  wTemperature: 0,
  wAge: 0,
  wKind: 0,
};

export const DEFAULT_PARAM_SETS: ParamSet[] = [
  { id: "index.v1", arm: "index", params: { ...BASE_PARAMS } },
  { id: "hybrid.v1", arm: "hybrid", params: { ...BASE_PARAMS } },
  {
    id: "spreading.v1",
    arm: "spreading",
    params: {
      ...BASE_PARAMS,
      trialItems: 3,
      trialFloor: 0.5,
      trialStep: 0.12,
      settledStep: 0.02,
      itemChars: 500,
      spreadMode: "bestfirst",
      maxHops: 3,
      minPath: 0.05,
      wPath: 1,
      scoreForm: "logodds",
      wRelevance: 4,
      wConfidence: 0.25,
      wTemperature: 0.15,
      wAge: 0,
      tempDecay: 0.5,
      tempFloor: -3,
      tempWindow: 1000,
      tempAgentUsed: 3,
      tempOwnerConfirm: 3,
      tempOpened: 1,
      linkTypeWeights: { "*|co_used|*": 1 },
    },
  },
];
