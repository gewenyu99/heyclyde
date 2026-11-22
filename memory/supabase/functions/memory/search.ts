// Retrieval arms. Every arm reads the same store and returns the same packet shape; only ranking differs.
import { config } from "./config.ts";
import { type Row, type Sql, timing } from "./db.ts";
import { embed, toPgvector } from "./embed.ts";
import { type Params, SPREAD, spreadKnobs } from "./params.ts";
import type { Params as CoreParams } from "./core/params.ts";
import {
  type ArmResult,
  artifactsLine,
  bestFirst,
  bestFirstRanked as coreBestFirstRanked,
  bigrams,
  boost,
  byScore,
  clip,
  CO_USE_SESSIONS,
  discount as coreDiscount,
  type Edges,
  estimateTokens,
  type Frontier,
  hasCjk,
  kindLabel,
  linkTypeWeight,
  MORE,
  packEntries,
  phrasePatterns,
  type Ranked,
  redactEntry,
  renderEntry as coreRenderEntry,
  renderItem as coreRenderItem,
  rrf,
  type Scoped,
  scored,
  sizeLabel,
  spread,
  titlePatterns,
  tokens,
  type Trace,
  unscored,
} from "./core/ranking.ts";
import {
  type AgentScope,
  canReadEntry,
  type EntryFilter,
  type EntryMeta,
  entryWhereSql,
  entryWhereStartSql,
  hasFilter,
} from "./permissions.ts";

export type { ArmResult, Frontier, Ranked, Scoped, Trace };
export {
  artifactsLine,
  bestFirst,
  bigrams,
  boost,
  clip,
  CO_USE_SESSIONS,
  estimateTokens,
  kindLabel,
  linkTypeWeight,
  MORE,
  phrasePatterns,
  rrf,
  sizeLabel,
  spread,
  titlePatterns,
  tokens,
};

export function discount(scores: Ranked[], info: Map<string, Scoped>, scope: string | null, p: Params): Ranked[] {
  return coreDiscount(scores, info, scope, p as CoreParams);
}

export function bestFirstRanked(out: Edges, seeds: Ranked[], superseded: Set<string>, p: Params): [Ranked[], Frontier] {
  return coreBestFirstRanked(out, seeds, superseded, p as CoreParams);
}

/** Runtime project entries (`remember({ pattern: "projects", ... })`) are searchable notes; seed containers (`origin = 'seed'`,
 * like golden's `proj-tea`) and auto-generated `notes-<agent>` hubs stay hidden from index and deep scans. */
export function searchableProjectSql(db: Sql, alias = "e") {
  const col = (name: string) => db.unsafe(alias ? `${alias}.${name}` : name);
  return db`(${col("pattern")} <> 'projects' or (${col("origin")} <> 'seed' and ${col("id")} not like 'notes-%'))`;
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
    where ${searchableProjectSql(db, "e")} ${entryWhereSql(db, "e", agentScope, filter)}
    order by e.project, e.pattern, e.id`;
  return rows.filter((r) => canReadEntry(agentScope, r, filter)).map((r) => {
    const title = r.superseded_by ? `~~${r.title}~~ → ${r.superseded_by}` : r.title;
    const lock = r.sensitivity === "private" ? " 🔒" : "";
    // Ranking reads `line`, as it was before kinds. `shown` is what the packet prints: kind, confidence, and a draft marked unreviewed.
    const line = `- \`${r.id}\` ${title} [${r.authority}, ${r.scope}]${lock} (${r.project_title})`;
    return {
      id: r.id as string,
      title: r.title as string,
      line,
      shown: `- \`${r.id}\` ${title} [${kindLabel(r, ", ")}, ${r.authority}${r.authority === "draft" ? ", unreviewed" : ""}, ${r.scope}]${lock} (${r.project_title})`,
      authority: r.authority as string,
      scope: r.scope as string,
      superseded: Boolean(r.superseded_by),
    };
  });
}

/** grep over the index map. Drafts rank at half weight, so a confirmed decision beats a suggestion on a tie, unless 2+
 * non-stopword query words match the draft's own title.
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
  rawQuery?: string,
): Promise<ArmResult> {
  const q = tokens(query);
  const raw = tokens(rawQuery ?? query);
  const hasTask = rawQuery !== undefined && rawQuery !== query && raw.size > 0;
  const hits: Ranked[] = [], scoped = new Set<string>(), info = new Map<string, Scoped>();
  for (const l of await indexLines(db, agentScope, filter)) {
    const words = tokens(l.line + " " + l.id.replaceAll("-", " "));
    let hit = 0;
    for (const t of q) if (words.has(t)) hit += hasTask && raw.has(t) ? 2 : 1;
    if (hit) {
      let titleHit = 0;
      if (l.authority === "draft" && raw.size >= 2) {
        const tw = tokens(l.title);
        for (const t of raw) if (tw.has(t)) titleHit++;
      }
      const factor = l.authority === "draft" && !(!l.superseded && raw.size >= 2 && titleHit >= 2) ? p.indexDraftFactor : 1;
      hits.push([l.id, hit * factor, l.shown]);
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

// hybrid keyword, CJK bigram, and vector rankers live here while pure fusion lives in ./core/ranking.ts.

/** Each ranker's list on its own, so an eval can tell which one lost an entry. The 中文 ranker only runs on queries
 * with 中文 in them, so English keyword evidence never counts twice. */
export async function hybridComponents(db: Sql, query: string, p: Params, agentScope: AgentScope = null, filter?: EntryFilter) {
  const [vec, degraded] = await vectorRanks(db, query, p.candidates, agentScope, filter);
  const en = await englishRanks(db, query, p.candidates, agentScope, filter);
  let zh: string[] = [], keyword = en;
  if (hasCjk(query)) {
    zh = await chineseRanks(db, query, p.candidates, agentScope, filter);
    keyword = rrf([en, zh], undefined, p.rrfK).map(([id]) => id);
  }
  return { parts: { en, zh, keyword, vec }, degraded };
}

/** Entries whose title matches 2+ distinct non-stopword query terms or CJK bigrams, newest/unembedded first. */
async function titleMatches(
  db: Sql,
  query: string,
  limit: number,
  agentScope: AgentScope = null,
  filter?: EntryFilter,
): Promise<{ id: string; unembedded: boolean }[]> {
  const patterns = titlePatterns(query).slice(0, limit);
  if (patterns.length < 2) return [];
  const rows = await db`with pats as (select p from unnest(${patterns}::text[]) as p),
    hits as (
      select e.id, e.owner_id, e.chances_left, e.created_at, count(*)::int as n,
        not exists (select 1 from memory.entry_embedding x where x.owner_id = e.owner_id and x.entry_id = e.id) as unembedded
      from memory.entry_current e
      join pats on e.title ~* pats.p
      where ${searchableProjectSql(db, "e")}
        ${entryWhereSql(db, "e", agentScope, filter)}
      group by e.id, e.owner_id, e.chances_left, e.created_at
      having count(*) >= 2
    )
    select h.id, h.unembedded from hits h
    order by h.n desc, (h.n = ${patterns.length}) desc, h.unembedded desc, (h.chances_left > 0) desc, h.created_at desc, h.id
    limit ${limit}`;
  return rows.map((r) => ({ id: r.id as string, unembedded: Boolean(r.unembedded) }));
}

export async function hybridSearch(
  db: Sql,
  query: string,
  scope: string | null,
  p: Params,
  agentScope: AgentScope = null,
  filter?: EntryFilter,
  rawQuery?: string,
): Promise<ArmResult> {
  const { parts, degraded } = await hybridComponents(db, query, p, agentScope, filter);
  const titleHits = await titleMatches(db, rawQuery ?? query, p.candidates, agentScope, filter);
  const eligibleTitle = titleHits.filter((r) => (p.trialItems ?? 0) > 0 || r.unembedded).map((r) => r.id);
  const lists = eligibleTitle.length ? [parts.keyword, parts.vec, eligibleTitle] : [parts.keyword, parts.vec];
  const weights = eligibleTitle.length ? [1, p.vecWeight, 1 + p.vecWeight] : [1, p.vecWeight];
  let fused = rrf(lists, weights, p.rrfK).map(([id, s]): Ranked => [id, s, null]);
  if (scope && fused.length) {
    const rows = await db`select id from memory.entry where id = any(${fused.map(([id]) => id)}::text[]) and scope = ${scope}`;
    fused = boost(fused, new Set(rows.map((r) => r.id)), p.scopeBoost);
  }
  if (fused.length && ((p.otherRunFactor ?? 1) !== 1 || (p.globalAgentDraftFactor ?? 1) !== 1)) {
    const rows = await db`select id, scope, authority from memory.entry where id = any(${fused.map(([id]) => id)}::text[])`;
    fused = discount(fused, new Map(rows.map((r) => [r.id as string, { scope: r.scope as string, authority: r.authority as string }])), scope, p);
  }
  const ranked = fused.slice(0, p.candidates);
  const trace: Trace = {
    hybrid: scored(ranked),
    keyword: unscored(parts.keyword),
    vec: unscored(parts.vec),
    ...(eligibleTitle.length ? { title: unscored(eligibleTitle) } : {}),
  };
  return [ranked, degraded, trace];
}

// ---------------------------------------------------------------- spreading: Wen's design
// Seeds are hybrid's top candidates. Activation spreads from them by personalized PageRank over typed links: each edge carries
// its link type's weight (the set's linkTypeWeights, set by the ants on train) times its own learned weight (link.weight, moved
// by the learner). A supersedes link carries activation from the old entry to its replacement only, so a query that
// matches an outdated note reaches what replaced it. Replaced entries keep supersededFactor of what they gather.
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

// ---- best-first (R44): `spreadMode: "bestfirst"`
// Seeds are the same ones PPR uses plus exact 2- and 3-word phrases of the query found in a title or body. A seed's strength is
// its score over the best seed's, so the top seed is 1 and every phrase seed is at least as strong as any keyword seed.

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
  rawQuery?: string,
): Promise<ArmResult> {
  const [ranked, degraded, trace] = await hybridSearch(db, query, scope, p, agentScope, filter, rawQuery);
  if (spreadKnobs(p).mode !== "bestfirst") return [ranked, degraded, trace];
  const hits = await phraseHits(db, query, p, agentScope, filter);
  if (!hits.length) return [ranked, degraded, trace];
  const top = ranked.reduce((a, [, s]) => Math.max(a, s), 0) || 1;
  const seeds = new Map(ranked.map(([id, s]) => [id, s]));
  for (const id of hits) seeds.set(id, Math.max(seeds.get(id) ?? 0, top));
  const merged = [...seeds].map(([id, s]): Ranked => [id, s, null]).sort(byScore);
  return [merged, degraded, { ...trace, phrase: unscored(hits) }];
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
  const k = spreadKnobs(p as CoreParams);
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

export async function spreadingSearch(
  db: Sql,
  query: string,
  scope: string | null,
  p: Params,
  agentScope: AgentScope = null,
  filter?: EntryFilter,
  rawQuery?: string,
): Promise<ArmResult> {
  const [seedsRanked, degraded, seedTrace] = await spreadSeeds(db, query, scope, p, agentScope, filter, rawQuery);
  const g = await graph(db);
  const out = permittedEdges(edgesUnder(g, p.linkTypeWeights), g, agentScope, filter);
  if (spreadKnobs(p as CoreParams).mode === "bestfirst") {
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
  rawQuery?: string,
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
  return redactEntry(row, "Wen");
}

export function renderItem(n: number, row: Row, itemChars?: number) {
  return coreRenderItem(n, row, itemChars, "Wen");
}

/** Fill the packet in rank order up to the item and token budgets. The first item always goes in, cut to the budget
 * when it's bigger, so one huge entry can't fill an agent's context. */
export function pack(ranked: Ranked[], rows: Record<string, Row>, p: Params): [string[], string[]] {
  return packEntries(ranked, rows, p as CoreParams, "Wen");
}

export function renderEntry(row: Row, links: Row[], blobs: Row[] = []) {
  return coreRenderEntry(row, links, blobs, "Wen");
}
