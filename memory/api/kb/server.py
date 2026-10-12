"""kb: the memory server. One MCP endpoint for recall, one hook endpoint, HTTP routes for clyde-flow, the console's API,
bearer auth on all of them. The agents' token opens MCP, the hooks and the HTTP routes. clyde-flow's runtime token opens the
same, and alone writes above draft. The console's API takes its own admin token.

  uvicorn kb.server:app --host 0.0.0.0 --port 8000
"""
import asyncio
import hashlib
import hmac
import ipaddress
import logging
import math
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.transport_security import RequestBodyLimitMiddleware, TransportSecuritySettings
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse, RedirectResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import api, service, write
from .admin_service import EmbeddingSync
from .config import config
from .search import ARMS

log = logging.getLogger("kb")
# 8 MiB of blobs, base64-encoded, plus the rest of the entry. A bigger body gets a 413 before anything parses it.
MAX_REQUEST_BYTES = 12 * 1024 * 1024
CONSOLE = Path(__file__).parent / "console"
pool = AsyncConnectionPool(config.database_url, open=False, kwargs={"row_factory": dict_row})

# Caddy terminates TLS and the bearer token guards every request, so DNS-rebinding host checks would only block kb.<domain>.
mcp = FastMCP(
    "kb",
    instructions=("Wen's memory. Call recall before acting on anything that depends on Wen's decisions, preferences or history. "
                  "Wen's other agents leave you messages. Call check_messages when you start a task, and post_message to reach them."),
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


def _session(ctx: Context):
    request = ctx.request_context.request
    sid = request.headers.get("mcp-session-id") if request is not None else None
    return sid or f"anon-{id(ctx.session)}"


def _client(ctx: Context):
    params = getattr(ctx.session, "client_params", None)
    info = getattr(params, "clientInfo", None)
    return getattr(info, "name", None)


@mcp.tool()
async def recall(query: str, ctx: Context, task: str = "", scope: str = "") -> str:
    """Search Wen's memory: his decisions, preferences, observations and past reactions.

    query: what you need to know, in English or 中文.
    task: optional one-line description of what you are doing, to sharpen the search.
    scope: optional run scope like run:abc. That run's notes join the search and rank first.
    Results start with a retrieval id. Pass it to feedback() if the results helped or misled you."""
    async with pool.connection() as conn:
        return await service.recall(conn, _session(ctx), query, task, _client(ctx), scope or None)


@mcp.tool()
async def get_entry(id: str, ctx: Context) -> str:
    """Open one memory entry by id, with its evidence, source, links and blobs."""
    async with pool.connection() as conn:
        return await service.get_entry(conn, _session(ctx), id) or f"No entry {id}."


@mcp.tool()
async def get_blob(sha256: str, offset: int = 0, limit: int = 20000) -> str:
    """Read a blob that get_entry lists, as text, one page at a time. The reply says how to get the next page."""
    async with pool.connection() as conn:
        return await service.get_blob(conn, sha256, offset, limit)


@mcp.tool()
async def remember(pattern: str, title: str, body: str, scope: str, evidence: str, project: str = "",
                   evidence_kind: str = "summary", authority: str = "draft", sensitivity: str = "normal",
                   lang: str = "en", valid_from: str = "", links: list[dict] | None = None,
                   supersedes: list[str] | None = None, blobs: list[dict] | None = None) -> str:
    """Write one note to Wen's memory. It's a draft in a run scope until Wen or clyde-flow promotes it.

    pattern: projects, decisions, observations, preferences, recommendations, references or reactions.
    title, body: a one-line title, and the summary recall ranks on.
    scope: run:<id>, the run this note hands off within.
    evidence: what backs it. evidence_kind: summary, assistant or memory.
    project: id of the run's projects entry. Required unless pattern is projects.
    links: [{"type": "supports|contradicts|derived_from|relates|corrects", "to": "<id>"}].
    supersedes: ids of drafts in the same run that this note replaces. Hybrid recall stops serving them, and the index
    arm lists them struck through.
    blobs: [{"name": "gate-evidence", "media_type": "text/markdown", "text": "..."}] for long evidence.
    Returns the entry's id and each blob's sha256."""
    payload = {"pattern": pattern, "title": title, "body": body, "scope": scope, "evidence": evidence,
               "evidence_kind": evidence_kind, "authority": authority, "sensitivity": sensitivity, "lang": lang,
               "project": project or None, "valid_from": valid_from or None,
               "links": links or [], "supersedes": supersedes or [], "blobs": blobs or []}
    r = await write.remember(pool, payload, "agent")
    lines = [f"Remembered {r['id']}."] + [f"Blob {b['name']}: {b['sha256']}" for b in r["blobs"]]
    if not r["embedded"]:
        lines.append("Keyword search finds it now. Vector search finds it after the next embedding sync.")
    return "\n".join(lines)


@mcp.tool()
async def feedback(retrieval_id: str, verdict: str, entry_id: str = "", note: str = "") -> str:
    """Report how a recall went. verdict: helpful, irrelevant or wrong. entry_id narrows it to one item."""
    async with pool.connection() as conn:
        return await service.feedback(conn, retrieval_id, verdict, entry_id or None, note or None)


@mcp.tool()
async def post_message(to: str, body: str, ctx: Context) -> str:
    """Leave a message for Wen's other agents. to: claude, codex, or all. They see it at their next check or prompt."""
    async with pool.connection() as conn:
        return await service.post_message(conn, service.agent_name(_client(ctx)), to, body)


@mcp.tool()
async def check_messages(ctx: Context) -> str:
    """Read your unread messages from Wen's other agents. Reading marks them read."""
    async with pool.connection() as conn:
        return await service.read_messages(conn, service.agent_name(_client(ctx))) or "No new messages."


@mcp.custom_route("/messages/{me}", methods=["GET"])
async def inbox(request: Request):
    """Plain-text unread messages for one agent, marked read. kb-hook prints this into Claude Code's context."""
    async with pool.connection() as conn:
        return PlainTextResponse(await service.read_messages(conn, request.path_params["me"].lower()))


AGENT = re.compile(r"[a-z0-9_-]{1,40}")
MAX_HOOK_BODY = 2_000_000  # Caddy's own cap. A prompt bigger than this would not fit an agent's context anyway.


@mcp.custom_route("/hooks/{event}", methods=["POST"])
async def hooks(request: Request):
    """?agent= names the client that sent it, claude or codex, so the console can tell their hooks apart."""
    try:
        payload = await api.read_json(request, MAX_HOOK_BODY)
    except api.ApiError as e:
        return JSONResponse({"error": e.error}, status_code=e.status)
    agent = request.query_params.get("agent", "").lower()
    async with pool.connection() as conn:
        await service.hook(conn, request.path_params["event"], payload if isinstance(payload, dict) else {"body": payload},
                           agent if AGENT.fullmatch(agent) else None)
    return JSONResponse({"ok": True})


async def _json_object(request):
    """The body as a dict, or None when it isn't a JSON object."""
    try:
        body = await request.json()
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


@mcp.custom_route("/entries", methods=["POST"])
async def http_remember(request: Request):
    """clyde-flow's write, with the runtime token, up to approved. The agent token writes as remember does."""
    payload = await _json_object(request)
    if payload is None:
        return JSONResponse({"error": "body must be a JSON object"}, status_code=400)
    try:
        return JSONResponse(await write.remember(pool, payload, request.scope.get("kb_role", "agent")))
    except write.Refused as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)


@mcp.custom_route("/entries/{id}", methods=["GET"])
async def http_get_entry(request: Request):
    async with pool.connection() as conn:
        text = await service.get_entry(conn, "http", request.path_params["id"])
    if text is None:
        return JSONResponse({"error": "no such entry"}, status_code=404)
    return PlainTextResponse(text)


@mcp.custom_route("/blobs/{sha}", methods=["GET"])
async def http_get_blob(request: Request):
    """The raw bytes with their media type. Private blobs get the same redaction get_blob gives an agent."""
    async with pool.connection() as conn:
        row = await service.read_blob(conn, request.path_params["sha"])
    if row is None:
        return JSONResponse({"error": "no such blob"}, status_code=404)
    if not row["public"]:
        return JSONResponse({"error": service.PRIVATE_BLOB}, status_code=403)
    return Response(bytes(row["content"]), media_type=row["media_type"], headers={"X-Content-Type-Options": "nosniff"})


@mcp.custom_route("/recall", methods=["POST"])
async def http_recall(request: Request):
    """The packet text. Each scope is its own kb session, so a run draws one arm and keeps it."""
    body = await _json_object(request) or {}
    query, task, scope = body.get("query"), body.get("task") or "", body.get("scope") or None
    if not (isinstance(query, str) and query.strip()) or not all(isinstance(v, str) for v in (task, scope or "")):
        return JSONResponse({"error": "body must be {query, task, scope}, with a non-empty query"}, status_code=400)
    async with pool.connection() as conn:
        try:
            return PlainTextResponse(await service.recall(conn, f"http-{scope or 'global'}", query, task, "http", scope))
        except write.Refused as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)


@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(request: Request):
    async with pool.connection() as conn:
        await conn.execute("select 1")
    return JSONResponse({"ok": True, "arms": config.arms})


async def _sync_every(sync):
    """An embedding sync at startup, then every KB_EMBED_SYNC_SECONDS, so a write whose embedding failed gets one later."""
    trigger = "startup"
    while True:
        sync.start(trigger)
        trigger = "periodic"
        await asyncio.sleep(config.embed_sync_seconds)


async def home(request: Request):
    return RedirectResponse("/console/")


class Console(StaticFiles):
    """The console's files with no-cache. The browser revalidates each one, so after a deploy it never runs a new
    app.js against an old lib.js it kept."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["cache-control"] = "no-cache"
        return response


def build_app():
    unknown = set(config.arms) - set(ARMS)
    if unknown:
        raise SystemExit(f"KB_ARMS names unknown arms {sorted(unknown)}. Known: {sorted(ARMS)}")
    agent, runtime = Credential(config.token, config.token_sha256), Credential(config.runtime_token, config.runtime_token_sha256)
    if runtime and agent and runtime.digest == agent.digest:
        raise SystemExit("KB_RUNTIME_TOKEN must differ from KB_TOKEN, or every agent could write as clyde-flow")
    inner = mcp.streamable_http_app()
    # One guard for the startup sync and the console's, so the two never run at once.
    sync = inner.state.sync = EmbeddingSync(pool)
    # check_dir off: a missing console fails its own requests, never the server's start.
    inner.router.routes.extend([Mount("/api/v1", app=api.build(pool, sync)),
                                Mount("/console", app=Console(directory=CONSOLE, html=True, check_dir=False)),
                                Route("/", home, methods=["GET"])])
    mcp_lifespan = inner.router.lifespan_context

    @asynccontextmanager
    async def lifespan(app):
        await pool.open(wait=True)
        every = asyncio.create_task(_sync_every(sync))
        async with mcp_lifespan(app):
            yield
        every.cancel()
        sync.stop()
        await pool.close()

    inner.router.lifespan_context = lifespan
    auth = BearerAuth(inner, Credential(config.token, config.token_sha256), Credential(config.admin_token, config.admin_token_sha256),
                      runtime=runtime, max_body=MAX_REQUEST_BYTES)
    if auth.off:
        log.error("%s MCP and the hooks still serve.", auth.off)
    return auth


class Credential:
    """One bearer token. With a SHA-256 hex set, a token must hash to it, so the server never holds the token itself.
    Otherwise it must equal the token. Neither set matches nothing."""

    def __init__(self, token="", sha256=""):
        self.token, self.sha = token.encode(), sha256.strip().lower().encode()

    def __bool__(self):
        return bool(self.sha or self.token)

    @property
    def digest(self):
        """The SHA-256 hex this credential checks against, so two credentials compare without either token."""
        return self.sha or hashlib.sha256(self.token).hexdigest().encode()

    def matches(self, got):
        if not got:
            return False
        if self.sha:
            return hmac.compare_digest(hashlib.sha256(got).hexdigest().encode(), self.sha)
        return bool(self.token) and hmac.compare_digest(got, self.token)


MIN_ADMIN_TOKEN = 32


def console_off(agent, admin):
    """Why the admin token can't guard the console, or None. A short token falls to guessing, and the agents' token is
    in every agent's reach."""
    if not admin:
        return "The console is off. Set KB_ADMIN_TOKEN_SHA256 or KB_ADMIN_TOKEN on the server."
    if admin.sha and not re.fullmatch(rb"[0-9a-f]{64}", admin.sha):
        return "The console is off. KB_ADMIN_TOKEN_SHA256 is not a SHA-256 hex digest."
    if not admin.sha and len(admin.token) < MIN_ADMIN_TOKEN:
        return f"The console is off. KB_ADMIN_TOKEN is shorter than {MIN_ADMIN_TOKEN} characters."
    if agent and admin.digest == agent.digest:
        return "The console is off. Its admin token is the agents' token."
    return None


def credential_for(path):
    """Which credential a path takes. /healthz and the console's files take none. The console's API and / take the
    admin token. MCP, the hooks, the inbox and clyde-flow's HTTP routes take the agents' token, or the runtime token. Any
    other path takes neither and gets 401."""
    if path in ("/healthz", "/console") or path.startswith("/console/"):
        return "open"
    if path in ("/", "/api/v1") or path.startswith("/api/v1/"):
        return "admin"
    if path in ("/mcp", "/mcp/", "/entries", "/recall") or path.startswith(("/hooks/", "/messages/", "/entries/", "/blobs/")):
        return "agent"
    return None


def client_key(scope):
    """The client's address, which uvicorn takes from Caddy's X-Forwarded-For. IPv6 counts by /64, the block one host
    usually holds, so rotating through it buys no extra guesses."""
    host = (scope.get("client") or ("",))[0] or ""
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return host
    return str(ipaddress.ip_network(f"{ip}/64", strict=False)) if ip.version == 6 else host


class Throttle:
    """Wrong tokens per client address and credential. The first `free` misses cost nothing. Each miss after that locks
    the address out twice as long as the last, up to `cap` seconds. A locked address gets 429 and its token is never
    checked, so it can't keep guessing. Misses are forgotten after `forget` seconds without one."""

    def __init__(self, free=10, cap=900, forget=3600, size=10000, clock=time.monotonic):
        self.free, self.cap, self.forget, self.size, self.clock = free, cap, forget, size, clock
        self.seen = {}  # key -> (misses, last miss, locked until)

    def wait(self, key):
        """Whole seconds key stays locked, or 0."""
        left = self.seen[key][2] - self.clock() if key in self.seen else 0
        return math.ceil(left) if left > 0 else 0

    def miss(self, key):
        now = self.clock()
        n, last, _ = self.seen.get(key, (0, now, 0))
        n = 1 if now - last > self.forget else n + 1
        until = now + min(self.cap, 2 ** (n - self.free - 1)) if n > self.free else 0
        self.seen[key] = (n, now, until)
        if until:
            log.warning("%s wrong %s tokens from %s, locked out for %ds", n, key[0], key[1], math.ceil(until - now))
        if len(self.seen) > self.size:
            # The least recent half goes. Each address it drops gets its free misses back, no more.
            self.seen = dict(sorted(self.seen.items(), key=lambda kv: kv[1][1])[-(self.size // 2):])


def _plural(n, word):
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


class BearerAuth:
    """Every path but the open ones needs `Authorization: Bearer <token>`, and the token its path takes (see
    credential_for). While the admin token can't guard the console, its API answers 503 with the reason. Wrong tokens
    count against the client's address (see Throttle)."""

    def __init__(self, app, agent, admin=None, throttle=None, runtime=None, max_body=None):
        self.app, self.creds = app, {"agent": agent, "admin": admin or Credential()}
        # mcp caps /mcp bodies at 4 MiB, but not the custom routes, so max_body caps them all. self.app stays the inner app.
        self.limited = RequestBodyLimitMiddleware(app, max_body) if max_body else app
        self.runtime = runtime or Credential()
        # The admin token must differ from the runtime token too, since clyde-flow's daemon holds that one.
        self.off = console_off(agent, self.creds["admin"]) or (console_off(self.runtime, self.creds["admin"]) if self.runtime else None)
        self.throttle = throttle or Throttle()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        kind = credential_for(scope["path"])
        if kind == "open":
            await self.limited(scope, receive, send)
            return
        if kind == "admin" and self.off:
            await JSONResponse({"error": self.off}, status_code=503)(scope, receive, send)
            return
        key = (kind, client_key(scope))
        wait = self.throttle.wait(key)
        if wait:
            await JSONResponse({"error": f"Too many wrong tokens from your address. Try again in {_plural(wait, 'second')}."},
                               status_code=429, headers={"retry-after": str(wait)})(scope, receive, send)
            return
        header = dict(scope["headers"]).get(b"authorization", b"")
        got = header[7:] if header.startswith(b"Bearer ") else b""
        cred = self.creds.get(kind)
        # The runtime token opens every agent path, and rides in the scope as kb_role so writes above draft stay its own.
        role = "runtime" if kind == "agent" and self.runtime.matches(got) else kind if cred is not None and cred.matches(got) else None
        if role is None:
            if got and cred is not None:
                self.throttle.miss(key)
            await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)
            return
        scope = dict(scope, kb_role=role)
        await self.limited(scope, receive, send)


app = build_app()
