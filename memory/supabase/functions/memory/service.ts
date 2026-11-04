// What the MCP tools and hook endpoints do, independent of transport, so tests can call it directly.
import { sessionSet, unitOf } from "./allocation.ts";
import { type Row, type Sql, sql } from "./db.ts";
import { features } from "./features.ts";
import type { Params, ParamSet } from "./params.ts";
import { ARMS, fetchEntries, pack, type Ranked, redact as redactPrivate, renderEntry } from "./search.ts";
import * as store from "./blobs.ts";
import { MEDIA_TYPE_RE, Refused, SCOPE_RE } from "./write.ts";
import { redact, redactText } from "./redact.ts";
import { relevance, screen } from "./judge.ts";
import { BAD_VERDICT, checkFeedback, feedbackFooter, REMIND_MAX, reminderLine, VERDICTS } from "./feedback.ts";
import { renderTrialItem, TRIAL_CHANCES } from "./trial.ts";
import { provenanceLines, type Viewer } from "./provenance.ts";

const RID = /retrieval ([0-9a-f-]{36})/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PRIVATE_BLOB = "[private blob: ask Wen]";
const PAGE_MAX = 100_000;

/** The arm's ranking with dormant entries dropped and every score tilted by its entry's confidence, the confidences the tilt
 * read, and the chances each entry has left. Confidence tilts the ranking without overriding it:
 * score × (tiltBase + (1 - tiltBase) × confidence). */
async function tilt(db: Sql, ranked: Ranked[], p: Params): Promise<[Ranked[], Map<string, number>, Map<string, number>]> {
  const ids = ranked.slice(0, p.tiltWindow).map(([id]) => id);
  if (!ids.length) return [ranked, new Map(), new Map()];
  const found = await db`select id, confidence, chances_left from memory.entry where id = any(${ids}::text[])`;
  const conf = new Map(found.map((r) => [r.id, r.confidence as number]));
  const chances = new Map(found.map((r) => [r.id, r.chances_left as number]));
  const tilted = ranked
    .filter(([id]) => (conf.get(id) ?? 1) >= p.dormant)
    .map(([id, score, line]): Ranked => [id, score * (p.tiltBase + (1 - p.tiltBase) * (conf.get(id) ?? p.tiltUnknownConfidence)), line])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return [tilted, conf, chances];
}

/** What the filter shows the judge for one candidate. Private and confidential entries go by title alone, since their
 * bodies never reach a third-party model. */
function itemText(line: string | null, row: Row | undefined) {
  if (line !== null) return line;
  const r = redactPrivate(row!);
  return `${r.title}. ${r.sensitivity === "normal" ? r.body : ""}`.trim();
}

/** One parameter set's ranking and the packet recall delivers from it. Writes nothing, so the console can preview a set.
 * Every run's entries are candidates. With a scope like run:abc, that run's rank first.
 *
 * Every arm's candidates pass the same relevance filter before packing, so the arms stay comparable. The judge reads the
 * top filterK and drops what it calls irrelevant. When it drops them all, recall says nothing matches rather than
 * serving noise. When it can't answer, the ranking goes out unfiltered and `degraded` says so.
 *
 * With `lane` and a set whose trialItems is above 0, entries that still have chances left leave the main list. The best
 * trialItems of them that the judge rates at or above trialFloor come back in `trial`, ranked by the same arm, for recall
 * to spend a chance on. Previews and the eval pass no lane, so they spend nothing and rank every entry in one list. */
export async function rankAndPack(db: Sql, set: ParamSet, query: string, task = "", scope: string | null = null, filter = true, lane = false,
  viewer: Viewer = null) {
  const p = set.params;
  const request = task ? `${task}\n${query}`.trim() : query;
  const [armRanked, armDegraded, trace, frontier] = await ARMS[set.arm](db, request, scope || null, p);
  const [ranked, confidence, chances] = await tilt(db, armRanked, p);
  const split = lane && (p.trialItems ?? 0) > 0 && set.arm !== "index";
  const onTrial = ([id]: Ranked) => split && (chances.get(id) ?? 0) > 0;
  const settled = ranked.filter((r) => !onTrial(r)), waiting = ranked.filter(onTrial);
  const lines = ranked.every(([, , line]) => line !== null);
  const window = (list: Ranked[]) => list.slice(0, p.rowWindow).map(([id]) => id);
  const rows = lines ? {} : await fetchEntries(db, [...window(settled), ...window(waiting)]);
  let candidates = settled, rejected: string[] = [], filterDegraded: string | null = null, trial: string[] = [];
  const judged = new Map<string, number>();
  if (filter && ranked.length) {
    const loaded = ([id, , line]: Ranked) => line !== null || id in rows;
    const top = settled.filter(loaded).slice(0, p.filterK), trialTop = waiting.filter(loaded).slice(0, p.filterK);
    try {
      const odds = await relevance(request, [...top, ...trialTop].map(([id, , line]) => itemText(line, rows[id])));
      [...top, ...trialTop].forEach(([id], i) => judged.set(id, odds[i]));
      candidates = top.filter(([id]) => judged.get(id)! >= p.filterThreshold);
      rejected = top.filter(([id]) => judged.get(id)! < p.filterThreshold).map(([id]) => id);
      trial = trialTop.filter(([id]) => judged.get(id)! >= (p.trialFloor ?? p.filterThreshold)).slice(0, p.trialItems).map(([id]) => id);
    } catch (e) {
      filterDegraded = `filter-failed: ${(e as Error).name}`;
    }
  }
  // R41: each item says where it came from. Nothing is filtered by it. An index line is its own item, so the line goes on its end.
  const tagged = await provenanceLines(db, [...candidates.map(([id]) => id), ...trial], viewer);
  for (const [id, line] of tagged) if (id in rows) rows[id] = { ...rows[id], provenance: line };
  candidates = candidates.map(([id, score, line]): Ranked => line !== null && tagged.has(id) ? [id, score, `${line} · ${tagged.get(id)}`] : [id, score, line]);
  const [delivered, chunks] = pack(candidates, rows, p);
  const degraded = [armDegraded, filterDegraded].filter(Boolean).join("; ") || null;
  return { ranked, degraded, delivered, chunks, lines, rejected, trial, rows, frontier, features: features(ranked, trace, confidence, judged) };
}

/** The line a degraded recall leads with, so the caller knows the results are weaker than usual. */
function degradedLine(degraded: string) {
  const how = [degraded.includes("embed-failed") && "keyword-only", degraded.includes("filter-failed") && "unfiltered"];
  return `Degraded: ${degraded}; results are ${how.filter(Boolean).join(" and ") || "partial"}.`;
}

/** What the agent reads under the retrieval id. The console's preview shows the same text. Entries on trial come last, under
 * a line that is exactly "On trial". */
export function packetText(chunks: string[], lines: boolean, degraded: string | null = null, trial: string[] = []) {
  const head = degraded ? degradedLine(degraded) + "\n\n" : "";
  if (!chunks.length && !trial.length) return head + "Nothing in memory matches. Ask Wen rather than guessing.";
  const main = !chunks.length ? "" : lines ? "Index lines that match. Open any with get_entry(id).\n" + chunks.join("\n") : chunks.join("\n\n");
  if (!trial.length) return head + main;
  return head + (main ? main + "\n\n" : "") + "On trial\n" + trial.join("\n\n");
}

/** Search memory. Every run's entries are candidates. With a scope like run:abc, that run's rank first.
 *
 * An MCP recall without a scope also serves the trial lane of a set that has one: entries with chances left come under "On
 * trial", and each one shown spends a chance. The spend, the packet and the retrieval row are one transaction, so a recall that
 * fails spends nothing, and an entry whose last chance a concurrent recall took is dropped from this packet. A scoped recall
 * serves its run's notes in the main list, and an HTTP recall (clyde-flow) has no way to give feedback or see a trial list. */
export async function recall(session: string, query: string, task = "", client: string | null = null,
  scope: string | null = null, principal = "anyone", agent: string = agentName(client)) {
  if (scope && !SCOPE_RE.test(scope)) throw new Refused(`scope ${JSON.stringify(scope)} must look like run:<id>, or be left out.`);
  query = redactText(query)[0];
  task = redactText(task)[0];
  const started = performance.now();
  const { set, propensity } = await sessionSet(sql, session, unitOf(scope, principal, client), client);
  const mcp = client !== "http";
  const { ranked, degraded, delivered, chunks, lines, rejected, trial, rows, frontier, features: logged } =
    await rankAndPack(sql, set, query, task, scope, true, mcp && !scope, { device: principal, agent });
  const rid = crypto.randomUUID();
  // Only a whole recall ticks the clock, so a degraded one takes no seq.
  const seq = degraded ? null : sql`nextval('memory.retrieval_seq')`;
  const text = await sql.begin(async (tx) => {
    const left = trial.length
      ? new Map((await tx`update memory.entry set chances_left = chances_left - 1
          where id in (select id from memory.entry where id = any(${trial}::text[]) and chances_left > 0 order by id for update)
          returning id, chances_left`).map((r) => [r.id as string, r.chances_left as number]))
      : new Map<string, number>();
    const shown = trial.filter((id) => left.has(id));
    const packet = packetText(chunks, lines, degraded, shown.map((id, i) => renderTrialItem(i + 1, rows[id], left.get(id)!)));
    const text = mcp ? `${packet}\n${feedbackFooter(rid)}` : packet;
    const context: Row = { param_set: set.id, candidates: logged };
    // Best-first spreading's frontier (R44), for recall_more to resume the same queue from.
    if (frontier?.length) context.frontier = frontier.map(([id, strength]) => ({ id, strength }));
    if (shown.length) context.trial = shown.map((id) => ({ id, chance: TRIAL_CHANCES - left.get(id)! }));
    await tx`insert into memory.retrieval (id, mcp_session, arm, query, task, scope, candidates, delivered, rejected, on_trial, latency_ms,
        degraded, packet, param_set, propensity, seq, context)
      values (${rid}, ${session}, ${set.arm}, ${query}, ${task || null}, ${scope || null},
        ${tx.json(ranked.map(([id, score]: Ranked) => ({ id, score })))}, ${tx.json(delivered)}, ${tx.json(rejected)}, ${tx.json(shown)},
        ${Math.round(performance.now() - started)}, ${degraded}, ${text}, ${set.id}, ${propensity}, ${seq},
        ${tx.json(context)})`;
    return text;
  });
  return `retrieval ${rid}\n\n${text}`;
}

/** The entry rendered for an agent, with its links and blobs. null when there is no such entry. */
export async function getEntry(session: string, id: string, viewer: Viewer = null): Promise<string | null> {
  const rows = await fetchEntries(sql, [id]);
  if (!(id in rows)) return null;
  const provenance = (await provenanceLines(sql, [id], viewer)).get(id);
  if (provenance) rows[id].provenance = provenance;
  const links = await sql`select 'to' as dir, l.type, l.dst as other, e.title from memory.link l
      join memory.entry e on e.id = l.dst where l.src = ${id}
    union all select 'from', l.type, l.src, e.title from memory.link l join memory.entry e on e.id = l.src where l.dst = ${id}
    order by 1, 2, 3`;
  const blobs = await sql`select x.name, x.sha256, x.kind, b.media_type, b.size from memory.entry_blob x
    join memory.blob b on b.sha256 = x.sha256 where x.entry_id = ${id} order by x.name`;
  await sql`insert into memory.event (session_id, event, payload) values (${session}, 'get_entry', ${sql.json({ entry_id: id })})`;
  return renderEntry(rows[id], links, blobs);
}

/** The blob and whether some public entry attaches it. A blob only private entries reach stays private, and so does
 * one no entry reaches any more. null when memory has no such blob. */
export async function readBlob(sha: string): Promise<Row | null> {
  const [row] = await sql`select b.media_type, b.size, b.content, b.stored,
      coalesce(bool_or(e.sensitivity <> 'private'), false) as public
    from memory.blob b left join memory.entry_blob x on x.sha256 = b.sha256 left join memory.entry e on e.id = x.entry_id
    where b.sha256 = ${sha.trim().toLowerCase()} group by b.sha256`;
  return row ?? null;
}

/** upload_blob: a URL to PUT a big file to. Records what the device declared, so remember can refuse a file that isn't it.
 * It never says whether memory already holds the file, since that would tell anyone who guessed a private file that it's here. */
export async function uploadBlob(principal: string, args: Record<string, unknown>) {
  if (!store.storageOn()) throw new Refused("This memory has no file storage. Send the file inline as base64.");
  const sha = typeof args.sha256 === "string" ? args.sha256.trim().toLowerCase() : "";
  if (!store.SHA_RE.test(sha)) throw new Refused("sha256 must be 64 hex digits.");
  const size = args.size;
  if (!(typeof size === "number" && Number.isInteger(size) && size >= 1 && size <= store.MAX_STORED_BYTES)) {
    throw new Refused(`size must be 1 to ${store.MAX_STORED_BYTES} bytes.`);
  }
  const type = typeof args.media_type === "string" && args.media_type ? args.media_type.toLowerCase() : "application/octet-stream";
  if (!MEDIA_TYPE_RE.test(type)) throw new Refused(`media_type must look like image/png, not ${JSON.stringify(args.media_type)}.`);
  const { used, cap } = await store.quota();
  if (used + size > cap) {
    throw new Refused(`That needs ${size} bytes, and memory holds ${used} of its ${cap}. Free some space or raise blob_quota_bytes.`);
  }
  const [{ n }] = await sql`select count(*) as n from memory.upload where principal = ${principal} and sha256 <> ${sha}`;
  if (n >= store.MAX_WAITING) {
    throw new Refused(`This device has ${store.MAX_WAITING} uploads waiting. Cite them in remember, or wait two hours for memory to sweep them.`);
  }
  const url = await store.signUpload(sha);
  await sql`insert into memory.upload (sha256, principal, size, media_type) values (${sha}, ${principal}, ${size}, ${type})
    on conflict (principal, sha256) do update set size = excluded.size, media_type = excluded.media_type, created_at = now()`;
  return [`Upload ${sha}, ${size} bytes. PUT the file within two hours:`,
    `curl -fsS -X PUT -H 'content-type: ${type}' --data-binary @<file> '${url}'`,
    `Then call remember with artifacts: [{"name": "<name>", "kind": "<kind>", "sha256": "${sha}"}]. memory checks the size and hash before it keeps the file.`,
  ].join("\n");
}

export const notInBackup = (sha: string) => `Blob ${sha} wasn't in the backup.`;

/** A blob's text, one page of characters at a time, with the call for the next page. A blob in Storage that isn't text
 * comes back as a link that downloads it for 10 minutes. */
export async function getBlob(sha: string, offset = 0, limit = 20000) {
  sha = sha.trim().toLowerCase();
  const row = await readBlob(sha);
  if (!row) return `No blob ${sha}.`;
  if (!row.public) return PRIVATE_BLOB;
  let bytes: Uint8Array | null;
  if (row.stored === "storage") {
    if (!store.storageOn()) return notInBackup(sha);
    if (!store.isText(row.media_type)) {
      try {
        return `Blob ${sha}: ${row.media_type}, ${row.size} bytes. Download it within 10 minutes: ${await store.signDownload(sha)}`;
      } catch (e) {
        if (e instanceof store.NotStored) return notInBackup(sha);
        throw e;
      }
    }
    bytes = await store.get(sha);
    if (!bytes) return notInBackup(sha);
  } else bytes = row.content;
  const text = store.utf8(bytes!);
  if (text === null) return `Blob ${sha} is ${row.size} bytes of binary ${row.media_type}. get_blob only pages text.`;
  if (offset < 0 || limit < 1) return "offset must be 0 or more, and limit 1 or more.";
  if (offset && offset >= text.length) return `Blob ${sha} has ${text.length} characters, so offset ${offset} is past the end.`;
  const end = Math.min(offset + Math.min(limit, PAGE_MAX), text.length);
  let head = `Blob ${sha}: ${row.media_type}, characters ${offset} to ${end} of ${text.length}.`;
  if (end < text.length) head += `\nNext page: get_blob("${sha}", offset=${end})`;
  return `${head}\n\n${text.slice(offset, end)}`;
}

/** One verdict, logged under this source: Wen's, from the console, or an agent's older one-verdict call. */
export async function feedback(db: Sql, retrievalId: string, verdict: string, entryId: string | null = null,
  note: string | null = null, source = "agent") {
  if (!VERDICTS.includes(verdict)) return BAD_VERDICT;
  if (!UUID.test(retrievalId)) return `No retrieval ${retrievalId}.`;
  if (!(await db`select 1 from memory.retrieval where id = ${retrievalId}`).length) return `No retrieval ${retrievalId}.`;
  await db`insert into memory.feedback (retrieval_id, source, verdict, entry_id, note)
    values (${retrievalId}, ${source}, ${verdict}, ${entryId}, ${note})`;
  return "Logged.";
}

/** The agent's report on one of its own recalls (R33), all or nothing: a verdict per entry the recall showed, or
 * nothing_useful for the packet, or the older single verdict. Only the MCP session that made the recall may give it, and a
 * recall takes one such call. It is logged, and the learner reads it with the recall's other signals. */
export async function agentFeedback(session: string, args: Record<string, unknown>) {
  const id = typeof args.retrieval_id === "string" ? args.retrieval_id : "";
  if (!UUID.test(id)) return `No retrieval ${id}.`;
  const [r] = await sql`select delivered, on_trial from memory.retrieval where id = ${id} and mcp_session = ${session}`;
  if (!r) return `No retrieval ${id}.`;
  const checked = checkFeedback(args, [...(r.delivered ?? []), ...(r.on_trial ?? [])]);
  return await sql.begin(async (tx) => {
    // One call at a time per retrieval, so two at once can't both log.
    await tx`select pg_advisory_xact_lock(hashtext(${id}))`;
    if ((await tx`select 1 from memory.feedback where retrieval_id = ${id} and source = 'agent' limit 1`).length) return `Already logged for ${id}.`;
    if ("error" in checked) return checked.error;
    const note = typeof args.note === "string" && args.note ? redactText(args.note)[0] : null;
    for (const [i, row] of checked.rows.entries()) {
      await tx`insert into memory.feedback (retrieval_id, source, verdict, entry_id, note)
        values (${id}, 'agent', ${row.verdict}, ${row.entry_id}, ${i === 0 ? note : null})`;
    }
    return "Logged.";
  });
}

/** The line that ends a tool reply while this session has recalls with no agent feedback, naming the newest few, or "". It
 * reads the database, so it holds across isolates. `exclude` is the recall this reply is for. */
export async function reminder(session: string, exclude: string | null) {
  const rows = await sql`select retrieval_id from memory.unanswered_recall
    where mcp_session = ${session} and retrieval_id is distinct from ${exclude}::uuid
    order by created_at desc limit ${REMIND_MAX}`;
  return rows.length ? reminderLine(rows.map((r) => r.retrieval_id as string)) : "";
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
      // The folder the client reports is the MCP session's, so a note it writes records where it was written.
      const cwd = typeof payload.cwd === "string" && payload.cwd.trim() ? payload.cwd.trim() : null;
      const [tied] = await sql`update memory.mcp_session set claude_session_id = ${sessionId},
          cwd = coalesce(${cwd}::text, cwd), repo = coalesce(memory.repo_of(${cwd}::text), repo),
          cwd_from = case when ${cwd}::text is not null then 'hook' else cwd_from end
        where id = (select mcp_session from memory.retrieval where id = ${m[1]}) returning id`;
      // A note written before the hook arrived gets the folder now.
      if (tied && cwd) {
        await sql`update memory.entry_provenance set cwd = ${cwd}::text, repo = memory.repo_of(${cwd}::text)
          where session = ${tied.id} and cwd is null`;
      }
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
  if (!known || !body) return "Need a recipient (claude, codex, all, or a registered agent's name) and a body.";
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
async function claimMessages(mine: string | string[], ack: boolean) {
  const me = Array.isArray(mine) ? mine : [mine];
  return await sql.begin(async (tx) => {
    for (const name of me) await tx`select memory.drop_exhausted(${name}::text)`;
    return await tx`with picked as (
        update memory.message_delivery d set delivered_count = d.delivered_count + 1,
          visible_after = now() + make_interval(mins => ${REDELIVER_MINUTES}::int),
          acked_at = case when ${ack}::boolean then now() end
        where d.id in (
          select d2.id from memory.message_delivery d2 join memory.message m on m.id = d2.message_id
          where d2.recipient = any(${me}::text[]) and d2.acked_at is null and d2.dropped_at is null and d2.visible_after <= now()
            and m.expires_at > now()
          order by d2.id limit 20 for update of d2 skip locked)
        returning d.id, d.message_id)
      select p.id, p.message_id, m.sender, m.recipient, m.body, m.created_at
      from picked p join memory.message m on m.id = p.message_id order by p.id`;
  });
}

/** A message that reached two of one agent's mailboxes, its own name and claude, is listed once. */
function once(rows: Row[]) {
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(String(r.message_id)) && seen.add(String(r.message_id)));
}

const line = (r: Row, id: number) => `- #${id} from ${r.sender} to ${r.recipient} at ${stamp(r.created_at)} UTC: ${r.body}`;

/** The hook inbox: my waiting messages as text, acknowledged as they print, since the agent sees them in its context.
 * Hooks have read this format since before the queue, message ids and all. */
export async function readMessages(me: string | string[]) {
  const rows = once(await claimMessages(me, true));
  if (!rows.length) return "";
  return "Messages from your other agents (reply with post_message):\n" + rows.map((r) => line(r, r.message_id)).join("\n") + "\n";
}

/** check_messages: the same list, numbered by message id the same way, left waiting until ack_messages or a dismiss. */
export async function checkMessages(me: string | string[]) {
  const rows = once(await claimMessages(me, false));
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
async function closeDeliveries(mine: string | string[], raw: unknown, verb: string, everything: boolean) {
  const me = Array.isArray(mine) ? mine : [mine];
  const ids = everything ? null : messageIds(raw);
  if (!everything && !ids) return "Need the ids check_messages listed, like [12, 13].";
  const done = everything
    ? await sql`update memory.message_delivery set acked_at = now()
        where recipient = any(${me}::text[]) and acked_at is null and dropped_at is null returning id`
    : await sql`update memory.message_delivery set acked_at = now()
        where message_id = any(${ids}::bigint[]) and recipient = any(${me}::text[]) and acked_at is null and dropped_at is null returning id`;
  let said = `${verb} ${count(done.length, "message")}.`;
  if (ids) {
    const mine = new Set(
      (await sql`select message_id from memory.message_delivery where message_id = any(${ids}::bigint[]) and recipient = any(${me}::text[])`)
        .map((r) => Number(r.message_id)),
    );
    said += [...new Set(ids)].filter((id) => !mine.has(id)).map((id) => ` Message ${id}: not yours.`).join("");
  }
  return said;
}

/** ack_messages: I've handled these messages. */
export const ackMessages = (me: string | string[], ids: unknown) => closeDeliveries(me, ids, "Acknowledged", false);

/** dismiss_messages: clear these messages, or all of mine, unread. */
export function dismissMessages(me: string | string[], ids: unknown) {
  const all = ids === "all" || (Array.isArray(ids) && ids.includes("all"));
  return closeDeliveries(me, ids, "Dismissed", all);
}
