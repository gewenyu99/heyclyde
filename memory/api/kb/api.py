"""The management API behind Wen's console, mounted at /api/v1. JSON in and out.

Each handler borrows one pooled connection and hands it to admin_service, which owns the SQL. Query strings that don't
parse get a 400. Bodies that parse but don't validate get a 422. A body over MAX_BODY gets a 413 before it is parsed."""
import json
import re
from datetime import datetime, timezone

from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.routing import Route

from . import admin_service as svc
from .admin_service import ApiError


class JSON(JSONResponse):
    """JSONResponse that also writes timestamps, dates, decimals and UUIDs."""

    def render(self, content):
        return svc.dumps(content).encode("utf-8")


MAX_BODY = 1 << 20  # 1 MiB. The longest fields take 50,000 characters each, so a real write fits with room to spare.
MAX_OFFSET = 10 ** 9
UNSTORABLE = "has a character the database can't store."


def _storable(text):
    """Postgres text holds neither NUL nor a lone UTF-16 surrogate. A query string can carry the first and JSON both."""
    if "\x00" in text:
        return False
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _int(req, name, default, lo, hi=None):
    raw = req.query_params.get(name, "").strip()
    if not raw:
        return default
    try:
        n = int(raw)
    except ValueError:
        raise ApiError(400, f"{name} must be a whole number.") from None
    if n < lo or (hi is not None and n > hi):
        raise ApiError(400, f"{name} must be at least {lo}." if hi is None else f"{name} must be {lo} to {hi}.")
    return n


def _page(req):
    """limit defaults to 50 and stops at 200."""
    return {"limit": min(_int(req, "limit", 50, 1), 200), "offset": _int(req, "offset", 0, 0, MAX_OFFSET)}


def _text(req, name):
    value = req.query_params.get(name, "").strip() or None
    if value is not None and not _storable(value):
        raise ApiError(400, f"{name} {UNSTORABLE}")
    return value


def _choice(req, name, choices, default=None):
    value = _text(req, name) or default
    if value is not None and value not in choices:
        raise ApiError(400, f"{name} must be one of {', '.join(choices)}.")
    return value


def _flag(req, name):
    value = (_text(req, name) or "false").lower()
    if value not in ("true", "false", "1", "0"):
        raise ApiError(400, f"{name} must be true or false.")
    return value in ("true", "1")


TZ = re.compile(r"[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}")


def _tz(req):
    """An IANA time zone name like America/New_York. UTC by default. admin_service.activity checks Postgres knows it."""
    value = _text(req, "tz") or "UTC"
    if not TZ.fullmatch(value):
        raise ApiError(400, "tz must be a time zone like America/New_York.")
    return value


def _since(req):
    """An ISO 8601 time. A naive one is UTC. A + that the query string turned into a space is put back."""
    raw = _text(req, "since")
    if raw is None:
        return None
    try:
        ts = datetime.fromisoformat(raw.replace(" ", "+"))
    except ValueError:
        raise ApiError(400, "since must be an ISO 8601 time like 2026-10-10T00:00:00Z.") from None
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


async def read_json(req, cap=MAX_BODY):
    """The body parsed as JSON. It is counted as it arrives, chunked or not, and refused with 413 once it passes cap
    bytes, so nothing bigger is ever held."""
    size = req.headers.get("content-length", "")
    if size.isdigit() and int(size) > cap:
        raise ApiError(413, "The body is too large.")
    raw = bytearray()
    async for chunk in req.stream():
        raw += chunk
        if len(raw) > cap:
            raise ApiError(413, "The body is too large.")
    try:
        return json.loads(raw)
    except ValueError:
        raise ApiError(400, "The body must be JSON.") from None


def _check_storable(value, name):
    if isinstance(value, str):
        if not _storable(value):
            raise ApiError(422, f"{name} {UNSTORABLE}")
    elif isinstance(value, dict):
        for k, v in value.items():
            _check_storable(k, name)
            _check_storable(v, k if name == "The body" else name)
    elif isinstance(value, list):
        for v in value:
            _check_storable(v, name)


async def _body(req):
    data = await read_json(req)
    if not isinstance(data, dict):
        raise ApiError(400, "The body must be a JSON object.")
    _check_storable(data, "The body")
    return data


def _id(req, name="id"):
    value = req.path_params[name]
    if not _storable(value):
        raise ApiError(400, f"{name} {UNSTORABLE}")
    return value


async def _entries(req, conn):
    return await svc.entries(
        conn, q=_text(req, "q"), project=_text(req, "project"),
        authority=_choice(req, "authority", svc.AUTHORITIES), pattern=_text(req, "pattern"),
        sensitivity=_choice(req, "sensitivity", svc.SENSITIVITIES),
        superseded=_choice(req, "superseded", tuple(svc.STATES), "current"),
        sort=_choice(req, "sort", tuple(svc.ENTRY_SORTS), "id"), **_page(req))


async def _create_entry(req, conn):
    return await svc.create_entry(conn, await _body(req))


async def _update_entry(req, conn):
    return await svc.update_entry(conn, _id(req), await _body(req))


async def _add_link(req, conn):
    data = await _body(req)
    return await svc.add_link(conn, _id(req), data.get("dst"), data.get("type"))


async def _supersede(req, conn):
    return await svc.supersede(conn, _id(req), (await _body(req)).get("by"))


async def _add_feedback(req, conn):
    return await svc.add_feedback(conn, await _body(req))


async def _add_message(req, conn):
    return await svc.add_message(conn, await _body(req))


async def _recall_preview(req, conn):
    return await svc.recall_preview(conn, await _body(req))


async def _http_error(req, exc):
    error = {404: "No such endpoint.", 405: "That method is not allowed here."}.get(exc.status_code, str(exc.detail))
    return JSON({"error": error}, status_code=exc.status_code, headers=exc.headers)


async def _crash(req, exc):
    """Starlette re-raises after this, so the traceback still reaches the server log."""
    return JSON({"error": "The server hit an error. Its log has the details."}, status_code=500)


def build(pool, sync=None):
    """The /api/v1 app on the server's pool. Tests hand in a pool of their own. sync is the server's one embedding sync
    guard, shared with the sync it runs at startup."""
    sync = sync or svc.EmbeddingSync(pool)

    def endpoint(fn, status=200):
        async def run(req):
            try:
                async with pool.connection() as conn:
                    return JSON(await fn(req, conn), status_code=status)
            except ApiError as e:
                return JSON({"error": e.error}, status_code=e.status)
        return run

    async def sync_embeddings(req):
        if not sync.start("console"):
            return JSON({"error": "An embedding sync is already running."}, status_code=409)
        return JSON({"started": True}, status_code=202)

    def get(path, fn):
        return Route(path, endpoint(fn))

    return Starlette(routes=[
        get("/overview", lambda req, conn: svc.overview(conn, sync.status())),
        get("/activity", lambda req, conn: svc.activity(conn, _int(req, "days", 14, 1, 90), _tz(req))),
        get("/meta", lambda req, conn: svc.meta(conn)),
        get("/entries", _entries),
        Route("/entries", endpoint(_create_entry, 201), methods=["POST"]),
        get("/entries/{id}", lambda req, conn: svc.entry(conn, _id(req))),
        Route("/entries/{id}", endpoint(_update_entry), methods=["PATCH"]),
        Route("/entries/{id}", endpoint(lambda req, conn: svc.delete_entry(conn, _id(req))), methods=["DELETE"]),
        Route("/entries/{id}/links", endpoint(_add_link, 201), methods=["POST"]),
        Route("/entries/{id}/links/{type}/{dst}", endpoint(
            lambda req, conn: svc.delete_link(conn, _id(req), _id(req, "type"), _id(req, "dst"))), methods=["DELETE"]),
        Route("/entries/{id}/supersede", endpoint(_supersede, 201), methods=["POST"]),
        get("/graph", lambda req, conn: svc.graph(conn, _text(req, "project"), _flag(req, "include_superseded"))),
        get("/sessions", lambda req, conn: svc.sessions(
            conn, client=_text(req, "client"), arm=_text(req, "arm"), **_page(req))),
        get("/sessions/{id}", lambda req, conn: svc.session(conn, _id(req))),
        get("/events", lambda req, conn: svc.events(
            conn, event=_text(req, "event"), session_id=_text(req, "session_id"), agent=_text(req, "agent"),
            since=_since(req), **_page(req))),
        get("/events/{id}", lambda req, conn: svc.event(conn, _id(req))),
        get("/retrievals", lambda req, conn: svc.retrievals(
            conn, arm=_text(req, "arm"), client=_text(req, "client"), q=_text(req, "q"), **_page(req))),
        get("/retrievals/{id}", lambda req, conn: svc.retrieval(conn, _id(req))),
        get("/feedback", lambda req, conn: svc.feedback_list(
            conn, verdict=_text(req, "verdict"), source=_text(req, "source"), **_page(req))),
        Route("/feedback", endpoint(_add_feedback, 201), methods=["POST"]),
        get("/messages", lambda req, conn: svc.messages(conn, **_page(req))),
        Route("/messages", endpoint(_add_message, 201), methods=["POST"]),
        Route("/recall/preview", endpoint(_recall_preview), methods=["POST"]),
        Route("/embeddings/sync", sync_embeddings, methods=["POST"]),
        get("/audit", lambda req, conn: svc.audit(conn, **_page(req))),
    ], exception_handlers={HTTPException: _http_error, Exception: _crash})
