// MCP over streamable HTTP, stateless, JSON responses only. initialize mints an Mcp-Session-Id and records the client's
// name, so a later call in any isolate knows claude from codex and keeps the arm its session drew. GET gets 405, which
// the spec allows a server that offers no stream.
import type { Principal } from "./auth.ts";
import { config } from "./config.ts";
import { sql } from "./db.ts";
import * as service from "./service.ts";
import { clientStatus, installerNote, SERVER_VERSION } from "./version.ts";
import { Refused, remember } from "./write.ts";

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const INSTRUCTIONS = "Wen's memory. Call recall before acting on anything that depends on Wen's decisions, " +
  "preferences or history. Wen's other agents leave you messages. Call check_messages when you start a task, " +
  "and post_message to reach them.";

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });

export const TOOLS = [
  {
    name: "recall",
    description: "Search Wen's memory: his decisions, preferences, observations and past reactions.\n\n" +
      "query: what you need to know, in English or 中文.\n" +
      "task: optional one-line description of what you are doing, to sharpen the search.\n" +
      "scope: optional run scope like run:abc. That run's notes join the search and rank first.\n" +
      "Results start with a retrieval id. Pass it to feedback() if the results helped or misled you.",
    inputSchema: {
      type: "object", required: ["query"],
      properties: { query: str("What you need to know"), task: str("What you are doing"), scope: str("run:<id>") },
    },
  },
  {
    name: "get_entry",
    description: "Open one memory entry by id, with its evidence, source, links and blobs.",
    inputSchema: { type: "object", required: ["id"], properties: { id: str("Entry id") } },
  },
  {
    name: "get_blob",
    description: "Read a blob that get_entry lists, as text, one page at a time. The reply says how to get the next page.",
    inputSchema: {
      type: "object", required: ["sha256"],
      properties: { sha256: str("The blob's sha256"), offset: int("First character, default 0"), limit: int("Characters, default 20000") },
    },
  },
  {
    name: "remember",
    description: "Write one note to Wen's memory. It's a draft in a run scope until Wen or clyde-flow promotes it.\n\n" +
      "pattern: projects, decisions, observations, preferences, recommendations, references or reactions.\n" +
      "title, body: a one-line title, and the summary recall ranks on.\n" +
      "scope: run:<id>, the run this note hands off within.\n" +
      "evidence: what backs it. evidence_kind: summary, assistant or memory.\n" +
      "project: id of the run's projects entry. Required unless pattern is projects.\n" +
      'links: [{"type": "supports|contradicts|derived_from|relates|corrects", "to": "<id>"}].\n' +
      "supersedes: ids of drafts in the same run that this note replaces. Hybrid recall stops serving them, and the " +
      "index arm lists them struck through.\n" +
      'blobs: [{"name": "gate-evidence", "media_type": "text/markdown", "text": "..."}] for long evidence.\n' +
      "Returns the entry's id and each blob's sha256.",
    inputSchema: {
      type: "object", required: ["pattern", "title", "body", "scope", "evidence"],
      properties: {
        pattern: str("Entry pattern"), title: str("One-line title"), body: str("Summary recall ranks on"),
        scope: str("run:<id>"), evidence: str("What backs it"), project: str("The run's projects entry id"),
        evidence_kind: str("summary, assistant or memory"), authority: str("draft"), sensitivity: str("normal, private (title only for everyone) or confidential (work: title only for outside models)"),
        lang: str("Language code, default en"), valid_from: str("YYYY-MM-DD"),
        links: { type: "array", items: { type: "object" } }, supersedes: { type: "array", items: { type: "string" } },
        blobs: { type: "array", items: { type: "object" } },
      },
    },
  },
  {
    name: "feedback",
    description: "Report how a recall went. verdict: helpful, irrelevant or wrong. entry_id narrows it to one item.",
    inputSchema: {
      type: "object", required: ["retrieval_id", "verdict"],
      properties: { retrieval_id: str("From the packet"), verdict: str("helpful, irrelevant or wrong"), entry_id: str("One item"), note: str("Why") },
    },
  },
  {
    name: "post_message",
    description: "Leave a message for Wen's other agents. to: claude, codex, or all. They see it at their next check or prompt.",
    inputSchema: { type: "object", required: ["to", "body"], properties: { to: str("claude, codex or all"), body: str("The message") } },
  },
  {
    name: "check_messages",
    description: "Read your unread messages from Wen's other agents. Reading marks them read.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** The note for a computer whose hook is too old to update itself, or "" for everyone else. A claude.ai connector (oauth:)
 * has no hook, and neither does a computer that only uses MCP: it has never called a hook and reported no version. */
function installNote(who: Principal) {
  if (who.role !== "device" || who.device?.startsWith("oauth:")) return "";
  if (!who.hookSeen && !who.clientVersion) return "";
  return installerNote(clientStatus(who.clientVersion, config.clientCutoffDays), Boolean(who.updateFailed));
}

type Call = { session: string; client: string | null; principal: string; args: Record<string, any>; note: string };
const s = (v: unknown, fallback = "") => typeof v === "string" ? v : fallback;

const RUN: Record<string, (c: Call) => Promise<string>> = {
  recall: ({ session, client, principal, args }) =>
    service.recall(session, s(args.query), s(args.task), client, s(args.scope) || null, principal),
  get_entry: async ({ session, args }) => (await service.getEntry(session, s(args.id))) ?? `No entry ${s(args.id)}.`,
  get_blob: ({ args }) => service.getBlob(s(args.sha256), Number(args.offset ?? 0), Number(args.limit ?? 20000)),
  remember: async ({ args }) => {
    const payload = {
      pattern: args.pattern, title: args.title, body: args.body, scope: args.scope, evidence: args.evidence,
      evidence_kind: args.evidence_kind ?? "summary", authority: args.authority ?? "draft",
      sensitivity: args.sensitivity ?? "normal", lang: args.lang ?? "en", project: args.project || null,
      valid_from: args.valid_from || null, links: args.links ?? [], supersedes: args.supersedes ?? [], blobs: args.blobs ?? [],
    };
    const r = await remember(payload, "agent");
    return [`Remembered ${r.id}.`, ...r.blobs.map((b: { name: string; sha256: string }) => `Blob ${b.name}: ${b.sha256}`),
      "Keyword search finds it now. Vector search finds it after the next embedding sync."].join("\n");
  },
  feedback: ({ args }) => service.feedback(sql, s(args.retrieval_id), s(args.verdict), s(args.entry_id) || null, s(args.note) || null),
  post_message: ({ client, args }) => service.postMessage(sql, service.agentName(client), s(args.to), s(args.body)),
  check_messages: async ({ client, note }) =>
    ((await service.readMessages(service.agentName(client))) || "No new messages.") + (note ? `\n${note}` : ""),
};

type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };
const result = (id: RpcMessage["id"], value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const error = (id: RpcMessage["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function clientOf(session: string | null): Promise<string | null> {
  if (!session) return null;
  const [row] = await sql`select client from memory.mcp_client where session_id = ${session}`;
  return row?.client ?? null;
}

async function answer(msg: RpcMessage, session: string | null, minted: { id?: string }, who: Principal) {
  const id = msg.id;
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      const sid = crypto.randomUUID();
      minted.id = sid;
      const client = msg.params?.clientInfo?.name ?? null;
      await sql`insert into memory.mcp_client (session_id, client) values (${sid}, ${client}) on conflict do nothing`;
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
      try {
        const principal = who.device ?? who.role;
        const text = await run({ session: sid, client: await clientOf(session), principal, args: msg.params?.arguments ?? {}, note: installNote(who) });
        return result(id, { content: [{ type: "text", text }] });
      } catch (e) {
        if (!(e instanceof Refused)) console.error(e);
        const text = e instanceof Refused ? e.message : `Error: ${(e as Error).message}`;
        return result(id, { content: [{ type: "text", text }], isError: true });
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
    body = await req.json();
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
