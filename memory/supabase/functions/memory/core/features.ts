// Candidate ranking features and final score computation (tilt and log-odds forms plus ACT-R
// recall-clock temperature). Pure functions shared across hosted and local deployments.
import type { Params } from "./params.ts";

export const MAX_CONTEXT_CANDIDATES = 50;

export const SCORE = { form: "tilt", wRelevance: 1, wConfidence: 1 } as const;
export const DEFAULT_TEMPERATURE = { decay: 0.5, floor: -3, window: 1000, agentUsed: 3, ownerConfirm: 3, opened: 1 } as const;
export const CONFIDENCE_CLAMP = [0.01, 0.99] as const;

export type RankedCandidate = [id: string, score: number, line: string | null];
export type TraceMap = Record<string, [id: string, score: number | null][]>;

export type TemperatureKnobs = {
  decay: number;
  floor: number;
  window: number;
  agentUsed: number;
  ownerConfirm: number;
  opened: number;
};

export const scoreForm = (p: Params) => p.scoreForm ?? SCORE.form;

export function temperatureKnobsFrom(p: Params): TemperatureKnobs {
  return {
    decay: p.tempDecay ?? DEFAULT_TEMPERATURE.decay,
    floor: p.tempFloor ?? DEFAULT_TEMPERATURE.floor,
    window: p.tempWindow ?? DEFAULT_TEMPERATURE.window,
    agentUsed: p.tempAgentUsed ?? DEFAULT_TEMPERATURE.agentUsed,
    ownerConfirm: p.tempOwnerConfirm ?? DEFAULT_TEMPERATURE.ownerConfirm,
    opened: p.tempOpened ?? DEFAULT_TEMPERATURE.opened,
  };
}

export function logit(c: number): number {
  const x = Math.min(CONFIDENCE_CLAMP[1], Math.max(CONFIDENCE_CLAMP[0], c));
  return Math.log(x / (1 - x));
}

export type Signals = {
  armScore: number;
  relevance: number;
  confidence: number | null;
  temperature: number | null;
  age: number | null;
};

/** Combines candidate signals under either the tilt or log-odds scoring formula. */
export function finalScore(s: Signals, p: Params): number {
  const c = s.confidence ?? p.tiltUnknownConfidence;
  if (scoreForm(p) !== "logodds") return s.armScore * (p.tiltBase + (1 - p.tiltBase) * c);
  return (p.wRelevance ?? SCORE.wRelevance) * s.relevance +
    p.wTemperature * (s.temperature ?? 0) +
    p.wAge * (s.age === null ? 0 : Math.log1p(s.age)) +
    (p.wConfidence ?? SCORE.wConfidence) * logit(c);
}

/** Normalizes arm scores relative to the top candidate score. */
export function relevanceOf(ranked: RankedCandidate[]): Map<string, number> {
  const top = ranked.reduce((a, [, s]) => Math.max(a, s), 0);
  return new Map(ranked.map(([id, s]) => [id, top > 0 ? s / top : 0]));
}

export type Clocked = { cNow: number; temperature: Map<string, number>; age: Map<string, number> };

export type FeedbackHeatRow = {
  retrieval_id: string;
  entry_id: string;
  source: string;
  verdict: string;
  seq: number;
};

export type OpenHeatRow = {
  session_id: string;
  entry_id: string;
  seq: number;
};

/** Computes ACT-R recall-clock temperature and age in pure TypeScript identically to the SQL function. */
export function computeTemperatureAndAge(
  writtenSeqById: Map<string, number>,
  feedbackRows: FeedbackHeatRow[],
  openRows: OpenHeatRow[],
  asOf: number,
  knobs: TemperatureKnobs,
  humanSources: ReadonlySet<string> = new Set(["user", "owner"]),
): Clocked {
  const minSeq = asOf - knobs.window;
  const sums = new Map<string, number>();

  const add = (id: string, seq: number, weight: number) => {
    if (seq > asOf || seq <= minSeq) return;
    const term = weight * Math.pow(Math.max(1, asOf - seq + 1), -knobs.decay);
    sums.set(id, (sums.get(id) ?? 0) + term);
  };

  // Dedupe feedback once per (retrieval_id, entry_id, source), taking earliest seq in window.
  const seenFeedback = new Map<string, FeedbackHeatRow>();
  for (const f of feedbackRows) {
    if (f.verdict !== "helpful" && f.verdict !== "used") continue;
    if (f.source !== "agent" && !humanSources.has(f.source)) continue;
    if (f.seq > asOf || f.seq <= minSeq) continue;
    const key = `${f.retrieval_id}\0${f.entry_id}\0${f.source}`;
    const prev = seenFeedback.get(key);
    if (!prev || f.seq < prev.seq) seenFeedback.set(key, f);
  }
  for (const f of seenFeedback.values()) {
    add(f.entry_id, f.seq, f.source === "agent" ? knobs.agentUsed : knobs.ownerConfirm);
  }

  // Dedupe opens once per (session_id, entry_id, seq).
  const seenOpens = new Set<string>();
  for (const o of openRows) {
    if (o.seq > asOf || o.seq <= minSeq) continue;
    const key = `${o.session_id}\0${o.entry_id}\0${o.seq}`;
    if (seenOpens.has(key)) continue;
    seenOpens.add(key);
    add(o.entry_id, o.seq, knobs.opened);
  }

  const temperature = new Map<string, number>();
  const age = new Map<string, number>();
  for (const [id, writtenSeq] of writtenSeqById) {
    age.set(id, Math.max(0, asOf - writtenSeq));
    const s = sums.get(id) ?? 0;
    const base = s > 0 ? Math.max(Math.log(s), knobs.floor) : knobs.floor;
    temperature.set(id, base - knobs.floor);
  }
  return { cNow: asOf, temperature, age };
}

export type Feature = {
  id: string;
  arms: Record<string, { rank: number; score: number | null }>;
  relevance: number | null;
  confidence: number | null;
  kind: string | null;
  judge: number | null;
  temperature: number | null;
  age: number | null;
  score: number;
};

export function features(
  ranked: RankedCandidate[],
  trace: TraceMap,
  confidence: Map<string, number>,
  judged: Map<string, number>,
  relevance: Map<string, number> = new Map(),
  clock: Clocked | null = null,
): Feature[] {
  const lists = Object.entries(trace).map(([name, list]) => [
    name,
    new Map(list.map(([id, score], i) => [id, { rank: i + 1, score }])),
  ] as const);
  return ranked.slice(0, MAX_CONTEXT_CANDIDATES).map(([id, score]): Feature => ({
    id,
    arms: Object.fromEntries(lists.flatMap(([name, found]) => found.has(id) ? [[name, found.get(id)!]] : [])),
    relevance: relevance.get(id) ?? null,
    confidence: confidence.get(id) ?? null,
    kind: null,
    judge: judged.get(id) ?? null,
    temperature: clock?.temperature.get(id) ?? null,
    age: clock?.age.get(id) ?? null,
    score,
  }));
}
