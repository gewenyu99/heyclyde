// Unified Fetch-style HTTP router and node:http listener (runs natively in Node 22+ and Deno 2+).
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ClydeRuntime } from "../runtime/app.ts";
import { authenticateRequest } from "../runtime/auth.ts";
import { redactText } from "../core/redact.ts";
import { handleMcpHttp, MCP_VERSION } from "./mcp.ts";
import { renderWorkspaceHtml } from "./ui.ts";
import { Refused } from "../store/memory-store.ts";

const AGENT_RE = /^[a-z0-9_-]{1,40}$/;
const MAX_HOOK_BODY = 2_000_000;
const HOOK_METADATA = ["session_id", "cwd", "git_remote", "hook_event_name", "tool_name", "matcher", "source", "reason"];

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "access-control-expose-headers": "mcp-session-id, x-clyde-registered, x-clyde-version",
};

function makeNonce(): string {
  return randomBytes(16).toString("base64url");
}

function htmlHeaders(nonce: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  };
}

async function readJsonObject(req: Request, maxBytes = 2 * 1024 * 1024): Promise<Record<string, unknown> | null> {
  const txt = await req.text();
  if (txt.length > maxBytes) throw new Refused("Request body too large.");
  if (!txt.trim()) return {};
  const parsed = JSON.parse(txt) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

export function createHttpHandler(runtime: ClydeRuntime) {
  const { store, config, blobs } = runtime;

  return async function handleRequest(req: Request, explicitBaseUrl?: string): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(req.url);
    const path = url.pathname || "/";
    const baseUrl = (explicitBaseUrl ?? `${url.protocol}//${url.host}`).replace(/\/+$/, "");

    let res: Response;
    try {
      const auth = await authenticateRequest(req, path, config, runtime.connector);
      if (auth instanceof Response) {
        res = auth;
      } else {
        res = await route(req, url, path, auth, baseUrl);
      }
    } catch (err) {
      if (err instanceof Refused) {
        res = Response.json({ error: err.message }, { status: 400 });
      } else {
        const ref = crypto.randomUUID().slice(0, 8);
        console.error(`[clyde ref=${ref}]`, err);
        res = path.startsWith("/mcp")
          ? Response.json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: `Internal error (ref ${ref})` } }, { status: 500 })
          : Response.json({ error: `Internal error (ref ${ref})` }, { status: 500 });
      }
    }

    for (const [k, v] of Object.entries(CORS)) {
      if (!res.headers.has(k)) res.headers.set(k, v);
    }
    res.headers.set("x-clyde-version", MCP_VERSION);
    return res;
  };

  async function route(
    req: Request,
    url: URL,
    path: string,
    who: { role: "owner" | "device"; owner: string; principal: string; hooks: "full" | "metadata" },
    baseUrl: string,
  ): Promise<Response> {
    const m = req.method;

    if (m === "GET" && path === "/healthz") {
      return Response.json({ ok: true, ...(await store.stats()), version: MCP_VERSION });
    }
    if (path === "/mcp" || path === "/mcp/") {
      return await handleMcpHttp(req, who, store, baseUrl);
    }
    if (m === "PUT" && path.startsWith("/blobs/upload/")) {
      const token = path.slice("/blobs/upload/".length);
      const claims = blobs.verifyUploadToken(token);
      if (!claims) return Response.json({ error: "Invalid or expired upload token." }, { status: 403 });
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.byteLength !== claims.size) {
        return Response.json({ error: `Expected ${claims.size} bytes, got ${bytes.byteLength}.` }, { status: 400 });
      }
      await blobs.put(claims.sha256, claims.media_type, bytes, "incoming");
      return Response.json({ ok: true, sha256: claims.sha256, size: bytes.byteLength });
    }
    if (m === "GET" && path.startsWith("/blobs/")) {
      const sha = path.slice("/blobs/".length).toLowerCase();
      const agent = await store.resolveAgent(who.principal, who.principal);
      const b = await store.readBlob(sha, who.role === "owner" ? null : agent);
      if (!b) return Response.json({ error: "No such blob." }, { status: 404 });
      if (!b.public) return Response.json({ error: `Private blob: ask ${store.ownerLabel}.` }, { status: 403 });
      if (!b.content) return Response.json({ error: "Blob bytes missing." }, { status: 404 });
      return new Response(b.content as unknown as BodyInit, {
        headers: { "content-type": b.media_type, "x-content-type-options": "nosniff" },
      });
    }

    let match: RegExpExecArray | null;
    if (m === "POST" && (match = /^\/hooks\/([^/]+)$/.exec(path))) {
      const event = decodeURIComponent(match[1]);
      let payload = await readJsonObject(req, MAX_HOOK_BODY);
      if (!payload) payload = {};
      const agentParam = (url.searchParams.get("agent") ?? "").toLowerCase();
      const agent = AGENT_RE.test(agentParam) ? agentParam : null;
      const body = who.hooks === "metadata"
        ? Object.fromEntries(HOOK_METADATA.filter((k) => k in payload!).map((k) => [k, payload![k]]))
        : payload;
      await store.recordHookEvent(event, body, agent, who.principal, who.hooks);
      if (body.session_id && body.cwd) {
        await store.ensureSession(String(body.session_id), agent ?? "hook", String(body.session_id), String(body.cwd)).catch(() => {});
      }
      if (event === "SessionStart" && agent) {
        const reg = await store.hasRegisteredAgent(who.principal, agent);
        const board = await store.boardSummary(who.principal, agent, "start");
        return new Response(board, {
          headers: { "content-type": "text/plain; charset=utf-8", "x-clyde-registered": reg ? "1" : "0" },
        });
      }
      if (event === "UserPromptSubmit") {
        const nudge = await store.promptNudge(body, agent, who.principal, who.hooks);
        if (nudge) return new Response(nudge, { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      return new Response("");
    }

    if (m === "GET" && (match = /^\/messages\/([^/]+)$/.exec(path))) {
      const agent = decodeURIComponent(match[1]).toLowerCase();
      const msg = await store.boardSummary(who.principal, agent, "prompt");
      return new Response(msg, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (m === "POST" && path === "/entries") {
      const body = await readJsonObject(req, 12 * 1024 * 1024);
      if (!body) return Response.json({ error: "Body must be a JSON object." }, { status: 400 });
      const res = await store.remember(body, who.role === "owner" ? "runtime" : "agent", "http", who.principal, {
        agent: "http",
        context: null,
        session: null,
      });
      return Response.json(res);
    }

    if (m === "GET" && (match = /^\/entries\/([^/]+)$/.exec(path))) {
      const entry = await store.getEntry(decodeURIComponent(match[1]), null, null, who.principal);
      return entry === null
        ? Response.json({ error: "No such entry." }, { status: 404 })
        : new Response(entry, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (m === "POST" && path === "/recall") {
      const body = await readJsonObject(req);
      if (!body || typeof body.query !== "string" || !body.query.trim()) {
        return Response.json({ error: "Body must include a non-empty query string." }, { status: 400 });
      }
      const res = await store.recall({
        session: null,
        query: body.query.trim(),
        task: typeof body.task === "string" ? body.task : "",
        agent: "http",
        scope: typeof body.scope === "string" ? body.scope : null,
        principal: who.principal,
        surface: "http",
        depth: "packet",
        filter: {
          category: typeof body.category === "string" ? body.category : null,
          context: typeof body.context === "string" ? body.context : null,
          project: typeof body.project === "string" ? body.project : null,
          transferability: typeof body.transferability === "string" ? body.transferability : null,
        },
      });
      return new Response(res.text, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (m === "POST" && path === "/learn") {
      return Response.json(await store.learn());
    }
    if (m === "POST" && path === "/embeddings/sync") {
      const embedded = await store.syncEmbeddings();
      return Response.json({ embedded });
    }
    if (m === "GET" && path === "/export") {
      const ndjson = await store.exportNdjson();
      return new Response(ndjson, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
    }
    if (m === "POST" && path === "/import") {
      const ndjson = await req.text();
      return Response.json(await store.importNdjson(ndjson));
    }

    // Local Workspace REST API
    if (m === "GET" && path === "/api/stats") {
      return Response.json(await store.stats());
    }
    if (m === "GET" && path === "/api/notes") {
      return Response.json(
        await store.listEntries({
          q: url.searchParams.get("q") ?? undefined,
          pattern: url.searchParams.get("pattern") ?? undefined,
          context: url.searchParams.get("context") ?? undefined,
          limit: Number(url.searchParams.get("limit") ?? 50),
          offset: Number(url.searchParams.get("offset") ?? 0),
        }),
      );
    }
    if ((match = /^\/api\/notes\/([^/]+)$/.exec(path))) {
      const id = decodeURIComponent(match[1]);
      if (m === "GET") {
        const txt = await store.getEntry(id, null, null, who.principal);
        return txt ? Response.json({ id, text: txt }) : Response.json({ error: "Not found" }, { status: 404 });
      }
      if (m === "PATCH") {
        const body = await readJsonObject(req);
        if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        const updated = await store.updateEntryFields(id, {
          title: typeof body.title === "string" ? redactText(body.title)[0] : undefined,
          body: typeof body.body === "string" ? redactText(body.body)[0] : undefined,
          authority: typeof body.authority === "string" ? body.authority : undefined,
          context: typeof body.context === "string" ? body.context : undefined,
          transferability: typeof body.transferability === "string" ? body.transferability : undefined,
        });
        return updated ? Response.json(updated) : Response.json({ error: "Not found" }, { status: 404 });
      }
      if (m === "DELETE") {
        const ok = await store.deleteEntry(id);
        return ok ? Response.json({ ok: true }) : Response.json({ error: "Not found" }, { status: 404 });
      }
    }
    if (m === "GET" && path === "/api/graph") {
      return Response.json(await store.graphData());
    }
    if (m === "GET" && path === "/api/agents") {
      return Response.json(await store.listAgents());
    }
    if (m === "GET" && path === "/api/messages") {
      return Response.json(await store.listAllMessages());
    }
    if (m === "GET" && path === "/api/quests") {
      return Response.json(
        await store.listQuests(
          { name: config.server.owner_name, family: "owner", principal: who.principal, session: null, context: null, profile: null },
          { show: url.searchParams.get("show") ?? "all" },
        ),
      );
    }

    if (config.server.ui && m === "GET" && path === "/favicon.svg") {
      return new Response(null, { status: 204 });
    }
    if (config.server.ui && m === "GET" && (path === "/" || path === "/index.html")) {
      const n = makeNonce();
      return new Response(renderWorkspaceHtml(n, config), { status: 200, headers: htmlHeaders(n) });
    }

    return Response.json({ error: "No such endpoint." }, { status: 404 });
  }
}

async function readIncomingBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function startHttpServer(runtime: ClydeRuntime) {
  const handler = createHttpHandler(runtime);
  const { host, port } = runtime.config.server;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const addr = server.address() as AddressInfo | null;
      const boundPort = addr?.port ?? port;
      const hostHeader = req.headers.host || `${host}:${boundPort}`;
      const fullUrl = `http://${hostHeader}${req.url || "/"}`;

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) {
          for (const item of v) headers.append(k, item);
        } else if (v !== undefined) {
          headers.set(k, v);
        }
      }

      const hasBody = !["GET", "HEAD"].includes(req.method || "GET");
      const rawBody = hasBody ? await readIncomingBody(req) : undefined;
      const webReq = new Request(fullUrl, {
        method: req.method || "GET",
        headers,
        body: rawBody && rawBody.length > 0 ? (rawBody as unknown as BodyInit) : undefined,
      });

      const webRes = await handler(webReq, `http://${hostHeader}`);
      const outHeaders: Record<string, string | string[]> = {};
      webRes.headers.forEach((v, k) => {
        outHeaders[k] = v;
      });
      res.writeHead(webRes.status, outHeaders);
      const buf = Buffer.from(await webRes.arrayBuffer());
      res.end(buf);
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const actualHost = addr.address.includes(":") ? `[${addr.address}]` : addr.address;
  const url = `http://${actualHost}:${addr.port}`;
  runtime.scheduler.start();

  return {
    server,
    port: addr.port,
    url,
    async close() {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.close();
    },
  };
}
