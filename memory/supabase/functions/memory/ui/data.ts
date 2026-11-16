// R67: what a card shows, as plain data. Each tool's card is built from the rows its text came from, through the same
// redaction, so a card never shows what the text hides: a private entry is its title only, a private blob is withheld, and
// a recall card lists only what that recall delivered to this MCP session. The text result itself is never touched.
import { type Row, sql } from "../db.ts";
import { type AgentScope, canReadEntry, questPermitted } from "../permissions.ts";
import { provenanceLines, type Viewer } from "../provenance.ts";
import { fetchEntries, redact } from "../search.ts";
import { TRIAL_CHANCES } from "../trial.ts";
import { CARD_OF } from "./cards.ts";

/** The agent a card says it acted as, for the identity badge every card carries. */
export type Badge = { name: string; context: string | null; surface: string | null; registered: boolean };
export type CardCall = {
  tool: string; args: Record<string, any>; text: string; error: boolean; session: string; viewer: Viewer; badge: Badge;
  agentScope?: AgentScope;
};

const BODY_MAX = 1200, PREVIEW_MAX = 6000;
const clip = (t: unknown, n: number) => {
  const s = String(t ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
const iso = (d: unknown) => d instanceof Date ? d.toISOString() : d ? String(d) : null;
const day = (d: unknown) => d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null;

/** One memory as a card shows it. The row goes through redact first, as every packet item does. */
export function memoryCard(raw: Row, trial = false, chancesLeft: number | null = null) {
  const row = redact(raw);
  const priv = row.sensitivity === "private";
  return {
    id: String(row.id), title: String(row.title ?? ""), body: clip(row.body, BODY_MAX), pattern: row.pattern ?? null,
    category: row.category ?? "general", context: row.context ?? "general", transferability: row.transferability ?? "general",
    project_slug: row.project_slug ?? null,
    kind: row.kind ?? "observation", confidence: Number(Number(row.confidence ?? 0).toFixed(2)), verified: row.verified !== false,
    authority: row.authority ?? null, unreviewed: row.authority === "draft", scope: row.scope ?? null, valid_from: day(row.valid_from),
    provenance: row.provenance ?? null, superseded_by: row.superseded_by ?? null, private: priv,
    quote: !priv && row.evidence && row.evidence_kind === "quote" ? clip(row.evidence, 400) : null,
    artifacts: priv ? [] : ((row.artifacts ?? []) as Row[]).map((a) => ({ name: String(a.name), kind: String(a.kind), size: Number(a.size) })),
    trial, chance: trial && chancesLeft !== null ? TRIAL_CHANCES - chancesLeft : null,
  };
}

async function withProvenance(ids: string[], viewer: Viewer, agentScope: AgentScope = null) {
  const rows = await fetchEntries(sql, ids, agentScope);
  for (const [id, line] of await provenanceLines(sql, ids, viewer)) if (id in rows) rows[id] = { ...rows[id], provenance: line };
  return rows;
}

const RID = /^retrieval ([0-9a-f-]{36})/;

/** recall and recall_more: the items that recall delivered to this session, in order, then the ones on trial. */
async function recallCard(c: CardCall) {
  const rid = RID.exec(c.text)?.[1];
  if (!rid) return null;
  const [r] = await sql`select query, delivered, on_trial, degraded, depth, parent_id from memory.retrieval
    where id = ${rid} and mcp_session = ${c.session}`;
  if (!r) return null;
  const main: string[] = r.delivered ?? [], trial: string[] = r.on_trial ?? [];
  const scope = c.agentScope ?? null;
  const rows = await withProvenance([...main, ...trial], c.viewer, scope);
  const left = trial.length
    ? new Map((await sql`select id, chances_left from memory.entry where id = any(${trial}::text[])`).map((x) => [x.id as string, Number(x.chances_left)]))
    : new Map<string, number>();
  return {
    retrieval_id: rid, query: String(r.query ?? ""), degraded: r.degraded ?? null, page: r.parent_id ? "more" : "packet",
    items: [
      ...main.filter((id) => id in rows && canReadEntry(scope, rows[id])).map((id) => memoryCard(rows[id])),
      ...trial.filter((id) => id in rows && canReadEntry(scope, rows[id])).map((id) => memoryCard(rows[id], true, left.get(id) ?? null)),
    ],
  };
}

/** get_entry and remember: one memory in full, with its links and its artifacts' hashes, so the card can open them. */
async function entryCard(id: string, viewer: Viewer, agentScope: AgentScope = null) {
  if (!id) return null;
  const rows = await withProvenance([id], viewer, agentScope);
  if (!(id in rows) || !canReadEntry(agentScope, rows[id])) return null;
  const card = memoryCard(rows[id]);
  const linkRows = await sql`select 'to' as dir, l.type, l.dst as other, e.title,
        e.category, e.context, e.transferability, e.project_slug, e.computer, e.pattern, e.scope
      from memory.link l join memory.entry e on e.owner_id = l.owner_id and e.id = l.dst where l.src = ${id}
    union all select 'from', l.type, l.src, e.title,
        e.category, e.context, e.transferability, e.project_slug, e.computer, e.pattern, e.scope
      from memory.link l join memory.entry e on e.owner_id = l.owner_id and e.id = l.src where l.dst = ${id}
    order by 1, 2, 3`;
  const links = linkRows.filter((l) => canReadEntry(agentScope, l)).slice(0, 20);
  const blobs = card.private ? [] : await sql`select x.name, x.sha256, x.kind, b.media_type, b.size from memory.entry_blob x
    join memory.blob b on b.owner_id = x.owner_id and b.sha256 = x.sha256 where x.entry_id = ${id} order by x.name`;
  return {
    entry: {
      ...card, body: card.private ? card.body : clip(rows[id].body, 4000),
      links: links.map((l) => ({ dir: l.dir, type: l.type, id: l.other, title: String(l.title ?? "") })),
      artifacts: blobs.map((b) => ({ name: String(b.name), kind: String(b.kind), media_type: String(b.media_type), size: Number(b.size), sha256: String(b.sha256) })),
    },
  };
}

/** get_blob: read back out of the text the tool returned, which already withheld a private blob, plus the name a note
 * gives it. A link to download a binary file is passed on as it is. */
async function artifactCard(c: CardCall) {
  const sha = String(c.args.sha256 ?? "").trim().toLowerCase();
  const head = /^Blob ([0-9a-f]{64}): ([^,]+), characters (\d+) to (\d+) of (\d+)\./.exec(c.text);
  const link = /^Blob ([0-9a-f]{64}): ([^,]+), (\d+) bytes\. Download it within 10 minutes: (https:\/\/\S+)$/.exec(c.text);
  if (!head && !link) return null;
  const candidates = await sql`select x.name, e.category, e.context, e.transferability, e.project_slug, e.computer, e.pattern, e.scope
    from memory.entry_blob x join memory.entry e on e.owner_id = x.owner_id and e.id = x.entry_id
    where x.owner_id = memory.owner_default() and x.sha256 = ${sha} and e.sensitivity <> 'private'
    order by x.name`;
  const named = candidates.find((e) => canReadEntry(c.agentScope ?? null, e));
  const name = named ? String(named.name) : sha.slice(0, 12);
  if (link) return { artifact: { sha256: sha, name, media_type: link[2], size: Number(link[3]), url: link[4], text: null } };
  const body = c.text.slice(c.text.indexOf("\n\n") + 2);
  const [from, to, total] = [Number(head![3]), Number(head![4]), Number(head![5])];
  return {
    artifact: {
      sha256: sha, name, media_type: head![2], from, to, total, url: null,
      text: clip(body, PREVIEW_MAX), next: to < total ? to : null,
    },
  };
}

const questOf = (q: Row) => ({
  id: Number(q.id), title: String(q.title), brief: String(q.brief), done_when: String(q.done_when), state: String(q.state),
  priority: String(q.priority), context: String(q.context), project: q.project ?? null, tags: (q.tags ?? []) as string[], assignee: String(q.assignee),
  posted_by: String(q.posted_by), claimed_by: q.claimed_by ?? null, lease_until: iso(q.lease_until), closed_at: iso(q.closed_at),
  evidence: q.evidence ? clip(q.evidence, 600) : null, result_entry: q.result_entry ?? null,
});

/** The quest tools: the quests the reply names, in the order it names them. */
async function questsCard(c: CardCall) {
  const ids = [...new Set([...c.text.matchAll(/(?:^- |[Qq]uest )#(\d{1,15})\b/gm)].map((m) => Number(m[1])))].slice(0, 50);
  if (!ids.length && c.args.id !== undefined && /^#?\d{1,15}$/.test(String(c.args.id).trim())) ids.push(Number(String(c.args.id).replace("#", "")));
  const head = c.tool === "list_quests" ? c.text.split("\n")[0] : null;
  if (!ids.length) return { action: c.tool, head: head ?? c.text.split("\n")[0], show: c.args.show ?? "open", quests: [] };
  const rows = await sql`select * from memory.quest where id = any(${ids}::bigint[])`;
  const scope = c.agentScope ?? null;
  const byId = new Map(rows.filter((q) => questPermitted(scope, q).ok).map((q) => [Number(q.id), q]));
  return {
    action: c.tool, head: head ?? c.text.split("\n")[0], show: c.args.show ?? "open",
    quests: ids.filter((id) => byId.has(id)).map((id) => questOf(byId.get(id)!)),
  };
}

/** register_agent: the profile the session now writes under. */
async function agentCard(c: CardCall) {
  const name = String(c.args.name ?? "").trim().toLowerCase();
  const [a] = await sql`select name, context, surface, description, computer, projects, agent_type, strict_projects, created_at, last_seen
    from memory.agent where owner_id = memory.owner_default() and name = ${name}`;
  if (!a) return null;
  return {
    agent: {
      name: a.name, context: a.context, surface: a.surface, description: a.description,
      computer: a.computer ?? null, projects: a.projects ?? [], agent_type: a.agent_type ?? "other", strict_projects: Boolean(a.strict_projects),
      since: day(a.created_at),
    },
  };
}

/** The data a tool's card renders, or null when it has none: no card for the tool, or nothing the card could show. */
export async function cardData(c: CardCall): Promise<Record<string, unknown> | null> {
  const card = CARD_OF[c.tool];
  if (!card) return null;
  if (c.error) return { card, version: 1, badge: c.badge, error: clip(c.text, 600) };
  let data: Record<string, unknown> | null = null;
  if (card === "recall") data = await recallCard(c);
  else if (card === "entry") data = await entryCard(String(c.args.id ?? ""), c.viewer, c.agentScope ?? null);
  else if (card === "remembered") data = await entryCard(/^Remembered (\S+)\./.exec(c.text)?.[1] ?? "", c.viewer, c.agentScope ?? null);
  else if (card === "artifact") data = await artifactCard(c);
  else if (card === "quests") data = await questsCard(c);
  else if (card === "agent") data = await agentCard(c);
  return data ? { card, version: 1, badge: c.badge, ...data } : null;
}
