"""kb: the memory server. One MCP endpoint for recall, one hook endpoint, bearer auth on both.

  uvicorn kb.server:app --host 0.0.0.0 --port 8000
"""
import asyncio
import hashlib
import hmac
import logging
from contextlib import asynccontextmanager

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse

from . import service
from .config import config
from .embed import pull_model, sync_embeddings
from .search import ARMS

log = logging.getLogger("kb")
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
async def recall(query: str, ctx: Context, task: str = "") -> str:
    """Search Wen's memory: his decisions, preferences, observations and past reactions.

    query: what you need to know, in English or 中文.
    task: optional one-line description of what you are doing, to sharpen the search.
    Results start with a retrieval id. Pass it to feedback() if the results helped or misled you."""
    async with pool.connection() as conn:
        return await service.recall(conn, _session(ctx), query, task, _client(ctx))


@mcp.tool()
async def get_entry(id: str, ctx: Context) -> str:
    """Open one memory entry by id, with its evidence, source and links."""
    async with pool.connection() as conn:
        return await service.get_entry(conn, _session(ctx), id)


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


@mcp.custom_route("/hooks/{event}", methods=["POST"])
async def hooks(request: Request):
    try:
        payload = await request.json()
    except ValueError:
        return JSONResponse({"error": "body must be JSON"}, status_code=400)
    async with pool.connection() as conn:
        await service.hook(conn, request.path_params["event"], payload if isinstance(payload, dict) else {"body": payload})
    return JSONResponse({"ok": True})


@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(request: Request):
    async with pool.connection() as conn:
        await conn.execute("select 1")
    return JSONResponse({"ok": True, "arms": config.arms})


async def _embed_in_background():
    try:
        await pull_model()
        async with pool.connection() as conn:
            log.info("embedded %d entries", await sync_embeddings(conn))
    except Exception:
        log.exception("embedding sync failed; hybrid serves keyword ranks until it succeeds")


def build_app():
    unknown = set(config.arms) - set(ARMS)
    if unknown:
        raise SystemExit(f"KB_ARMS names unknown arms {sorted(unknown)}. Known: {sorted(ARMS)}")
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
    return BearerAuth(inner, config.token, config.token_sha256)


class BearerAuth:
    """Every path but /healthz needs `Authorization: Bearer <token>`. With KB_TOKEN_SHA256 set, the token's SHA-256 must
    match it. Otherwise the token must equal KB_TOKEN. Neither set refuses everything."""

    def __init__(self, app, token, token_sha256=""):
        self.app, self.token, self.sha = app, token.encode(), token_sha256.encode()

    def _ok(self, header):
        if not header.startswith(b"Bearer "):
            return False
        got = header[7:]
        if self.sha:
            return hmac.compare_digest(hashlib.sha256(got).hexdigest().encode(), self.sha)
        return bool(self.token) and hmac.compare_digest(got, self.token)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"] != "/healthz":
            if not self._ok(dict(scope["headers"]).get(b"authorization", b"")):
                await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)
                return
        await self.app(scope, receive, send)


app = build_app()
