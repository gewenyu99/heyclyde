// Pure retrieval math, graph spreading, packet formatting, and vector similarity functions.
import { type Params, SPREAD, spreadKnobs } from "./params.ts";

// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;
export type Ranked = [id: string, score: number, line: string | null];
export type Trace = Record<string, [id: string, score: number | null][]>;
export type Frontier = [id: string, strength: number][];
export type ArmResult = [Ranked[], string | null, Trace, Frontier?];
export type Edges = Map<string, [string, number][]>;
export type Scoped = { scope: string; authority: string };

export const CO_USE_SESSIONS = 2;
export const MORE = "… more in get_entry";
const CLIPPED = "\n    [Cut to fit the packet. get_entry has the rest.]";

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const CJK_RUNS = /[\u3400-\u9fff\uf900-\ufaff]+/g;
const WORD = /[a-z0-9][a-z0-9.+-]*/g;
const STOP = new Set(
  ("a an and are as at be but by can do does for from how i if in is it its me my of on or so that the " +
    "this to use using was we what when where which who why will with you your").split(" "),
);

export const byScore = (a: Ranked, b: Ranked) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
export const scored = (ranked: Ranked[]): Trace[string] => ranked.map(([id, score]) => [id, score]);
export const unscored = (ids: string[]): Trace[string] => ids.map((id) => [id, null]);
export const hasCjk = (text: string) => CJK.test(text);

/** Overlapping CJK bigrams; a lone character stays as itself. */
export function bigrams(text: string): string[] {
  const out: string[] = [];
  for (const run of text.match(CJK_RUNS) ?? []) {
    const chars = [...run];
    if (chars.length === 1) out.push(run);
    else for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  }
  return out;
}

/** Lowercase English words (without stopwords) plus CJK bigrams. */
export function tokens(text: string): Set<string> {
  text = text.toLowerCase();
  const out = new Set<string>();
  for (const w of text.match(WORD) ?? []) {
    const t = w.replace(/^[.+-]+|[.+-]+$/g, "");
    if (t && !STOP.has(t)) out.add(t);
  }
  for (const b of bigrams(text)) out.add(b);
  return out;
}

export function estimateTokens(text: string): number {
  const cjk = (text.match(new RegExp(CJK, "g")) ?? []).length;
  return cjk + Math.floor((text.length - cjk) / 4);
}

/** Multiply scores of entries in `ids` by `factor` and re-sort descending. */
export function boost(scores: Ranked[], ids: Set<string>, factor: number): Ranked[] {
  return scores.map(([id, s, line]): Ranked => [id, ids.has(id) ? s * factor : s, line]).sort(byScore);
}

/** Discounts other runs' notes and unscoped drafts when configured in `p`. */
export function discount(scores: Ranked[], info: Map<string, Scoped>, scope: string | null, p: Params): Ranked[] {
  const run = p.otherRunFactor ?? 1;
  const draft = p.globalAgentDraftFactor ?? 1;
  if (run === 1 && draft === 1) return scores;
  return scores.map(([id, s, line]): Ranked => {
    const e = info.get(id);
    if (!e) return [id, s, line];
    const inRun = e.scope.startsWith("run:");
    const f = inRun ? (e.scope !== scope ? run : 1) : e.authority === "draft" ? draft : 1;
    return [id, s * f, line];
  }).sort(byScore);
}

const escRe = (s: string) => s.replace(/[.+*?^${}()|[\]\\-]/g, "\\$&");

/** Distinct non-stopword ASCII terms and CJK bigrams in `query` for 2+ term title checks. */
export function titlePatterns(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of query.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (STOP.has(w) || (w.length < 2 && !/^\d+$/.test(w)) || seen.has(w)) continue;
    seen.add(w);
    out.push(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`);
  }
  for (const b of bigrams(query)) {
    if (seen.has(b)) continue;
    seen.add(b);
    out.push(escRe(b));
  }
  return out;
}

/** Weighted Reciprocal Rank Fusion over multiple ranked ID lists. */
export function rrf(rankings: string[][], weights: number[] | undefined, k: number): [string, number][] {
  const score = new Map<string, number>();
  rankings.forEach((ranking, i) => {
    const w = weights?.[i] ?? 1;
    ranking.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + w / (k + rank + 1)));
  });
  return [...score].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Weight for a link type under parameter set weights (`co_used` defaults to 0 unless explicitly named). */
export function linkTypeWeight(typeWeights: Params["linkTypeWeights"], sp: string, type: string, dp: string): number {
  return typeWeights[`${sp}|${type}|${dp}`] ?? typeWeights[`*|${type}|*`] ?? (type === "co_used" ? 0 : 1);
}

/** Personalized PageRank over typed link graph from `seeds`. */
export function spread(out: Edges, seeds: Map<string, number>, restart: number, iterations: number): Map<string, number> {
  const total = [...seeds.values()].reduce((a, b) => a + b, 0) || 1;
  const p = new Map([...seeds].map(([id, s]) => [id, s / total]));
  let r = new Map(p);
  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>();
    for (const [id, v] of p) next.set(id, restart * v);
    for (const [id, v] of r) {
      const edges = out.get(id);
      if (!edges?.length) {
        next.set(id, (next.get(id) ?? 0) + (1 - restart) * v);
        continue;
      }
      const sum = edges.reduce((a, [, w]) => a + w, 0);
      for (const [to, w] of edges) next.set(to, (next.get(to) ?? 0) + (1 - restart) * v * (w / sum));
    }
    r = next;
  }
  return r;
}

/** Query word runs of length 2 and 3 as case-insensitive whole-word regex patterns. */
export function phrasePatterns(query: string, limit: number): string[] {
  const words = (query.toLowerCase().match(WORD) ?? []).map((w) => w.replace(/^[.+-]+|[.+-]+$/g, "")).filter(Boolean);
  const out = new Set<string>();
  for (const size of SPREAD.phraseWords) {
    for (let i = 0; i + size <= words.length; i++) {
      const run = words.slice(i, i + size);
      if (run.every((w) => STOP.has(w))) continue;
      out.add("(^|[^a-z0-9])" + run.map((w) => w.replace(/[.+*?^${}()|[\]\\-]/g, "\\$&")).join("\\s+") + "([^a-z0-9]|$)");
    }
  }
  return [...out].slice(0, limit);
}

type Step = [strength: number, id: string, hops: number];
const stronger = (a: Step, b: Step) => a[0] > b[0] || (a[0] === b[0] && a[1] < b[1]);

function push(heap: Step[], item: Step) {
  heap.push(item);
  for (let i = heap.length - 1; i > 0;) {
    const up = (i - 1) >> 1;
    if (!stronger(heap[i], heap[up])) break;
    [heap[i], heap[up]] = [heap[up], heap[i]];
    i = up;
  }
}

function pop(heap: Step[]): Step {
  const top = heap[0], last = heap.pop()!;
  if (heap.length) {
    heap[0] = last;
    for (let i = 0;;) {
      let big = i;
      for (const c of [2 * i + 1, 2 * i + 2]) if (c < heap.length && stronger(heap[c], heap[big])) big = c;
      if (big === i) break;
      [heap[i], heap[big]] = [heap[big], heap[i]];
      i = big;
    }
  }
  return top;
}

/** Priority-queue best-first expansion from `seeds`, returning strongest path per node plus frontier. */
export function bestFirst(out: Edges, seeds: Map<string, number>, maxHops: number, minPath: number, cap: number) {
  const best = new Map(seeds), held = new Map<string, number>(), expanded = new Set<string>(), heap: Step[] = [];
  for (const [id, s] of seeds) push(heap, [s, id, 0]);
  while (heap.length) {
    const [s, id, hops] = pop(heap);
    const edges = out.get(id);
    if (s < best.get(id)! || !edges?.length || s < minPath) continue;
    if (hops >= maxHops) {
      held.set(id, Math.max(held.get(id) ?? 0, s));
      continue;
    }
    expanded.add(id);
    for (const [to, w] of edges) {
      const next = s * w;
      if (next <= (best.get(to) ?? 0)) continue;
      if (next < minPath) {
        held.set(to, Math.max(held.get(to) ?? 0, next));
        continue;
      }
      best.set(to, next);
      push(heap, [next, to, hops + 1]);
    }
  }
  const frontier: Frontier = [...held].filter(([id]) => !expanded.has(id) && out.get(id)?.length)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, cap);
  return { best, frontier };
}

/** Combines normalized seed score with best-first path strength and applies superseded discount. */
export function bestFirstRanked(out: Edges, seeds: Ranked[], superseded: Set<string>, p: Params): [Ranked[], Frontier] {
  const k = spreadKnobs(p);
  const top = seeds.reduce((a, [, s]) => Math.max(a, s), 0);
  const strength = new Map(seeds.filter(([, s]) => s > 0).map(([id, s]) => [id, s / top]));
  const { best, frontier } = bestFirst(out, strength, k.maxHops, k.minPath, SPREAD.frontierCap);
  const ranked = [...best]
    .map(([id, path]): Ranked => {
      const score = (strength.get(id) ?? 0) + k.wPath * path;
      return [id, superseded.has(id) ? score * p.supersededFactor : score, null];
    })
    .sort(byScore).slice(0, p.candidates);
  return [ranked, frontier];
}

/** Exact cosine similarity between two numeric vectors (handles normalized and unnormalized vectors). */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/** Redacts body, evidence, and artifacts for private entries. */
export function redactEntry(row: Row, ownerLabel = "the owner"): Row {
  return row.sensitivity !== "private"
    ? row
    : { ...row, body: `[private entry: ask ${ownerLabel}]`, evidence: "", artifacts: null };
}

export function kindLabel(row: Row, sep: string): string {
  return `${row.kind ?? "observation"}${row.verified === false ? sep === ", " ? " unverified" : " · unverified" : ""}${sep}${
    Number(row.confidence ?? 0).toFixed(2)}`;
}

export function sizeLabel(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function artifactsLine(row: Row): string {
  const list: { name: string; kind: string; size: number }[] = row.artifacts ?? [];
  return list.length ? `Artifacts: ${list.map((a) => `${a.name} (${a.kind}, ${sizeLabel(a.size)})`).join(", ")}` : "";
}

export function renderItem(n: number, row: Row, itemChars?: number, ownerLabel = "the owner"): string {
  row = redactEntry(row, ownerLabel);
  let meta = `    ${kindLabel(row, " · confidence ")} · ${row.authority}${row.authority === "draft" ? " · unreviewed" : ""} · ${row.scope} · ${row.valid_from}`;
  if (row.superseded_by) meta += ` · replaced by ${row.superseded_by}`;
  const body = itemChars && String(row.body).length > itemChars ? `${String(row.body).slice(0, itemChars)}${MORE}` : row.body;
  const parts = [`[${n}] ${row.id}: ${row.title}`, meta, ...(row.provenance ? [`    ${row.provenance}`] : []), `    ${body}`];
  if (row.evidence && row.evidence_kind === "quote") parts.push(`    ${ownerLabel}: “${row.evidence}”`);
  const artifacts = artifactsLine(row);
  if (artifacts) parts.push(`    ${artifacts}`);
  return parts.join("\n");
}

export function clip(text: string, budget: number): string {
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (estimateTokens(text.slice(0, mid) + CLIPPED) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + CLIPPED;
}

export function packEntries(ranked: Ranked[], rows: Record<string, Row>, p: Params, ownerLabel = "the owner"): [string[], string[]] {
  const delivered: string[] = [], chunks: string[] = [];
  let used = 0;
  for (const [id, , line] of ranked) {
    if (!(id in rows) && line === null) continue;
    let chunk = line ?? renderItem(delivered.length + 1, rows[id], p.itemChars, ownerLabel);
    let cost = estimateTokens(chunk);
    if (used + cost > p.packetTokens) {
      if (delivered.length) break;
      chunk = clip(chunk, p.packetTokens);
      cost = estimateTokens(chunk);
    }
    delivered.push(id);
    chunks.push(chunk);
    used += cost;
    if (delivered.length === p.packetItems) break;
  }
  return [delivered, chunks];
}

export function renderEntry(row: Row, links: Row[], blobs: Row[] = [], ownerLabel = "the owner"): string {
  row = redactEntry(row, ownerLabel);
  const out = [
    `${row.id}: ${row.title}`,
    `pattern ${row.pattern} · ${row.authority} · ${row.scope} · valid from ${row.valid_from} · project ${row.project}`,
    `kind ${row.kind ?? "observation"} · confidence ${Number(row.confidence ?? 0).toFixed(2)}${row.verified === false ? " · unverified" : ""}`,
    ...(row.provenance ? [`provenance ${row.provenance}`] : []),
    "",
    row.body,
  ];
  if (row.evidence) {
    const who = row.evidence_kind === "quote" ? ownerLabel : row.evidence_kind;
    out.push("", `Evidence (${who}): “${row.evidence}”`);
  }
  out.push("", `Source: ${row.source_title} ${row.source_uri ?? ""}`.trimEnd());
  if (row.superseded_by) out.push(`Replaced by: ${row.superseded_by}`);
  if (links.length) out.push("", "Links:", ...links.map((l) => `- ${l.dir} ${l.type} ${l.other}: ${l.title}`));
  if (blobs.length && row.sensitivity === "private") {
    out.push("", `Blobs: ${blobs.length}, private. Ask ${ownerLabel}.`);
  } else if (blobs.length) {
    out.push(
      "",
      "Blobs. Open one with get_blob(sha256):",
      ...blobs.map((b) => `- ${b.name}: ${b.sha256} · ${b.kind} · ${b.media_type} · ${b.size} bytes`),
    );
  }
  return out.join("\n");
}
