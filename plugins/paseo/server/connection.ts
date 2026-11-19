import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Identity = { id: string; project: string; role: string; provider: string };
const MAX_SESSIONS = 512;
const sessions = new Map<string, Promise<string>>();

export async function agentReply(agent: Identity, tool: string, args: Record<string, unknown>) {
  const config = process.env.CLYDE_CONFIG_DIR || join(homedir(), ".config/memory");
  const token = readFileSync(join(config, "token"), "utf8").trim();
  const base = readFileSync(join(config, "url"), "utf8").trim().replace(/\/$/, "");
  const url = new URL(base + "/mcp");
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("Clyde requires HTTPS");
  }
  const host = readFileSync(join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "server-id"), "utf8").trim();
  const hash = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  const name = "paseo-" + hash(host, agent.id).slice(0, 32);
  const key = hash(base, token, name, agent.project, agent.role);
  async function rpc(method: string, params: object, session?: string) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10000);
    try {
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        signal: abort.signal,
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          ...(session ? { "mcp-session-id": session } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!response.ok) throw new Error("Clyde returned HTTP " + response.status);
      const body = await response.json() as {
        error?: { message: string };
        result?: { _meta?: { "clyde/card"?: unknown }; isError?: boolean; content?: { text?: string }[] };
      };
      const text = body.result?.content?.[0]?.text || "";
      if (body.error || body.result?.isError) throw new Error(body.error?.message || text);
      return { text, card: body.result?._meta?.["clyde/card"], session: response.headers.get("mcp-session-id") };
    } finally {
      clearTimeout(timer);
    }
  }
  if (!sessions.has(key)) {
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    sessions.set(
      key,
      (async () => {
        const { session } = await rpc("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
          clientInfo: { name, version: "1" },
        });
        if (!session) throw new Error("Clyde did not return a session");
        await rpc("tools/call", {
          name: "register_agent",
          arguments: {
            name,
            surface: "paseo",
            context: "work",
            type: "coding",
            harness: agent.provider,
            description: agent.role,
            projects: [agent.project],
            strict_projects: true,
          },
        }, session);
        return session;
      })().catch((err) => {
        sessions.delete(key);
        throw err;
      }),
    );
  }
  const session = await sessions.get(key)!;
  const dir = join(process.env.CLYDE_HOME || join(homedir(), ".clyde"), "recall-sessions");
  const file = join(dir, hash(base, token, name) + ".json");
  const bindings = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  };
  const origin = tool === "feedback" && typeof args.retrieval_id === "string"
    ? bindings()[args.retrieval_id]
    : undefined;
  const reply = await rpc("tools/call", { name: tool, arguments: args }, origin ?? session);
  if (tool === "recall" || tool === "recall_more") {
    const rid = (reply.card as { retrieval_id?: string } | undefined)?.retrieval_id ??
      /^retrieval ([0-9a-f-]{36})/.exec(reply.text)?.[1];
    if (rid) {
      const rows = Object.fromEntries(Object.entries(bindings()).slice(-511));
      rows[rid] = session;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(file + ".tmp", JSON.stringify(rows), { mode: 0o600 });
      renameSync(file + ".tmp", file);
    }
  }
  return reply;
}

export async function agentCall(agent: Identity, tool: string, args: Record<string, unknown>): Promise<string> {
  return (await agentReply(agent, tool, args)).text;
}
