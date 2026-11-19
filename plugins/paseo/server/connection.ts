import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export type Identity = { id: string; project: string; role: string; provider: string; context?: string };
const MAX_SESSIONS = 512;
const sessions = new Map<string, Promise<string>>();

function readConfigValue(dir: string, file: string): string {
  const path = join(dir, file);
  let value = "";
  try {
    value = readFileSync(path, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Clyde isn't connected on this machine. Run `clyde install` or sign in first.");
    }
    throw err;
  }
  if (!value) throw new Error(`Clyde config file ${file} is empty. Run \`clyde install\` to reconnect.`);
  return value;
}

function readServerId(): string {
  const path = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "server-id");
  try {
    if (existsSync(path)) {
      const value = readFileSync(path, "utf8").trim();
      if (value) return value;
    }
  } catch { /* Fall back to host fingerprint below. */ }
  return createHash("sha256").update(hostname() || "local").digest("hex").slice(0, 16);
}

export async function agentReply(agent: Identity, tool: string, args: Record<string, unknown>) {
  return scopedReply(agent,tool,args);
}
export async function sharedBoardReply(args:Record<string,unknown>) {
  return scopedReply(null,"list_quests",args);
}
async function scopedReply(agent:Identity|null,tool:string,args:Record<string,unknown>){
  const config = process.env.CLYDE_CONFIG_DIR || join(homedir(), ".config/memory");
  const token = readConfigValue(config, "token");
  const base = readConfigValue(config, "url").replace(/\/$/, "");
  const url = new URL(base + "/mcp");
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("Clyde requires HTTPS");
  }
  const host = readServerId();
  const hash = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  const name = agent ? "paseo-"+hash(host,agent.id).slice(0,32) : "clyde-paseo-board";
  const realm = agent?.context ?? "work";
  const key = hash(base, token, name, agent?.project ?? "", agent?.role ?? "", agent?.provider ?? "", realm);
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
        if(agent) await rpc("tools/call", {
          name: "register_agent",
          arguments: {
            name,
            surface: "paseo",
            context: realm,
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
