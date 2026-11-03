// Retrieval arms. Every arm reads the same store and returns the same packet shape; only ranking differs.
import { config } from "./config.ts";
import { type Row, type Sql } from "./db.ts";
import { embed, toPgvector } from "./embed.ts";
import type { Params } from "./params.ts";

export type Ranked = [id: string, score: number, line: string | null];
/** Each ranker's own list, by name, for the features a recall logs. A ranker with no score of its own gives null. */
export type Trace = Record<string, [id: string, score: number | null][]>;
export type ArmResult = [Ranked[], string | null, Trace];
const scored = (ranked: Ranked[]): Trace[string] => ranked.map(([id, score]) => [id, score]);
const unscored = (ids: string[]): Trace[string] => ids.map((id) => [id, null]);

const CJK = /[㐀-鿿豈-﫿]/;
const CJK_RUNS = /[㐀-鿿豈-﫿]+/g;
const WORD = /[a-z0-9][a-z0-9.+-]*/g;
const STOP = new Set(("a an and are as at be but by can do does for from how i if in is it its me my of on or so that the " +
  "this to use using was we what when where which who why will with you your").split(" "));

/** Overlapping 中文 bigrams, a lone character as itself. The migration's cjk_bigrams indexes the same way. */
export function bigrams(text: string): string[] {
  const out: string[] = [];
  for (const run of text.match(CJK_RUNS) ?? []) {
    const chars = [...run];
    if (chars.length === 1) out.push(run);
    else for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  }
  return out;
}

/** Lowercase words plus 中文 bigrams, for the index arm's grep. */
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

export function estimateTokens(text: string) {
  const cjk = (text.match(new RegExp(CJK, "g")) ?? []).length;
  return cjk + Math.floor((text.length - cjk) / 4);
}

// ---------------------------------------------------------------- scope: a run's entries reach only that run's recalls
/** Leave out run: entries unless they're in the asked-for scope. Every arm's SQL takes this. */
function scopeFilter(db: Sql, scope: string | null, alias = "") {
  return db`(${db.unsafe(alias)}scope not like 'run:%' or ${db.unsafe(alias)}scope = ${scope})`;
}

const byScore = (a: Ranked, b: Ranked) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/** Multiply the scores of entries in the asked-for scope by the set's scopeBoost and re-sort, so a run's notes lead. */
export function boost(scores: Ranked[], ids: Set<string>, factor: number): Ranked[] {
  return scores.map(([id, s, line]): Ranked => [id, ids.has(id) ? s * factor : s, line]).sort(byScore);
}

// ---------------------------------------------------------------- index: grep the index map
/** The INDEX.md map, one line per entry, superseded entries struck through, as build.py writes it. */
export async function indexLines(db: Sql, scope: string | null = null) {
  const rows = await db`select e.id, e.title, e.authority, e.scope, e.sensitivity, e.pattern, p.title as project_title,
      (select string_agg(l.src, ', ' order by l.src) from memory.link l where l.dst = e.id and l.type = 'supersedes') as superseded_by
    from memory.entry e left join memory.entry p on p.id = e.project
    where e.pattern <> 'projects' and ${scopeFilter(db, scope, "e.")}
    order by e.project, e.pattern, e.id`;
  return rows.map((r) => {
    const title = r.superseded_by ? `~~${r.title}~~ → ${r.superseded_by}` : r.title;
    const lock = r.sensitivity === "private" ? " 🔒" : "";
    return {
      id: r.id as string,
      line: `- \`${r.id}\` ${title} [${r.authority}, ${r.scope}]${lock} (${r.project_title})`,
      authority: r.authority as string,
      scope: r.scope as string,
      superseded: Boolean(r.superseded_by),
    };
  });
}

/** grep over the index map. Drafts rank at half weight, so a confirmed decision beats a suggestion on a tie.
 *
 * A superseded line stays, struck through, but gets no scope boost. Its line names its replacement, so it matches
 * every word the replacement does and would otherwise outrank it. */
export async function indexSearch(db: Sql, query: string, scope: string | null, p: Params): Promise<ArmResult> {
  const q = tokens(query);
  const hits: Ranked[] = [], scoped = new Set<string>();
  for (const l of await indexLines(db, scope)) {
    const words = tokens(l.line + " " + l.id.replaceAll("-", " "));
    let hit = 0;
    for (const t of q) if (words.has(t)) hit++;
    if (hit) {
      hits.push([l.id, hit * (l.authority === "draft" ? p.indexDraftFactor : 1), l.line]);
      if (scope && l.scope === scope && !l.superseded) scoped.add(l.id);
    }
  }
  const ranked = boost(hits, scoped, p.scopeBoost).slice(0, p.candidates);
  return [ranked, null, { index: scored(ranked) }];
}

// ---------------------------------------------------------------- hybrid: keyword plus vector search
async function englishRanks(db: Sql, query: string, scope: string | null, limit: number): Promise<string[]> {
  // plainto_tsquery ANDs every term, which a natural-language question rarely satisfies. OR them instead.
  const rows = await db`select id, ts_rank_cd(tsv_en, t.q) as score from memory.entry_current
    cross join (select nullif(replace(plainto_tsquery('english', ${query})::text, ' & ', ' | '), '')::tsquery as q) t
    where t.q is not null and tsv_en @@ t.q and ${scopeFilter(db, scope)}
    order by score desc, id limit ${limit}`;
  return rows.map((r) => r.id);
}

/** PGroonga over search_text, indexed as bigrams. The query's 中文 bigrams are OR'ed, the way the English ranker ORs
 * its terms. pgroonga_score only counts when the index runs, so the scan is forced onto it. */
async function chineseRanks(db: Sql, query: string, scope: string | null, limit: number): Promise<string[]> {
  const terms = [...new Set(bigrams(query))];
  if (!terms.length) return [];
  const run = async (tx: Sql) => {
    await tx`set local enable_seqscan = off`;
    return await tx`select e.id, extensions.pgroonga_score(e.tableoid, e.ctid) as score from memory.entry e
      where e.search_text operator(extensions.&@~) ${terms.join(" OR ")}
        and not exists (select 1 from memory.link l where l.dst = e.id and l.type = 'supersedes')
        and ${scopeFilter(tx, scope, "e.")}
      order by score desc, e.id limit ${limit}`;
  };
  const rows = "begin" in db ? await (db as any).begin(run) : await run(db);
  return rows.map((r: Row) => r.id);
}

const queryVectors = new Map<string, number[]>();

/** Keep the last 512 query vectors per isolate, so a repeated query costs no API call. */
async function queryVector(query: string) {
  const key = `${config.embedModel}\n${query}`;
  if (!queryVectors.has(key)) {
    if (queryVectors.size >= 512) queryVectors.delete(queryVectors.keys().next().value!);
    queryVectors.set(key, (await embed([query]))[0]);
  }
  return queryVectors.get(key)!;
}

async function vectorRanks(db: Sql, query: string, scope: string | null, limit: number): Promise<[string[], string | null]> {
  let vec: number[];
  try {
    vec = await queryVector(query);
  } catch (e) { // OpenAI down, no key or over budget: keyword ranks still answer.
    return [[], `embed-failed: ${(e as Error).name}`];
  }
  // The HNSW scan stops at hnsw.ef_search (40) candidates, and the scope and superseded filters run after it. When run
  // notes crowd those 40, few or none survive. An iterative scan keeps going until the limit is met. pgvector 0.8+.
  const run = async (tx: Sql) => {
    await tx`set local hnsw.iterative_scan = strict_order`;
    return await tx`select x.entry_id as id from memory.entry_embedding x join memory.entry_current e on e.id = x.entry_id
      where ${scopeFilter(tx, scope, "e.")}
      order by x.embedding <=> ${toPgvector(vec)}::extensions.vector limit ${limit}`;
  };
  const rows = "begin" in db ? await (db as any).begin(run) : await run(db);
  return [rows.map((r: Row) => r.id), null];
}

export function rrf(rankings: string[][], weights: number[] | undefined, k: number): [string, number][] {
  const score = new Map<string, number>();
  rankings.forEach((ranking, i) => {
    const w = weights?.[i] ?? 1;
    ranking.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + w / (k + rank + 1)));
  });
  return [...score].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Each ranker's list on its own, so an eval can tell which one lost an entry. The 中文 ranker only runs on queries
 * with 中文 in them, so English keyword evidence never counts twice. */
export async function hybridComponents(db: Sql, query: string, scope: string | null, p: Params) {
  const [vec, degraded] = await vectorRanks(db, query, scope, p.candidates);
  const en = await englishRanks(db, query, scope, p.candidates);
  let zh: string[] = [], keyword = en;
  if (CJK.test(query)) {
    zh = await chineseRanks(db, query, scope, p.candidates);
    keyword = rrf([en, zh], undefined, p.rrfK).map(([id]) => id);
  }
  return { parts: { en, zh, keyword, vec }, degraded };
}

export async function hybridSearch(db: Sql, query: string, scope: string | null, p: Params): Promise<ArmResult> {
  const { parts, degraded } = await hybridComponents(db, query, scope, p);
  let fused = rrf([parts.keyword, parts.vec], [1, p.vecWeight], p.rrfK).map(([id, s]): Ranked => [id, s, null]);
  if (scope && fused.length) {
    const rows = await db`select id from memory.entry where id = any(${fused.map(([id]) => id)}::text[]) and scope = ${scope}`;
    fused = boost(fused, new Set(rows.map((r) => r.id)), p.scopeBoost);
  }
  const ranked = fused.slice(0, p.candidates);
  return [ranked, degraded, { hybrid: scored(ranked), keyword: unscored(parts.keyword), vec: unscored(parts.vec) }];
}

// ---------------------------------------------------------------- spreading: Wen's design
// Seeds are hybrid's top candidates. Activation spreads from them by personalized PageRank over typed links: each edge carries
// its link type's weight (the set's linkTypeWeights, set by the ants on train) times its own learned weight (link.weight, moved
// by the learner). A supersedes link carries activation from the old entry to its replacement only, so a query that
// matches an outdated note reaches what replaced it. Replaced entries keep supersededFactor of what they gather.
type Edges = Map<string, [string, number][]>;
type Graph = {
  links: Row[]; scope: Map<string, string>; superseded: Set<string>; at: number;
  /** The edges under one set's link type weights, built once per distinct weights. */
  edges: Map<string, Edges>;
};
let graphCache: Graph | null = null;

/** The links and scopes, cached per isolate for a minute. */
async function graph(db: Sql): Promise<Graph> {
  if (graphCache && Date.now() - graphCache.at < 60_000) return graphCache;
  const [links, entries] = await Promise.all([
    db`select l.src, l.dst, l.type, coalesce(l.weight, 1) as weight, s.pattern as sp, d.pattern as dp
       from memory.link l join memory.entry s on s.id = l.src join memory.entry d on d.id = l.dst`,
    db`select id, scope from memory.entry`]);
  graphCache = {
    links: [...links], scope: new Map(entries.map((e) => [e.id, e.scope])), at: Date.now(), edges: new Map(),
    superseded: new Set(links.filter((l) => l.type === "supersedes").map((l) => l.dst as string)),
  };
  return graphCache;
}

/** Every edge with its weight under these link type weights. */
function edgesUnder(g: Graph, typeWeights: Params["linkTypeWeights"]): Edges {
  const key = JSON.stringify(typeWeights);
  const hit = g.edges.get(key);
  if (hit) return hit;
  const out: Edges = new Map();
  const add = (a: string, b: string, w: number) => { if (!out.has(a)) out.set(a, []); out.get(a)!.push([b, w]); };
  for (const l of g.links) {
    const w = (typeWeights[`${l.sp}|${l.type}|${l.dp}`] ?? 1) * l.weight;
    if (l.type === "supersedes") {
      add(l.dst, l.src, w);  // old → new only
    } else {
      add(l.src, l.dst, w);
      add(l.dst, l.src, w);
    }
  }
  g.edges.set(key, out);
  return out;
}

/** Personalized PageRank from the seeds. Returns each reached entry's activation. */
export function spread(out: Edges, seeds: Map<string, number>, restart: number, iterations: number) {
  const total = [...seeds.values()].reduce((a, b) => a + b, 0) || 1;
  const p = new Map([...seeds].map(([id, s]) => [id, s / total]));
  let r = new Map(p);
  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>();
    for (const [id, v] of p) next.set(id, restart * v);
    for (const [id, v] of r) {
      const edges = out.get(id);
      if (!edges?.length) { next.set(id, (next.get(id) ?? 0) + (1 - restart) * v); continue; }
      const sum = edges.reduce((a, [, w]) => a + w, 0);
      for (const [to, w] of edges) next.set(to, (next.get(to) ?? 0) + (1 - restart) * v * (w / sum));
    }
    r = next;
  }
  return r;
}

export async function spreadingSearch(db: Sql, query: string, scope: string | null, p: Params): Promise<ArmResult> {
  const [seedsRanked, degraded, seedTrace] = await hybridSearch(db, query, scope, p);
  const g = await graph(db);
  const activation = spread(edgesUnder(g, p.linkTypeWeights), new Map(seedsRanked.map(([id, s]) => [id, s])), p.restart, p.iterations);
  const visible = (id: string) => { const sc = g.scope.get(id) ?? ""; return !sc.startsWith("run:") || sc === scope; };
  const ranked = [...activation]
    .filter(([id]) => visible(id))
    .map(([id, a]): Ranked => [id, g.superseded.has(id) ? a * p.supersededFactor : a, null])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, p.candidates);
  return [ranked, degraded, { ...seedTrace, spreading: scored(ranked) }];
}

export const ARMS: Record<string, (db: Sql, query: string, scope: string | null, p: Params) => Promise<ArmResult>> = {
  index: indexSearch,
  hybrid: hybridSearch,
  spreading: spreadingSearch,
};

// ---------------------------------------------------------------- packing
export async function fetchEntries(db: Sql, ids: string[]): Promise<Record<string, Row>> {
  if (!ids.length) return {};
  const rows = await db`select e.*, s.title as source_title, s.uri as source_uri,
      (select string_agg(l.src, ', ' order by l.src) from memory.link l where l.dst = e.id and l.type = 'supersedes') as superseded_by
    from memory.entry e left join memory.source s on s.id = e.source_id where e.id = any(${ids}::text[])`;
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

/** Private entries never leave the server unredacted: the agent sees the title and the id only. */
export function redact(row: Row): Row {
  return row.sensitivity !== "private" ? row : { ...row, body: "[private entry: ask Wen]", evidence: "" };
}

export function renderItem(n: number, row: Row) {
  row = redact(row);
  let meta = `    ${row.authority} · ${row.scope} · ${row.valid_from}`;
  if (row.superseded_by) meta += ` · replaced by ${row.superseded_by}`;
  const parts = [`[${n}] ${row.id}: ${row.title}`, meta, `    ${row.body}`];
  if (row.evidence && row.evidence_kind === "quote") parts.push(`    Wen: “${row.evidence}”`);
  return parts.join("\n");
}

const CLIPPED = "\n    [Cut to fit the packet. get_entry has the rest.]";

/** The longest start of text that fits budget tokens with the cut marked. */
export function clip(text: string, budget: number) {
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (estimateTokens(text.slice(0, mid) + CLIPPED) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + CLIPPED;
}

/** Fill the packet in rank order up to the item and token budgets. The first item always goes in, cut to the budget
 * when it's bigger, so one huge entry can't fill an agent's context. */
export function pack(ranked: Ranked[], rows: Record<string, Row>, p: Params): [string[], string[]] {
  const delivered: string[] = [], chunks: string[] = [];
  let used = 0;
  for (const [id, , line] of ranked) {
    if (!(id in rows) && line === null) continue;
    let chunk = line ?? renderItem(delivered.length + 1, rows[id]);
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

export function renderEntry(row: Row, links: Row[], blobs: Row[] = []) {
  row = redact(row);
  const out = [`${row.id}: ${row.title}`,
    `pattern ${row.pattern} · ${row.authority} · ${row.scope} · valid from ${row.valid_from} · project ${row.project}`,
    "", row.body];
  if (row.evidence) {
    const who = row.evidence_kind === "quote" ? "Wen" : row.evidence_kind;
    out.push("", `Evidence (${who}): “${row.evidence}”`);
  }
  out.push("", `Source: ${row.source_title} ${row.source_uri ?? ""}`.trimEnd());
  if (row.superseded_by) out.push(`Replaced by: ${row.superseded_by}`);
  if (links.length) out.push("", "Links:", ...links.map((l) => `- ${l.dir} ${l.type} ${l.other}: ${l.title}`));
  if (blobs.length && row.sensitivity === "private") {
    // A name or sha256 can give away a private blob, since its content may be short enough to guess and hash.
    out.push("", `Blobs: ${blobs.length}, private. Ask Wen.`);
  } else if (blobs.length) {
    out.push("", "Blobs. Open one with get_blob(sha256):",
      ...blobs.map((b) => `- ${b.name}: ${b.sha256} · ${b.media_type} · ${b.size} bytes`));
  }
  return out.join("\n");
}
