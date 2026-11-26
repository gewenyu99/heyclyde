// Digging past a recall's packet (R29): recall_more(retrieval_id) and recall's depth "deep". A page is the next ranks past what the
// recall and the pages before it showed, in the order the recall ranked them, then what recall hides: for best-first spreading the
// nodes past the frontier it logged, and the dormant and superseded entries that match the query's words. Each item is labelled
// with its kind, strength and state. A page asks no judge and embeds nothing, and it spends no trial chance.
import { searchColdStorage } from "./archive.ts";
import { currentOwner, type Row, type Sql } from "./db.ts";
import type { Params } from "./params.ts";
import { type AgentScope, canReadEntry, type EntryFilter, entryWhereSql } from "./permissions.ts";
import {
  capLine,
  closingLine,
  deepLabel,
  DEPTHS,
  moreLine,
  NOTHING_MORE,
  type Page,
  PAGE_HEAD,
  renderDeepItem as renderCoreDeepItem,
} from "./core/deep-rules.ts";
import type { Params as CoreParams } from "./core/params.ts";
import {
  artifactsLine,
  bigrams,
  clip,
  estimateTokens,
  fetchEntries,
  type Frontier,
  MORE,
  redact,
  searchableProjectSql,
  spreadMore,
} from "./search.ts";

export { capLine, closingLine, deepLabel, DEPTHS, moreLine, NOTHING_MORE, PAGE_HEAD };
export type { Page };

/** One page item: "[n] <id>: <title>", its label, where it came from, the body and its artifacts. A private body never shows. */
export function renderDeepItem(n: number, row: Row, p: Params) {
  return renderCoreDeepItem(n, row, p as CoreParams, "Wen");
}

/** Entries recall hides that match the query's words: dormant ones and superseded ones, best keyword match first. */
async function hidden(db: Sql, request: string, p: Params, agentScope: AgentScope = null, filter?: EntryFilter): Promise<string[]> {
  const rows = await db`select e.id from memory.entry e
    cross join (select nullif(replace(plainto_tsquery('english', ${request})::text, ' & ', ' | '), '')::tsquery as q) t
    where t.q is not null and e.tsv_en @@ t.q and ${searchableProjectSql(db, "e")}
      and (e.confidence < ${p.dormant} or exists (select 1 from memory.link l where l.owner_id = e.owner_id and l.dst = e.id and l.type = 'supersedes'))
      ${entryWhereSql(db, "e", agentScope, filter)}
    order by ts_rank_cd(e.tsv_en, t.q) desc, e.id limit ${p.candidates}`;
  const out = rows.map((r) => r.id as string);
  const terms = [...new Set(bigrams(request))];
  if (terms.length) {
    const zh = await db`select e.id from memory.entry e where e.search_text like any(${terms.map((t) => `%${t}%`)}::text[])
        and ${searchableProjectSql(db, "e")}
        and (e.confidence < ${p.dormant} or exists (select 1 from memory.link l where l.owner_id = e.owner_id and l.dst = e.id and l.type = 'supersedes'))
        ${entryWhereSql(db, "e", agentScope, filter)}
      order by e.id limit ${p.candidates}`;
    for (const r of zh) if (!out.includes(r.id)) out.push(r.id);
  }
  return out;
}

/** Everything a recall's pages can show, in order: its candidates as it ranked them, then the nodes best-first reaches from its
 * frontier, strongest first, then the hidden matches. */
export async function deepPool(
  db: Sql,
  p: Params,
  request: string,
  candidates: string[],
  frontier: Frontier | null,
  agentScope: AgentScope = null,
  filter?: EntryFilter,
): Promise<string[]> {
  const pool = [...candidates], have = new Set(pool);
  const add = (id: string) => {
    if (!have.has(id)) {
      have.add(id);
      pool.push(id);
    }
  };
  if (frontier?.length) {
    const { best } = await spreadMore(db, frontier, p, {}, agentScope, filter);
    [...best].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).forEach(([id]) => add(id));
  }
  for (const id of await hidden(db, request, p, agentScope, filter)) add(id);
  return pool;
}

/** The next page of `pool` past `seen`, up to the packet's item and token budgets, numbered from `start`. An entry deleted since
 * the recall is skipped. `decorate` adds provenance to the rows it is handed before they're rendered. */
export async function nextPage(db: Sql, p: Params, pool: string[], seen: Set<string>, candidates: number, start = 1,
  decorate: (rows: Record<string, Row>, ids: string[]) => Promise<void> = async () => {},
  agentScope: AgentScope = null, filter?: EntryFilter): Promise<Page> {
  const unseen = pool.filter((id) => !seen.has(id));
  const window = unseen.slice(0, p.packetItems * 3);
  const fetched = await fetchEntries(db, window, agentScope);
  const rows: Record<string, Row> = {};
  for (const [id, r] of Object.entries(fetched)) {
    if (canReadEntry(agentScope, r, filter)) rows[id] = r;
  }
  await decorate(rows, window.filter((id) => id in rows));
  const delivered: string[] = [], chunks: string[] = [];
  let used = 0;
  for (const id of window) {
    if (!(id in rows)) continue;
    let chunk = renderDeepItem(start + delivered.length, rows[id], p);
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
  // What's left past this page that still exists. Rows past the window aren't read, so they count as there.
  const after = unseen.slice(unseen.indexOf(delivered.at(-1) ?? "") + 1);
  const left = after.filter((id) => !window.includes(id) || id in rows).length;
  return { delivered, chunks, left: delivered.length ? left : 0, capped: candidates >= p.candidates };
}

// Closing line helper comes from ./core/deep-rules.ts.

export const ARCHIVE_INCLUDES = ["all", "cold", "dormant", "superseded"] as const;
export type ArchiveInclude = (typeof ARCHIVE_INCLUDES)[number];

export type ArchiveSearchArgs = {
  query: string;
  include?: ArchiveInclude;
  scope?: string;
  before?: string;
  after?: string;
  limit?: number;
  offset?: number;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

/** Full-archive text search across all memories in memory.entry, including vector-evicted (cold), dormant, and superseded
 * rows. Uses Postgres full-text, CJK bigrams, and substring matching with zero embedding or LLM spend. */
export async function searchArchive(
  db: Sql,
  args: ArchiveSearchArgs,
  agentScope: AgentScope = null,
  filter?: EntryFilter,
): Promise<string> {
  const query = args.query.trim();
  const include: ArchiveInclude = args.include ?? "all";
  const limit = Math.min(50, Math.max(1, Math.trunc(args.limit ?? 20)));
  const offset = Math.max(0, Math.trunc(args.offset ?? 0));
  const likePattern = `%${escapeLike(query)}%`;
  const terms = [...new Set(bigrams(query))].map((t) => `%${escapeLike(t)}%`);
  const tierSql = include === "cold"
    ? db`and (x.entry_id is null or e.confidence < 0.15 or sup.src is not null)`
    : include === "dormant"
    ? db`and e.confidence < 0.15`
    : include === "superseded"
    ? db`and sup.src is not null`
    : db``;
  const scopeSql = args.scope
    ? args.scope === "run:*"
      ? db`and e.scope like 'run:%'`
      : db`and e.scope = ${args.scope}`
    : db``;
  const beforeSql = args.before && DATE_RE.test(args.before) ? db`and e.created_at < (${args.before}::date + interval '1 day')` : db``;
  const afterSql = args.after && DATE_RE.test(args.after) ? db`and e.created_at >= ${args.after}::date` : db``;
  const zhSql = terms.length ? db`or e.search_text like any(${terms}::text[])` : db``;

  const rows = await db`select e.id, e.title, e.body, e.kind, e.pattern, e.scope, e.confidence, e.sensitivity,
      e.created_at, sup.src as superseded_by, x.entry_id is not null as has_embedding,
      coalesce(ts_rank_cd(e.tsv_en, t.q), 0)
        + case when e.id ilike ${likePattern} then 2.0 else 0 end
        + case when e.title ilike ${likePattern} then 1.0 else 0 end as rank_score
    from memory.entry e
    cross join (select nullif(replace(plainto_tsquery('english', ${query})::text, ' & ', ' | '), '')::tsquery as q) t
    left join memory.entry_embedding x on x.owner_id = e.owner_id and x.entry_id = e.id
    left join lateral (
      select l.src from memory.link l
      where l.owner_id = e.owner_id and l.dst = e.id and l.type = 'supersedes'
      order by l.src desc limit 1
    ) sup on true
    where (
        (t.q is not null and e.tsv_en @@ t.q)
        ${zhSql}
        or e.id ilike ${likePattern}
        or e.title ilike ${likePattern}
        or (e.sensitivity = 'normal' and (e.body ilike ${likePattern} or e.evidence ilike ${likePattern}))
      )
      ${tierSql}
      ${scopeSql}
      ${beforeSql}
      ${afterSql}
      ${entryWhereSql(db, "e", agentScope, filter)}
    order by rank_score desc, e.created_at desc, e.id
    limit ${offset + limit + 1}`;

  const seenIds = new Set(rows.map((r) => String(r.id)));
  const coldMatches = await searchColdStorage(currentOwner(), {
    query,
    include,
    scope: args.scope,
    before: args.before,
    after: args.after,
  });
  const combined: Row[] = [
    ...rows,
    ...coldMatches
      .filter((c) => !seenIds.has(c.id))
      .map((c) => ({
        id: c.id,
        title: c.title,
        body: c.body,
        kind: c.kind,
        pattern: c.pattern,
        scope: c.scope,
        confidence: c.confidence,
        sensitivity: c.sensitivity,
        created_at: c.created_at,
        superseded_by: c.superseded_by ?? null,
        has_embedding: false,
        in_cold_storage: true,
        archive_reason: c.reason,
      })),
  ];

  const hasMore = combined.length > offset + limit;
  const page = combined.slice(offset, offset + limit);
  if (!page.length) {
    return offset > 0
      ? `No more archive matches for "${query}" (include=${include}, offset=${offset}).`
      : `No archive matches for "${query}" (include=${include}).`;
  }
  const items = page.map((raw, i) => {
    const r = redact(raw);
    const conf = Number(r.confidence ?? 0);
    const where = r.in_cold_storage ? " · cold storage" : "";
    const tier = r.superseded_by
      ? `superseded by ${r.superseded_by}${where}`
      : conf < 0.15
      ? `dormant${where}`
      : r.has_embedding
      ? "hot"
      : r.in_cold_storage
      ? `archived (${r.archive_reason ?? "cold"})`
      : "cold (unembedded)";
    const day = r.created_at instanceof Date ? r.created_at.toISOString().slice(0, 10) : String(r.created_at ?? "").slice(0, 10);
    const snippet = r.sensitivity === "private" || r.sensitivity === "confidential"
      ? "(private; open with get_entry)"
      : clip(String(r.body ?? "").replace(/\s+/g, " ").trim(), 220);
    return [
      `[${offset + i + 1}] ${r.id}: ${r.title}`,
      `    ${tier} · kind ${r.kind ?? "observation"} · strength ${conf.toFixed(2)} · ${r.scope ?? "global"} · ${day}`,
      `    ${snippet}`,
    ].join("\n");
  });
  const head = `Archive search for "${query}" (include=${include}, showing ${offset + 1}-${offset + page.length}${hasMore ? "+" : ""}):`;
  const foot = hasMore
    ? `More matches: search_archive(query=${JSON.stringify(query)}, include=${JSON.stringify(include)}, offset=${offset + page.length}). Open any note with get_entry(id).`
    : "End of archive matches. Open any note with get_entry(id).";
  return [head, "", ...items, "", foot].join("\n");
}
