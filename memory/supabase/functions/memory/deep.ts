// Digging past a recall's packet (R29): recall_more(retrieval_id) and recall's depth "deep". A page is the next ranks past what the
// recall and the pages before it showed, in the order the recall ranked them, then what recall hides: for best-first spreading the
// nodes past the frontier it logged, and the dormant and superseded entries that match the query's words. Each item is labelled
// with its kind, strength and state. A page asks no judge and embeds nothing, and it spends no trial chance.
import type { Row, Sql } from "./db.ts";
import type { Params } from "./params.ts";
import { type AgentScope, canReadEntry, type EntryFilter, entryWhereSql } from "./permissions.ts";
import { artifactsLine, bigrams, clip, estimateTokens, fetchEntries, type Frontier, MORE, redact, spreadMore } from "./search.ts";

export const DEPTHS = ["packet", "deep"];
export const NOTHING_MORE = "Nothing more in memory matches.";
export const capLine = (n: number) => `Memory ranks only the top ${n} matches. Narrow the query to see more.`;
export const moreLine = (rid: string) => `More past these: recall_more(retrieval_id="${rid}").`;
export const PAGE_HEAD = "Deeper in memory, past what the recall showed. Each item says its kind, strength and state.";

/** "    kind observation · strength 0.70 · settled": the state is superseded, then dormant (under the set's dormant line), then on
 * trial with the chances it has left, then settled. */
export function deepLabel(row: Row, dormant: number) {
  const c = Number(row.confidence ?? 0);
  const state = row.superseded_by ? `superseded by ${row.superseded_by}` : c < dormant ? "dormant"
    : Number(row.chances_left ?? 0) > 0 ? `on trial, ${row.chances_left} left` : "settled";
  return `    kind ${row.kind ?? "observation"} · strength ${c.toFixed(2)} · ${state}`;
}

/** One page item: "[n] <id>: <title>", its label, where it came from, the body and its artifacts. A private body never shows. */
export function renderDeepItem(n: number, row: Row, p: Params) {
  row = redact(row);
  const body = p.itemChars && String(row.body).length > p.itemChars ? `${String(row.body).slice(0, p.itemChars)}${MORE}` : row.body;
  const parts = [`[${n}] ${row.id}: ${row.title}`, deepLabel(row, p.dormant), ...(row.provenance ? [`    ${row.provenance}`] : []), `    ${body}`];
  const artifacts = artifactsLine(row);
  if (artifacts) parts.push(`    ${artifacts}`);
  return parts.join("\n");
}

/** Entries recall hides that match the query's words: dormant ones and superseded ones, best keyword match first. */
async function hidden(db: Sql, request: string, p: Params, agentScope: AgentScope = null, filter?: EntryFilter): Promise<string[]> {
  const rows = await db`select e.id from memory.entry e
    cross join (select nullif(replace(plainto_tsquery('english', ${request})::text, ' & ', ' | '), '')::tsquery as q) t
    where t.q is not null and e.tsv_en @@ t.q and e.pattern <> 'projects'
      and (e.confidence < ${p.dormant} or exists (select 1 from memory.link l where l.owner_id = e.owner_id and l.dst = e.id and l.type = 'supersedes'))
      ${entryWhereSql(db, "e", agentScope, filter)}
    order by ts_rank_cd(e.tsv_en, t.q) desc, e.id limit ${p.candidates}`;
  const out = rows.map((r) => r.id as string);
  const terms = [...new Set(bigrams(request))];
  if (terms.length) {
    const zh = await db`select e.id from memory.entry e where e.search_text like any(${terms.map((t) => `%${t}%`)}::text[])
        and e.pattern <> 'projects'
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

export type Page = { delivered: string[]; chunks: string[]; left: number; capped: boolean };

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

/** The line a page ends with: how to get the next one, or why there is none. */
export const closingLine = (page: Page, rid: string, p: Params) =>
  page.left ? moreLine(rid) : page.capped ? capLine(p.candidates) : NOTHING_MORE;
