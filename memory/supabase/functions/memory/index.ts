// memory: Wen's memory server. One Edge Function for MCP, the hooks, clyde-flow's HTTP routes, the console's API, the
// nightly export and the embed sync. auth.ts decides who a request is before anything here runs.
import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import * as admin from "./admin.ts";
import { authenticate, type Principal } from "./auth.ts";
import { config } from "./config.ts";
import { sql } from "./db.ts";
import * as mcp from "./mcp.ts";
import * as service from "./service.ts";
import { Refused, remember } from "./write.ts";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { FILES } from "./client/files.ts";

// The Supabase runtime's global for work that outlives the response.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const AGENT = /^[a-z0-9_-]{1,40}$/;
const MAX_HOOK_BODY = 2_000_000;
// 8 MiB of blobs, base64-encoded, plus the rest of the entry.
const MAX_ENTRY_BODY = 12 * 1024 * 1024;
const WRITE_DEADLINE_MS = 1500;
// Tables the export carries, parents first, so a restore can load them in order. Embeddings are rebuilt, not kept.
const EXPORT = ["source", "entry", "link", "question", "qrel", "blob", "entry_blob", "mcp_session", "mcp_client", "retrieval",
  "event", "feedback", "message", "admin_audit", "link_type_weight", "device", "embed_usage"];

const json = (body: unknown, status = 200) => Response.json(body, { status });
const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** The path after the function's name, so routes read the same as on the old server. */
function routeOf(url: URL) {
  const p = url.pathname.replace(/^\/functions\/v1/, "").replace(/^\/memory/, "");
  return p || "/";
}

async function jsonObject(req: Request, cap: number) {
  try {
    const body = await admin.readJson(req, cap);
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch (e) {
    if (e instanceof admin.ApiError && e.status === 413) throw e;
    return null;
  }
}

async function hooks(req: Request, event: string, url: URL) {
  let payload;
  try {
    payload = await admin.readJson(req, MAX_HOOK_BODY);
  } catch (e) {
    return json({ error: (e as admin.ApiError).error }, (e as admin.ApiError).status ?? 400);
  }
  const agent = (url.searchParams.get("agent") ?? "").toLowerCase();
  await service.hook(event, payload && typeof payload === "object" && !Array.isArray(payload) ? payload : { body: payload },
    AGENT.test(agent) ? agent : null);
  return json({ ok: true });
}

/** clyde-flow's write, with the runtime token, up to approved. A device token writes as remember does. */
async function httpRemember(req: Request, who: Principal) {
  const payload = await jsonObject(req, MAX_ENTRY_BODY);
  if (!payload) return json({ error: "body must be a JSON object" }, 400);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"late">((resolve) => timer = setTimeout(() => resolve("late"), WRITE_DEADLINE_MS));
  try {
    const result = await Promise.race([remember(payload, who.role === "runtime" ? "runtime" : "agent"), deadline]);
    if (result === "late") return json({ error: "write temporarily unavailable; retry the same entry" }, 503);
    return json(result);
  } catch (e) {
    if (e instanceof Refused) return json({ error: e.message }, 400);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function httpRecall(req: Request) {
  const body = (await jsonObject(req, 1 << 20)) ?? {};
  const { query, task = "", scope = null } = body;
  if (!(typeof query === "string" && query.trim()) || typeof task !== "string" || (scope !== null && typeof scope !== "string")) {
    return json({ error: "body must be {query, task, scope}, with a non-empty query" }, 400);
  }
  try {
    // Each scope is its own session, so a run draws one arm and keeps it.
    return text(await service.recall(`http-${scope || "global"}`, query, task, "http", scope || null));
  } catch (e) {
    if (e instanceof Refused) return json({ error: e.message }, 400);
    throw e;
  }
}

// A stable order per table, so offset paging never skips or repeats a row.
const ORDER: Record<string, string> = {
  source: "id", entry: "id", link: "src, dst, type", question: "id", qrel: "question_id, entry_id", blob: "sha256",
  entry_blob: "entry_id, name", mcp_session: "id", mcp_client: "session_id", retrieval: "created_at, id", event: "id",
  feedback: "id", message: "id", admin_audit: "id", link_type_weight: "src_pattern, link_type, dst_pattern", device: "id",
  embed_usage: "month",
};
// Blobs run to 4 MiB each, so their pages stay small.
const PAGE = (table: string) => table === "blob" ? 20 : 2000;

/** With no table, the tables to export in load order, with each one's page size and row count. With ?table=&offset=, one page of that
 * table as NDJSON, one {table, row} per line, and its row count in x-rows. Pages keep each request inside the
 * function's limits, so the export can't be cut off mid-stream. bytea goes out as base64. */
async function exportPage(url: URL) {
  const table = url.searchParams.get("table");
  if (!table) {
    const tables = [];
    for (const t of EXPORT) tables.push({ table: t, page: PAGE(t), rows: (await sql`select count(*) as n from ${sql("memory." + t)}`)[0].n });
    return json({ tables });
  }
  if (!EXPORT.includes(table)) return json({ error: `Can't export ${table}.` }, 400);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  if (!Number.isInteger(offset) || offset < 0) return json({ error: "offset must be a whole number." }, 400);
  const rows = await sql`select * from ${sql("memory." + table)} order by ${sql.unsafe(ORDER[table])}
    limit ${PAGE(table)} offset ${offset}`;
  const body = rows.map((row) => {
    if (row.content instanceof Uint8Array) row.content = { base64: encodeBase64(row.content) };
    return JSON.stringify({ table, row }) + "\n";
  }).join("");
  return new Response(body, { headers: { "content-type": "application/x-ndjson", "x-rows": String(rows.length) } });
}

// The files a new computer's installer fetches. memory/deploy.sh bakes ./client into ./client/files.ts.
const CLIENT_FILES = ["install.sh", "memory-hook", "claude-settings.json", "codex-hooks.json"];
const CLAIM = /^[A-Za-z0-9_-]{20,100}$/;

function clientFile(name: string) {
  return FILES[name];
}

/** The installer, its files, and the sign-in hand-off. All open: nothing here reveals data or mints a token without the
 * PKCE verifier and the owner's sign-in. */
async function install(req: Request, path: string, url: URL) {
  if (path === "/install") return text(clientFile("install.sh"));
  if (path === "/install/config") {
    return json({ auth: `${Deno.env.get("SUPABASE_URL")}/auth/v1`, key: Deno.env.get("SUPABASE_ANON_KEY") });
  }
  let m;
  if ((m = /^\/install\/files\/([^/]+)$/.exec(path)) && CLIENT_FILES.includes(m[1])) return text(clientFile(m[1]));
  if (path === "/install/approve") {
    const claim = url.searchParams.get("claim") ?? "", code = url.searchParams.get("code") ?? "";
    if (!CLAIM.test(claim) || !code) {
      return text(`memory: that sign-in link didn't work. ${url.searchParams.get("error_description") ?? ""}`.trim(), 400);
    }
    await sql`insert into memory.install_claim (id, auth_code) values (${claim}, ${code})
      on conflict (id) do update set auth_code = excluded.auth_code, created_at = now()`;
    return text("memory: signed in. Go back to your terminal, it finishes on its own.\n");
  }
  if ((m = /^\/install\/claim\/([^/]+)$/.exec(path)) && CLAIM.test(m[1])) {
    // Once only, and only within 15 minutes of the click.
    const [row] = await sql`delete from memory.install_claim where id = ${m[1]} returning auth_code, created_at > now() - interval '15 minutes' as fresh`;
    if (!row) return new Response(null, { status: 204 });
    return row.fresh ? json({ auth_code: row.auth_code }) : json({ error: "That sign-in expired. Run the installer again." }, 410);
  }
  return json({ error: "No such endpoint." }, 404);
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url), path = routeOf(url), m = req.method;
  const who = await authenticate(req, path);
  if (who instanceof Response) return who;

  if (path === "/healthz") {
    await sql`select 1`;
    return json({ ok: true, arms: config.arms });
  }
  if (path === "/mcp" || path === "/mcp/") return mcp.handle(req);
  if (path === "/install" || path.startsWith("/install/")) return install(req, path, url);
  if (m === "POST" && path === "/devices/claim") return admin.claimDevice(await admin.readJson(req));
  if (path.startsWith("/api/v1") || path === "/") return path === "/" ? json({ ok: true }) : admin.handle(req, path);

  let match;
  if (m === "POST" && (match = /^\/hooks\/([^/]+)$/.exec(path))) return hooks(req, decodeURIComponent(match[1]), url);
  if (m === "GET" && (match = /^\/messages\/([^/]+)$/.exec(path))) {
    return text(await service.readMessages(decodeURIComponent(match[1]).toLowerCase()));
  }
  if (m === "POST" && path === "/entries") return httpRemember(req, who);
  if (m === "GET" && (match = /^\/entries\/([^/]+)$/.exec(path))) {
    const entry = await service.getEntry("http", decodeURIComponent(match[1]));
    return entry === null ? json({ error: "no such entry" }, 404) : text(entry);
  }
  if (m === "GET" && (match = /^\/blobs\/([^/]+)$/.exec(path))) {
    const blob = await service.readBlob(match[1]);
    if (!blob) return json({ error: "no such blob" }, 404);
    if (!blob.public) return json({ error: service.PRIVATE_BLOB }, 403);
    return new Response(blob.content, { headers: { "content-type": blob.media_type, "x-content-type-options": "nosniff" } });
  }
  if (m === "POST" && path === "/recall") return httpRecall(req);
  if (m === "GET" && path === "/export") return exportPage(url);
  if (m === "POST" && path === "/embeddings/sync") {
    EdgeRuntime.waitUntil(admin.runEmbeddingSync("periodic"));
    return json({ started: true }, 202);
  }
  return json({ error: "No such endpoint." }, 404);
}

// Any origin may call, since every route but /healthz takes a bearer token and nothing rides on cookies. The console
// runs on another origin.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-expose-headers": "mcp-session-id, retry-after, x-rows",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  let res: Response;
  try {
    res = await route(req);
  } catch (e) {
    if (e instanceof admin.ApiError) res = json({ error: e.error }, e.status);
    else {
      console.error(e);
      res = json({ error: "The server hit an error. Its log has the details." }, 500);
    }
  }
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  return res;
});
