"""kb: the memory server. One MCP endpoint for recall, one hook endpoint, bearer auth on both.

  uvicorn kb.server:app --host 0.0.0.0 --port 8000
"""
import asyncio
import hmac
import logging
from contextlib import asynccontextmanager

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from starlette.requests import Request
from starlette.responses import JSONResponse

from . import service
from .config import config
from .embed import pull_model, sync_embeddings

log = logging.getLogger("kb")
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
        log.exception("embedding sync failed; A1 serves keyword ranks until it succeeds")


def build_app():
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
    return BearerAuth(inner, config.token)


class BearerAuth:
    """Every path but /healthz needs `Authorization: Bearer $KB_TOKEN`. An unset token refuses everything."""

    def __init__(self, app, token):
        self.app, self.expected = app, f"Bearer {token}".encode() if token else None

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"] != "/healthz":
            got = dict(scope["headers"]).get(b"authorization", b"")
            if self.expected is None or not hmac.compare_digest(got, self.expected):
                await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)
                return
        await self.app(scope, receive, send)


app = build_app()
