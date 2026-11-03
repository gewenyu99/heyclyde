// What the MCP tools and hook endpoints do, independent of transport, so tests can call it directly.
import { sessionSet, unitOf } from "./allocation.ts";
import { type Row, type Sql, sql } from "./db.ts";
import { features } from "./features.ts";
import type { Params, ParamSet } from "./params.ts";
import { ARMS, fetchEntries, pack, type Ranked, redact as redactPrivate, renderEntry } from "./search.ts";
import { Refused, SCOPE_RE } from "./write.ts";
import { redact, redactText } from "./redact.ts";
import { relevance, screen } from "./judge.ts";

const RID = /retrieval ([0-9a-f-]{36})/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PRIVATE_BLOB = "[private blob: ask Wen]";
const PAGE_MAX = 100_000;

/** The arm's ranking with dormant entries dropped and every score tilted by its entry's confidence, and the confidences
 * the tilt read. Confidence tilts the ranking without overriding it: score × (tiltBase + (1 - tiltBase) × confidence). */
async function tilt(db: Sql, ranked: Ranked[], p: Params): Promise<[Ranked[], Map<string, number>]> {
  const ids = ranked.slice(0, p.tiltWindow).map(([id]) => id);
  if (!ids.length) return [ranked, new Map()];
  const conf = new Map((await db`select id, confidence from memory.entry where id = any(${ids}::text[])`)
    .map((r) => [r.id, r.confidence as number]));
  const tilted = ranked
    .filter(([id]) => (conf.get(id) ?? 1) >= p.dormant)
    .map(([id, score, line]): Ranked => [id, score * (p.tiltBase + (1 - p.tiltBase) * (conf.get(id) ?? p.tiltUnknownConfidence)), line])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return [tilted, conf];
}

/** What the filter shows the judge for one candidate. Private and confidential entries go by title alone, since their
 * bodies never reach a third-party model. */
function itemText(line: string | null, row: Row | undefined) {
  if (line !== null) return line;
  const r = redactPrivate(row!);
  return `${r.title}. ${r.sensitivity === "normal" ? r.body : ""}`.trim();
}

/** One parameter set's ranking and the packet recall delivers from it. Writes nothing, so the console can preview a set.
 * With a scope like run:abc, that run's entries are candidates too and rank first.
 *
 * Every arm's candidates pass the same relevance filter before packing, so the arms stay comparable. The judge reads the
 * top filterK and drops what it calls irrelevant. When it drops them all, recall says nothing matches rather than
 * serving noise. When it can't answer, the ranking goes out unfiltered and `degraded` says so. */
export async function rankAndPack(db: Sql, set: ParamSet, query: string, task = "", scope: string | null = null, filter = true) {
  const p = set.params;
  const request = task ? `${task}\n${query}`.trim() : query;
  const [armRanked, armDegraded, trace] = await ARMS[set.arm](db, request, scope || null, p);
  const [ranked, confidence] = await tilt(db, armRanked, p);
  const lines = ranked.every(([, , line]) => line !== null);
  const rows = lines ? {} : await fetchEntries(db, ranked.slice(0, p.rowWindow).map(([id]) => id));
  let candidates = ranked, rejected: string[] = [], filterDegraded: string | null = null;
  const judged = new Map<string, number>();
  if (filter && ranked.length) {
    const top = ranked.filter(([id, , line]) => line !== null || id in rows).slice(0, p.filterK);
    try {
      const odds = await relevance(request, top.map(([id, , line]) => itemText(line, rows[id])));
      top.forEach(([id], i) => judged.set(id, odds[i]));
      candidates = top.filter((_, i) => odds[i] >= p.filterThreshold);
      rejected = top.filter((_, i) => odds[i] < p.filterThreshold).map(([id]) => id);
    } catch (e) {
      filterDegraded = `filter-failed: ${(e as Error).name}`;
    }
  }
  const [delivered, chunks] = pack(candidates, rows, p);
  const degraded = [armDegraded, filterDegraded].filter(Boolean).join("; ") || null;
  return { ranked, degraded, delivered, chunks, lines, rejected, features: features(ranked, trace, confidence, judged) };
}

/** The line a degraded recall leads with, so the caller knows the results are weaker than usual. */
function degradedLine(degraded: string) {
  const how = [degraded.includes("embed-failed") && "keyword-only", degraded.includes("filter-failed") && "unfiltered"];
  return `Degraded: ${degraded}; results are ${how.filter(Boolean).join(" and ") || "partial"}.`;
}

/** What the agent reads under the retrieval id. The console's preview shows the same text. */
export function packetText(chunks: string[], lines: boolean, degraded: string | null = null) {
  const head = degraded ? degradedLine(degraded) + "\n\n" : "";
  if (!chunks.length) return head + "Nothing in memory matches. Ask Wen rather than guessing.";
  if (lines) return head + "Index lines that match. Open any with get_entry(id).\n" + chunks.join("\n");
  return head + chunks.join("\n\n");
}

/** Search memory. With a scope like run:abc, that run's entries are candidates too and rank first. */
export async function recall(session: string, query: string, task = "", client: string | null = null,
  scope: string | null = null, principal = "anyone") {
  if (scope && !SCOPE_RE.test(scope)) throw new Refused(`scope ${JSON.stringify(scope)} must look like run:<id>, or be left out.`);
  query = redactText(query)[0];
  task = redactText(task)[0];
  const started = performance.now();
  const { set, propensity } = await sessionSet(sql, session, unitOf(scope, principal, client), client);
  const { ranked, degraded, delivered, chunks, lines, rejected, features: logged } = await rankAndPack(sql, set, query, task, scope);
  const rid = crypto.randomUUID(), text = packetText(chunks, lines, degraded);
  // Only a whole recall ticks the clock, so a degraded one takes no seq.
  const seq = degraded ? null : sql`nextval('memory.retrieval_seq')`;
  await sql`insert into memory.retrieval (id, mcp_session, arm, query, task, scope, candidates, delivered, rejected, latency_ms,
      degraded, packet, param_set, propensity, seq, context)
    values (${rid}, ${session}, ${set.arm}, ${query}, ${task || null}, ${scope || null},
      ${sql.json(ranked.map(([id, score]: Ranked) => ({ id, score })))}, ${sql.json(delivered)}, ${sql.json(rejected)},
      ${Math.round(performance.now() - started)}, ${degraded}, ${text}, ${set.id}, ${propensity}, ${seq},
      ${sql.json({ param_set: set.id, candidates: logged })})`;
  return `retrieval ${rid}\n\n${text}`;
}

/** The entry rendered for an agent, with its links and blobs. null when there is no such entry. */
export async function getEntry(session: string, id: string): Promise<string | null> {
  const rows = await fetchEntries(sql, [id]);
  if (!(id in rows)) return null;
  const links = await sql`select 'to' as dir, l.type, l.dst as other, e.title from memory.link l
      join memory.entry e on e.id = l.dst where l.src = ${id}
    union all select 'from', l.type, l.src, e.title from memory.link l join memory.entry e on e.id = l.src where l.dst = ${id}
    order by 1, 2, 3`;
  const blobs = await sql`select x.name, x.sha256, b.media_type, b.size from memory.entry_blob x
    join memory.blob b on b.sha256 = x.sha256 where x.entry_id = ${id} order by x.name`;
  await sql`insert into memory.event (session_id, event, payload) values (${session}, 'get_entry', ${sql.json({ entry_id: id })})`;
  return renderEntry(rows[id], links, blobs);
}

/** The blob and whether some public entry attaches it. A blob only private entries reach stays private, and so does
 * one no entry reaches any more. null when memory has no such blob. */
export async function readBlob(sha: string): Promise<Row | null> {
  const [row] = await sql`select b.media_type, b.size, b.content,
      coalesce(bool_or(e.sensitivity <> 'private'), false) as public
    from memory.blob b left join memory.entry_blob x on x.sha256 = b.sha256 left join memory.entry e on e.id = x.entry_id
    where b.sha256 = ${sha.trim().toLowerCase()} group by b.sha256`;
  return row ?? null;
}

/** A blob's text, one page of characters at a time, with the call for the next page. */
export async function getBlob(sha: string, offset = 0, limit = 20000) {
  sha = sha.trim().toLowerCase();
  const row = await readBlob(sha);
  if (!row) return `No blob ${sha}.`;
  if (!row.public) return PRIVATE_BLOB;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(row.content);
  } catch {
    return `Blob ${sha} is ${row.size} bytes of binary ${row.media_type}. get_blob only pages text.`;
  }
  if (offset < 0 || limit < 1) return "offset must be 0 or more, and limit 1 or more.";
  if (offset && offset >= text.length) return `Blob ${sha} has ${text.length} characters, so offset ${offset} is past the end.`;
  const end = Math.min(offset + Math.min(limit, PAGE_MAX), text.length);
  let head = `Blob ${sha}: ${row.media_type}, characters ${offset} to ${end} of ${text.length}.`;
  if (end < text.length) head += `\nNext page: get_blob("${sha}", offset=${end})`;
  return `${head}\n\n${text.slice(offset, end)}`;
}

/** The agent's own report is logged and never moves weights alone. */
export async function feedback(db: Sql, retrievalId: string, verdict: string, entryId: string | null = null,
  note: string | null = null, source = "agent") {
  if (!["helpful", "irrelevant", "wrong"].includes(verdict)) return "verdict must be helpful, irrelevant or wrong.";
  if (!UUID.test(retrievalId)) return `No retrieval ${retrievalId}.`;
  if (!(await db`select 1 from memory.retrieval where id = ${retrievalId}`).length) return `No retrieval ${retrievalId}.`;
  await db`insert into memory.feedback (retrieval_id, source, verdict, entry_id, note)
    values (${retrievalId}, ${source}, ${verdict}, ${entryId}, ${note})`;
  return "Logged.";
}

/** Postgres text and jsonb refuse NUL, and one in a prompt or tool output would lose the whole event. Drop them. */
export function noNul(value: any): any {
  if (typeof value === "string") return value.replaceAll("\0", "");
  if (Array.isArray(value)) return value.map(noNul);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [noNul(k), noNul(v)]));
  return value;
}

/** Store a lifecycle hook payload, with the agent memory-hook names. A recall's PostToolUse also ties the MCP session
 * to the client's session id. */
export async function hook(event: string, payload: Row, agent: string | null = null) {
  event = noNul(event);
  payload = redact(noNul(payload));
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : null;
  await sql`insert into memory.event (session_id, event, payload, agent) values (${sessionId}, ${event}, ${sql.json(payload)}, ${agent})`;
  if (event === "PostToolUse" && String(payload.tool_name ?? "").endsWith("recall") && sessionId) {
    const m = RID.exec(JSON.stringify(payload.tool_response ?? ""));
    if (m) {
      await sql`update memory.mcp_session set claude_session_id = ${sessionId}
        where id = (select mcp_session from memory.retrieval where id = ${m[1]})`;
    }
  }
}

/** claude or codex from an MCP client name like claude-code or codex-mcp-client. Anything else keeps its own name, with
 * anything outside a-z, 0-9, _ and - turned into a hyphen, at most 40 characters. memory.agent_name() in the queue
 * migration is the same rule in sql, and it's what 'all' fans out by. */
export function agentName(client: string | null) {
  const c = (client ?? "").toLowerCase();
  return c.includes("claude") ? "claude" : c.includes("codex") ? "codex"
    : c.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
}

const AGENTS = ["claude", "codex", "all"];
const AGENT = /^[a-z0-9_-]{1,40}$/;
// A delivery that isn't acknowledged comes back after this long, up to three times.
const REDELIVER_MINUTES = 30;

export async function postMessage(db: Sql, sender: string, to: string, body: string) {
  to = to.trim().toLowerCase();
  body = body.trim();
  // claude, codex and all, or any other agent memory has seen in the last 30 days.
  const known = AGENTS.includes(to) ||
    (AGENT.test(to) && (await db`select exists (select 1 from memory.agent_names() a where a = ${to}::text) as known`)[0].known);
  if (!known || !body) return "Need a recipient (claude, codex or all) and a body.";
  if (to === sender) return "That's you. Message another agent, or all.";
  body = redactText(body)[0];
  // Messages land straight in another agent's context, so they pass the same judge as notes. Wen's own, from the
  // console, don't.
  if (sender !== "wen" && sender !== "memory") {
    let why: string | null;
    try {
      why = await screen(body);
    } catch {
      return "memory couldn't screen this message right now, so it didn't post it. Try again later.";
    }
    if (why) return `Not posted: ${why}`;
  }
  // One statement, so a message never exists without its deliveries. All fans out to every agent name seen lately but
  // the sender's own, and when that's no one, nothing is posted.
  const [row] = await db`with r as (
      select a as name from memory.agent_names() a where ${to}::text = 'all' and a <> ${sender}::text
      union select ${to}::text where ${to}::text <> 'all'),
    m as (insert into memory.message (sender, recipient, body)
      select ${sender}::text, ${to}::text, ${body}::text where exists (select 1 from r) returning id),
    d as (insert into memory.message_delivery (message_id, recipient) select m.id, r.name from m, r returning 1)
    select id from m`;
  if (!row) return "No other agent has been seen in the last 30 days, so nobody got it.";
  return `Posted message ${row.id} to ${to}.`;
}

const stamp = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");
const count = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;

/** Up to 20 of my waiting deliveries, oldest first, claimed in one statement: each is hidden for 30 minutes and counted
 * as delivered, and with `ack` it's acknowledged on the spot. skip locked keeps two readers at once from claiming the
 * same one. A delivery already out three times without an ack is dropped here first, with a note to its sender. */
async function claimMessages(me: string, ack: boolean) {
  return await sql.begin(async (tx) => {
    await tx`select memory.drop_exhausted(${me}::text)`;
    return await tx`with picked as (
        update memory.message_delivery d set delivered_count = d.delivered_count + 1,
          visible_after = now() + make_interval(mins => ${REDELIVER_MINUTES}::int),
          acked_at = case when ${ack}::boolean then now() end
        where d.id in (
          select d2.id from memory.message_delivery d2 join memory.message m on m.id = d2.message_id
          where d2.recipient = ${me}::text and d2.acked_at is null and d2.dropped_at is null and d2.visible_after <= now()
            and m.expires_at > now()
          order by d2.id limit 20 for update of d2 skip locked)
        returning d.id, d.message_id)
      select p.id, p.message_id, m.sender, m.recipient, m.body, m.created_at
      from picked p join memory.message m on m.id = p.message_id order by p.id`;
  });
}

const line = (r: Row, id: number) => `- #${id} from ${r.sender} to ${r.recipient} at ${stamp(r.created_at)} UTC: ${r.body}`;

/** The hook inbox: my waiting messages as text, acknowledged as they print, since the agent sees them in its context.
 * Hooks have read this format since before the queue, message ids and all. */
export async function readMessages(me: string) {
  const rows = await claimMessages(me, true);
  if (!rows.length) return "";
  return "Messages from your other agents (reply with post_message):\n" + rows.map((r) => line(r, r.message_id)).join("\n") + "\n";
}

/** check_messages: the same list, numbered by message id the same way, left waiting until ack_messages or a dismiss. */
export async function checkMessages(me: string) {
  const rows = await claimMessages(me, false);
  if (!rows.length) return "";
  return "Messages from your other agents (reply with post_message):\n" + rows.map((r) => line(r, r.message_id)).join("\n") + "\n" +
    `Call ack_messages with ids [${rows.map((r) => r.message_id).join(", ")}] once you've handled them. A message you don't ` +
    `acknowledge comes back in ${REDELIVER_MINUTES} minutes, up to 3 times.\n`;
}

/** Message ids from a tool argument: a list of whole numbers or numeric strings, or one of them. */
function messageIds(raw: unknown): number[] | null {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const ids = list.map((v) => typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : v);
  return ids.length && ids.every((v) => Number.isSafeInteger(v) && (v as number) > 0) ? ids as number[] : null;
}

/** Closes my deliveries of these messages, by acknowledging or dismissing them. A message and a recipient have one
 * delivery, so the id check_messages and the hook inbox print picks it out. Only mine count: any other id, taken or made
 * up, changes nothing and comes back as "not yours". */
async function closeDeliveries(me: string, raw: unknown, verb: string, everything: boolean) {
  const ids = everything ? null : messageIds(raw);
  if (!everything && !ids) return "Need the ids check_messages listed, like [12, 13].";
  const done = everything
    ? await sql`update memory.message_delivery set acked_at = now()
        where recipient = ${me}::text and acked_at is null and dropped_at is null returning id`
    : await sql`update memory.message_delivery set acked_at = now()
        where message_id = any(${ids}::bigint[]) and recipient = ${me}::text and acked_at is null and dropped_at is null returning id`;
  let said = `${verb} ${count(done.length, "message")}.`;
  if (ids) {
    const mine = new Set(
      (await sql`select message_id from memory.message_delivery where message_id = any(${ids}::bigint[]) and recipient = ${me}::text`)
        .map((r) => Number(r.message_id)),
    );
    said += [...new Set(ids)].filter((id) => !mine.has(id)).map((id) => ` Message ${id}: not yours.`).join("");
  }
  return said;
}

/** ack_messages: I've handled these messages. */
export const ackMessages = (me: string, ids: unknown) => closeDeliveries(me, ids, "Acknowledged", false);

/** dismiss_messages: clear these messages, or all of mine, unread. */
export function dismissMessages(me: string, ids: unknown) {
  const all = ids === "all" || (Array.isArray(ids) && ids.includes("all"));
  return closeDeliveries(me, ids, "Dismissed", all);
}
