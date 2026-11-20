import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { call } from "./daemon.ts";
import type { RawRun, RawThread } from "./shape.ts";

type Agent = NonNullable<ReturnType<ReturnType<PluginHandlerContext["paseo"]["agents"]["ref"]>["current"]>>;
type Request = Agent["pendingPermissions"][number];

// Read-only tools injected by this plugin into Paseo's own MCP server.
const paseoLookups = new Set(["mcp__paseo__clyde_recall", "mcp__paseo__clyde_recall_more"]);
// Read-only Clyde memory tools exposed through the user's configured `memory` MCP server.
const memoryLookups = new Set([
  "mcp__memory__recall",
  "mcp__memory__recall_more",
  "mcp__memory__check_messages",
]);
const ALLOWED_HTTP_TYPES = new Set(["http", "sse", "streamable-http", "streamablehttp"]);

function lookup(request: Request): boolean {
  return request.kind === "tool" &&
    (paseoLookups.has(request.name) || memoryLookups.has(request.name)) &&
    (request.actions === undefined || (Array.isArray(request.actions) && request.actions.length === 0));
}

function canonicalPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

function samePath(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return canonicalPath(a) === canonicalPath(b);
}

function ancestors(dir: string): string[] {
  const out: string[] = [];
  let cur = canonicalPath(dir);
  for (;;) {
    out.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

function normalizeMcpUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
      return null;
    }
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

function trustedClydeMcpUrl(): string | null {
  const configDir = process.env.CLYDE_CONFIG_DIR || join(homedir(), ".config/memory");
  let raw = "";
  try {
    raw = readFileSync(join(configDir, "url"), "utf8").trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  const base = raw.replace(/\/+$/, "");
  return normalizeMcpUrl(base.endsWith("/mcp") ? base : `${base}/mcp`);
}

function isTrustedHttpMcpEntry(entry: unknown, trustedUrl: string): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const rec = entry as Record<string, unknown>;
  if (rec.disabled === true || rec.enabled === false) return false;
  if (rec.command !== undefined || rec.args !== undefined) return false;
  if (rec.type !== undefined) {
    if (typeof rec.type !== "string" || !ALLOWED_HTTP_TYPES.has(rec.type.toLowerCase())) return false;
  }
  const rawUrl = typeof rec.url === "string" ? rec.url : typeof rec.serverUrl === "string" ? rec.serverUrl : null;
  if (!rawUrl) return false;
  return normalizeMcpUrl(rawUrl) === trustedUrl;
}

type InspectResult = "absent" | "trusted" | "untrusted";

function inspectJsonMemoryServer(file: string, trustedUrl: string, projectDirs?: Set<string>): InspectResult {
  if (!existsSync(file)) return "absent";
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return "untrusted";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "untrusted";
  const root = parsed as Record<string, unknown>;
  let foundTrusted = false;

  if (projectDirs && root.projects && typeof root.projects === "object" && !Array.isArray(root.projects)) {
    for (const [projPath, projConfig] of Object.entries(root.projects as Record<string, unknown>)) {
      if (!projectDirs.has(canonicalPath(projPath))) continue;
      if (!projConfig || typeof projConfig !== "object" || Array.isArray(projConfig)) continue;
      const servers = (projConfig as Record<string, unknown>).mcpServers;
      if (servers && typeof servers === "object" && !Array.isArray(servers) && "memory" in servers) {
        if (!isTrustedHttpMcpEntry((servers as Record<string, unknown>).memory, trustedUrl)) return "untrusted";
        foundTrusted = true;
      }
    }
  }

  const servers = root.mcpServers;
  if (servers !== undefined) {
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return "untrusted";
    if ("memory" in servers) {
      if (!isTrustedHttpMcpEntry((servers as Record<string, unknown>).memory, trustedUrl)) return "untrusted";
      foundTrusted = true;
    }
  }
  return foundTrusted ? "trusted" : "absent";
}

function unquoteTomlString(raw: string): string | null {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1);
  }
  return null;
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        quote = null;
      }
    } else if (quote === "'") {
      if (ch === "'") quote = null;
    } else {
      if (ch === "#") return line.slice(0, i);
      if (ch === '"' || ch === "'") quote = ch;
    }
  }
  return line;
}

function inspectTomlMemoryServer(file: string, trustedUrl: string): InspectResult {
  if (!existsSync(file)) return "absent";
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "untrusted";
  }
  let inMemory = false;
  let sawMemory = false;
  let url: string | null = null;
  let invalid = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const segs = header[1].split(".").map((s) => {
        const t = s.trim();
        return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
      });
      inMemory = segs.length === 2 && segs[0] === "mcp_servers" && segs[1] === "memory";
      if (inMemory) sawMemory = true;
      continue;
    }
    // Dotted or inline assignment outside section, e.g. mcp_servers.memory = { ... } or mcp_servers.memory.url = "..."
    const dotted = /^mcp_servers\.(?:memory|"memory"|'memory')(?:\.([a-zA-Z0-9_-]+))?\s*=\s*(.+)$/.exec(line);
    if (dotted) {
      sawMemory = true;
      const key = dotted[1];
      const val = dotted[2].trim();
      if (!key) {
        // Inline table: only accept if it defines url and no command/enabled=false.
        if (/\bcommand\s*=/.test(val) || /\benabled\s*=\s*false\b/.test(val)) return "untrusted";
        const m = /\burl\s*=\s*("[^"]*"|'[^']*')/.exec(val);
        const parsedUrl = m ? unquoteTomlString(m[1]) : null;
        if (!parsedUrl || normalizeMcpUrl(parsedUrl) !== trustedUrl) return "untrusted";
        url = parsedUrl;
        continue;
      }
      if (key === "command" || key === "args") invalid = true;
      else if (key === "enabled" && val === "false") invalid = true;
      else if (key === "url") {
        const parsedUrl = unquoteTomlString(val);
        if (!parsedUrl) invalid = true;
        else url = parsedUrl;
      }
      continue;
    }
    if (!inMemory) continue;
    const kv = /^([a-zA-Z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const [, key, val] = kv;
    if (key === "command" || key === "args") invalid = true;
    else if (key === "enabled" && val.trim() === "false") invalid = true;
    else if (key === "url") {
      const parsedUrl = unquoteTomlString(val);
      if (!parsedUrl) invalid = true;
      else url = parsedUrl;
    }
  }
  if (!sawMemory) return "absent";
  if (invalid || !url || normalizeMcpUrl(url) !== trustedUrl) return "untrusted";
  return "trusted";
}

function requestServerConsistent(request: Request, trustedUrl: string): boolean {
  for (const bag of [request.detail, request.metadata]) {
    if (!bag || typeof bag !== "object" || Array.isArray(bag)) continue;
    const rec = bag as Record<string, unknown>;
    if (typeof rec.server === "string" && rec.server !== "memory") return false;
    if (typeof rec.serverName === "string" && rec.serverName !== "memory") return false;
    const rawUrl = typeof rec.serverUrl === "string" ? rec.serverUrl : typeof rec.url === "string" ? rec.url : null;
    if (rawUrl && normalizeMcpUrl(rawUrl) !== trustedUrl) return false;
  }
  return true;
}

function verifyTrustedMemoryForCwd(provider: string, cwd: string, trustedUrl: string): boolean {
  const dirs = ancestors(cwd);
  const dirSet = new Set(dirs);
  let verified = false;
  const check = (result: InspectResult): boolean => {
    if (result === "untrusted") return false;
    if (result === "trusted") verified = true;
    return true;
  };

  if (provider === "claude") {
    const managed = process.env.CLAUDE_MANAGED_MCP_FILE || "/Library/Application Support/ClaudeCode/managed-mcp.json";
    if (!check(inspectJsonMemoryServer(managed, trustedUrl))) return false;
    for (const dir of dirs) {
      if (!check(inspectJsonMemoryServer(join(dir, ".mcp.json"), trustedUrl))) return false;
      if (!check(inspectJsonMemoryServer(join(dir, ".claude", "settings.json"), trustedUrl))) return false;
      if (!check(inspectJsonMemoryServer(join(dir, ".claude", "settings.local.json"), trustedUrl))) return false;
    }
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const claudeJson = process.env.CLAUDE_CONFIG_FILE || join(claudeConfigDir || homedir(), ".claude.json");
    if (!check(inspectJsonMemoryServer(claudeJson, trustedUrl, dirSet))) return false;
    const userSettings = join(claudeConfigDir || join(homedir(), ".claude"), "settings.json");
    if (!check(inspectJsonMemoryServer(userSettings, trustedUrl))) return false;
    return verified;
  }

  if (provider === "codex") {
    for (const dir of dirs) {
      if (!check(inspectTomlMemoryServer(join(dir, ".codex", "config.toml"), trustedUrl))) return false;
    }
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    if (!check(inspectTomlMemoryServer(join(codexHome, "config.toml"), trustedUrl))) return false;
    return verified;
  }

  if (provider === "antigravity") {
    for (const dir of dirs) {
      if (!check(inspectJsonMemoryServer(join(dir, ".gemini", "mcp_config.json"), trustedUrl))) return false;
      if (!check(inspectJsonMemoryServer(join(dir, ".gemini", "settings.json"), trustedUrl))) return false;
    }
    const geminiDir = process.env.GEMINI_CONFIG_DIR || join(homedir(), ".gemini");
    for (const rel of ["config/mcp_config.json", "antigravity/mcp_config.json", "settings.json"]) {
      if (!check(inspectJsonMemoryServer(join(geminiDir, rel), trustedUrl))) return false;
    }
    return verified;
  }

  return false;
}

function trustedMemoryServer(provider: string, cwds: (string | null | undefined)[], request: Request): boolean {
  const trustedUrl = trustedClydeMcpUrl();
  if (!trustedUrl) return false;
  if (!requestServerConsistent(request, trustedUrl)) return false;
  const uniqueCwds = [...new Set(cwds.filter((c): c is string => typeof c === "string" && !!c.trim()).map(canonicalPath))];
  if (!uniqueCwds.length) return false;
  return uniqueCwds.every((cwd) => verifyTrustedMemoryForCwd(provider, cwd, trustedUrl));
}

async function ownsRun(native: Agent | null | undefined, agentId: string, provider: string): Promise<RawRun | null> {
  if (!native || native.id !== agentId || native.archivedAt || native.provider !== provider) return null;
  const labels = native.labels ?? {};
  const runId = labels["clyde.run"] ?? labels["clyde.orchestrator"];
  if (typeof runId !== "string" || !/^r-[\da-f-]+$/i.test(runId)) return null;
  const run = await call<RawRun>("GET", "/runs/" + encodeURIComponent(runId), undefined, { recover: false });
  if (!run || run.id !== runId || run.archivedAt || run.endedAt || !["running", "asking"].includes(run.status)) return null;
  if (labels["clyde.thread"]) {
    if (run.status !== "running" || labels["clyde.run"] !== run.id) return null;
    const stage = run.stages.findLast(stage => stage.status === "running");
    const attempt = stage?.attempts.at(-1);
    if (!stage || stage.endedAt || !attempt || attempt.endedAt || attempt.result || attempt.verdict || attempt.ok === false || attempt.judgeId || attempt.threadId !== labels["clyde.thread"]) return null;
    const thread = await call<RawThread>("GET", "/threads/" + encodeURIComponent(attempt.threadId), undefined, { recover: false });
    const ok = !!thread && thread.id === attempt.threadId && thread.status === "running" && !thread.archivedAt && !thread.readOnly && thread.runId === run.id && thread.stage === stage.name && thread.rung.backend === provider && thread.paseoAgentId === agentId && samePath(thread.cwd, run.cwd) && samePath(native.cwd, thread.cwd);
    return ok ? run : null;
  }
  return labels["clyde.orchestrator"] === run.id && run.paseoParentId === agentId ? run : null;
}

export function allowRunLookups(server: PluginServerContext) {
  server.addHook("agent.permission.before", async ({ agent, request }, { paseo }) => {
    if (!lookup(request)) return;
    try {
      const handle = paseo.agents.ref(agent.id);
      await handle.refresh();
      const firstNative = handle.current();
      const firstRun = await ownsRun(firstNative, agent.id, request.provider);
      if (!firstRun) return;
      if (memoryLookups.has(request.name) && !trustedMemoryServer(request.provider, [firstNative?.cwd, firstRun.cwd], request)) return;
      // Native requests and the active attempt can both change while ownership is checked.
      await handle.refresh();
      const current = handle.current();
      const currentRun = await ownsRun(current, agent.id, request.provider);
      if (!currentRun) return;
      const pending = current?.pendingPermissions?.filter(p => p.id === request.id) ?? [];
      if (pending.length !== 1 || !lookup(pending[0]) || pending[0].name !== request.name || pending[0].provider !== request.provider) return;
      if (memoryLookups.has(pending[0].name) && !trustedMemoryServer(pending[0].provider, [current?.cwd, currentRun.cwd], pending[0])) return;
      await handle.respondToPermission({ requestId: pending[0].id, response: { behavior: "allow" } });
    } catch {
      // Unavailable ownership or response services leave the native request pending for explicit review.
    }
  });
}
