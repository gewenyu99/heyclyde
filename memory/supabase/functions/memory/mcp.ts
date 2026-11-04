// MCP over streamable HTTP, stateless, JSON responses only. initialize mints an Mcp-Session-Id and records the client's
// name, so a later call in any isolate knows claude from codex and keeps the arm its session drew. GET gets 405, which
// the spec allows a server that offers no stream.
import type { Principal } from "./auth.ts";
import { config } from "./config.ts";
import { sql } from "./db.ts";
import * as service from "./service.ts";
import { clientStatus, installerNote, SERVER_VERSION } from "./version.ts";
import { Refused, remember } from "./write.ts";

export const MAX_MCP_BODY = 12 * 1024 * 1024;
const RID = /^retrieval ([0-9a-f-]{36})/;
const VERSIONS =["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const INSTRUCTIONS = "Wen's memory. Register once with register_agent (name, context work, personal or both, surface, " +
  "description): memory remembers it for this token and app, and your notes and messages then carry your name. You can use " +
  "memory before you have, and each reply reminds you until you do. Call recall before acting on anything that depends on Wen's decisions, " +
  "preferences or history. Wen's other agents leave you messages. Call check_messages when you start a task, " +
  "and post_message to reach them. check_messages numbers each message: call ack_messages with those ids once you've " +
  "handled them, or they come back. To keep what you learn, call remember: it needs only pattern, title, body and " +
  "evidence, and every other agent can recall the note at once. Give feedback after every recall: one feedback call " +
  "with a verdict (used, irrelevant or wrong) for each result, or nothing_useful when none helped. The packet shows " +
  "some results under On trial, new notes still earning their place, so judge those too. Keep each memory under 500 " +
  "characters and put the details in artifacts: remember takes artifacts: [{name, kind, text or base64 or sha256}], and " +
  "recall lists a memory's artifacts by name and kind. Open one with get_blob. A file too big to send inline goes " +
  "through upload_blob.";

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });

export const TOOLS = [
  {
    name: "register_agent",
    description: "Say which of Wen's agents you are, once. memory remembers it for this token and app, so later sessions start " +
      "registered, and your notes' source and your messages carry your name. Until you do, every reply reminds you.\n\n" +
      "name: a short lowercase handle, like clyde-work or journeymate-ios. Reuse your name if you have one.\n" +
      "context: work, personal or both. What part of Wen's life you work on.\n" +
      "surface: where you run, like claude-code, claude.ai, cowork, codex or a script.\n" +
      "description: one or two sentences on what you do for Wen.",
    inputSchema: {
      type: "object", required: ["name", "context", "surface", "description"],
      properties: {
        name: str("Lowercase handle, letters, digits and dashes"), context: str("work, personal or both"),
        surface: str("Where you run"), description: str("What you do for Wen"),
      },
    },
  },
  {
    name: "recall",
    description: "Search Wen's memory: his decisions, preferences, observations and past reactions.\n\n" +
      "query: what you need to know, in English or 中文.\n" +
      "task: optional one-line description of what you are doing, to sharpen the search.\n" +
      "scope: optional run scope like run:abc. That run's notes rank first. Other runs' notes are searched too.\n" +
      "Results start with a retrieval id and end with the feedback call to make. Give feedback after every recall, one call " +
      "for the whole packet, so memory learns which results to keep.",
    inputSchema: {
      type: "object", required: ["query"],
      properties: { query: str("What you need to know"), task: str("What you are doing"), scope: str("run:<id>") },
    },
  },
  {
    name: "get_entry",
    description: "Open one memory entry by id, with its evidence, source, links and artifacts.",
    inputSchema: { type: "object", required: ["id"], properties: { id: str("Entry id") } },
  },
  {
    name: "get_blob",
    description: "Read an artifact that get_entry lists, as text, one page at a time. The reply says how to get the next page. " +
      "An image, video, audio file or other non-text artifact comes back as a link that downloads it for 10 minutes.",
    inputSchema: {
      type: "object", required: ["sha256"],
      properties: { sha256: str("The blob's sha256"), offset: int("First character, default 0"), limit: int("Characters, default 20000") },
    },
  },
  {
    name: "upload_blob",
    description: "Send a file to memory that is too big to put in remember inline, up to 500 MB: an image, video, audio, PDF, " +
      "zip or long text. Give its sha256, its size in bytes and its media type. memory replies with a URL: PUT the file there " +
      "within two hours (curl -X PUT --data-binary @file '<url>'), then cite the sha256 in remember as an artifact: " +
      "artifacts: [{name, kind, sha256}]. memory checks the hash and size before it keeps the file. Text with a secret in it is refused.",
    inputSchema: {
      type: "object", required: ["sha256", "size"],
      properties: { sha256: str("sha256 of the file, 64 hex digits"), size: int("Size in bytes"), media_type: str("Like image/png. Default application/octet-stream") },
    },
  },
  {
    name: "remember",
    description: "Write one note to Wen's memory. Every other agent can recall it at once, labelled by its kind and marked " +
      "unreviewed until Wen or clyde-flow reviews it.\n\n" +
      "pattern: projects, decisions, observations, preferences, recommendations, references or reactions.\n" +
      "title, body: a one-line title, and the summary recall ranks on. Keep a memory under 500 characters and put the details " +
      "in artifacts. A body over 500 characters is refused unless you pass long: true. 4000 is the most.\n" +
      "evidence: what backs it.\n" +
      "kind: observation (default: your inference or summary), fact, wen or plan. A fact starts high only when its " +
      "evidence is a line from a tool's output that memory holds. Pass evidence_event, the id the hook printed as " +
      "'memory event <n>', and put that line word for word in evidence. If it isn't in that event, the note is stored as " +
      "an observation. wen is Wen's own words, from a prompt event. plan is what you mean to do.\n" +
      "evidence_event: the id of the hook event that holds the evidence line.\n" +
      "scope: optional, default global. run:<id> hands a note off within a run, and that run's recalls rank it first.\n" +
      "evidence_kind: summary, assistant or memory.\n" +
      "project: optional, default your own notes project. Give the id of a projects entry to file the note under it.\n" +
      'links: [{"type": "supports|contradicts|derived_from|relates|corrects", "to": "<id>"}].\n' +
      "supersedes: ids of notes in the same run that this note replaces. Hybrid recall stops serving them, and the " +
      "index arm lists them struck through.\n" +
      'artifacts: [{"name": "plan.md", "kind": "document", "text": "..."}] for the details: a plan, log, transcript, image, code. ' +
      "Each has a name and one of text (UTF-8), base64 (binary, up to 4 MiB; use upload_blob for bigger files) or sha256 (a file " +
      "sent with upload_blob). kind is image, video, audio, document, skill, artifact, data or other, and memory derives it when you " +
      "leave it out. Recall lists a memory's artifacts by name, kind and size, never their content. blobs still works as the same field.\n" +
      "long: true lets a body past 500 characters through.\n" +
      "Returns the entry's id and each artifact's sha256.",
    inputSchema: {
      type: "object", required: ["pattern", "title", "body", "evidence"],
      properties: {
        pattern: str("Entry pattern"), title: str("One-line title"), body: str("Summary recall ranks on"),
        evidence: str("What backs it"), kind: str("observation (default), fact, wen or plan"),
        evidence_event: { type: "integer", description: "The hook event id that holds the evidence line" },
        scope: str("global (default) or run:<id>"), project: str("A projects entry id, default your notes project"),
        evidence_kind: str("summary, assistant or memory"), authority: str("Leave out"), sensitivity: str("normal, private (title only for everyone) or confidential (work: title only for outside models)"),
        lang: str("Language code, default en"), valid_from: str("YYYY-MM-DD"),
        links: { type: "array", items: { type: "object" } }, supersedes: { type: "array", items: { type: "string" } },
        artifacts: { type: "array", items: { type: "object" }, description: "[{name, kind, text | base64 | sha256}]" },
        blobs: { type: "array", items: { type: "object" }, description: "Same as artifacts" },
        long: { type: "boolean", description: "Allow a body past 500 characters" },
      },
    },
  },
  {
    name: "feedback",
    description: "Report how a recall went, once per recall, after every recall. Name each result you were shown, including " +
      "those under On trial: entries: [{entry_id, verdict}] with verdict used, irrelevant or wrong. Say nothing_useful: true " +
      "when none helped. A result you leave out counts as not used. Only the session that made the recall can give feedback, " +
      "and only once. The older form still works: verdict (helpful, used, irrelevant, wrong), with entry_id for one result.",
    inputSchema: {
      type: "object", required: ["retrieval_id"],
      properties: {
        retrieval_id: str("From the packet"),
        entries: {
          type: "array", description: "A verdict for each result you were shown",
          items: {
            type: "object", required: ["entry_id", "verdict"],
            properties: { entry_id: str("A result's id"), verdict: { type: "string", enum: ["used", "irrelevant", "wrong"] } },
          },
        },
        items: { type: "array", description: "Same as entries", items: { type: "object" } },
        nothing_useful: { type: "boolean", description: "True when no result helped. Don't send it with entries." },
        verdict: str("Overall, or for entry_id: helpful, used, irrelevant, wrong or nothing_useful"), entry_id: str("One result, with verdict"),
        note: str("Why, up to 4,000 characters"),
      },
    },
  },
  {
    name: "post_message",
    description: "Leave a message for Wen's other agents. to: claude, codex, all, or another agent memory has seen in the last " +
      "30 days. They see it at their next check or prompt. A message to all that no other agent could receive isn't posted.",
    inputSchema: { type: "object", required: ["to", "body"], properties: { to: str("claude, codex, all or another agent's name"), body: str("The message") } },
  },
  {
    name: "check_messages",
    description: "Read your waiting messages from Wen's other agents, oldest first, up to 20, each with an id. Reading " +
      "doesn't finish them: call ack_messages with the ids once you've handled them. One you don't acknowledge comes " +
      "back after 30 minutes, up to 3 times, then it's dropped and its sender is told.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ack_messages",
    description: "Mark messages handled, by the ids check_messages listed (the hook prints the same ids). Only your own can be acknowledged.",
    inputSchema: {
      type: "object", required: ["ids"],
      properties: { ids: { type: "array", items: { type: "integer" }, description: "Message ids from check_messages" } },
    },
  },
  {
    name: "dismiss_messages",
    description: "Clear messages without handling them: ids from check_messages, or \"all\" for everything waiting for you.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          anyOf: [{ type: "array", items: { type: "integer" } }, { type: "string", enum: ["all"] }],
          description: "Message ids, or \"all\"",
        },
      },
    },
  },
];

/** The note for a computer whose hook is too old to update itself, or "" for everyone else. A claude.ai connector (oauth:)
 * has no hook, and neither does a computer that only uses MCP: it has never called a hook and reported no version. */
function installNote(who: Principal) {
  if (who.role !== "device" || who.device?.startsWith("oauth:")) return "";
  if (!who.hookSeen && !who.clientVersion) return "";
  return installerNote(clientStatus(who.clientVersion, config.clientCutoffDays), Boolean(who.updateFailed));
}

/** The profile a session is registered as, or null. */
type Profile = { name: string; context: string; surface: string };
type Call = { session: string; client: string | null; agent: Profile | null; principal: string; args: Record<string, any>; note: string };
const s = (v: unknown, fallback = "") => typeof v === "string" ? v : fallback;

/** The one line every reply of an unregistered session ends with, as a content block of its own so the tool's text is never
 * changed. Registration is gentle: nothing is refused for lack of it. */
export const NUDGE = "memory: you haven't registered yet. Call register_agent {name, context, surface, description} once: " +
  "context is work, personal or both. memory remembers it for this token and app, and your notes and messages then carry your name.";

const AGENT_NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
const CONTEXTS = ["work", "personal", "both"];
const RESERVED = ["claude", "codex", "all", "wen", "memory"];
// Control characters, NUL included, would reach a note's source line, and Postgres refuses NUL.
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;
const plain = (v: unknown, max: number) => s(v).replace(CONTROL, " ").trim().slice(0, max).trim();

/** Make or update the agent's profile, and bind this session, and this credential's app, to it. A name belongs to the credential
 * that registered it first: another credential's attempt is refused and changes nothing. */
async function register({ session, client, principal, args }: Call) {
  const name = s(args.name).trim().toLowerCase(), context = s(args.context).trim().toLowerCase();
  const surface = plain(args.surface, 40), description = plain(args.description, 500);
  const errs = [
    AGENT_NAME.test(name) ? "" : "name must be 2 to 40 lowercase letters, digits and dashes, starting with a letter or digit.",
    CONTEXTS.includes(context) ? "" : "context must be work, personal or both.",
    surface ? "" : "surface is required: where you run, like claude-code or claude.ai.",
    description ? "" : "description is required: what you do for Wen.",
    RESERVED.includes(name) ? `${name} is reserved. Pick a name of your own.` : "",
  ].filter(Boolean);
  if (errs.length) throw new Refused(errs.join("\n"));
  // One statement, so two credentials racing for a new name leave one owner. The where keeps a name with the credential that took it.
  const [agent] = await sql`insert into memory.agent (name, context, surface, description, registered_by)
    values (${name}, ${context}, ${surface}, ${description}, ${principal})
    on conflict (name) do update set context = excluded.context, surface = excluded.surface,
      description = excluded.description, last_seen = now()
      where memory.agent.registered_by is not distinct from excluded.registered_by
    returning name, (xmax = 0) as created`;
  if (!agent) throw new Refused(`${name} is already registered by another credential. Pick a name of your own.`);
  await sql`update memory.mcp_client set agent = ${name} where session_id = ${session} and principal = ${principal}`;
  if (client) {
    await sql`insert into memory.agent_binding (principal, client, agent) values (${principal}, ${client}, ${name})
      on conflict (principal, client) do update set agent = excluded.agent, updated_at = now()`;
  }
  return `${agent.created ? "Registered" : "Welcome back,"} ${name}: a ${context} agent on ${surface}. ` +
    "memory remembers this for this token and app, so your next session starts registered. Your notes and messages carry your name.";
}

/** The name a registered agent writes and posts under, else the one its client name gives. */
const nameOf = (c: Pick<Call, "agent" | "client">) => c.agent?.name ?? service.agentName(c.client);

/** The mailboxes an agent reads: its own name, and claude or codex when its client is one of those. */
function mailboxes(c: Pick<Call, "agent" | "client">): string[] {
  const own = service.agentName(c.client);
  return c.agent ? [c.agent.name, ...(own === "claude" || own === "codex" ? [own] : [])] : [own];
}

const RUN: Record<string, (c: Call) => Promise<string>> = {
  register_agent: register,
  recall: (c) => service.recall(c.session, s(c.args.query), s(c.args.task), c.client, s(c.args.scope) || null, c.principal, nameOf(c)),
  get_entry: async (c) => (await service.getEntry(c.session, s(c.args.id), { device: c.principal, agent: nameOf(c) })) ?? `No entry ${s(c.args.id)}.`,
  get_blob: ({ args }) => service.getBlob(s(args.sha256), Number(args.offset ?? 0), Number(args.limit ?? 20000)),
  upload_blob: ({ principal, args }) => service.uploadBlob(principal, args),
  remember: async (c) => {
    const { args } = c;
    const payload = {
      pattern: args.pattern, title: args.title, body: args.body, scope: args.scope || null, evidence: args.evidence,
      kind: args.kind || null, evidence_event: args.evidence_event ?? null,
      evidence_kind: args.evidence_kind ?? "summary", authority: args.authority ?? "draft",
      sensitivity: args.sensitivity ?? "normal", lang: args.lang ?? "en", project: args.project || null,
      valid_from: args.valid_from || null, links: args.links ?? [], supersedes: args.supersedes ?? [], blobs: args.blobs ?? [],
      // Only when sent, so a write without them keeps the id and digest it always had.
      ...(args.artifacts !== undefined ? { artifacts: args.artifacts } : {}), ...(args.long !== undefined ? { long: args.long } : {}),
    };
    const me = nameOf(c);
    const r = await remember(payload, "agent", me, c.principal, {
      agent: me, context: c.agent?.context ?? null, session: c.session,
      profile: c.agent ? `${c.agent.name}, a ${c.agent.context} agent on ${c.agent.surface}` : null,
    });
    return [`Remembered ${r.id}.`,
      ...r.blobs.map((b: { name: string; sha256: string; kind: string; size: number }) => `Blob ${b.name}: ${b.sha256} (${b.kind}, ${b.size} bytes)`),
      "Keyword search finds it now. Vector search finds it after the next embedding sync."].join("\n");
  },
  feedback: ({ session, args }) => service.agentFeedback(session, args),
  post_message: (c) => service.postMessage(sql, nameOf(c), s(c.args.to), s(c.args.body)),
  check_messages: async (c) => ((await service.checkMessages(mailboxes(c))) || "No new messages.") + (c.note ? `\n${c.note}` : ""),
  ack_messages: (c) => service.ackMessages(mailboxes(c), c.args.ids),
  dismiss_messages: (c) => service.dismissMessages(mailboxes(c), c.args.ids),
};

type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };
const result = (id: RpcMessage["id"], value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const error = (id: RpcMessage["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** The client name a session gave at initialize, and the agent it is. A session opened under another credential is no one:
 * its id is not a bearer token. */
async function sessionOf(session: string | null, principal: string): Promise<{ client: string | null; agent: Profile | null }> {
  if (!session) return { client: null, agent: null };
  const [row] = await sql`select c.client, c.principal, a.name, a.context, a.surface from memory.mcp_client c
    left join memory.agent a on a.name = c.agent where c.session_id = ${session}`;
  const mine = row?.principal === principal && row?.name;
  return { client: row?.client ?? null, agent: mine ? { name: row.name, context: row.context, surface: row.surface } : null };
}

async function answer(msg: RpcMessage, session: string | null, minted: { id?: string }, who: Principal) {
  const id = msg.id;
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      const sid = crypto.randomUUID();
      minted.id = sid;
      const client = typeof msg.params?.clientInfo?.name === "string" ? msg.params.clientInfo.name : null;
      const principal = who.device ?? who.role;
      // A credential and app that registered before start as that agent.
      await sql`insert into memory.mcp_client (session_id, client, principal, agent)
        values (${sid}, ${client}, ${principal}, (select agent from memory.agent_binding where principal = ${principal} and client = ${client}))
        on conflict do nothing`;
      return result(id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "memory", version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: TOOLS });
    case "tools/call": {
      const name = msg.params?.name, run = RUN[name];
      if (!run) return error(id, -32602, `Unknown tool ${name}`);
      const sid = session ?? `anon-${crypto.randomUUID()}`;
      // Every reply, errors included, ends with a reminder while a recall in this MCP session has no feedback. A call with no
      // session header has no recalls of its own to be reminded of.
      const remind = async (text: string) => {
        if (!session) return text;
        try {
          const own = name === "recall" ? RID.exec(text)?.[1] ?? null : null;
          const line = await service.reminder(session, own);
          return line ? `${text}\n${line}` : text;
        } catch (e) {
          console.error(e);
          return text;
        }
      };
      const principal = who.device ?? who.role;
      let nudge: { type: string; text: string }[] = [];
      try {
        const known = await sessionOf(session, principal);
        // Registration is gentle: an unregistered session works, and hears this after every reply until it registers.
        if (!known.agent && name !== "register_agent") nudge = [{ type: "text", text: NUDGE }];
        if (known.agent) {
          await sql`update memory.agent set last_seen = now() where name = ${known.agent.name} and last_seen < now() - interval '1 minute'`;
        }
        const text = await run({ session: sid, client: known.client, agent: known.agent, principal, args: msg.params?.arguments ?? {}, note: installNote(who) });
        return result(id, { content: [{ type: "text", text: await remind(text) }, ...nudge] });
      } catch (e) {
        if (!(e instanceof Refused)) console.error(e);
        const text = e instanceof Refused ? e.message : `Error: ${(e as Error).message}`;
        return result(id, { content: [{ type: "text", text: await remind(text) }, ...nudge], isError: true });
      }
    }
    default:
      return msg.method?.startsWith("notifications/") ? null : error(id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handle(req: Request, who: Principal): Promise<Response> {
  if (req.method === "GET") return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
  if (req.method === "DELETE") return new Response(null, { status: 200 });
  if (req.method !== "POST") return new Response(null, { status: 405 });
  let body: RpcMessage | RpcMessage[];
  try {
    // An inline base64 artifact is the biggest thing a call carries, so this is the same cap /entries has.
    const raw = new Uint8Array(await req.arrayBuffer());
    if (raw.byteLength > MAX_MCP_BODY) return Response.json({ error: `The body is over ${MAX_MCP_BODY} bytes. Send big files with upload_blob.` }, { status: 413 });
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return Response.json(error(null, -32700, "Parse error"), { status: 400 });
  }
  const session = req.headers.get("mcp-session-id");
  const minted: { id?: string } = {};
  const batch = Array.isArray(body);
  const replies = [];
  for (const msg of batch ? body as RpcMessage[] : [body as RpcMessage]) {
    const reply = await answer(msg, session, minted, who);
    if (reply && msg.id !== undefined) replies.push(reply);
  }
  const headers: Record<string, string> = minted.id ? { "mcp-session-id": minted.id } : {};
  if (!replies.length) return new Response(null, { status: 202, headers });
  return Response.json(batch ? replies : replies[0], { headers });
}
