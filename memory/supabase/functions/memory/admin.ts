// The management API behind Wen's console, mounted at /api/v1. JSON in and out. This is Wen's own console behind his
// token, so private entries show in full. Every write lands with an admin_audit row in the same transaction. Query
// strings that don't parse get a 400. Bodies that parse but don't validate get a 422. A body over 1 MiB gets a 413.
import { config } from "./config.ts";
import { type Row, type Sql, sql } from "./db.ts";
import { budget, contentSha, entryText, sha256, syncEmbeddings } from "./embed.ts";
import { ARMS, hybridComponents } from "./search.ts";
import * as service from "./service.ts";
import { redact, redactText } from "./redact.ts";
import { screen } from "./judge.ts";
import { remember, Refused } from "./write.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

export class ApiError extends Error {
  constructor(public status: number, public error: string) {
    super(error);
  }
}

const ENTRY_ID = /^[a-z0-9][a-z0-9-]{1,100}$/;
const LINK_TYPE = /^[a-z_]{2,40}$/;
const PATTERN = /^[a-z][a-z_-]{1,40}$/;
const SCOPE = /^(global|domain:[a-z0-9-]+|repo:[A-Za-z0-9._/-]+)$/;
const LANG = /^[A-Za-z]{2,8}([-_][A-Za-z0-9]{1,8})*$/;
const DEVICE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const AUTHORITIES = ["approved", "observed", "draft"];
export const SENSITIVITIES = ["normal", "private", "confidential"];
const EVIDENCE_KINDS = ["quote", "assistant", "summary", "memory"];
const AGENTS = ["claude", "codex"];
const FIELDS = ["title", "body", "pattern", "authority", "scope", "sensitivity", "lang", "valid_from", "source_id",
  "evidence_kind", "evidence", "project"];
const REQUIRED = ["id", "title", "body", "pattern", "authority", "scope"];
const NULLABLE = ["valid_from", "source_id", "evidence_kind", "evidence", "project"];
const HIDDEN = ["tsv_en", "search_text"];
// The most characters a text field takes. Anything not named takes 200.
const MAX_LEN: Record<string, number> = { title: 500, body: 50000, evidence: 50000, note: 4000, query: 4000, task: 4000 };
const MAX_BODY = 1 << 20;
const MAX_OFFSET = 10 ** 9;
const SUPERSEDED = "exists (select 1 from memory.link s where s.dst = e.id and s.type = 'supersedes')";
const SUPERSEDED_BY = "array(select s.src from memory.link s where s.dst = e.id and s.type = 'supersedes' order by s.src)";
const EVENT_SUMMARY = "case v.event when 'UserPromptSubmit' then left(coalesce(v.payload->>'prompt', ''), 160) " +
  "when 'PostToolUse' then coalesce(v.payload->>'tool_name', '') else '' end";
// check_messages' rule: to a.name or to all, from someone else, not yet read by a.name.
const UNREAD = "m.recipient in (a.name, 'all') and m.sender <> a.name and not (a.name = any(m.read_by))";

const n = (count: number, one: string, many = one + "s") => `${count} ${count === 1 ? one : many}`;
const like = (q: string) => "%" + q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_") + "%";
const omit = (row: Row, keys: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));
const u = (fragment: string) => sql.unsafe(fragment);

function where(db: Sql, clauses: any[]) {
  if (!clauses.length) return db``;
  return clauses.slice(1).reduce((acc, c) => db`${acc} and ${c}`, db`where ${clauses[0]}`);
}

/** One page of a list and the total it came from. order is fixed SQL. */
async function page(db: Sql, query: any, order: string, limit: number, offset: number) {
  const [{ total }] = await db`select count(*) as total from (${query}) q`;
  const items = await db`${query} order by ${u(order)} limit ${limit} offset ${offset}`;
  return { items, total, limit, offset };
}

async function audit(db: Sql, action: string, target: string, before: unknown = null, after: unknown = null) {
  const [row] = await db`insert into memory.admin_audit (action, target, before, after)
    values (${action}, ${target}, ${before === null ? null : db.json(before as any)}, ${after === null ? null : db.json(after as any)})
    returning id`;
  return row.id as number;
}

// ---------------------------------------------------------------- dashboard
/** Current entries whose stored embedding matches their text now, by the same hash the sync checks. */
async function embeddingCounts(db: Sql) {
  const rows = await db`select e.id, e.title, e.body, e.evidence, e.search_text, e.sensitivity, x.content_sha256
    from memory.entry_current e left join memory.entry_embedding x on x.entry_id = e.id`;
  let fresh = 0;
  for (const r of rows) if (r.content_sha256 === await contentSha(entryText(r))) fresh++;
  return { embedded: fresh, stale_or_missing: rows.length - fresh };
}

async function syncStatus() {
  const [row] = await sql`select value from memory.setting where name = 'embed_sync_status'`;
  return row ? JSON.parse(row.value) : null;
}

async function overview() {
  const [c] = await sql`select (select count(*) from memory.entry_current) as entries,
      (select count(*) from memory.entry e where ${u(SUPERSEDED)}) as superseded,
      (select count(*) from memory.entry where sensitivity = 'private') as private,
      (select count(*) from memory.link) as links, (select count(*) from memory.source) as sources,
      (select count(*) from memory.entry where pattern = 'projects') as projects, (select count(*) from memory.event) as events,
      (select count(distinct session_id) from memory.event where event <> 'get_entry') as client_sessions,
      (select count(*) from memory.mcp_session) as mcp_sessions, (select count(*) from memory.retrieval) as recalls,
      (select count(*) from memory.feedback) as feedback, (select count(*) from memory.message) as messages,
      (select count(*) from memory.device where revoked_at is null) as devices,
      (select max(received_at) from memory.event) as last_event,
      (select max(received_at) from memory.event where event <> 'get_entry') as last_hook,
      (select max(created_at) from memory.retrieval) as last_recall,
      (select max(created_at) from memory.message) as last_message, (select max(created_at) from memory.feedback) as last_feedback,
      (select count(*) from memory.message m where exists (select 1 from unnest(${AGENTS}::text[]) a(name)
        where ${u(UNREAD)})) as unread_messages`;
  const unread = await sql`select a.name, count(m.id) as n from unnest(${AGENTS}::text[]) a(name)
    left join memory.message m on ${u(UNREAD)} group by a.name`;
  const last: Row = {};
  for (const k of ["event", "hook", "recall", "message", "feedback"]) {
    last[k] = c[`last_${k}`];
    delete c[`last_${k}`];
  }
  return {
    health: { db: true, arms: config.arms, embedding_model: config.embedModel, vector: true, sync: await syncStatus(),
      budget: await budget() },
    counts: { ...c, unread: Object.fromEntries(unread.map((r) => [r.name, r.n])) },
    embeddings: await embeddingCounts(sql), last,
  };
}

const DAILY = [["events", "event", "received_at"], ["recalls", "retrieval", "created_at"],
  ["feedback", "feedback", "created_at"], ["messages", "message", "created_at"]];

/** Counts per day in the time zone tz, oldest first, with empty days present. tz must be a name Postgres lists, since
 * POSIX strings like UTC+14 read their sign backwards. */
async function activity(days: number, tz: string) {
  if (!(await sql`select 1 from pg_timezone_names where name = ${tz}`).length) {
    throw new ApiError(400, "tz must be a time zone like America/New_York.");
  }
  const [{ first }] = await sql`select ((now() at time zone ${tz})::date - ${days}::int + 1)::text as first`;
  const since = sql`(${first}::timestamp at time zone ${tz})`;
  const counts = await Promise.all(DAILY.map(([name, table, col]) =>
    sql`select (${u(col)} at time zone ${tz})::date::text as day, count(*) as n from ${u("memory." + table)}
      where ${u(col)} >= ${since} group by 1`.then((rows) => [name, Object.fromEntries(rows.map((r) => [r.day, r.n]))] as const)
  ));
  const span = await sql`select (${first}::date + i)::text as day from generate_series(0, ${days}::int - 1) i order by 1`;
  const rows = span.map(({ day }) => ({ day, ...Object.fromEntries(counts.map(([name, by]) => [name, by[day] ?? 0])) }));
  const byType = await sql`select event, count(*) as count, max(received_at) as last from memory.event
    where received_at >= ${since} group by event order by count desc, event`;
  const clients = await sql`select coalesce(s.client, 'unknown') as client, count(distinct s.id) as sessions,
      count(r.id) as recalls, greatest(max(r.created_at), max(s.created_at)) as last
    from memory.mcp_session s left join memory.retrieval r on r.mcp_session = s.id and r.created_at >= ${since}
    where s.created_at >= ${since} or r.id is not null group by 1 order by last desc`;
  const agents = await sql`select coalesce(agent, 'unknown') as agent, count(*) as events,
      count(distinct session_id) as sessions, max(received_at) as last from memory.event
    where event <> 'get_entry' and received_at >= ${since} group by 1 order by last desc`;
  return { days: rows, events_by_type: byType, clients, agents };
}

async function meta() {
  const patterns = await sql`select distinct pattern from memory.entry where pattern is not null order by 1`;
  const types = await sql`select distinct type from memory.link`;
  return {
    authorities: AUTHORITIES, sensitivities: SENSITIVITIES, patterns: patterns.map((r) => r.pattern),
    link_types: [...new Set([...types.map((r) => r.type), "part_of", "relates", "supersedes"])].sort(),
    projects: await sql`select id, title from memory.entry where pattern = 'projects' order by title, id`,
    sources: await sql`select id, kind, title, date from memory.source order by date desc nulls last, id`,
    arms: Object.keys(ARMS), live_arms: config.arms,
  };
}

// ---------------------------------------------------------------- entries
const ENTRY_SORTS: Record<string, string> = { id: "e.id", title: "e.title, e.id", valid_from: "e.valid_from desc nulls last, e.id",
  updated: "updated desc nulls last, e.id" };
const STATES: Record<string, string | null> = { current: `not ${SUPERSEDED}`, superseded: SUPERSEDED, all: null };

async function entries(p: Row) {
  const clauses: any[] = STATES[p.superseded] ? [u(STATES[p.superseded]!)] : [];
  for (const col of ["project", "authority", "pattern", "sensitivity"]) {
    if (p[col]) clauses.push(sql`${u("e." + col)} = ${p[col]}`);
  }
  // id, title and body only. The search text also carries the project's title, so a word from it would match every
  // entry in the project. ilike covers 中文 substrings too.
  if (p.q) {
    const l = like(p.q);
    clauses.push(sql`(e.id ilike ${l} or e.title ilike ${l} or e.body ilike ${l}
      or to_tsvector('english', concat_ws(' ', e.title, e.body)) @@ plainto_tsquery('english', ${p.q}))`);
  }
  const query = sql`select e.id, e.title, e.pattern, e.authority, e.scope, e.sensitivity, e.lang, e.valid_from, e.project,
      p.title as project_title, ${u(SUPERSEDED_BY)} as superseded_by,
      (select count(*) from memory.link l where l.src = e.id or l.dst = e.id) as links,
      (select count(*) from memory.retrieval r where r.delivered ? e.id) as delivered,
      (select max(a.at) from memory.admin_audit a where a.target = 'entry:' || e.id) as updated
    from memory.entry e left join memory.entry p on p.id = e.project ${where(sql, clauses)}`;
  return page(sql, query, ENTRY_SORTS[p.sort], p.limit, p.offset);
}

async function row(db: Sql, id: string) {
  const [r] = await db`select * from memory.entry where id = ${id}`;
  if (!r) throw new ApiError(404, `No entry ${id}.`);
  return omit(r, HIDDEN);
}

async function entry(db: Sql, id: string) {
  const [r] = await db`select e.*, p.title as project_title from memory.entry e left join memory.entry p on p.id = e.project
    where e.id = ${id}`;
  if (!r) throw new ApiError(404, `No entry ${id}.`);
  const [emb] = await db`select model, updated_at, content_sha256 from memory.entry_embedding where entry_id = ${id}`;
  let embedding = null;
  if (emb) {
    const { content_sha256, ...rest } = emb;
    embedding = { ...rest, fresh: content_sha256 === await contentSha(entryText(r)) };
  }
  const out = await db`select l.type, l.dst, d.title, d.authority from memory.link l join memory.entry d on d.id = l.dst
    where l.src = ${id} order by l.type, l.dst`;
  const into = await db`select l.type, l.src, s.title, s.authority from memory.link l join memory.entry s on s.id = l.src
    where l.dst = ${id} order by l.type, l.src`;
  const [usage] = await db`select (select count(*) from memory.retrieval where delivered ? ${id}) as delivered,
      (select count(*) from memory.retrieval where candidates @> ${db.json([{ id }])}) as candidate,
      (select max(created_at) from memory.retrieval where delivered ? ${id}) as last_delivered`;
  usage.feedback = await db`select verdict, source, note, created_at, retrieval_id from memory.feedback
    where entry_id = ${id} order by created_at desc limit 100`;
  const by = into.filter((l) => l.type === "supersedes").map((l) => l.src);
  const [source] = r.source_id ? await db`select * from memory.source where id = ${r.source_id}` : [null];
  return {
    entry: omit(r, HIDDEN), source: source ?? null, links_out: out, links_in: into, superseded_by: by,
    supersedes: out.filter((l) => l.type === "supersedes").map((l) => l.dst), current: !by.length, embedding, usage,
  };
}

const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + "T00:00:00Z").toISOString().startsWith(v);

const VALID: Record<string, [(v: string) => boolean, string]> = {
  title: [(v) => Boolean(v.trim()), "title cannot be empty."],
  body: [(v) => Boolean(v.trim()), "body cannot be empty."],
  pattern: [(v) => PATTERN.test(v), "pattern must be a lowercase word like decisions."],
  authority: [(v) => AUTHORITIES.includes(v), "authority must be approved, observed or draft."],
  scope: [(v) => SCOPE.test(v), "scope must be global, domain:<name> or repo:<path>."],
  sensitivity: [(v) => SENSITIVITIES.includes(v), "sensitivity must be normal, private or confidential."],
  lang: [(v) => LANG.test(v), "lang must be a language code like en or zh."],
  valid_from: [isDate, "valid_from must be a date like 2026-10-10."],
  evidence_kind: [(v) => EVIDENCE_KINDS.includes(v), "evidence_kind must be quote, assistant, summary or memory."],
};

function shortEnough(k: string, v: string) {
  const cap = MAX_LEN[k] ?? 200;
  if (v.length > cap) throw new ApiError(422, `${k} must be at most ${cap.toLocaleString("en-US")} characters.`);
}

/** Type and format checks on writable entry fields. An empty string clears a nullable field. */
async function fields(data: Row) {
  const out: Row = {};
  for (const [k, v] of Object.entries(data)) {
    if (NULLABLE.includes(k) && (v === null || v === "")) {
      out[k] = null;
      continue;
    }
    if (typeof v !== "string") throw new ApiError(422, `${k} must be a string.`);
    shortEnough(k, v);
    const [ok, error] = VALID[k] ?? [(x: string) => Boolean(x), `${k} cannot be empty.`];
    if (!ok(v)) throw new ApiError(422, error);
    out[k] = redactText(k === "title" ? v.trim() : v)[0];
  }
  if ("evidence" in out) out.evidence_sha256 = out.evidence ? await sha256(out.evidence) : null;
  return out;
}

async function checkRefs(db: Sql, id: string, f: Row) {
  if (f.source_id && !(await db`select 1 from memory.source where id = ${f.source_id}`).length) {
    throw new ApiError(422, `No source ${f.source_id}.`);
  }
  if (f.project && f.project !== id) {
    const [p] = await db`select pattern from memory.entry where id = ${f.project}`;
    if (!p) throw new ApiError(422, `No project ${f.project}.`);
    if (p.pattern !== "projects") throw new ApiError(422, `${f.project} is not a project.`);
  }
}

function link(src: string, dst: unknown, type: unknown) {
  if (typeof type !== "string" || !LINK_TYPE.test(type)) throw new ApiError(422, "type must be 2 to 40 lowercase letters or underscores.");
  if (typeof dst !== "string" || !dst || dst.length > 200) throw new ApiError(422, "dst must be an entry id.");
  if (dst === src) throw new ApiError(422, "An entry cannot link to itself.");
  return { src, dst, type };
}

async function checkDsts(db: Sql, ids: string[]) {
  const found = new Set((await db`select id from memory.entry where id = any(${ids}::text[])`).map((r) => r.id));
  const missing = ids.filter((i) => !found.has(i)).sort();
  if (missing.length) throw new ApiError(422, `No entry ${missing[0]} to link to.`);
}

/** seed/build.py's two rules for `by` supersedes `old`. Supersession never loops, and a draft never supersedes an
 * approved entry. authority stands in for by's own when by is not stored yet. */
async function checkSupersedes(db: Sql, by: string, old: string, authority: string | null = null) {
  const loop = await db`with recursive down(id) as (select ${old}::text union
      select l.dst from memory.link l join down on l.src = down.id where l.type = 'supersedes')
    select 1 from down where id = ${by}`;
  if (loop.length) throw new ApiError(409, `That would make a supersession loop. ${old} already leads to ${by}.`);
  const rows = Object.fromEntries((await db`select id, authority from memory.entry where id = any(${[by, old]}::text[])`)
    .map((r) => [r.id, r.authority]));
  if ((authority ?? rows[by]) === "draft" && rows[old] === "approved") {
    throw new ApiError(422, `A draft cannot supersede an approved entry. Approve ${by} first.`);
  }
}

/** The draft rule from the other side. */
async function checkAuthority(db: Sql, id: string, authority: string) {
  if (authority === "draft" && (await db`select 1 from memory.link l join memory.entry o on o.id = l.dst
      where l.src = ${id} and l.type = 'supersedes' and o.authority = 'approved'`).length) {
    throw new ApiError(422, `${id} supersedes an approved entry, so it can't be a draft.`);
  }
  if (authority === "approved" && (await db`select 1 from memory.link l join memory.entry n on n.id = l.src
      where l.dst = ${id} and l.type = 'supersedes' and n.authority = 'draft'`).length) {
    throw new ApiError(422, `A draft supersedes ${id}, so it can't be approved.`);
  }
}

const pgCode = (e: unknown) => (e as { code?: string })?.code;

/** The vault's rule holds here too: an entry in a project is part_of it, so the link comes with the project. */
async function createEntry(data: Row) {
  const unknown = Object.keys(data).filter((k) => !["id", "links", ...FIELDS].includes(k)).sort();
  if (unknown.length) throw new ApiError(422, `Unknown fields: ${unknown.join(", ")}.`);
  const missing = REQUIRED.filter((k) => data[k] === null || data[k] === undefined || data[k] === "");
  if (missing.length) throw new ApiError(422, `Missing ${missing.join(", ")}.`);
  const id = data.id;
  if (typeof id !== "string" || !ENTRY_ID.test(id)) {
    throw new ApiError(422, "id must be 2 to 101 lowercase letters, digits or dashes, and start with a letter or digit.");
  }
  const f = await fields({ sensitivity: "normal", lang: "en", ...Object.fromEntries(FIELDS.filter((k) => k in data).map((k) => [k, data[k]])) });
  f.valid_from ??= new Date().toISOString().slice(0, 10);
  f.evidence_sha256 ??= null;
  if (f.project == null && f.pattern === "projects") f.project = id;
  const raw = data.links ?? [];
  if (!Array.isArray(raw) || !raw.every((l) => l && typeof l === "object")) throw new ApiError(422, "links must be a list of {dst, type}.");
  let links = raw.map((l: Row) => link(id, l.dst, l.type));
  if (f.project != null && f.project !== id) links.push({ src: id, dst: f.project, type: "part_of" });
  links = [...new Map(links.map((l) => [`${l.dst}\0${l.type}`, l])).values()];
  return await sql.begin(async (tx) => {
    if ((await tx`select 1 from memory.entry where id = ${id}`).length) throw new ApiError(409, `Entry ${id} already exists.`);
    await checkRefs(tx, id, f);
    await checkDsts(tx, [...new Set(links.map((l) => l.dst))]);
    for (const l of links) if (l.type === "supersedes") await checkSupersedes(tx, id, l.dst, f.authority);
    try {
      await tx`insert into memory.entry ${tx({ id, ...f })}`;
    } catch (e) {
      if (pgCode(e) === "23505") throw new ApiError(409, `Entry ${id} already exists.`);
      throw e;
    }
    for (const l of links) await tx`insert into memory.link (src, dst, type) values (${l.src}, ${l.dst}, ${l.type})`;
    await audit(tx, "entry.create", `entry:${id}`, null, { ...(await row(tx, id)), links });
    return await entry(tx, id);
  });
}

/** Moving an entry to another project moves its part_of link too. Renaming a project refreshes the search text of
 * the entries in it, since theirs carries its title. */
async function updateEntry(id: string, data: Row) {
  const unknown = Object.keys(data).filter((k) => !FIELDS.includes(k)).sort();
  if (unknown.length) throw new ApiError(422, `Unknown fields: ${unknown.join(", ")}.`);
  if (!Object.keys(data).length) throw new ApiError(422, "Nothing to change.");
  return await sql.begin(async (tx) => {
    const before = await row(tx, id);
    const f = await fields(data);
    await checkRefs(tx, id, f);
    if (f.authority != null && f.authority !== before.authority) await checkAuthority(tx, id, f.authority);
    await tx`update memory.entry set ${tx(f)} where id = ${id}`;
    if ("project" in f && f.project !== before.project) {
      await tx`delete from memory.link where src = ${id} and dst = ${before.project} and type = 'part_of'`;
      if (f.project != null && f.project !== id) {
        await tx`insert into memory.link (src, dst, type) values (${id}, ${f.project}, 'part_of') on conflict do nothing`;
      }
    }
    if ("title" in f) await tx`update memory.entry set title = title where project = ${id} and id <> ${id}`;
    const after = await row(tx, id);
    const keys = Object.keys(f);
    await audit(tx, "entry.update", `entry:${id}`, Object.fromEntries(keys.map((k) => [k, before[k]])),
      Object.fromEntries(keys.map((k) => [k, after[k]])));
    return await entry(tx, id);
  });
}

/** Only an entry nothing points at goes. One that was ever delivered stays as evidence of what an agent saw. */
async function deleteEntry(id: string) {
  return await sql.begin(async (tx) => {
    const before = await row(tx, id);
    const [c] = await tx`select (select count(*) from memory.link where src = ${id} or dst = ${id}) as links,
        (select count(*) from memory.retrieval where delivered ? ${id}) as delivered,
        (select count(*) from memory.entry where project = ${id} and id <> ${id}) as members,
        (select count(*) from memory.qrel where entry_id = ${id}) as qrels`;
    if (c.links) throw new ApiError(409, `${id} still has ${n(c.links, "link")}. Remove the links first.`);
    if (c.delivered) throw new ApiError(409, `${id} was delivered in ${n(c.delivered, "recall")}. Supersede it instead.`);
    if (c.members) throw new ApiError(409, `${id} is still the project of ${n(c.members, "entry", "entries")}.`);
    if (c.qrels) throw new ApiError(409, `${id} is graded in the retrieval eval.`);
    await audit(tx, "entry.delete", `entry:${id}`, before, null);
    try {
      await tx`delete from memory.entry where id = ${id}`;
    } catch (e) {
      if (pgCode(e) === "23503") throw new ApiError(409, `Something still references ${id}.`);
      throw e;
    }
    return { deleted: id };
  });
}

/** A supersedes link takes supersede()'s checks and lands in the audit as entry.supersede, the same as there. */
async function addLink(src: string, dst: unknown, type: unknown) {
  return await sql.begin(async (tx) => {
    await row(tx, src);
    const l = link(src, dst, type);
    await checkDsts(tx, [l.dst]);
    if (l.type === "supersedes") await checkSupersedes(tx, src, l.dst);
    const ins = await tx`insert into memory.link (src, dst, type) values (${src}, ${l.dst}, ${l.type})
      on conflict do nothing returning src`;
    if (!ins.length) throw new ApiError(409, `${src} already has a ${l.type} link to ${l.dst}.`);
    if (l.type === "supersedes") await audit(tx, "entry.supersede", `entry:${l.dst}`, null, l);
    else await audit(tx, "link.create", `entry:${src}`, null, l);
    return l;
  });
}

async function deleteLink(src: string, type: string, dst: string) {
  return await sql.begin(async (tx) => {
    const [l] = await tx`delete from memory.link where src = ${src} and dst = ${dst} and type = ${type} returning src, dst, type`;
    if (!l) throw new ApiError(404, `No ${type} link from ${src} to ${dst}.`);
    await audit(tx, "link.delete", `entry:${src}`, l, null);
    return { deleted: l };
  });
}

async function supersede(id: string, by: unknown) {
  return await sql.begin(async (tx) => {
    await row(tx, id);
    if (typeof by !== "string" || !by || by.length > 200) throw new ApiError(422, "by must be the id of the entry that replaces this one.");
    if (by === id) throw new ApiError(422, "An entry cannot supersede itself.");
    await checkDsts(tx, [by]);
    await checkSupersedes(tx, by, id);
    if (!(await tx`insert into memory.link (src, dst, type) values (${by}, ${id}, 'supersedes') on conflict do nothing
        returning src`).length) {
      throw new ApiError(409, `${by} already supersedes ${id}.`);
    }
    await audit(tx, "entry.supersede", `entry:${id}`, null, { src: by, dst: id, type: "supersedes" });
    return await entry(tx, id);
  });
}

async function graph(project: string | null, includeSuperseded: boolean) {
  const clauses: any[] = includeSuperseded ? [] : [u(`not ${SUPERSEDED}`)];
  if (project) clauses.push(sql`e.project = ${project}`);
  const nodes = await sql`select e.id, e.title, e.authority, e.pattern, e.project, p.title as project_title,
      e.sensitivity = 'private' as private, not ${u(SUPERSEDED)} as current
    from memory.entry e left join memory.entry p on p.id = e.project ${where(sql, clauses)} order by e.id`;
  const ids = nodes.map((x) => x.id);
  const links = await sql`select src, dst, type from memory.link where src = any(${ids}::text[]) and dst = any(${ids}::text[])
    order by src, dst, type`;
  return { nodes, links };
}

// ---------------------------------------------------------------- sessions, events, retrievals
async function sessions(p: Row) {
  const clauses = [p.client && sql`s.client = ${p.client}`, p.arm && sql`s.arm = ${p.arm}`].filter(Boolean);
  const query = sql`select s.id, s.arm, s.client, s.claude_session_id, s.created_at,
      (select count(*) from memory.retrieval r where r.mcp_session = s.id) as recalls,
      (select max(r.created_at) from memory.retrieval r where r.mcp_session = s.id) as last_recall,
      (select count(*) from memory.event v where v.session_id = s.claude_session_id) as events
    from memory.mcp_session s ${where(sql, clauses)}`;
  return page(sql, query, "s.created_at desc, s.id", p.limit, p.offset);
}

/** One MCP session's story: its recalls, its get_entry opens, its feedback, and the hook events of the client session
 * it is tied to. */
async function session(id: string) {
  const [s] = await sql`select * from memory.mcp_session where id = ${id}`;
  if (!s) throw new ApiError(404, `No session ${id}.`);
  const timeline: Row[] = (await sql`select * from memory.retrieval where mcp_session = ${id}`).map((r) => ({
    kind: "recall", at: r.created_at, id: String(r.id), summary: r.query, arm: r.arm, task: r.task, delivered: r.delivered,
    latency_ms: r.latency_ms, degraded: r.degraded,
  }));
  const ids = [id, s.claude_session_id].filter(Boolean);
  for (const v of await sql`select v.id, v.event, v.received_at, v.payload->>'tool_name' as tool_name,
      v.payload->>'entry_id' as entry_id, ${u(EVENT_SUMMARY)} as summary from memory.event v
      where v.session_id = any(${ids}::text[])`) {
    const opened = v.event === "get_entry";
    timeline.push({ kind: opened ? "get_entry" : "event", at: v.received_at, id: String(v.id),
      summary: opened ? v.entry_id : v.summary, event: v.event, tool_name: v.tool_name, entry_id: v.entry_id });
  }
  for (const f of await sql`select f.* from memory.feedback f join memory.retrieval r on r.id = f.retrieval_id
      where r.mcp_session = ${id}`) {
    const said = f.verdict + (f.entry_id ? ` on ${f.entry_id}` : "") + (f.note ? `: ${f.note}` : "");
    timeline.push({ kind: "feedback", at: f.created_at, id: String(f.id), summary: said, verdict: f.verdict,
      source: f.source, retrieval_id: f.retrieval_id, entry_id: f.entry_id, note: f.note });
  }
  timeline.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { session: s, timeline };
}

/** agent is what memory-hook reported, claude or codex. Events from before it reported one have none. */
async function events(p: Row) {
  const clauses = [p.event && sql`v.event = ${p.event}`, p.session_id && sql`v.session_id = ${p.session_id}`,
    p.agent && sql`v.agent = ${p.agent}`, p.since && sql`v.received_at >= ${p.since}`].filter(Boolean);
  const query = sql`select v.id, v.event, v.session_id, v.agent, v.received_at, v.payload->>'cwd' as cwd,
      v.payload->>'tool_name' as tool_name, ${u(EVENT_SUMMARY)} as summary from memory.event v ${where(sql, clauses)}`;
  return page(sql, query, "v.received_at desc, v.id desc", p.limit, p.offset);
}

/** Event ids are whole numbers. Anything else is a missing event, the same as retrieval() treats a bad UUID. */
async function event(id: string) {
  const [r] = /^[0-9]{1,18}$/.test(id)
    ? await sql`select id, event, session_id, agent, received_at, payload from memory.event where id = ${id}`
    : [];
  if (!r) throw new ApiError(404, `No event ${id}.`);
  return { event: r };
}

async function retrievals(p: Row) {
  const clauses = [p.arm && sql`r.arm = ${p.arm}`, p.client && sql`s.client = ${p.client}`,
    p.q && sql`(r.query ilike ${like(p.q)} or r.task ilike ${like(p.q)})`].filter(Boolean);
  const query = sql`select r.id, r.created_at, r.arm, s.client, r.mcp_session, r.query, r.task,
      jsonb_array_length(r.delivered) as delivered_count, r.latency_ms, r.degraded,
      (select count(*) from memory.feedback f where f.retrieval_id = r.id) as feedback
    from memory.retrieval r left join memory.mcp_session s on s.id = r.mcp_session ${where(sql, clauses)}`;
  return page(sql, query, "r.created_at desc, r.id", p.limit, p.offset);
}

/** Title, authority and what supersedes each entry now. A recall's candidates show today's state. */
async function titles(db: Sql, ids: string[]) {
  return Object.fromEntries((await db`select e.id, e.title, e.authority, ${u(SUPERSEDED_BY)} as superseded_by
    from memory.entry e where e.id = any(${ids}::text[])`).map((r) => [r.id, r]));
}

function known(rows: Record<string, Row>, id: string) {
  const r = rows[id] ?? {};
  const by = r.superseded_by ?? [];
  return { title: r.title ?? null, authority: r.authority ?? null, superseded_by: by, current: !by.length };
}

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

async function retrieval(id: string) {
  if (!UUID.test(id)) throw new ApiError(404, `No retrieval ${id}.`);
  const [r] = await sql`select r.*, s.client from memory.retrieval r left join memory.mcp_session s on s.id = r.mcp_session
    where r.id = ${id}::uuid`;
  if (!r) throw new ApiError(404, `No retrieval ${id}.`);
  const { client, ...rest } = r;
  const t = await titles(sql, r.candidates.map((c: Row) => c.id));
  const delivered = new Set(r.delivered);
  const candidates = r.candidates.map((c: Row, i: number) => ({
    rank: i + 1, id: c.id, score: c.score, ...known(t, c.id), delivered: delivered.has(c.id), exists: c.id in t,
  }));
  const fb = await sql`select id, source, verdict, entry_id, note, created_at from memory.feedback
    where retrieval_id = ${id}::uuid order by created_at, id`;
  return { retrieval: rest, client, candidates, feedback: fb };
}

async function feedbackList(p: Row) {
  const clauses = [p.verdict && sql`f.verdict = ${p.verdict}`, p.source && sql`f.source = ${p.source}`].filter(Boolean);
  const query = sql`select f.id, f.retrieval_id, f.source, f.verdict, f.entry_id, f.note, f.created_at, r.query
    from memory.feedback f left join memory.retrieval r on r.id = f.retrieval_id ${where(sql, clauses)}`;
  return page(sql, query, "f.created_at desc, f.id desc", p.limit, p.offset);
}

function optionalText(data: Row, ...keys: string[]) {
  for (const k of keys) {
    if (data[k] != null) {
      if (typeof data[k] !== "string") throw new ApiError(422, `${k} must be a string.`);
      shortEnough(k, data[k]);
    }
  }
  return keys.map((k) => data[k] || null);
}

/** Wen's own verdict, logged through the same path as the agent's, with source wen. */
async function addFeedback(data: Row) {
  const [rid, verdict, entryId, note] = optionalText(data, "retrieval_id", "verdict", "entry_id", "note");
  if (!rid || !verdict) throw new ApiError(422, "Need a retrieval_id and a verdict.");
  return await sql.begin(async (tx) => {
    await audit(tx, "feedback.create", `retrieval:${rid}`, null, { verdict, entry_id: entryId, note });
    const said = await service.feedback(tx, rid, verdict, entryId, note, "wen");
    if (said !== "Logged.") throw new ApiError(422, said);
    return { ok: true };
  });
}

/** The whole board, newest first. Reading here marks nothing read, so the agents still get their mail. */
const messages = (p: Row) =>
  page(sql, sql`select id, created_at, sender, recipient, body, read_by from memory.message`, "id desc", p.limit, p.offset);

async function addMessage(data: Row) {
  const [to, body] = optionalText(data, "to", "body");
  return await sql.begin(async (tx) => {
    const aid = await audit(tx, "message.create", "message", null, { to, body });
    const said = await service.postMessage(tx, "wen", to ?? "", body ?? "");
    const m = /^Posted message (\d+) to (\w+)\.$/.exec(said);
    if (!m) throw new ApiError(422, said);
    await tx`update memory.admin_audit set target = ${`message:${m[1]}`} where id = ${aid}`;
    return { id: Number(m[1]), to: m[2] };
  });
}

// ---------------------------------------------------------------- recall preview, embeddings, devices, audit
/** What each arm would deliver for a query, through recall's own ranking and packing. No retrieval, no session. */
async function recallPreview(data: Row) {
  const [query, task] = optionalText(data, "query", "task");
  const arms = data.arms ?? Object.keys(ARMS);
  if (!query || !query.trim()) throw new ApiError(422, "Need a query.");
  if (!Array.isArray(arms) || !arms.every((a) => typeof a === "string" && a in ARMS)) {
    throw new ApiError(422, `arms must be a list drawn from ${Object.keys(ARMS).join(", ")}.`);
  }
  const out = [];
  for (const arm of arms) {
    const started = performance.now();
    const r = await service.rankAndPack(sql, arm, query, task ?? "");
    const ms = Math.round(performance.now() - started);
    const top = r.ranked.slice(0, 25);
    const t = await titles(sql, top.map(([id]) => id));
    const inPacket = new Set(r.delivered);
    out.push({
      arm, degraded: r.degraded, latency_ms: ms, packet: r.delivered, text: service.packetText(r.chunks, r.lines),
      ranked: top.map(([id, score], i) => ({ rank: i + 1, id, score, ...known(t, id), in_packet: inPacket.has(id) })),
    });
  }
  return { arms: out };
}

/** Embed what changed, one sync at a time across isolates. The lease in setting expires after five minutes, so a sync
 * that died mid-run never blocks the next. */
export async function runEmbeddingSync(trigger: string): Promise<Row | null> {
  const started = new Date().toISOString();
  const lease = await sql`insert into memory.setting (name, value) values ('embed_sync_lease', (now() + interval '5 minutes')::text)
    on conflict (name) do update set value = excluded.value where memory.setting.value::timestamptz < now() returning name`;
  if (!lease.length) return null;
  const status = (s: Row) => sql`insert into memory.setting (name, value) values ('embed_sync_status', ${JSON.stringify(s)})
    on conflict (name) do update set value = excluded.value`;
  const base = { running: true, trigger, started_at: started, finished_at: null, embedded: null, error: null };
  await status(base);
  let result: Row;
  try {
    result = { embedded: await syncEmbeddings() };
  } catch (e) {
    console.warn("embedding sync failed, hybrid serves keyword ranks until one succeeds:", e);
    result = { error: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 300) };
  }
  const done = { ...base, running: false, finished_at: new Date().toISOString(), ...result };
  await status(done);
  await sql`update memory.setting set value = now()::text where name = 'embed_sync_lease'`;
  if (trigger === "console") await audit(sql, "embeddings.sync", "embeddings", null, result);
  return done;
}

const devices = () =>
  sql`select name, hooks, created_at, last_seen, revoked_at,
      coalesce(last_seen, created_at) + interval '90 days' as lapses_at from memory.device order by revoked_at nulls first, name`;

/** Switch a computer between full and metadata-only hook payloads. */
async function setDeviceHooks(name: string, data: Row) {
  if (!HOOK_LEVELS.includes(data.hooks)) throw new ApiError(422, "hooks must be full or metadata.");
  return await sql.begin(async (tx) => {
    const [d] = await tx`update memory.device set hooks = ${data.hooks} where name = ${name} returning name, hooks`;
    if (!d) throw new ApiError(404, `No device ${name}.`);
    await audit(tx, "device.hooks", `device:${name}`, null, d);
    return d;
  });
}

/** A new computer's token, shown once. Only its SHA-256 is kept. */
/** Tell every agent a computer was connected, so Wen hears it at his next prompt. A device he didn't add is the alarm. */
async function announce(db: Sql, name: string, how: string) {
  await service.postMessage(db, "memory", "all",
    `A computer named ${name} was connected to memory ${how} at ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC. ` +
    "Tell Wen. If he didn't do it, revoke it in the console API with DELETE /api/v1/devices/" + name + ".");
}

const HOOK_LEVELS = ["full", "metadata"];

async function addDevice(data: Row) {
  const name = data.name;
  const hooks = data.hooks ?? "full";
  if (!HOOK_LEVELS.includes(hooks)) throw new ApiError(422, "hooks must be full or metadata.");
  if (typeof name !== "string" || !DEVICE.test(name)) {
    throw new ApiError(422, "name must be up to 64 lowercase letters, digits, '.', '_' or '-'.");
  }
  const token = newToken();
  return await sql.begin(async (tx) => {
    if ((await tx`select 1 from memory.device where name = ${name}`).length) throw new ApiError(409, `Device ${name} already exists.`);
    await tx`insert into memory.device (name, token_sha256, hooks) values (${name}, ${await sha256(token)}, ${hooks})`;
    await audit(tx, "device.create", `device:${name}`, null, { name, hooks });
    await announce(tx, name, "from the console");
    return { name, token, hooks };
  });
}

/** The owner's sign-in from the installer: a token for this computer, shown once. A name already taken gets a fresh
 * token, so reinstalling a computer rotates its token rather than failing. */
export async function claimDevice(data: Row) {
  const name = data?.name;
  const hooks = data?.hooks ?? "full";
  if (!HOOK_LEVELS.includes(hooks)) return Response.json({ error: "hooks must be full or metadata." }, { status: 422 });
  if (typeof name !== "string" || !DEVICE.test(name)) {
    return Response.json({ error: "name must be up to 64 lowercase letters, digits, '.', '_' or '-'." }, { status: 422 });
  }
  const token = newToken();
  await sql.begin(async (tx) => {
    await tx`insert into memory.device (name, token_sha256, hooks) values (${name}, ${await sha256(token)}, ${hooks})
      on conflict (name) do update set token_sha256 = excluded.token_sha256, hooks = excluded.hooks, revoked_at = null,
        created_at = now(), last_seen = null`;
    await audit(tx, "device.claim", `device:${name}`, null, { name, hooks });
    await announce(tx, name, "through the installer's email sign-in");
  });
  return Response.json({ name, token });
}

async function revokeDevice(name: string) {
  return await sql.begin(async (tx) => {
    const [d] = await tx`update memory.device set revoked_at = now() where name = ${name} and revoked_at is null returning name`;
    if (!d) throw new ApiError(404, `No active device ${name}.`);
    await audit(tx, "device.revoke", `device:${name}`, null, { name });
    return { revoked: name };
  });
}

/** 43 random URL-safe characters, the same strength as Python's secrets.token_urlsafe(32). */
export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Store a secret the function reads from Vault. The value never lands in the audit, only that it changed. */
async function putSecret(name: string, data: Row) {
  if (typeof data.value !== "string" || !data.value.trim()) throw new ApiError(422, "value must be a non-empty string.");
  return await sql.begin(async (tx) => {
    const [old] = await tx`select id from vault.secrets where name = ${name}`;
    if (old) await tx`select vault.update_secret(${old.id}::uuid, ${data.value.trim()})`;
    else await tx`select vault.create_secret(${data.value.trim()}, ${name})`;
    await audit(tx, "secret.set", `secret:${name}`, null, { name });
    return { set: name };
  });
}

// Tables /import fills, the same set /export writes, and the serial columns whose sequences follow the rows in.
const IMPORTABLE = new Set(["source", "entry", "link", "question", "qrel", "blob", "entry_blob", "mcp_session", "mcp_client",
  "retrieval", "event", "feedback", "message", "admin_audit", "link_type_weight", "device", "embed_usage"]);
const SERIAL = ["event", "feedback", "message", "admin_audit", "device"];
// jsonb columns go in through sql.json, or a list of strings would be sent as text[].
const JSONB = new Set(["payload", "candidates", "delivered", "rejected", "context", "before", "after"]);
const MAX_IMPORT = 8 * 1024 * 1024;

/** Load rows in /export's NDJSON shape, {table, row} per line, in one transaction. A row whose key is taken is skipped,
 * so a chunk sent twice lands once. bytea comes as {base64}. Restores a backup without database credentials. */
async function importRows(req: Request) {
  const size = req.headers.get("content-length");
  if (size && Number(size) > MAX_IMPORT) throw new ApiError(413, "The body is too large.");
  const raw = await req.text();
  if (raw.length > MAX_IMPORT) throw new ApiError(413, "The body is too large.");
  const groups: [string, Row[]][] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: Row;
    try {
      rec = JSON.parse(line);
    } catch {
      throw new ApiError(400, "Every line must be JSON.");
    }
    if (!IMPORTABLE.has(rec.table) || !rec.row || typeof rec.row !== "object") throw new ApiError(422, `Can't import ${rec.table}.`);
    const { tsv_en: _, ...row } = redact(rec.row);
    for (const [k, v] of Object.entries(row)) {
      if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && "base64" in v) {
        row[k] = Uint8Array.from(atob((v as Row).base64), (c) => c.charCodeAt(0));
      }
    }
    if (groups.at(-1)?.[0] !== rec.table) groups.push([rec.table, []]);
    groups.at(-1)![1].push(row);
  }
  const counts: Record<string, number> = {};
  await sql.begin(async (tx) => {
    for (const [table, rows] of groups) {
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500).map((r) =>
          Object.fromEntries(cols.map((c) => [c, r[c] == null ? null : JSONB.has(c) ? tx.json(r[c]) : r[c]]))
        );
        const done = await tx`insert into ${tx("memory." + table)} ${tx(chunk, ...cols)} on conflict do nothing returning 1`;
        counts[table] = (counts[table] ?? 0) + done.length;
      }
    }
    for (const t of SERIAL) {
      await tx`select setval(${`memory.${t}_id_seq`}, greatest(coalesce((select max(id) from ${tx("memory." + t)}), 1), 1))`;
    }
  });
  return { imported: counts };
}

/** The practice queries with their gold and must_not entries, for eval/retrieval_eval.py. */
const evalQuestions = (split: string) =>
  sql`select q.id, q.text, q.qtype, q.split,
      coalesce(array_agg(r.entry_id) filter (where r.grade = 2), '{}') as gold,
      coalesce(array_agg(r.entry_id) filter (where r.grade = -1), '{}') as must_not
    from memory.question q left join memory.qrel r on r.question_id = q.id
    where ${split} = 'all' or q.split = ${split} group by q.id order by q.id`;

/** One arm's full ranking and packet for a query, plus hybrid's rankers on their own, so the eval can place a miss. */
async function evalRank(data: Row) {
  const [query] = optionalText(data, "query");
  if (!query || !(data.arm in ARMS)) throw new ApiError(422, "Need a query and an arm.");
  const r = await service.rankAndPack(sql, data.arm, query, "", null, data.filter !== false,
    typeof data.tilt === "number" ? data.tilt : undefined);
  const parts = data.arm === "hybrid" ? (await hybridComponents(sql, query)).parts : null;
  return { candidates: r.ranked.map(([id]) => id), delivered: r.delivered, rejected: r.rejected, degraded: r.degraded, parts };
}

// The text each table holds, for the redaction backfill: its key column and the columns to redact.
const REDACTABLE: Record<string, [key: string, cols: string[]]> = {
  event: ["id", ["payload"]], entry: ["id", ["title", "body", "evidence"]], message: ["id", ["body"]],
  retrieval: ["id", ["query", "task", "packet"]],
};

/** Redact one page of stored rows in place with the same rules new writes get. Returns how many changed and where the
 * next page starts. */
async function redactBackfill(data: Row) {
  const table = data.table, after = data.after ?? null;
  if (!(table in REDACTABLE)) throw new ApiError(422, `table must be one of ${Object.keys(REDACTABLE).join(", ")}.`);
  const [key, cols] = REDACTABLE[table];
  const rows = await sql`select ${sql([key, ...cols])} from ${sql("memory." + table)}
    where ${after === null ? sql`true` : sql`${sql(key)}::text > ${String(after)}`} order by ${sql(key)}::text limit 500`;
  let changed = 0;
  const kinds: Record<string, number> = {};
  for (const r of rows) {
    const found: string[] = [];
    const next = Object.fromEntries(cols.map((c) => [c, redact(r[c], found)]));
    if (!found.length) continue;
    for (const k of found) kinds[k] = (kinds[k] ?? 0) + 1;
    const set = Object.fromEntries(cols.map((c) => [c, c === "payload" ? sql.json(next[c]) : next[c]]));
    await sql`update ${sql("memory." + table)} set ${sql(set)} where ${sql(key)} = ${r[key]}`;
    changed++;
  }
  return { table, scanned: rows.length, changed, kinds, next: rows.length === 500 ? String(rows.at(-1)![key]) : null };
}

/** Run the judge over stored entries, one page at a time, and report which ones it would refuse today. Changes nothing. */
async function judgeBackfill(data: Row) {
  const offset = Number(data.offset ?? 0);
  const rows = await sql`select id, title, body, evidence from memory.entry order by id limit 25 offset ${offset}`;
  const flagged: Row[] = [];
  for (const r of rows) {
    const why = await screen([r.title, r.body, r.evidence].filter(Boolean).join("\n\n"));
    if (why) flagged.push({ id: r.id, title: r.title, why });
  }
  return { scanned: rows.length, flagged, next: rows.length === 25 ? offset + 25 : null };
}

// ---------------------------------------------------------------- grooming
// The daily groom-memory skill drafts entries from Wen's own words. Every draft and reinforcement names the hook event
// its quote came from, and the quote has to appear in that event's prompt word for word, so the groomer can't put
// words in his mouth. Drafts start at confidence 0.6 and earn the rest through the learner.

const squash = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

/** The event's prompt, when `quote` appears in it word for word, else a 422. */
async function quoted(eventId: unknown, quote: unknown) {
  if (typeof quote !== "string" || squash(quote).length < 8) throw new ApiError(422, "quote must be Wen's words, at least 8 characters.");
  if (!/^\d+$/.test(String(eventId))) throw new ApiError(422, "event_id must be the hook event the quote came from.");
  const [ev] = await sql`select id, session_id, payload->>'prompt' as prompt from memory.event
    where id = ${String(eventId)} and event = 'UserPromptSubmit'`;
  if (!ev?.prompt) throw new ApiError(422, `Event ${eventId} isn't one of Wen's prompts.`);
  if (!squash(ev.prompt).includes(squash(quote))) throw new ApiError(422, `That quote isn't in event ${eventId} word for word.`);
  return ev;
}

/** Wen's prompts since the last groom, grouped by session, oldest first, up to 300 prompts. */
async function groomSessions() {
  const after = Number(await setting_("groom_checkpoint")) || 0;
  const rows = await sql`select v.id, v.session_id, v.agent, v.received_at, v.payload->>'cwd' as cwd, v.payload->>'prompt' as prompt
    from memory.event v where v.id > ${after} and v.event = 'UserPromptSubmit' and v.payload ? 'prompt'
    order by v.id limit 300`;
  const sessions = new Map<string, Row>();
  for (const r of rows) {
    const key = r.session_id ?? "unknown";
    if (!sessions.has(key)) sessions.set(key, { session_id: key, agent: r.agent, cwd: r.cwd, prompts: [] });
    sessions.get(key)!.prompts.push({ event_id: r.id, at: r.received_at, text: r.prompt });
  }
  const [{ last }] = await sql`select coalesce(max(id), 0) as last from memory.event`;
  return { after, through: rows.length ? rows.at(-1)!.id : last, more: rows.length === 300, sessions: [...sessions.values()] };
}

async function setting_(name: string) {
  const [r] = await sql`select value from memory.setting where name = ${name}`;
  return r?.value ?? "";
}

async function groomCheckpoint(data: Row) {
  if (!/^\d+$/.test(String(data.through))) throw new ApiError(422, "through must be an event id.");
  await sql`update memory.setting set value = ${String(data.through)} where name = 'groom_checkpoint'`;
  return { checkpoint: Number(data.through) };
}

/** A new entry from Wen's words. It goes through remember()'s rules, redaction and judge like any other write. */
async function groomDraft(data: Row) {
  const ev = await quoted(data.event_id, data.quote);
  let r;
  try {
    r = await remember({
      pattern: data.pattern, title: data.title, body: data.body, scope: data.scope ?? "global",
      project: data.project || null, sensitivity: data.sensitivity ?? "normal", lang: data.lang ?? "en",
      authority: "observed", evidence_kind: "quote", evidence: data.quote,
      source: { kind: "session", title: `Wen's prompt in session ${ev.session_id ?? "unknown"}`, uri: `event:${ev.id}` },
      links: data.links ?? [], supersedes: data.supersedes ?? [],
    }, "runtime");
  } catch (e) {
    if (e instanceof Refused) throw new ApiError(422, e.message);
    throw e;
  }
  const [e] = await sql`update memory.entry set confidence = least(confidence, 0.6), origin = 'groomer'
    where id = ${r.id} and origin <> 'groomer' returning confidence`;
  if (e) {
    await sql`insert into memory.confidence_log (target, before, after, reason, event_id)
      values (${"entry:" + r.id}, null, ${e.confidence}, 'drafted by the groomer from Wen''s words', ${ev.id})`;
  }
  return { id: r.id, confidence: e?.confidence ?? null };
}

/** Wen said it again in a new session: +0.15, once per event. */
async function groomReinforce(data: Row) {
  const ev = await quoted(data.event_id, data.quote);
  const id = String(data.entry_id ?? "");
  const [e] = await sql`select confidence from memory.entry where id = ${id}`;
  if (!e) throw new ApiError(404, `No entry ${id}.`);
  if ((await sql`select 1 from memory.confidence_log where target = ${"entry:" + id} and event_id = ${ev.id}`).length) {
    return { id, confidence: e.confidence, already: true };
  }
  const after = Math.min(0.99, e.confidence + 0.15);
  await sql`update memory.entry set confidence = ${after} where id = ${id}`;
  await sql`insert into memory.confidence_log (target, before, after, reason, event_id)
    values (${"entry:" + id}, ${e.confidence}, ${after}, 'Wen said it again', ${ev.id})`;
  return { id, confidence: after };
}

/** The spreading arm's per-link-type weights, as the ants left them. */
const linkTypeWeights = () =>
  sql`select src_pattern, link_type, dst_pattern, n_links, weight from memory.link_type_weight order by n_links desc`;

/** Set per-link-type weights, clamped to 0.2 to 5. eval/ants.py writes them after training on train questions. */
async function setLinkTypeWeights(data: Row) {
  const rows = data.rows;
  if (!Array.isArray(rows) || !rows.length) throw new ApiError(422, "rows must be a list of {src_pattern, link_type, dst_pattern, weight}.");
  return await sql.begin(async (tx) => {
    let n = 0;
    for (const r of rows) {
      const w = Math.min(5, Math.max(0.2, Number(r.weight)));
      if (!Number.isFinite(w)) continue;
      const done = await tx`update memory.link_type_weight set weight = ${w}
        where src_pattern = ${r.src_pattern} and link_type = ${r.link_type} and dst_pattern = ${r.dst_pattern} returning 1`;
      n += done.length;
    }
    await audit(tx, "link_type_weight.set", "link_type_weight", null, { rows: rows.length, updated: n, by: data.by ?? "ants" });
    return { updated: n };
  });
}

const auditList = (p: Row) =>
  page(sql, sql`select id, at, action, target, before, after from memory.admin_audit`, "id desc", p.limit, p.offset);

// ---------------------------------------------------------------- routing
function storable(text: string) {
  return !text.includes("\0") && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);
}
const UNSTORABLE = "has a character the database can't store.";

function query(q: URLSearchParams) {
  const text = (name: string) => {
    const v = (q.get(name) ?? "").trim() || null;
    if (v !== null && !storable(v)) throw new ApiError(400, `${name} ${UNSTORABLE}`);
    return v;
  };
  const int = (name: string, fallback: number, lo: number, hi?: number) => {
    const raw = (q.get(name) ?? "").trim();
    if (!raw) return fallback;
    if (!/^-?\d+$/.test(raw)) throw new ApiError(400, `${name} must be a whole number.`);
    const v = Number(raw);
    if (v < lo || (hi !== undefined && v > hi)) {
      throw new ApiError(400, hi === undefined ? `${name} must be at least ${lo}.` : `${name} must be ${lo} to ${hi}.`);
    }
    return v;
  };
  const choice = (name: string, choices: string[], fallback: string | null = null) => {
    const v = text(name) ?? fallback;
    if (v !== null && !choices.includes(v)) throw new ApiError(400, `${name} must be one of ${choices.join(", ")}.`);
    return v;
  };
  const flag = (name: string) => {
    const v = (text(name) ?? "false").toLowerCase();
    if (!["true", "false", "1", "0"].includes(v)) throw new ApiError(400, `${name} must be true or false.`);
    return v === "true" || v === "1";
  };
  const pageOf = () => ({ limit: Math.min(int("limit", 50, 1), 200), offset: int("offset", 0, 0, MAX_OFFSET) });
  const tz = () => {
    const v = text("tz") ?? "UTC";
    if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(v)) throw new ApiError(400, "tz must be a time zone like America/New_York.");
    return v;
  };
  const since = () => {
    const raw = text("since");
    if (raw === null) return null;
    const fixed = raw.replace(" ", "+");
    const t = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(fixed) ? fixed : fixed + "Z");
    if (isNaN(t.getTime())) throw new ApiError(400, "since must be an ISO 8601 time like 2026-10-10T00:00:00Z.");
    return t;
  };
  return { text, int, choice, flag, page: pageOf, tz, since };
}

function checkStorable(value: unknown, name: string) {
  if (typeof value === "string") {
    if (!storable(value)) throw new ApiError(422, `${name} ${UNSTORABLE}`);
  } else if (Array.isArray(value)) value.forEach((v) => checkStorable(v, name));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      checkStorable(k, name);
      checkStorable(v, name === "The body" ? k : name);
    }
  }
}

/** The body parsed as JSON, refused with 413 past cap bytes. */
export async function readJson(req: Request, cap = MAX_BODY) {
  const size = req.headers.get("content-length");
  if (size && /^\d+$/.test(size) && Number(size) > cap) throw new ApiError(413, "The body is too large.");
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.length > cap) throw new ApiError(413, "The body is too large.");
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new ApiError(400, "The body must be JSON.");
  }
}

async function body(req: Request): Promise<Row> {
  const data = await readJson(req);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ApiError(400, "The body must be a JSON object.");
  checkStorable(data, "The body");
  return data;
}

function id(value: string, name = "id") {
  const v = decodeURIComponent(value);
  if (!storable(v)) throw new ApiError(400, `${name} ${UNSTORABLE}`);
  return v;
}

type Route = [method: string, pattern: RegExp, status: number, run: (req: Request, m: string[], q: ReturnType<typeof query>) => Promise<unknown>];

const ROUTES: Route[] = [
  ["GET", /^\/overview$/, 200, () => overview()],
  ["GET", /^\/activity$/, 200, (_r, _m, q) => activity(q.int("days", 14, 1, 90), q.tz())],
  ["GET", /^\/meta$/, 200, () => meta()],
  ["GET", /^\/entries$/, 200, (_r, _m, q) => entries({
    q: q.text("q"), project: q.text("project"), authority: q.choice("authority", AUTHORITIES), pattern: q.text("pattern"),
    sensitivity: q.choice("sensitivity", SENSITIVITIES), superseded: q.choice("superseded", Object.keys(STATES), "current"),
    sort: q.choice("sort", Object.keys(ENTRY_SORTS), "id"), ...q.page(),
  })],
  ["POST", /^\/entries$/, 201, async (r) => createEntry(await body(r))],
  ["GET", /^\/entries\/([^/]+)$/, 200, (_r, m) => entry(sql, id(m[1]))],
  ["PATCH", /^\/entries\/([^/]+)$/, 200, async (r, m) => updateEntry(id(m[1]), await body(r))],
  ["DELETE", /^\/entries\/([^/]+)$/, 200, (_r, m) => deleteEntry(id(m[1]))],
  ["POST", /^\/entries\/([^/]+)\/links$/, 201, async (r, m) => {
    const d = await body(r);
    return addLink(id(m[1]), d.dst, d.type);
  }],
  ["DELETE", /^\/entries\/([^/]+)\/links\/([^/]+)\/([^/]+)$/, 200,
    (_r, m) => deleteLink(id(m[1]), id(m[2], "type"), id(m[3], "dst"))],
  ["POST", /^\/entries\/([^/]+)\/supersede$/, 201, async (r, m) => supersede(id(m[1]), (await body(r)).by)],
  ["GET", /^\/graph$/, 200, (_r, _m, q) => graph(q.text("project"), q.flag("include_superseded"))],
  ["GET", /^\/sessions$/, 200, (_r, _m, q) => sessions({ client: q.text("client"), arm: q.text("arm"), ...q.page() })],
  ["GET", /^\/sessions\/([^/]+)$/, 200, (_r, m) => session(id(m[1]))],
  ["GET", /^\/events$/, 200, (_r, _m, q) => events({
    event: q.text("event"), session_id: q.text("session_id"), agent: q.text("agent"), since: q.since(), ...q.page(),
  })],
  ["GET", /^\/events\/([^/]+)$/, 200, (_r, m) => event(id(m[1]))],
  ["GET", /^\/retrievals$/, 200, (_r, _m, q) => retrievals({ arm: q.text("arm"), client: q.text("client"), q: q.text("q"), ...q.page() })],
  ["GET", /^\/retrievals\/([^/]+)$/, 200, (_r, m) => retrieval(id(m[1]))],
  ["GET", /^\/feedback$/, 200, (_r, _m, q) => feedbackList({ verdict: q.text("verdict"), source: q.text("source"), ...q.page() })],
  ["POST", /^\/feedback$/, 201, async (r) => addFeedback(await body(r))],
  ["GET", /^\/messages$/, 200, (_r, _m, q) => messages(q.page())],
  ["POST", /^\/messages$/, 201, async (r) => addMessage(await body(r))],
  ["POST", /^\/recall\/preview$/, 200, async (r) => recallPreview(await body(r))],
  ["GET", /^\/devices$/, 200, () => devices()],
  ["POST", /^\/devices$/, 201, async (r) => addDevice(await body(r))],
  ["DELETE", /^\/devices\/([^/]+)$/, 200, (_r, m) => revokeDevice(id(m[1], "name"))],
  ["PATCH", /^\/devices\/([^/]+)$/, 200, async (r, m) => setDeviceHooks(id(m[1], "name"), await body(r))],
  ["PUT", /^\/secrets\/(openai_key)$/, 200, async (r, m) => putSecret(m[1], await body(r))],
  ["POST", /^\/import$/, 200, (r) => importRows(r)],
  ["GET", /^\/link-type-weights$/, 200, () => linkTypeWeights()],
  ["PUT", /^\/link-type-weights$/, 200, async (r) => setLinkTypeWeights(await body(r))],
  ["GET", /^\/groom\/sessions$/, 200, () => groomSessions()],
  ["POST", /^\/groom\/checkpoint$/, 200, async (r) => groomCheckpoint(await body(r))],
  ["POST", /^\/groom\/draft$/, 201, async (r) => groomDraft(await body(r))],
  ["POST", /^\/groom\/reinforce$/, 200, async (r) => groomReinforce(await body(r))],
  ["POST", /^\/redact\/backfill$/, 200, async (r) => redactBackfill(await body(r))],
  ["POST", /^\/judge\/backfill$/, 200, async (r) => judgeBackfill(await body(r))],
  ["GET", /^\/eval\/questions$/, 200, (_r, _m, q) => evalQuestions(q.choice("split", ["all", "train", "test"], "train")!)],
  ["POST", /^\/eval\/rank$/, 200, async (r) => evalRank(await body(r))],
  ["GET", /^\/audit$/, 200, (_r, _m, q) => auditList(q.page())],
];

export async function handle(req: Request, path: string): Promise<Response> {
  const sub = path.replace(/^\/api\/v1/, "") || "/";
  if (req.method === "POST" && sub === "/embeddings/sync") {
    const [lease] = await sql`select value from memory.setting where name = 'embed_sync_lease'`;
    if (lease && new Date(lease.value) > new Date()) return Response.json({ error: "An embedding sync is already running." }, { status: 409 });
    EdgeRuntime.waitUntil(runEmbeddingSync("console"));
    return Response.json({ started: true }, { status: 202 });
  }
  const matches = ROUTES.filter(([, pattern]) => pattern.test(sub));
  if (!matches.length) return Response.json({ error: "No such endpoint." }, { status: 404 });
  const route = matches.find(([method]) => method === req.method);
  if (!route) return Response.json({ error: "That method is not allowed here." }, { status: 405 });
  const [, pattern, status, run] = route;
  try {
    return Response.json(await run(req, pattern.exec(sub)!, query(new URL(req.url).searchParams)), { status });
  } catch (e) {
    if (e instanceof ApiError) return Response.json({ error: e.error }, { status: e.status });
    console.error(e);
    return Response.json({ error: "The server hit an error. Its log has the details." }, { status: 500 });
  }
}
