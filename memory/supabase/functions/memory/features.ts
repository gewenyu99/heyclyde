// What a recall logs about each candidate in retrieval.context (R32): its rank and score in every ranker that listed it,
// the entry's confidence, its kind, the judge's probability where the filter asked, and the final score ranking used.
// Slice 3 adds temperature and age. At most the top 50 candidates, so a row stays small.
import type { Ranked, Trace } from "./search.ts";

export const MAX_CONTEXT_CANDIDATES = 50;

export type Feature = {
  id: string;
  arms: Record<string, { rank: number; score: number | null }>;
  confidence: number | null;
  /** null until entries carry a kind. */
  kind: string | null;
  judge: number | null;
  score: number;
};

/** `ranked` is the final ranking, after the tilt. `trace` has each ranker's own list. Both confidence and judge hold only
 * the entries they were read for. */
export function features(ranked: Ranked[], trace: Trace, confidence: Map<string, number>, judged: Map<string, number>): Feature[] {
  const lists = Object.entries(trace).map(([name, list]) => [name, new Map(list.map(([id, score], i) => [id, { rank: i + 1, score }]))] as const);
  return ranked.slice(0, MAX_CONTEXT_CANDIDATES).map(([id, score]): Feature => ({
    id,
    arms: Object.fromEntries(lists.flatMap(([name, found]) => found.has(id) ? [[name, found.get(id)!]] : [])),
    confidence: confidence.get(id) ?? null, kind: null, judge: judged.get(id) ?? null, score,
  }));
}
