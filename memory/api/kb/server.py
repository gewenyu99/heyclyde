"""kb: the memory server. One MCP endpoint, a hook endpoint, and HTTP routes for lv-flow, bearer auth on all of them.

  uvicorn kb.server:app --host 0.0.0.0 --port 8000
"""
import asyncio
import hmac
import logging
from contextlib import asynccontextmanager

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.transport_security import RequestBodyLimitMiddleware, TransportSecuritySettings
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse, Response

from . import service, write
from .config import config
from .embed import pull_model, sync_embeddings
from .search import ARMS

log = logging.getLogger("kb")
# 8 MiB of blobs, base64-encoded, plus the rest of the entry. A bigger body gets a 413 before anything parses it.
MAX_REQUEST_BYTES = 12 * 1024 * 1024
pool = AsyncConnectionPool(config.database_url, open=False, kwargs={"row_factory": dict_row})

# Caddy terminates TLS and the bearer token guards every request, so DNS-rebinding host checks would only block kb.<domain>.
mcp = FastMCP(
    "kb",
    instructions="Wen's memory. Call recall before acting on anything that depends on Wen's decisions, preferences or history.",
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
    """Write one note to Wen's memory. It's a draft in a run scope until Wen or lv-flow promotes it.

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


@mcp.custom_route("/hooks/{event}", methods=["POST"])
async def hooks(request: Request):
    try:
        payload = await request.json()
    except ValueError:
        return JSONResponse({"error": "body must be JSON"}, status_code=400)
    async with pool.connection() as conn:
        await service.hook(conn, request.path_params["event"], payload if isinstance(payload, dict) else {"body": payload})
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
    """lv-flow's write, with the runtime token, up to approved. The agent token writes as remember does."""
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


async def _embed_in_background():
    """Pull the model, then sync every KB_EMBED_SYNC_SECONDS. A write whose embedding failed gets one on the next pass."""
    pulled = False
    while True:
        try:
            if not pulled:
                await pull_model()
                pulled = True
            if n := await sync_embeddings(pool):
                log.info("embedded %d entries", n)
        except Exception:
            log.exception("embedding sync failed. Hybrid ranks unembedded entries by keyword until a later pass")
        await asyncio.sleep(config.embed_sync_seconds)


def build_app():
    unknown = set(config.arms) - set(ARMS)
    if unknown:
        raise SystemExit(f"KB_ARMS names unknown arms {sorted(unknown)}. Known: {sorted(ARMS)}")
    if config.runtime_token and config.runtime_token == config.token:
        raise SystemExit("KB_RUNTIME_TOKEN must differ from KB_TOKEN, or every agent could write as lv-flow")
    inner = mcp.streamable_http_app()
    mcp_lifespan = inner.router.lifespan_context

    @asynccontextmanager
    async def lifespan(app):
        await pool.open(wait=True)
        task = asyncio.create_task(_embed_in_background())
        async with mcp_lifespan(app):
            yield
        task.cancel()
        await pool.close()

    inner.router.lifespan_context = lifespan
    # mcp caps /mcp bodies at 4 MiB, but not the custom routes, so this caps them all.
    return BearerAuth(RequestBodyLimitMiddleware(inner, MAX_REQUEST_BYTES), config.token, config.runtime_token)


class BearerAuth:
    """Every path but /healthz needs a bearer token. KB_TOKEN gets the agent role and KB_RUNTIME_TOKEN the runtime
    role, which rides in the ASGI scope as kb_role. An unset token matches nothing, so with neither set all is refused."""

    def __init__(self, app, token, runtime_token=""):
        self.app = app
        self.roles = [(f"Bearer {t}".encode(), role) for t, role in ((token, "agent"), (runtime_token, "runtime")) if t]

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"] != "/healthz":
            got = dict(scope["headers"]).get(b"authorization", b"")
            role = next((role for expected, role in self.roles if hmac.compare_digest(got, expected)), None)
            if role is None:
                await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)
                return
            scope = dict(scope, kb_role=role)
        await self.app(scope, receive, send)


app = build_app()
