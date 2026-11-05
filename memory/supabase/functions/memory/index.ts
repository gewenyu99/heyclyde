// memory: Wen's memory server. One Edge Function for MCP, the hooks, clyde-flow's HTTP routes, the console's API, the
// nightly export and the embed sync. auth.ts decides who a request is before anything here runs.
import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import * as admin from "./admin.ts";
import { servingArms } from "./allocation.ts";
import { allowed, authenticate, baseOf, type Principal } from "./auth.ts";
import { config } from "./config.ts";
import { sql } from "./db.ts";
import { learn } from "./learn.ts";
import * as mcp from "./mcp.ts";
import * as oauth from "./oauth.ts";
import * as service from "./service.ts";
import * as store from "./blobs.ts";
import { CLIENT_VERSION, clientStatus, installerNote, SERVER_VERSION } from "./version.ts";
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
const EXPORT = ["source", "entry", "link", "co_use", "question", "qrel", "blob", "entry_blob", "entry_provenance", "agent", "agent_binding", "mcp_session",
  "mcp_client", "retrieval",
  "event", "feedback", "message", "message_delivery", "admin_audit", "link_type_weight", "device", "embed_usage", "param_set", "allocation",
  "openai_usage"];

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

// What a "metadata" computer's hook payloads keep: enough to tie events to sessions and folders, never prompts or output.
const HOOK_METADATA = ["session_id", "cwd", "hook_event_name", "tool_name", "matcher", "source", "reason"];

async function hooks(req: Request, event: string, url: URL, who: Principal) {
  let payload;
  try {
    payload = await admin.readJson(req, MAX_HOOK_BODY);
  } catch (e) {
    return json({ error: (e as admin.ApiError).error }, (e as admin.ApiError).status ?? 400);
  }
  const agent = (url.searchParams.get("agent") ?? "").toLowerCase();
  let body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : { body: payload };
  if (who.hooks === "metadata") body = Object.fromEntries(HOOK_METADATA.filter((k) => k in body).map((k) => [k, body[k]]));
  await service.hook(event, body, AGENT.test(agent) ? agent : null);
  // Empty on purpose: memory-hook prints whatever comes back into the agent's context, so an answer is a decision to make.
  return new Response("");
}

/** clyde-flow's write, with the runtime token, up to approved. A device token writes as remember does. */
async function httpRemember(req: Request, who: Principal) {
  const payload = await jsonObject(req, MAX_ENTRY_BODY);
  if (!payload) return json({ error: "body must be a JSON object" }, 400);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"late">((resolve) => timer = setTimeout(() => resolve("late"), WRITE_DEADLINE_MS));
  try {
    const result = await Promise.race([remember(payload, who.role === "runtime" ? "runtime" : "agent", "agent", who.device ?? who.role, { agent: "http", context: null, session: null }), deadline]);
    if (result === "late") return json({ error: "write temporarily unavailable; retry the same entry" }, 503);
    return json(result);
  } catch (e) {
    if (e instanceof Refused) return json({ error: e.message }, 400);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function httpRecall(req: Request, who: Principal) {
  const body = (await jsonObject(req, 1 << 20)) ?? {};
  const { query, task = "", scope = null } = body;
  // R29 leaves clyde-flow's recall out: it has no recall_more, so a depth is refused rather than ignored.
  if (!(typeof query === "string" && query.trim()) || typeof task !== "string" || (scope !== null && typeof scope !== "string") || "depth" in body) {
    return json({ error: "body must be {query, task, scope}, with a non-empty query" }, 400);
  }
  try {
    // Each scope is its own session, so a run draws one arm and keeps it.
    return text(await service.recall(`http-${scope || "global"}`, query, task, "http", scope || null, who.device ?? who.role));
  } catch (e) {
    if (e instanceof Refused) return json({ error: e.message }, 400);
    throw e;
  }
}

// A stable order per table, so offset paging never skips or repeats a row.
const ORDER: Record<string, string> = {
  source: "id", entry: "id", link: "src, dst, type", co_use: "src, dst", question: "id", qrel: "question_id, entry_id", blob: "sha256",
  entry_blob: "entry_id, name", entry_provenance: "entry_id", agent: "name", agent_binding: "principal, client", mcp_session: "id", mcp_client: "session_id", retrieval: "created_at, id", event: "id",
  feedback: "id", message: "id", message_delivery: "id", admin_audit: "id", link_type_weight: "src_pattern, link_type, dst_pattern", device: "id",
  embed_usage: "month", param_set: "id", allocation: "param_set", openai_usage: "month, kind",
};
// A blob page is cut by bytes as well as rows (exportBlobs), so its row count is only the most it takes.
const PAGE = (table: string) => table === "blob" ? 500 : 2000;
const BLOB_PAGE_BYTES = 16 * 1024 * 1024;

/** One page of the blob table. A page holds at most 500 rows and about 16 MiB of blob bytes, so the row count it returns
 * (x-rows) can be less than a full page, and x-truncated says it was cut for size. Postgres blobs go out as base64. A Storage blob
 * goes out too if it is 4 MiB or less and the export is still within MEMORY_EXPORT_STORED_TOTAL bytes of them, counted in sha256
 * order so each page can tell without remembering the last. Any other Storage blob goes out with content null, and so does one
 * whose object is missing, and x-missing-blobs counts them. */
async function exportBlobs(offset: number) {
  const head = await sql`select sha256, media_type, size, stored, created_at,
      case when stored = 'storage' and size <= ${store.EXPORT_BLOB_MAX}
        then sum(size) filter (where stored = 'storage' and size <= ${store.EXPORT_BLOB_MAX}) over (order by sha256) end as running
    from memory.blob order by sha256 limit ${PAGE("blob")} offset ${offset}`;
  const page: Record<string, any>[] = [];
  let bytes = 0, truncated = false;
  for (const r of head) {
    const carried = r.stored === "db" || (r.running !== null && r.running <= store.EXPORT_STORED_TOTAL);
    const cost = carried ? r.size : 0;
    if (page.length && bytes + cost > BLOB_PAGE_BYTES) {
      truncated = true;
      break;
    }
    bytes += cost;
    page.push(r);
  }
  const inDb = new Map((await sql`select sha256, content from memory.blob where stored = 'db' and sha256 = any(${page.map((r) => r.sha256)}::text[])`)
    .map((r) => [r.sha256 as string, r.content as Uint8Array]));
  let missing = 0;
  const lines: string[] = [];
  for (const r of page) {
    const { running, ...row } = r;
    let content: Uint8Array | null = null;
    if (r.stored === "db") content = inDb.get(r.sha256) ?? null;
    else {
      if (running !== null && running <= store.EXPORT_STORED_TOTAL && store.storageOn()) content = await store.get(r.sha256);
      if (!content) missing++;
    }
    lines.push(JSON.stringify({ table: "blob", row: { ...row, content: content ? { base64: encodeBase64(new Uint8Array(content)) } : null } }) + "\n");
  }
  const headers: Record<string, string> = { "content-type": "application/x-ndjson", "x-rows": String(page.length), "x-missing-blobs": String(missing) };
  if (truncated) headers["x-truncated"] = "1";
  return new Response(lines.join(""), { headers });
}

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
  if (table === "blob") return exportBlobs(offset);
  const rows = await sql`select * from ${sql("memory." + table)} order by ${sql.unsafe(ORDER[table])}
    limit ${PAGE(table)} offset ${offset}`;
  const body = rows.map((row) => {
    if (row.content instanceof Uint8Array) row.content = { base64: encodeBase64(row.content) };
    return JSON.stringify({ table, row }) + "\n";
  }).join("");
  return new Response(body, { headers: { "content-type": "application/x-ndjson", "x-rows": String(rows.length) } });
}

// The files a new computer's installer fetches, and the release's manifest with its signature (manifest.sig). memory/deploy.sh
// bakes ./client into ./client/files.ts: it stamps memory-hook with CLIENT_VERSION, writes a manifest of the version and
// every file's sha256, and signs that manifest with the offline key. A computer verifies the manifest against the public key
// it saved at install, then each file against its line, so only files of one signed release install.
const CLIENT_FILES = ["install.sh", "memory-hook", "claude-settings.json", "codex-hooks.json", "signing-pub.pem"];
const SERVED = new Set([...CLIENT_FILES, "manifest", "manifest.sig"]);
const CLAIM = /^[A-Za-z0-9_-]{20,100}$/;

function clientFile(name: string) {
  return FILES[name];
}

/** The installer, its files, and the sign-in hand-off. All open: nothing here reveals data or mints a token without the
 * PKCE verifier and the owner's sign-in. */
async function install(req: Request, path: string, url: URL) {
  if (path === "/install") return text(clientFile("install.sh"));
  if (path === "/install/check" && req.method === "POST") {
    const email = String((await admin.readJson(req, 4096))?.email ?? "");
    return (await allowed(email))
      ? json({ allowed: true })
      : json({ error: `${email || "That email"} isn't on memory's allowlist.` }, 403);
  }
  if (path === "/install/config") {
    return json({ auth: `${Deno.env.get("SUPABASE_URL")}/auth/v1`, key: Deno.env.get("SUPABASE_ANON_KEY") });
  }
  let m;
  if ((m = /^\/install\/files\/([^/]+)$/.exec(path)) && SERVED.has(m[1]) && clientFile(m[1])) return text(clientFile(m[1]));
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
    return json({ ok: true, arms: await servingArms(sql).catch(() => config.arms), version: SERVER_VERSION, client_version: CLIENT_VERSION });
  }
  if (path === "/mcp" || path === "/mcp/") return mcp.handle(req, who);
  if (path.startsWith("/.well-known/oauth-protected-resource")) return oauth.resourceMetadata(await baseOf(req));
  if (path.startsWith("/oauth/")) return oauth.handle(await baseOf(req), path, url);
  if (path === "/install" || path.startsWith("/install/")) return install(req, path, url);
  if (m === "POST" && path === "/devices/claim") return admin.claimDevice(await admin.readJson(req));
  if (path.startsWith("/api/v1") || path === "/") {
    return path === "/" ? json({ ok: true }) : admin.handle(req, path, who.role === "research" ? "research" : "admin");
  }

  let match;
  if (m === "POST" && (match = /^\/hooks\/([^/]+)$/.exec(path))) return hooks(req, decodeURIComponent(match[1]), url, who);
  if (m === "GET" && (match = /^\/messages\/([^/]+)$/.exec(path))) {
    const messages = await service.readMessages(decodeURIComponent(match[1]).toLowerCase());
    // A hook that sends no version predates self-update and can't fix itself or print its own line, so it hears it here.
    // One that does send a version prints its own, when its update has failed.
    const note = who.role === "device" && !who.device?.startsWith("oauth:")
      ? installerNote(clientStatus(req.headers.get("x-memory-client-version"), config.clientCutoffDays), false)
      : "";
    return text(note ? `${messages}${note}\n` : messages);
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
    if (blob.stored === "storage") {
      // A link that works for 10 minutes. A restored blob whose file wasn't in the backup is a 404.
      if (!store.storageOn()) return json({ error: service.notInBackup(match[1]) }, 404);
      try {
        return new Response(null, { status: 302, headers: { location: await store.signDownload(match[1].toLowerCase()) } });
      } catch (e) {
        if (e instanceof store.NotStored) return json({ error: service.notInBackup(match[1]) }, 404);
        throw e;
      }
    }
    return new Response(blob.content, { headers: { "content-type": blob.media_type, "x-content-type-options": "nosniff" } });
  }
  if (m === "POST" && path === "/blobs/sweep") {
    // Uploads nobody cited in two hours: the file in incoming/, and the row that says it is expected.
    const files = store.storageOn() ? await store.sweepIncoming() : 0;
    const rows = await sql`delete from memory.upload where created_at < now() - make_interval(secs => ${store.UPLOAD_TTL_SECONDS}) returning 1`;
    return json({ swept: files, uploads: rows.length });
  }
  if (m === "POST" && path === "/recall") return httpRecall(req, who);
  if (m === "GET" && path === "/export") return exportPage(url);
  if (m === "POST" && path === "/learn") return json(await learn());
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
  "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version, x-memory-client-version, x-memory-update-failed",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-expose-headers": "mcp-session-id, retry-after, x-rows, www-authenticate, x-memory-version, x-memory-client-latest, x-memory-client-status",
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
  // Every answer carries the server's version and the newest client version, the one a hook updates itself to. A client
  // that sent its own also hears where it stands (R31).
  res.headers.set("x-memory-version", SERVER_VERSION);
  res.headers.set("x-memory-client-latest", CLIENT_VERSION);
  const sent = req.headers.get("x-memory-client-version");
  if (sent) res.headers.set("x-memory-client-status", clientStatus(sent, config.clientCutoffDays));
  return res;
});
