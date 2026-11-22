// MCP Streamable HTTP & JSON-RPC handler exposing all 18 Clyde memory, messaging, artifact, and quest tools.
import { AGENT_CONTEXTS, AGENT_TYPES, CATEGORY_RE } from "../core/permissions.ts";
import { decodeUtf8, isTextMedia } from "../core/write-rules.ts";
import type { LocalPrincipal } from "../runtime/auth.ts";
import { type AgentIdentity, agentNameFrom, MemoryStore, Refused } from "../store/memory-store.ts";

export const MCP_VERSION = "0.1.0";
export const MAX_MCP_BODY = 12 * 1024 * 1024;
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const PAGE_MAX = 100_000;

export const INSTRUCTIONS =
  "Clyde keeps one shared memory for your AI agents: what one agent learns, every other agent can recall. " +
  "register_agent names the agent once per client (name, context work, home, hobby, personal or both, surface, " +
  "description, plus optional nickname, type, harness, repos, projects, computer, strict_projects). recall searches " +
  "notes with optional category, context, project, or transferability filters. Each packet begins with a retrieval id. " +
  "recall_more pages past it (including dormant and superseded notes). feedback rates shown entries (used, irrelevant, wrong, or nothing_useful) " +
  "so ranking learns. remember stores a short note (<500 chars by default) with pattern, title, body, evidence, and optional artifacts. " +
  "get_entry reads a full note; get_blob and upload_blob handle larger files. Agents coordinate via post_message, check_messages, " +
  "ack_messages, dismiss_messages, and the quest board (post_quest, list_quests, claim_quest, update_quest, complete_quest, abandon_quest).";

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });
const hints = (title: string, readOnly: boolean, destructive?: boolean) => ({
  title,
  annotations: {
    title,
    readOnlyHint: readOnly,
    ...(readOnly ? {} : { destructiveHint: Boolean(destructive) }),
    openWorldHint: false,
  },
});

export const TOOLS = [
  {
    name: "register_agent",
    ...hints("Register agent", false, true),
    description: "Registers the calling agent (name, context, surface, description, optional projects/repos/computer/type).",
    inputSchema: {
      type: "object",
      required: ["name", "context", "surface", "description"],
      properties: {
        name: str("Lowercase handle (letters, digits, dashes, underscores)"),
        context: str(`One of ${AGENT_CONTEXTS.join(", ")}`),
        surface: str("Client surface, e.g. claude-code, codex, gemini-cli, antigravity"),
        description: str("What the agent does"),
        nickname: str("Optional unique nickname"),
        repos: { type: "array", items: { type: "string" }, description: "Repositories the agent reaches" },
        harness: str("Optional client harness name"),
        projects: { type: "array", items: { type: "string" }, description: "Project slugs" },
        computer: str("Machine name"),
        type: { type: "string", enum: [...AGENT_TYPES], description: "Agent role" },
        strict_projects: { type: "boolean", description: "Lock project-scoped reads strictly to declared projects" },
      },
    },
  },
  {
    name: "recall",
    ...hints("Recall notes", true),
    description: "Searches stored notes (decisions, preferences, observations, reactions) and returns a compact packet with a retrieval id.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: str("What to search for"),
        task: str("Optional current task summary"),
        scope: str("Optional run:<id> scope to boost"),
        depth: str("packet (default) or deep"),
        category: str("Optional category slug"),
        context: str("Optional realm filter: general, work, home, hobby, personal or all"),
        project: str("Optional project slug"),
        transferability: str("Optional transferability filter: general, context, project or computer"),
      },
    },
  },
  {
    name: "recall_more",
    ...hints("Recall more", true),
    description: "Returns the next page of results past a prior recall, including dormant and superseded entries.",
    inputSchema: {
      type: "object",
      required: ["retrieval_id"],
      properties: { retrieval_id: str("Retrieval ID from recall or previous recall_more") },
    },
  },
  {
    name: "get_entry",
    ...hints("Get note", true),
    description: "Opens one note by ID with full metadata, evidence, links, and artifact list.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: str("Entry ID") },
    },
  },
  {
    name: "get_blob",
    ...hints("Read artifact", true),
    description: "Reads a text artifact page by page or returns a download URL for binary blobs.",
    inputSchema: {
      type: "object",
      required: ["sha256"],
      properties: {
        sha256: str("Artifact SHA-256 hex digest"),
        offset: int("Character offset (default 0)"),
        limit: int("Maximum characters (default 20000)"),
      },
    },
  },
  {
    name: "upload_blob",
    ...hints("Upload file", false, false),
    description: "Reserves a local upload URL for binary or large files before citing their sha256 in remember.",
    inputSchema: {
      type: "object",
      required: ["sha256", "size"],
      properties: {
        sha256: str("File SHA-256 (64 hex chars)"),
        size: int("File size in bytes"),
        media_type: str("MIME type (default application/octet-stream)"),
      },
    },
  },
  {
    name: "remember",
    ...hints("Save note", false, false),
    description:
      "Stores a verified note (decisions, preferences, observations, projects, recommendations, references, reactions). Keep body <= 500 chars unless long: true.",
    inputSchema: {
      type: "object",
      required: ["pattern", "title", "body", "evidence_kind", "evidence"],
      properties: {
        pattern: str("projects, decisions, observations, preferences, recommendations, references, reactions"),
        title: str("Short title"),
        body: str("Concise summary (<= 500 chars unless long: true)"),
        scope: str("global (default), domain:<x>, repo:<x>, run:<id>"),
        authority: str("draft (default) or observed"),
        kind: str("observation (default), fact, user, plan"),
        sensitivity: str("normal (default), confidential, private"),
        lang: str("Language code (default en)"),
        valid_from: str("YYYY-MM-DD"),
        project: str("Optional project entry ID"),
        evidence_kind: str("quote, assistant, summary, memory"),
        evidence: str("Supporting evidence"),
        evidence_event: str("Event ID for verbatim verification"),
        links: { type: "array", items: { type: "object" }, description: "[{type, to}] links" },
        supersedes: { type: "array", items: { type: "string" }, description: "Entry IDs replaced by this note" },
        artifacts: { type: "array", items: { type: "object" }, description: "[{name, kind?, media_type?, text|base64|sha256}]" },
        long: { type: "boolean", description: "Allow body up to 4000 characters" },
        category: str("Category slug"),
        context: str("general, work, home, hobby, personal"),
        transferability: str("general, context, project, computer"),
        project_slug: str("Project slug"),
        computer: str("Computer name"),
      },
    },
  },
  {
    name: "feedback",
    ...hints("Rate recall", false, false),
    description: "Logs entry verdicts (used, irrelevant, wrong) or nothing_useful for a recall so ranking improves.",
    inputSchema: {
      type: "object",
      required: ["retrieval_id"],
      properties: {
        retrieval_id: str("Retrieval ID"),
        entries: { type: "array", items: { type: "object" }, description: "[{entry_id, verdict: used|irrelevant|wrong}]" },
        nothing_useful: { type: "boolean", description: "True when no item helped" },
        note: str("Optional explanation"),
      },
    },
  },
  {
    name: "post_message",
    ...hints("Send message", false, false),
    description: "Sends a short message to another agent or 'all'.",
    inputSchema: {
      type: "object",
      required: ["to", "body"],
      properties: {
        to: str("Agent name or 'all'"),
        body: str("Message text (<= 2000 chars)"),
        context: str("Optional recipient realm filter for 'all'"),
        project: str("Optional recipient project filter for 'all'"),
      },
    },
  },
  {
    name: "check_messages",
    ...hints("Check inbox", false, false),
    description: "Lists unacknowledged messages for the calling agent.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ack_messages",
    ...hints("Acknowledge messages", false, false),
    description: "Marks message IDs as handled.",
    inputSchema: {
      type: "object",
      required: ["ids"],
      properties: { ids: { type: "array", items: { type: "integer" }, description: "Message IDs" } },
    },
  },
  {
    name: "dismiss_messages",
    ...hints("Dismiss messages", false, false),
    description: "Dismisses queued messages permanently without acknowledgment.",
    inputSchema: {
      type: "object",
      required: ["ids"],
      properties: { ids: { type: "array", items: { type: "integer" }, description: "Message IDs" } },
    },
  },
  {
    name: "post_quest",
    ...hints("Post quest", false, false),
    description: "Posts a scoped task onto the shared quest board.",
    inputSchema: {
      type: "object",
      required: ["title", "brief", "done_when"],
      properties: {
        title: str("Short title"),
        brief: str("Task summary"),
        done_when: str("Completion criterion"),
        priority: str("urgent, high, normal (default), low"),
        context: str("work, home, hobby, personal, both"),
        for: str("Target agent or 'any'"),
        project: str("Project slug"),
        computer: str("Target computer"),
        agent_type: str("Required agent type"),
        target: { type: "object", description: "Structured routing filter" },
        tags: { type: "array", items: { type: "string" }, description: "Up to 8 tags" },
        artifacts: { type: "array", items: { type: "object" }, description: "[{name, sha256}]" },
      },
    },
  },
  {
    name: "list_quests",
    ...hints("List quests", true),
    description: "Lists quests visible to the calling agent.",
    inputSchema: {
      type: "object",
      properties: {
        show: str("open (default), mine, done, all"),
        tag: str("Filter by tag"),
        project: str("Filter by project slug"),
        limit: int("Max results (default 20)"),
      },
    },
  },
  {
    name: "claim_quest",
    ...hints("Claim quest", false, false),
    description: "Atomically claims an open quest under a renewable lease.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: int("Quest ID"), lease_minutes: int("15-480, default 120") },
    },
  },
  {
    name: "update_quest",
    ...hints("Update quest", false, false),
    description: "Adds a progress note on a claimed quest and renews its lease.",
    inputSchema: {
      type: "object",
      required: ["id", "note"],
      properties: { id: int("Quest ID"), note: str("Progress note") },
    },
  },
  {
    name: "complete_quest",
    ...hints("Complete quest", false, false),
    description: "Completes a claimed quest with evidence and the entry ID it produced.",
    inputSchema: {
      type: "object",
      required: ["id", "evidence", "entry_id"],
      properties: { id: int("Quest ID"), evidence: str("Completion evidence"), entry_id: str("Entry ID produced") },
    },
  },
  {
    name: "abandon_quest",
    ...hints("Abandon quest", false, false),
    description: "Releases a claimed quest back to open, or withdraws an open quest posted by you.",
    inputSchema: {
      type: "object",
      required: ["id", "reason"],
      properties: { id: int("Quest ID"), reason: str("Why") },
    },
  },
];

export type McpCallContext = {
  principal: LocalPrincipal;
  sessionId: string | null;
  clientName: string;
};

const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

function textAnswer(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

export async function handleJsonRpcMessage(
  msg: Record<string, unknown>,
  ctx: McpCallContext,
  store: MemoryStore,
  baseUrl: string,
): Promise<{ status: number; body?: unknown; headers?: Record<string, string> }> {
  const id = msg.id ?? null;
  const method = String(msg.method ?? "");
  const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;

  if (msg.id === undefined && method.startsWith("notifications/")) {
    return { status: 204 };
  }

  if (method === "ping") {
    return { status: 200, body: rpcResult(id, {}) };
  }

  if (method === "initialize") {
    const reqProto = typeof params.protocolVersion === "string" ? params.protocolVersion : VERSIONS[0];
    const proto = VERSIONS.includes(reqProto) ? reqProto : VERSIONS[0];
    const clientName = String((params.clientInfo as Record<string, unknown> | undefined)?.name ?? ctx.clientName ?? "mcp-client");
    const sid = ctx.sessionId ?? crypto.randomUUID();
    await store.ensureSession(sid, clientName, null, null);
    return {
      status: 200,
      headers: { "mcp-session-id": sid },
      body: rpcResult(id, {
        protocolVersion: proto,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "clyde", title: "Clyde Local", version: MCP_VERSION },
        instructions: INSTRUCTIONS,
      }),
    };
  }

  if (method === "tools/list") {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }

  if (method !== "tools/call") {
    return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
  }

  const toolName = String(params.name ?? "");
  const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
  const sid = ctx.sessionId ?? "default";
  const sess = await store.getSessionMeta(sid);
  const clientName = sess?.client ?? ctx.clientName ?? "mcp-client";
  if (!sess) await store.ensureSession(sid, clientName, null, null);

  let who: AgentIdentity = await store.resolveAgent(ctx.principal.principal, clientName);
  who = { ...who, session: sid, sessionRepo: sess?.repo ?? null };
  const isUnregistered = who.context === null;

  try {
    let outText = "";
    let isErr = false;

    if (toolName === "register_agent") {
      const reg = await store.registerAgent(ctx.principal.principal, clientName, args);
      outText = `Registered agent "${reg.name}" (${reg.context} on ${reg.surface}).`;
    } else if (toolName === "recall") {
      const q = typeof args.query === "string" ? args.query.trim() : "";
      if (!q) throw new Refused("query is required.");
      if (args.category && !CATEGORY_RE.test(String(args.category).trim().toLowerCase())) {
        throw new Refused("category must be 1 to 40 lowercase chars.");
      }
      const res = await store.recall({
        session: sid,
        query: q,
        task: typeof args.task === "string" ? args.task : "",
        agent: who.name,
        scope: typeof args.scope === "string" ? args.scope : null,
        principal: ctx.principal.principal,
        surface: "mcp",
        depth: typeof args.depth === "string" ? args.depth : "packet",
        agentIdentity: who,
        filter: {
          category: typeof args.category === "string" ? args.category : null,
          context: typeof args.context === "string" ? args.context : null,
          project: typeof args.project === "string" ? args.project : null,
          transferability: typeof args.transferability === "string" ? args.transferability : null,
        },
      });
      outText = res.text;
    } else if (toolName === "recall_more") {
      const rid = typeof args.retrieval_id === "string" ? args.retrieval_id.trim() : "";
      if (!rid) throw new Refused("retrieval_id is required.");
      const res = await store.recallMore(rid, sid, who);
      outText = res.text;
    } else if (toolName === "get_entry") {
      const eid = typeof args.id === "string" ? args.id.trim() : "";
      if (!eid) throw new Refused("id is required.");
      const entry = await store.getEntry(eid, who, sid, ctx.principal.principal);
      if (entry === null) throw new Refused(`No entry "${eid}".`);
      outText = entry;
    } else if (toolName === "get_blob") {
      const sha = typeof args.sha256 === "string" ? args.sha256.trim().toLowerCase() : "";
      const blob = await store.readBlob(sha, who);
      if (!blob) throw new Refused(`No blob ${sha}.`);
      if (!blob.public) throw new Refused(`Private blob: ask ${store.ownerLabel}.`);
      if (isTextMedia(blob.media_type) && blob.content) {
        const text = decodeUtf8(blob.content) ?? "";
        const offset = Math.max(0, Number(args.offset ?? 0) || 0);
        const limit = Math.min(PAGE_MAX, Math.max(1, Number(args.limit ?? 20_000) || 20_000));
        const slice = text.slice(offset, offset + limit);
        const next = offset + slice.length;
        const tail = next < text.length ? `\n\n[Showing chars ${offset}-${next} of ${text.length}. Next: get_blob(sha256="${sha}", offset=${next})]` : "";
        outText = `${slice}${tail}`;
      } else {
        outText = `Download binary artifact (${blob.media_type}, ${blob.size} bytes): ${baseUrl}/blobs/${sha}`;
      }
    } else if (toolName === "upload_blob") {
      const sha = typeof args.sha256 === "string" ? args.sha256 : "";
      const size = Number(args.size);
      const mediaType = typeof args.media_type === "string" ? args.media_type : "application/octet-stream";
      const slot = await store.createUploadSlot(ctx.principal.principal, sha, size, mediaType);
      const putUrl = `${baseUrl}${slot.uploadPath}`;
      outText = `Upload with:\ncurl -X PUT --data-binary @file '${putUrl}'\nThen cite sha256 "${sha.toLowerCase()}" in remember.`;
    } else if (toolName === "remember") {
      const res = await store.remember(args, "agent", who.name, ctx.principal.principal, {
        agent: who.name,
        context: who.context,
        session: sid,
        profile: who.profile,
        computer: who.computer ?? null,
        projects: who.projects ?? [],
        repo: sess?.repo ?? null,
        agentScope: who,
      });
      outText = `Remembered ${res.id}.${res.blobs.length ? ` (${res.blobs.length} artifact${res.blobs.length === 1 ? "" : "s"})` : ""}`;
    } else if (toolName === "feedback") {
      outText = await store.recordFeedback(args, sid, "agent");
      isErr = !outText.startsWith("Logged");
    } else if (toolName === "post_message") {
      const res = await store.postMessage(who.name, args.to, args.body, { context: args.context, project: args.project });
      outText = `Posted message #${res.id} to ${res.to} (${res.targets.length} recipient${res.targets.length === 1 ? "" : "s"}).`;
    } else if (toolName === "check_messages") {
      const msgs = await store.checkMessages(who.name);
      outText = msgs.length
        ? msgs.map((m) => `#${m.id} from ${m.sender} -> ${m.to} (${m.created_at}): ${m.body}`).join("\n")
        : "No unread messages.";
    } else if (toolName === "ack_messages") {
      const ids = Array.isArray(args.ids) ? args.ids.map(Number).filter(Number.isSafeInteger) : [];
      const n = await store.ackMessages(who.name, ids);
      outText = `Acknowledged ${n} message${n === 1 ? "" : "s"}.`;
    } else if (toolName === "dismiss_messages") {
      const ids = Array.isArray(args.ids) ? args.ids.map(Number).filter(Number.isSafeInteger) : [];
      const n = await store.dismissMessages(who.name, ids);
      outText = `Dismissed ${n} message${n === 1 ? "" : "s"}.`;
    } else if (toolName === "post_quest") {
      const q = await store.postQuest(who, args);
      outText = `Posted quest #${q.id} [${q.priority}]: ${q.title}`;
    } else if (toolName === "list_quests") {
      const qs = await store.listQuests(who, args);
      outText = qs.length
        ? qs.map((q) => `#${q.id} [${q.status}/${q.priority}] ${q.title} (by ${q.poster}${q.claimed_by ? `, claimed by ${q.claimed_by}` : ""})`).join("\n")
        : "No matching quests.";
    } else if (toolName === "claim_quest") {
      const q = await store.claimQuest(who, args.id, args.lease_minutes);
      outText = `Claimed quest #${q.id} until ${q.lease_until}.\nBrief: ${q.brief}\nDone when: ${q.done_when}` +
        (q.notes?.length ? `\nNotes:\n${q.notes.map((n: Record<string, unknown>) => `- ${n.author}: ${n.note}`).join("\n")}` : "");
    } else if (toolName === "update_quest") {
      const q = await store.updateQuest(who, args.id, args.note);
      outText = `Updated quest #${q.id}; lease renewed until ${q.lease_until}.`;
    } else if (toolName === "complete_quest") {
      const q = await store.completeQuest(who, args.id, args.evidence, args.entry_id);
      outText = `Completed quest #${q.id} (entry ${q.entry_id}).`;
    } else if (toolName === "abandon_quest") {
      const q = await store.abandonQuest(who, args.id, args.reason);
      outText = `Quest #${q.id} is now ${q.status}.`;
    } else {
      return { status: 200, body: rpcError(id, -32601, `Unknown tool: ${toolName}`) };
    }

    if (toolName !== "feedback" && toolName !== "recall" && toolName !== "recall_more") {
      outText += await store.pendingFeedbackNote(sid);
    }
    if (isUnregistered && toolName !== "register_agent") {
      outText += "\n\nNote: This agent is not registered yet. Call register_agent(name, context, surface, description).";
    }

    return { status: 200, body: rpcResult(id, textAnswer(outText, isErr)) };
  } catch (err) {
    if (err instanceof Refused) {
      return { status: 200, body: rpcResult(id, textAnswer(err.message, true)) };
    }
    return { status: 200, body: rpcResult(id, textAnswer(`Internal error: ${(err as Error).message}`, true)) };
  }
}

export async function handleMcpHttp(
  req: Request,
  principal: LocalPrincipal,
  store: MemoryStore,
  baseUrl: string,
): Promise<Response> {
  if (req.method === "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST, OPTIONS" } });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST, OPTIONS" } });
  }
  const raw = await req.text();
  if (raw.length > MAX_MCP_BODY) {
    return Response.json(rpcError(null, -32600, "Request body too large."), { status: 413 });
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }

  const sessionId = req.headers.get("mcp-session-id");
  const clientName = agentNameFrom(req.headers.get("user-agent") ?? "http-mcp");
  const res = await handleJsonRpcMessage(parsed, { principal, sessionId, clientName }, store, baseUrl);
  if (res.status === 204) {
    return new Response(null, { status: 204, headers: res.headers });
  }
  return Response.json(res.body, { status: res.status, headers: res.headers });
}
