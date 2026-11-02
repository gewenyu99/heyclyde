// What the MCP tools and hook endpoints do, independent of transport, so tests can call it directly.
import { config } from "./config.ts";
import { type Row, type Sql, sql } from "./db.ts";
import { ARMS, fetchEntries, pack, type Ranked, redact as redactPrivate, renderEntry } from "./search.ts";
import { Refused, SCOPE_RE } from "./write.ts";
import { redact, redactText } from "./redact.ts";
import { relevance, screen } from "./judge.ts";

const RID = /retrieval ([0-9a-f-]{36})/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PRIVATE_BLOB = "[private blob: ask Wen]";
const PAGE_MAX = 100_000;

/** The session's arm, drawn once at random on first use. The agent and Wen never see it. */
export async function sessionArm(db: Sql, session: string, client: string | null = null): Promise<string> {
  const arm = config.arms[Math.floor(Math.random() * config.arms.length)];
  const [row] = await db`insert into memory.mcp_session (id, arm, client) values (${session}, ${arm}, ${client})
    on conflict (id) do nothing returning arm`;
  if (row) return row.arm;
  const [existing] = await db`select arm from memory.mcp_session where id = ${session}`;
  return existing.arm;
}

// The filter reads this many of an arm's top candidates and keeps the ones the judge calls relevant. Tuned on train only.
const FILTER_K = 12;
const FILTER_THRESHOLD = Number(Deno.env.get("MEMORY_FILTER_THRESHOLD") ?? 0.5);

/** What the filter shows the judge for one candidate. Private and confidential entries go by title alone, since their
 * bodies never reach a third-party model. */
function itemText(line: string | null, row: Row | undefined) {
  if (line !== null) return line;
  const r = redactPrivate(row!);
  return `${r.title}. ${r.sensitivity === "normal" ? r.body : ""}`.trim();
}

/** One arm's ranking and the packet recall delivers from it. Writes nothing, so the console can preview an arm.
 * With a scope like run:abc, that run's entries are candidates too and rank first.
 *
 * Every arm's candidates pass the same relevance filter before packing, so the arms stay comparable. The judge reads the
 * top FILTER_K and drops what it calls irrelevant. When it drops them all, recall says nothing matches rather than
 * serving noise. When it can't answer, the ranking goes out unfiltered and `degraded` says so. */
export async function rankAndPack(db: Sql, arm: string, query: string, task = "", scope: string | null = null,
  filter = true) {
  const request = task ? `${task}\n${query}`.trim() : query;
  const [ranked, armDegraded] = await ARMS[arm](db, request, scope || null);
  const lines = ranked.every(([, , line]) => line !== null);
  const rows = lines ? {} : await fetchEntries(db, ranked.slice(0, FILTER_K * 2).map(([id]) => id));
  let candidates = ranked, rejected: string[] = [], filterDegraded: string | null = null;
  if (filter && ranked.length) {
    const top = ranked.filter(([id, , line]) => line !== null || id in rows).slice(0, FILTER_K);
    try {
      const p = await relevance(request, top.map(([id, , line]) => itemText(line, rows[id])));
      candidates = top.filter((_, i) => p[i] >= FILTER_THRESHOLD);
      rejected = top.filter((_, i) => p[i] < FILTER_THRESHOLD).map(([id]) => id);
    } catch (e) {
      filterDegraded = `filter-failed: ${(e as Error).name}`;
    }
  }
  const [delivered, chunks] = pack(candidates, rows);
  const degraded = [armDegraded, filterDegraded].filter(Boolean).join("; ") || null;
  return { ranked, degraded, delivered, chunks, lines, rejected };
}

/** What the agent reads under the retrieval id. The console's preview shows the same text. */
export function packetText(chunks: string[], lines: boolean) {
  if (!chunks.length) return "Nothing in memory matches. Ask Wen rather than guessing.";
  if (lines) return "Index lines that match. Open any with get_entry(id).\n" + chunks.join("\n");
  return chunks.join("\n\n");
}

/** Search memory. With a scope like run:abc, that run's entries are candidates too and rank first. */
export async function recall(session: string, query: string, task = "", client: string | null = null,
  scope: string | null = null) {
  if (scope && !SCOPE_RE.test(scope)) throw new Refused(`scope ${JSON.stringify(scope)} must look like run:<id>, or be left out.`);
  query = redactText(query)[0];
  task = redactText(task)[0];
  const started = performance.now();
  const arm = await sessionArm(sql, session, client);
  const { ranked, degraded, delivered, chunks, lines, rejected } = await rankAndPack(sql, arm, query, task, scope);
  const rid = crypto.randomUUID(), text = packetText(chunks, lines);
  await sql`insert into memory.retrieval (id, mcp_session, arm, query, task, scope, candidates, delivered, rejected, latency_ms,
      degraded, packet)
    values (${rid}, ${session}, ${arm}, ${query}, ${task || null}, ${scope || null},
      ${sql.json(ranked.map(([id, score]: Ranked) => ({ id, score })))}, ${sql.json(delivered)}, ${sql.json(rejected)},
      ${Math.round(performance.now() - started)}, ${degraded}, ${text})`;
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

/** claude or codex from an MCP client name like claude-code or codex-mcp-client. Anything else keeps its own name. */
export function agentName(client: string | null) {
  const c = (client ?? "").toLowerCase();
  return c.includes("claude") ? "claude" : c.includes("codex") ? "codex" : c || "agent";
}

const AGENTS = ["claude", "codex", "all"];

export async function postMessage(db: Sql, sender: string, to: string, body: string) {
  to = to.trim().toLowerCase();
  body = body.trim();
  if (!AGENTS.includes(to) || !body) return "Need a recipient (claude, codex or all) and a body.";
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
  const [row] = await db`insert into memory.message (sender, recipient, body) values (${sender}, ${to}, ${body}) returning id`;
  return `Posted message ${row.id} to ${to}.`;
}

const stamp = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

/** Unread messages for me or all, oldest first, as text, marked read for me only. One statement claims them, so two
 * readers at once never get the same message. */
export async function readMessages(me: string) {
  const rows = await sql`update memory.message set read_by = array_append(read_by, ${me}) where id in (
      select id from memory.message where recipient in (${me}, 'all') and sender <> ${me} and not (${me} = any(read_by))
      order by id limit 20 for update skip locked)
    returning id, sender, recipient, body, created_at`;
  if (!rows.length) return "";
  const lines = [...rows].sort((a, b) => a.id - b.id)
    .map((r) => `- #${r.id} from ${r.sender} to ${r.recipient} at ${stamp(r.created_at)} UTC: ${r.body}`);
  return "Messages from your other agents (reply with post_message):\n" + lines.join("\n") + "\n";
}
