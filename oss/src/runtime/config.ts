// Zero-dependency TOML/JSON configuration loader with env interpolation and strict loopback security checks.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import type { DatabaseConfig } from "../connectors/types.ts";

export type ClydeConfig = {
  server: {
    host: string;
    port: number;
    ui: boolean;
    owner_name: string;
    owner_id: string;
    data_dir: string;
  };
  auth: {
    mode: "none" | "token" | "devices";
    token: string;
  };
  database: DatabaseConfig;
  blobs: {
    backend: "fs" | "sql";
    dir: string;
    inline_max_bytes: number;
    max_blob_bytes: number;
    max_quota_bytes: number;
  };
  embeddings: {
    provider: "none" | "ollama" | "openai" | "openai-compatible";
    base_url: string;
    model: string;
    dimensions: number;
    api_key: string;
  };
  judge: {
    write_screen: "redact-only" | "llm" | "off";
    relevance_filter: "off" | "llm";
    provider: "none" | "ollama" | "openai" | "openai-compatible";
    base_url: string;
    model: string;
    api_key: string;
  };
  ranking: {
    arm: "index" | "hybrid" | "spreading";
    learn_interval_sec: number;
    embed_sync_interval_sec: number;
    event_retention_days: number;
  };
  configDir: string;
};

export function expandHome(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return raw;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || h.startsWith("127.");
}

export function defaultConfig(env: Record<string, string | undefined> = process.env): ClydeConfig {
  const dataDir = expandHome(env.CLYDE_DATA_DIR || "~/.local/share/clyde");
  return {
    server: {
      host: "127.0.0.1",
      port: 8787,
      ui: true,
      owner_name: "local",
      owner_id: "local",
      data_dir: dataDir,
    },
    auth: {
      mode: "none",
      token: "",
    },
    database: {
      connector: "sqlite",
      path: join(dataDir, "clyde.db"),
      fts_backend: "auto",
      vector_backend: "memory",
    },
    blobs: {
      backend: "fs",
      dir: join(dataDir, "blobs"),
      inline_max_bytes: 256 * 1024,
      max_blob_bytes: 64 * 1024 * 1024,
      max_quota_bytes: 10 * 1024 * 1024 * 1024,
    },
    embeddings: {
      provider: "none",
      base_url: "",
      model: "nomic-embed-text",
      dimensions: 0,
      api_key: "",
    },
    judge: {
      write_screen: "redact-only",
      relevance_filter: "off",
      provider: "none",
      base_url: "",
      model: "",
      api_key: "",
    },
    ranking: {
      arm: "spreading",
      learn_interval_sec: 300,
      embed_sync_interval_sec: 300,
      event_retention_days: 180,
    },
    configDir: process.cwd(),
  };
}

function stripTomlComment(line: string): string {
  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\" && quote === '"') {
      escaped = true;
      continue;
    }
    if (c === '"' || c === "'") {
      if (quote === null) quote = c;
      else if (quote === c) quote = null;
      continue;
    }
    if (c === "#" && quote === null) return line.slice(0, i);
  }
  return line;
}

function unescapeBasicString(raw: string): string {
  return raw.replace(/\\(["\\ntr])/g, (_, ch) => {
    if (ch === "n") return "\n";
    if (ch === "t") return "\t";
    if (ch === "r") return "\r";
    return ch;
  });
}

function parseTomlValue(rawVal: string): unknown {
  const s = rawVal.trim();
  if (!s) throw new Error("Empty TOML value");
  if (s === "true") return true;
  if (s === "false") return false;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return unescapeBasicString(s.slice(1, -1));
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1);
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    const items: unknown[] = [];
    let cur = "";
    let quote: string | null = null;
    let esc = false;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (esc) {
        cur += c;
        esc = false;
        continue;
      }
      if (c === "\\" && quote === '"') {
        cur += c;
        esc = true;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = quote === c ? null : (quote === null ? c : quote);
        cur += c;
        continue;
      }
      if (c === "," && quote === null) {
        if (cur.trim()) items.push(parseTomlValue(cur));
        cur = "";
        continue;
      }
      cur += c;
    }
    if (cur.trim()) items.push(parseTomlValue(cur));
    return items;
  }
  if (/^[+-]?\d+(?:_\d+)*$/.test(s)) return Number(s.replaceAll("_", ""));
  if (/^[+-]?\d+(?:_\d+)*\.\d+(?:_\d+)*$/.test(s)) return Number(s.replaceAll("_", ""));
  throw new Error(`Unsupported TOML value: ${s}`);
}

/** Parses basic TOML (sections, dotted sub-sections, strings, numbers, booleans, inline arrays). */
export function parseToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const clean = stripTomlComment(lines[i]).trim();
    if (!clean) continue;
    if (clean.startsWith("[") && clean.endsWith("]")) {
      const path = clean.slice(1, -1).trim().split(".").map((p) => p.trim()).filter(Boolean);
      if (!path.length) throw new Error(`Invalid TOML table header on line ${i + 1}`);
      let target: Record<string, unknown> = root;
      for (const seg of path) {
        const next = target[seg];
        if (!next || typeof next !== "object" || Array.isArray(next)) {
          target[seg] = {};
        }
        target = target[seg] as Record<string, unknown>;
      }
      current = target;
      continue;
    }
    const eq = clean.indexOf("=");
    if (eq <= 0) throw new Error(`Invalid TOML line ${i + 1}: ${clean}`);
    const key = clean.slice(0, eq).trim().replace(/^["']|["']$/g, "");
    const val = parseTomlValue(clean.slice(eq + 1));
    current[key] = val;
  }
  return root;
}

function interpolateEnv(v: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof v === "string") {
    return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? "");
  }
  if (Array.isArray(v)) return v.map((item) => interpolateEnv(item, env));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, interpolateEnv(val, env)]));
  }
  return v;
}

function mergeConfig(base: ClydeConfig, raw: Record<string, unknown>, env: Record<string, string | undefined>): ClydeConfig {
  const data = interpolateEnv(raw, env) as Record<string, Record<string, unknown>>;
  const out: ClydeConfig = structuredClone(base);

  const pick = <T extends Record<string, unknown>>(dst: T, src: unknown, keys: (keyof T)[]) => {
    if (!src || typeof src !== "object") return;
    const s = src as Record<string, unknown>;
    for (const k of keys) {
      if (s[k as string] !== undefined) dst[k] = s[k as string] as T[keyof T];
    }
  };

  if (data.server?.data_dir && typeof data.server.data_dir === "string") {
    const dir = expandHome(data.server.data_dir);
    out.server.data_dir = dir;
    out.database.path = join(dir, "clyde.db");
    out.blobs.dir = join(dir, "blobs");
  }

  pick(out.server, data.server, ["host", "port", "ui", "owner_name", "owner_id", "data_dir"]);
  pick(out.auth, data.auth, ["mode", "token"]);
  pick(out.database, data.database, ["connector", "path", "url", "auth_token", "schema", "table_prefix", "fts_backend", "vector_backend", "options"]);
  pick(out.blobs, data.blobs, ["backend", "dir", "inline_max_bytes", "max_blob_bytes", "max_quota_bytes"]);
  pick(out.embeddings, data.embeddings, ["provider", "base_url", "model", "dimensions", "api_key"]);
  pick(out.judge, data.judge, ["write_screen", "relevance_filter", "provider", "base_url", "model", "api_key"]);
  pick(out.ranking, data.ranking, ["arm", "learn_interval_sec", "embed_sync_interval_sec", "event_retention_days"]);

  // Environment overrides take precedence over config file values.
  if (env.CLYDE_HOST) out.server.host = env.CLYDE_HOST;
  if (env.CLYDE_PORT !== undefined && env.CLYDE_PORT !== "") out.server.port = Number(env.CLYDE_PORT);
  if (env.CLYDE_UI !== undefined && env.CLYDE_UI !== "") out.server.ui = !["0", "false", "no"].includes(env.CLYDE_UI.toLowerCase());
  if (env.CLYDE_OWNER_NAME) out.server.owner_name = env.CLYDE_OWNER_NAME;
  if (env.CLYDE_OWNER_ID) out.server.owner_id = env.CLYDE_OWNER_ID;
  if (env.CLYDE_DATA_DIR) {
    const envDir = expandHome(env.CLYDE_DATA_DIR);
    out.server.data_dir = envDir;
    if (!data.database?.path) out.database.path = join(envDir, "clyde.db");
    if (!data.blobs?.dir) out.blobs.dir = join(envDir, "blobs");
  }
  if (env.CLYDE_AUTH_MODE) out.auth.mode = env.CLYDE_AUTH_MODE as ClydeConfig["auth"]["mode"];
  if (env.CLYDE_TOKEN) out.auth.token = env.CLYDE_TOKEN;
  if (env.CLYDE_DB_CONNECTOR) out.database.connector = env.CLYDE_DB_CONNECTOR;
  if (env.CLYDE_DB_PATH) out.database.path = env.CLYDE_DB_PATH;
  if (env.CLYDE_DB_URL) out.database.url = env.CLYDE_DB_URL;
  if (env.CLYDE_DB_AUTH_TOKEN) out.database.auth_token = env.CLYDE_DB_AUTH_TOKEN;
  if (env.CLYDE_DB_SCHEMA) out.database.schema = env.CLYDE_DB_SCHEMA;
  if (env.CLYDE_DB_PREFIX) out.database.table_prefix = env.CLYDE_DB_PREFIX;
  if (env.CLYDE_DB_FTS) out.database.fts_backend = env.CLYDE_DB_FTS as DatabaseConfig["fts_backend"];
  if (env.CLYDE_BLOB_BACKEND) out.blobs.backend = env.CLYDE_BLOB_BACKEND as ClydeConfig["blobs"]["backend"];
  if (env.CLYDE_BLOB_DIR) out.blobs.dir = expandHome(env.CLYDE_BLOB_DIR);
  if (env.CLYDE_EMBED_PROVIDER) out.embeddings.provider = env.CLYDE_EMBED_PROVIDER as ClydeConfig["embeddings"]["provider"];
  if (env.CLYDE_EMBED_URL) out.embeddings.base_url = env.CLYDE_EMBED_URL;
  if (env.CLYDE_EMBED_MODEL) out.embeddings.model = env.CLYDE_EMBED_MODEL;
  if (env.CLYDE_EMBED_DIM) out.embeddings.dimensions = Number(env.CLYDE_EMBED_DIM);
  if (env.CLYDE_EMBED_KEY) out.embeddings.api_key = env.CLYDE_EMBED_KEY;
  if (env.CLYDE_WRITE_SCREEN) out.judge.write_screen = env.CLYDE_WRITE_SCREEN as ClydeConfig["judge"]["write_screen"];
  if (env.CLYDE_RELEVANCE_FILTER) out.judge.relevance_filter = env.CLYDE_RELEVANCE_FILTER as ClydeConfig["judge"]["relevance_filter"];
  if (env.CLYDE_JUDGE_PROVIDER) out.judge.provider = env.CLYDE_JUDGE_PROVIDER as ClydeConfig["judge"]["provider"];
  if (env.CLYDE_JUDGE_URL) out.judge.base_url = env.CLYDE_JUDGE_URL;
  if (env.CLYDE_JUDGE_MODEL) out.judge.model = env.CLYDE_JUDGE_MODEL;
  if (env.CLYDE_JUDGE_KEY) out.judge.api_key = env.CLYDE_JUDGE_KEY;
  if (env.CLYDE_ARM) out.ranking.arm = env.CLYDE_ARM as ClydeConfig["ranking"]["arm"];
  if (env.CLYDE_LEARN_INTERVAL_SEC !== undefined && env.CLYDE_LEARN_INTERVAL_SEC !== "") {
    out.ranking.learn_interval_sec = Number(env.CLYDE_LEARN_INTERVAL_SEC);
  }
  if (env.CLYDE_EMBED_SYNC_INTERVAL_SEC !== undefined && env.CLYDE_EMBED_SYNC_INTERVAL_SEC !== "") {
    out.ranking.embed_sync_interval_sec = Number(env.CLYDE_EMBED_SYNC_INTERVAL_SEC);
  }
  if (env.CLYDE_EVENT_RETENTION_DAYS !== undefined && env.CLYDE_EVENT_RETENTION_DAYS !== "") {
    out.ranking.event_retention_days = Number(env.CLYDE_EVENT_RETENTION_DAYS);
  }

  out.server.data_dir = expandHome(out.server.data_dir);
  if (out.database.path && out.database.path !== ":memory:") {
    out.database.path = expandHome(out.database.path);
  }
  out.blobs.dir = expandHome(out.blobs.dir);
  return out;
}

export function validateConfig(cfg: ClydeConfig): ClydeConfig {
  if (!Number.isInteger(cfg.server.port) || cfg.server.port < 0 || cfg.server.port > 65535) {
    throw new Error(`Invalid server.port: ${cfg.server.port}`);
  }
  if (!["none", "token", "devices"].includes(cfg.auth.mode)) {
    throw new Error(`Invalid auth.mode "${cfg.auth.mode}". Expected "none", "token", or "devices".`);
  }
  if (!isLoopbackHost(cfg.server.host) && cfg.auth.mode === "none") {
    throw new Error(
      `Refusing to bind unauthenticated server to non-loopback host "${cfg.server.host}". ` +
        `Set auth.mode = "token" or auth.mode = "devices", or bind server.host = "127.0.0.1".`,
    );
  }
  if (cfg.auth.mode === "token" && !cfg.auth.token) {
    throw new Error(`auth.mode = "token" requires auth.token or CLYDE_TOKEN to be set.`);
  }
  if (!["index", "hybrid", "spreading"].includes(cfg.ranking.arm)) {
    throw new Error(`Invalid ranking.arm "${cfg.ranking.arm}". Expected "index", "hybrid", or "spreading".`);
  }
  return cfg;
}

export function resolveConfigPath(explicitPath?: string, env: Record<string, string | undefined> = process.env): string | null {
  if (explicitPath) {
    const abs = isAbsolute(expandHome(explicitPath)) ? expandHome(explicitPath) : resolve(process.cwd(), expandHome(explicitPath));
    if (!existsSync(abs)) throw new Error(`Config file not found: ${abs}`);
    return abs;
  }
  const candidates = [
    env.CLYDE_CONFIG ? expandHome(env.CLYDE_CONFIG) : "",
    resolve(process.cwd(), "clyde.toml"),
    expandHome("~/.config/clyde/config.toml"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadConfig(explicitPath?: string, env: Record<string, string | undefined> = process.env): ClydeConfig {
  const base = defaultConfig(env);
  const found = resolveConfigPath(explicitPath, env);
  if (!found) return validateConfig(mergeConfig(base, {}, env));

  const text = readFileSync(found, "utf8");
  const parsed = found.endsWith(".json") ? JSON.parse(text) : parseToml(text);
  const cfg = mergeConfig(base, parsed as Record<string, unknown>, env);
  cfg.configDir = dirname(found);
  return validateConfig(cfg);
}

export const EXAMPLE_CONFIG_TOML = `# Clyde Local Configuration (clyde.toml)
[server]
host = "127.0.0.1"
port = 8787
ui = true
owner_name = "local"
data_dir = "~/.local/share/clyde"

[auth]
# "none" (loopback only), "token" (single bearer token), or "devices" (per-device tokens)
mode = "none"
# token = "\${CLYDE_TOKEN}"

[database]
# "sqlite" (built-in WAL + FTS5), "postgres", "mysql", "libsql", or "./my-connector.ts"
connector = "sqlite"
path = "~/.local/share/clyde/clyde.db"
# url = "\${DATABASE_URL}"
# schema = "clyde"
# table_prefix = ""
fts_backend = "auto"
vector_backend = "memory"

[blobs]
backend = "fs"          # "fs" or "sql"
dir = "~/.local/share/clyde/blobs"

[embeddings]
# "none" (offline keyword/graph), "ollama", "openai", or "openai-compatible"
provider = "none"
# base_url = "http://127.0.0.1:11434/v1"
# model = "nomic-embed-text"
# dimensions = 768
# api_key = "\${OPENAI_API_KEY}"

[judge]
# "redact-only" (offline secret redaction), "llm", or "off"
write_screen = "redact-only"
relevance_filter = "off"
# provider = "ollama"
# base_url = "http://127.0.0.1:11434/v1"
# model = "qwen2.5:3b"
# api_key = "\${OPENAI_API_KEY}"

[ranking]
arm = "spreading"       # "index", "hybrid", or "spreading"
learn_interval_sec = 300
embed_sync_interval_sec = 300
event_retention_days = 180
`;
