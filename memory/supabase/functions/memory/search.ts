// Retrieval arms. Every arm reads the same store and returns the same packet shape; only ranking differs.
import { config } from "./config.ts";
import { type Row, type Sql, timing } from "./db.ts";
import { embed, toPgvector } from "./embed.ts";
import { type Params, SPREAD, spreadKnobs } from "./params.ts";
import {
  type AgentScope,
  canReadEntry,
  type EntryFilter,
  type EntryMeta,
  entryWhereSql,
  entryWhereStartSql,
  hasFilter,
} from "./permissions.ts";

export type Ranked = [id: string, score: number, line: string | null];
/** Each ranker's own list, by name, for the features a recall logs. A ranker with no score of its own gives null. */
export type Trace = Record<string, [id: string, score: number | null][]>;
/** Best-first spreading's continuation (R44): the nodes the initial spread stopped at, each with the path strength it
 * reached them with, strongest first, at most SPREAD.frontierCap. recall logs it in retrieval.context.frontier. */
export type Frontier = [id: string, strength: number][];
export type ArmResult = [Ranked[], string | null, Trace, Frontier?];
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

// ---------------------------------------------------------------- scope: a recall's own run leads, and no run is hidden
// No arm leaves an entry out for its scope. A recall that names a run:<id> scope boosts that run's entries.

const byScore = (a: Ranked, b: Ranked) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/** Multiply the scores of entries in the asked-for scope by the set's scopeBoost and re-sort, so a run's notes lead. */
export function boost(scores: Ranked[], ids: Set<string>, factor: number): Ranked[] {
  return scores.map(([id, s, line]): Ranked => [id, ids.has(id) ? s * factor : s, line]).sort(byScore);
}

/** What the discount needs to know of a candidate. */
export type Scoped = { scope: string; authority: string };

/** Discount the scores of other runs' notes (scope run:<x>, not the recall's own) by otherRunFactor, and of drafts in a
 * non-run scope by globalAgentDraftFactor. Both are 1 when a set doesn't carry them. Nothing is dropped, only ranked lower. */
export function discount(scores: Ranked[], info: Map<string, Scoped>, scope: string | null, p: Params): Ranked[] {
  const run = p.otherRunFactor ?? 1, draft = p.globalAgentDraftFactor ?? 1;
  if (run === 1 && draft === 1) return scores;
  return scores.map(([id, s, line]): Ranked => {
    const e = info.get(id);
    if (!e) return [id, s, line];
    const inRun = e.scope.startsWith("run:");
    const f = inRun ? (e.scope !== scope ? run : 1) : e.authority === "draft" ? draft : 1;
    return [id, s * f, line];
  }).sort(byScore);
}

// ---------------------------------------------------------------- index: grep the index map
/** The INDEX.md map, one line per entry, superseded entries struck through, as build.py writes it. */
export async function indexLines(db: Sql, agentScope: AgentScope = null, filter?: EntryFilter) {
  const rows = await db`select e.id, e.title, e.authority, e.scope, e.sensitivity, e.pattern, e.kind, e.confidence, e.verified,
      e.category, e.context, e.transferability, e.project_slug, e.computer,
      p.title as project_title,
      (select string_agg(l.src, ', ' order by l.src)
        from memory.link l join memory.entry s2 on s2.owner_id = l.owner_id and s2.id = l.src
        where l.owner_id = e.owner_id and l.dst = e.id and l.type = 'supersedes' ${entryWhereSql(db, "s2", agentScope)}) as superseded_by
    from memory.entry e left join memory.entry p on p.owner_id = e.owner_id and p.id = e.project
    where e.pattern <> 'projects' ${entryWhereSql(db, "e", agentScope, filter)}
    order by e.project, e.pattern, e.id`;
  return rows.filter((r) => canReadEntry(agentScope, r, filter)).map((r) => {
    const title = r.superseded_by ? `~~${r.title}~~ → ${r.superseded_by}` : r.title;
    const lock = r.sensitivity === "private" ? " 🔒" : "";
    // Ranking reads `line`, as it was before kinds. `shown` is what the packet prints: kind, confidence, and a draft marked unreviewed.
    const line = `- \`${r.id}\` ${title} [${r.authority}, ${r.scope}]${lock} (${r.project_title})`;
    return {
      id: r.id as string,
      line,
      shown: `- \`${r.id}\` ${title} [${kindLabel(r, ", ")}, ${r.authority}${r.authority === "draft" ? ", unreviewed" : ""}, ${r.scope}]${lock} (${r.project_title})`,
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
export async function indexSearch(
  db: Sql,
  query: string,
  scope: string | null,
  p: Params,
  agentScope: AgentScope = null,
  filter?: EntryFilter,
): Promise<ArmResult> {
  const q = tokens(query);
  const hits: Ranked[] = [], scoped = new Set<string>(), info = new Map<string, Scoped>();
  for (const l of await indexLines(db, agentScope, filter)) {
    const words = tokens(l.line + " " + l.id.replaceAll("-", " "));
    let hit = 0;
    for (const t of q) if (words.has(t)) hit++;
    if (hit) {
      hits.push([l.id, hit * (l.authority === "draft" ? p.indexDraftFactor : 1), l.shown]);
      info.set(l.id, { scope: l.scope, authority: l.authority });
      if (scope && l.scope === scope && !l.superseded) scoped.add(l.id);
    }
  }
  const ranked = discount(boost(hits, scoped, p.scopeBoost), info, scope, p).slice(0, p.candidates);
  return [ranked, null, { index: scored(ranked) }];
}

// ---------------------------------------------------------------- hybrid: keyword plus vector search
async function englishRanks(db: Sql, query: string, limit: number, agentScope: AgentScope = null, filter?: EntryFilter): Promise<string[]> {
  // plainto_tsquery ANDs every term, which a natural-language question rarely satisfies. OR them instead.
  const rows = await db`select e.id, ts_rank_cd(e.tsv_en, t.q) as score from memory.entry_current e
    cross join (select nullif(replace(plainto_tsquery('english', ${query})::text, ' & ', ' | '), '')::tsquery as q) t
    where t.q is not null and e.tsv_en @@ t.q ${entryWhereSql(db, "e", agentScope, filter)}
    order by score desc, e.id limit ${limit}`;
  return rows.map((r) => r.id);
}

/** PGroonga over search_text, indexed as bigrams. The query's 中文 bigrams are OR'ed, the way the English ranker ORs
 * its terms. pgroonga_score only counts when the index runs, so the scan is forced onto it. */
async function chineseRanks(db: Sql, query: string, limit: number, agentScope: AgentScope = null, filter?: EntryFilter): Promise<string[]> {
  const terms = [...new Set(bigrams(query))];
  if (!terms.length) return [];
  const run = async (tx: Sql) => {
    await tx`set local enable_seqscan = off`;
    const rows = await tx`select e.id, extensions.pgroonga_score(e.tableoid, e.ctid) as score from memory.entry e
      where e.search_text operator(extensions.&@~) ${terms.join(" OR ")}
        and not exists (select 1 from memory.link l where l.owner_id = e.owner_id and l.dst = e.id and l.type = 'supersedes')
        ${entryWhereSql(tx, "e", agentScope, filter)}
      order by score desc, e.id limit ${limit}`;
    // A request is one transaction (R49), so the setting is put back rather than left for the rest of it.
    await tx`set local enable_seqscan = on`;
    return rows;
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

async function vectorRanks(db: Sql, query: string, limit: number, agentScope: AgentScope = null, filter?: EntryFilter): Promise<[string[], string | null]> {
  let vec: number[];
  try {
    vec = await queryVector(query);
  } catch (e) { // OpenAI down, no key or over budget: keyword ranks still answer.
    return [[], `embed-failed: ${(e as Error).name}`];
  }
  // R49: an exact scan of the owner's own vectors, halfvec(1024) stored inline, found through entry_embedding's
  // (owner_id, entry_id) key; row-level security keeps it to the owner. The nearest 4 x limit are ranked on the vectors
  // alone, then only those few meet their entries: replaced ones and any the agent's scope excludes leave. Server-Timing's
  // vector entry says how long it took.
  const started = performance.now();
  const rows = await db`with near as (
      select x.owner_id, x.entry_id as id, x.embedding <=> ${toPgvector(vec)}::extensions.halfvec as d from memory.entry_embedding x
      order by d limit ${limit * 4})
    select n.id from near n join memory.entry_current e on e.owner_id = n.owner_id and e.id = n.id
      ${entryWhereStartSql(db, "e", agentScope, filter)}
    order by n.d limit ${limit}`;
  timing(`vector;dur=${(performance.now() - started).toFixed(2)}`);
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
export async function hybridComponents(db: Sql, query: string, p: Params, agentScope: AgentScope = null, filter?: EntryFilter) {
  const [vec, degraded] = await vectorRanks(db, query, p.candidates, agentScope, filter);
  const en = await englishRanks(db, query, p.candidates, agentScope, filter);
  let zh: string[] = [], keyword = en;
  if (CJK.test(query)) {
    zh = await chineseRanks(db, query, p.candidates, agentScope, filter);
    keyword = rrf([en, zh], undefined, p.rrfK).map(([id]) => id);
  }
  return { parts: { en, zh, keyword, vec }, degraded };
}

export async function hybridSearch(
  db: Sql,
  query: string,
  scope: string | null,
  p: Params,
  agentScope: AgentScope = null,
  filter?: EntryFilter,
): Promise<ArmResult> {
  const { parts, degraded } = await hybridComponents(db, query, p, agentScope, filter);
  let fused = rrf([parts.keyword, parts.vec], [1, p.vecWeight], p.rrfK).map(([id, s]): Ranked => [id, s, null]);
  if (scope && fused.length) {
    const rows = await db`select id from memory.entry where id = any(${fused.map(([id]) => id)}::text[]) and scope = ${scope}`;
    fused = boost(fused, new Set(rows.map((r) => r.id)), p.scopeBoost);
  }
  if (fused.length && ((p.otherRunFactor ?? 1) !== 1 || (p.globalAgentDraftFactor ?? 1) !== 1)) {
    const rows = await db`select id, scope, authority from memory.entry where id = any(${fused.map(([id]) => id)}::text[])`;
    fused = discount(fused, new Map(rows.map((r) => [r.id as string, { scope: r.scope as string, authority: r.authority as string }])), scope, p);
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
  links: Row[]; superseded: Set<string>; at: number;
  nodes: Map<string, EntryMeta>;
  /** The edges under one set's link type weights, built once per distinct weights. */
  edges: Map<string, Edges>;
};
const graphCaches = new Map<string, Graph>();

/** Drop cached links (for one owner, or all owners when omitted), so the next ranking reads them fresh. */
export const forgetGraph = (owner?: string | null) => {
  if (owner) graphCaches.delete(owner);
  else graphCaches.clear();
};

/** How many sessions must co-use a pair before its co_used link ranks (R43). */
export const CO_USE_SESSIONS = 2;

/** The links, cached per owner per isolate for a minute. A co_used link counts only once CO_USE_SESSIONS sessions have co-used the pair. */
async function graph(db: Sql): Promise<Graph> {
  const [{ o }] = await db`select coalesce(memory.owner_default()::text, '') as o`;
  const ownerKey = o || "default";
  const hit = graphCaches.get(ownerKey);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  const links = await db`select l.src, l.dst, l.type, coalesce(l.weight, 1) as weight,
         s.pattern as sp, s.scope as ss, s.category as sc, s.context as sctx, s.transferability as str, s.project_slug as sps, s.computer as scomp,
         d.pattern as dp, d.scope as ds, d.category as dc, d.context as dctx, d.transferability as dtr, d.project_slug as dps, d.computer as dcomp
       from memory.link l join memory.entry s on s.owner_id = l.owner_id and s.id = l.src join memory.entry d on d.owner_id = l.owner_id and d.id = l.dst
       where l.owner_id = memory.owner_default()
         and (l.type <> 'co_used' or exists (select 1 from memory.co_use c
           where c.owner_id = l.owner_id and c.src = l.src and c.dst = l.dst and cardinality(c.sessions) >= ${CO_USE_SESSIONS}))`;
  const nodes = new Map<string, EntryMeta>();
  for (const l of links) {
    if (!nodes.has(l.src)) {
      nodes.set(l.src, { pattern: l.sp, scope: l.ss, category: l.sc, context: l.sctx, transferability: l.str, project_slug: l.sps, computer: l.scomp });
    }
    if (!nodes.has(l.dst)) {
      nodes.set(l.dst, { pattern: l.dp, scope: l.ds, category: l.dc, context: l.dctx, transferability: l.dtr, project_slug: l.dps, computer: l.dcomp });
    }
  }
  const fresh: Graph = {
    links: [...links], at: Date.now(), edges: new Map(), nodes,
    superseded: new Set(links.filter((l) => l.type === "supersedes").map((l) => l.dst as string)),
  };
  for (const [k, old] of graphCaches) if (Date.now() - old.at >= 60_000) graphCaches.delete(k);
  graphCaches.set(ownerKey, fresh);
  return fresh;
}

/** A link's type weight under a set: its exact "src_pattern|type|dst_pattern" key, else the type's "*|type|*" key, else 1. A
 * co_used link (R43) is 0 unless the set names it, so the sets from before co-use rank as they always did. */
export function linkTypeWeight(typeWeights: Params["linkTypeWeights"], sp: string, type: string, dp: string): number {
  return typeWeights[`${sp}|${type}|${dp}`] ?? typeWeights[`*|${type}|*`] ?? (type === "co_used" ? 0 : 1);
}

/** Every edge with its weight under these link type weights. An edge of weight 0 is left out. */
function edgesUnder(g: Graph, typeWeights: Params["linkTypeWeights"]): Edges {
  const key = JSON.stringify(typeWeights);
  const hit = g.edges.get(key);
  if (hit) return hit;
  const out: Edges = new Map();
  const add = (a: string, b: string, w: number) => { if (!out.has(a)) out.set(a, []); out.get(a)!.push([b, w]); };
  for (const l of g.links) {
    const w = linkTypeWeight(typeWeights, l.sp, l.type, l.dp) * l.weight;
    if (!(w > 0)) continue;
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

// ---- best-first (R44): `spreadMode: "bestfirst"`
// Seeds are the same ones PPR uses plus exact 2- and 3-word phrases of the query found in a title or body. A seed's strength is
// its score over the best seed's, so the top seed is 1 and every phrase seed is at least as strong as any keyword seed. A priority
// queue then expands the strongest path first: a path's strength is its seed's strength times, along its links, the link's weight
// and its link type's weight. It stops at maxHops links or when a path falls below minPath, so something strongly connected but far
// beats something weakly connected and near. What it stopped at is the frontier, for a later recall_more to continue from.

/** The query's runs of 2 and 3 words in order, as case-insensitive patterns that match the words whole and whitespace-separated. */
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

/** Entries whose title or body holds one of the query's phrases, titles first. */
async function phraseHits(db: Sql, query: string, p: Params, agentScope: AgentScope = null, filter?: EntryFilter): Promise<string[]> {
  const patterns = phrasePatterns(query, p.candidates * 2);
  if (!patterns.length) return [];
  const rows = await db`select e.id from memory.entry_current e
    where (e.title ~* any(${patterns}::text[]) or e.body ~* any(${patterns}::text[]))
      ${entryWhereSql(db, "e", agentScope, filter)}
    order by (e.title ~* any(${patterns}::text[])) desc, e.id limit ${p.candidates}`;
  return rows.map((r) => r.id);
}

/** The seeds every spreading mode starts from: hybrid's top candidates. Under bestfirst, entries holding a phrase of the query
 * join them at the best seed's score, so a phrase seed is never weaker than a keyword or vector one. */
async function spreadSeeds(
  db: Sql,
  query: string,
  scope: string | null,
  p: Params,
  agentScope: AgentScope = null,
  filter?: EntryFilter,
): Promise<ArmResult> {
  const [ranked, degraded, trace] = await hybridSearch(db, query, scope, p, agentScope, filter);
  if (spreadKnobs(p).mode !== "bestfirst") return [ranked, degraded, trace];
  const hits = await phraseHits(db, query, p, agentScope, filter);
  if (!hits.length) return [ranked, degraded, trace];
  const top = ranked.reduce((a, [, s]) => Math.max(a, s), 0) || 1;
  const seeds = new Map(ranked.map(([id, s]) => [id, s]));
  for (const id of hits) seeds.set(id, Math.max(seeds.get(id) ?? 0, top));
  const merged = [...seeds].map(([id, s]): Ranked => [id, s, null]).sort(byScore);
  return [merged, degraded, { ...trace, phrase: unscored(hits) }];
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

/** Expand best-first from `seeds` (id → strength). Returns the best path strength of every node reached, seeds included, and the
 * frontier: nodes held at maxHops, and nodes a link reached below minPath, which a later pass with looser limits can expand.
 * A node keeps its strongest path, even when a weaker one would have more hops left. */
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

function permittedEdges(out: Edges, g: Graph, agentScope: AgentScope, filter?: EntryFilter): Edges {
  if (!agentScope && !hasFilter(filter)) return out;
  const allowed = (id: string) => {
    const meta = g.nodes.get(id);
    return meta ? canReadEntry(agentScope, meta, filter) : true;
  };
  const filtered: Edges = new Map();
  for (const [src, list] of out) {
    if (!allowed(src)) continue;
    const kept = list.filter(([dst]) => allowed(dst));
    if (kept.length) filtered.set(src, kept);
  }
  return filtered;
}

/** The hook for recall_more: pick the same queue up from a recall's logged frontier, with limits of the caller's choosing (the
 * set's, when it names none). Gives every node reached with its path strength, frontier nodes included; the caller keeps the
 * ones it hasn't delivered. */
export async function spreadMore(
  db: Sql,
  frontier: Frontier,
  p: Params,
  limits: { maxHops?: number; minPath?: number } = {},
  agentScope: AgentScope = null,
  filter?: EntryFilter,
) {
  const k = spreadKnobs(p);
  const g = await graph(db);
  const out = permittedEdges(edgesUnder(g, p.linkTypeWeights), g, agentScope, filter);
  const allowedFrontier = (!agentScope && !hasFilter(filter))
    ? frontier
    : frontier.filter(([id]) => {
      const m = g.nodes.get(id);
      return m ? canReadEntry(agentScope, m, filter) : true;
    });
  return bestFirst(out, new Map(allowedFrontier), limits.maxHops ?? k.maxHops,
    limits.minPath ?? k.minPath, SPREAD.frontierCap);
}

/** Seed score plus wPath × best path strength, replaced entries discounted like PPR's. */
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

export async function spreadingSearch(
  db: Sql,
  query: string,
  scope: string | null,
  p: Params,
  agentScope: AgentScope = null,
  filter?: EntryFilter,
): Promise<ArmResult> {
  const [seedsRanked, degraded, seedTrace] = await spreadSeeds(db, query, scope, p, agentScope, filter);
  const g = await graph(db);
  const out = permittedEdges(edgesUnder(g, p.linkTypeWeights), g, agentScope, filter);
  if (spreadKnobs(p).mode === "bestfirst") {
    const [ranked, frontier] = bestFirstRanked(out, seedsRanked, g.superseded, p);
    return [ranked, degraded, { ...seedTrace, spreading: scored(ranked) }, frontier];
  }
  const activation = spread(out, new Map(seedsRanked.map(([id, s]) => [id, s])), p.restart, p.iterations);
  const ranked = [...activation]
    .map(([id, a]): Ranked => [id, g.superseded.has(id) ? a * p.supersededFactor : a, null])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, p.candidates);
  return [ranked, degraded, { ...seedTrace, spreading: scored(ranked) }];
}

export const ARMS: Record<string, (
  db: Sql,
  query: string,
  scope: string | null,
  p: Params,
  agentScope?: AgentScope,
  filter?: EntryFilter,
) => Promise<ArmResult>> = {
  index: indexSearch,
  hybrid: hybridSearch,
  spreading: spreadingSearch,
};

// ---------------------------------------------------------------- packing
export async function fetchEntries(db: Sql, ids: string[], agentScope: AgentScope = null): Promise<Record<string, Row>> {
  if (!ids.length) return {};
  const rows = await db`select e.*, s.title as source_title, s.uri as source_uri,
      (select string_agg(l.src, ', ' order by l.src)
        from memory.link l join memory.entry s2 on s2.owner_id = l.owner_id and s2.id = l.src
        where l.owner_id = e.owner_id and l.dst = e.id and l.type = 'supersedes' ${entryWhereSql(db, "s2", agentScope)}) as superseded_by,
      (select jsonb_agg(jsonb_build_object('name', x.name, 'kind', x.kind, 'size', b.size) order by x.name)
        from memory.entry_blob x join memory.blob b on b.owner_id = x.owner_id and b.sha256 = x.sha256
        where x.owner_id = e.owner_id and x.entry_id = e.id) as artifacts
    from memory.entry e left join memory.source s on s.owner_id = e.owner_id and s.id = e.source_id where e.id = any(${ids}::text[])`;
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

/** Private entries never leave the server unredacted: the agent sees the title and the id only. */
export function redact(row: Row): Row {
  return row.sensitivity !== "private" ? row : { ...row, body: "[private entry: ask Wen]", evidence: "", artifacts: null };
}

/** What a note claims and how far it is trusted: "fact", "observation unverified" with a failed check, joined to the
 * confidence by `sep`. */
export function kindLabel(row: Row, sep: string) {
  return `${row.kind ?? "observation"}${row.verified === false ? sep === ", " ? " unverified" : " · unverified" : ""}${sep}${
    Number(row.confidence ?? 0).toFixed(2)}`;
}

/** A size for a packet line: 800 B, 5.0 KB, 1.2 MB. */
export function sizeLabel(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** An item's artifacts as "Artifacts: plan.md (document, 5.0 KB), shot.png (image, 1.2 MB)": names and kinds, never content. */
export function artifactsLine(row: Row) {
  const list: { name: string; kind: string; size: number }[] = row.artifacts ?? [];
  return list.length ? `Artifacts: ${list.map((a) => `${a.name} (${a.kind}, ${sizeLabel(a.size)})`).join(", ")}` : "";
}

export const MORE = "… more in get_entry";

export function renderItem(n: number, row: Row, itemChars?: number) {
  row = redact(row);
  // A draft is a note nobody has reviewed. It's served all the same.
  let meta = `    ${kindLabel(row, " · confidence ")} · ${row.authority}${row.authority === "draft" ? " · unreviewed" : ""} · ${row.scope} · ${row.valid_from}`;
  if (row.superseded_by) meta += ` · replaced by ${row.superseded_by}`;
  const body = itemChars && String(row.body).length > itemChars ? `${String(row.body).slice(0, itemChars)}${MORE}` : row.body;
  // R41: where the note came from, in the line provenance.ts worded. A note with no record of it has no line.
  const parts = [`[${n}] ${row.id}: ${row.title}`, meta, ...(row.provenance ? [`    ${row.provenance}`] : []), `    ${body}`];
  if (row.evidence && row.evidence_kind === "quote") parts.push(`    Wen: “${row.evidence}”`);
  const artifacts = artifactsLine(row);
  if (artifacts) parts.push(`    ${artifacts}`);
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
    let chunk = line ?? renderItem(delivered.length + 1, rows[id], p.itemChars);
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
    `kind ${row.kind ?? "observation"} · confidence ${Number(row.confidence ?? 0).toFixed(2)}${row.verified === false ? " · unverified" : ""}`,
    ...(row.provenance ? [`provenance ${row.provenance}`] : []), "", row.body];
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
      ...blobs.map((b) => `- ${b.name}: ${b.sha256} · ${b.kind} · ${b.media_type} · ${b.size} bytes`));
  }
  return out.join("\n");
}
