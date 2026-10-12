"""The management API through the real server app, against the test database. Ollama is a dead port.

Each test removes the entries, links and messages it adds, so test_db.py still sees the seed vault as it was."""
import asyncio
import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from kb import admin_service, server, service
from kb.config import Config, config

pytestmark = pytest.mark.asyncio
TOKEN = "test-token-the-agents-hold"
ADMIN = "test-admin-token-only-the-console-holds"
AUTH = {"Authorization": f"Bearer {ADMIN}"}
AGENT = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture(autouse=True)
async def cleanup(db_url):
    yield
    import psycopg
    async with await psycopg.AsyncConnection.connect(db_url) as c:
        await c.execute("delete from link where src like 'apitest-%' or dst like 'apitest-%'")
        await c.execute("delete from entry where id like 'apitest-%'")
        await c.execute("delete from message where body like 'apitest%'")


@pytest.fixture
async def app(db_url, monkeypatch):
    """The whole server on a pool the test owns. Lifespan never runs, so no model pull or embedding starts."""
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool
    monkeypatch.setenv("KB_TOKEN", TOKEN)
    monkeypatch.setenv("KB_ADMIN_TOKEN", ADMIN)
    for name in ("KB_TOKEN_SHA256", "KB_ADMIN_TOKEN_SHA256"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(server, "config", Config())
    pool = AsyncConnectionPool(db_url, open=False, min_size=1, max_size=4, kwargs={"row_factory": dict_row})
    await pool.open(wait=True)
    monkeypatch.setattr(server, "pool", pool)
    yield server.build_app()
    await pool.close()


@pytest.fixture
async def api(app):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://kb.test", headers=AUTH) as c:
        yield c


async def make(api, eid, **fields):
    body = {"id": eid, "title": f"Title {eid}", "body": f"Body of {eid}.", "pattern": "decisions",
            "authority": "approved", "scope": "domain:tea", **fields}
    r = await api.post("/api/v1/entries", json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def audit_rows(api, target):
    r = await api.get("/api/v1/audit", params={"limit": 200})
    return [a for a in r.json()["items"] if a["target"] == target]


async def test_api_needs_the_token_and_the_console_does_not(app):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://kb.test") as anon:
        r = await anon.get("/api/v1/overview")
        assert r.status_code == 401 and r.json() == {"error": "unauthorized"}
        assert (await anon.get("/api/v1/entries", headers={"Authorization": "Bearer nope"})).status_code == 401
        assert (await anon.post("/api/v1/messages", json={"to": "claude", "body": "x"})).status_code == 401
        assert (await anon.get("/consolex")).status_code == 401
        assert (await anon.get("/")).status_code == 401
        assert (await anon.get("/console/")).status_code != 401
        files = sorted(p.name for p in server.CONSOLE.glob("*") if p.is_file())
        if files:
            r = await anon.get(f"/console/{files[0]}")
            assert r.status_code == 200 and r.headers["cache-control"] == "no-cache"
            again = await anon.get(f"/console/{files[0]}", headers={"if-none-match": r.headers["etag"]})
            assert again.status_code == 304 and again.headers["cache-control"] == "no-cache"
        r = await anon.get("/console")
        assert r.status_code in (301, 307) and r.headers["location"].endswith("/console/")
        r = await anon.get("/", headers=AUTH)
        assert r.status_code == 307 and r.headers["location"] == "/console/"


async def test_the_agents_token_never_opens_the_console_api(app):
    """Every agent holds its token, so with it they could read private entries in full and write as Wen."""
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://kb.test", headers=AGENT) as agent:
        for r in (await agent.get("/api/v1/entries/tea-supplier"),
                  await agent.patch("/api/v1/entries/tea-zh", json={"authority": "draft", "body": "apitest poisoned"}),
                  await agent.post("/api/v1/messages", json={"to": "all", "body": "apitest from wen"}),
                  await agent.get("/")):
            assert r.status_code == 401 and r.json() == {"error": "unauthorized"}
        assert (await agent.get("/messages/claude")).status_code == 200
        assert (await agent.post("/hooks/Stop", json={"session_id": "apitest-auth"})).status_code == 200
        for path in ("/messages/claude", "/hooks/Stop"):
            assert (await agent.get(path, headers=AUTH)).status_code == 401
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://kb.test", headers=AUTH) as admin:
        assert (await admin.get("/api/v1/entries/tea-zh")).json()["entry"]["authority"] == "approved"
        assert not [m for m in (await admin.get("/api/v1/messages")).json()["items"] if m["body"] == "apitest from wen"]


@pytest.mark.parametrize("admin", ["", "too-short-for-a-console", TOKEN + "-but-long-enough"])
async def test_the_console_is_off_without_a_strong_admin_token(db_url, monkeypatch, admin):
    """Unset, short, or the agents' own token."""
    monkeypatch.setenv("KB_TOKEN", admin if admin.endswith("long-enough") else TOKEN)
    monkeypatch.setenv("KB_ADMIN_TOKEN", admin)
    monkeypatch.setattr(server, "config", Config())
    app = server.build_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://kb.test") as c:
        r = await c.get("/api/v1/meta", headers={"Authorization": f"Bearer {admin}"})
        assert r.status_code == 503 and r.json()["error"].startswith("The console is off.")
        assert app.off == r.json()["error"]


async def test_unknown_paths_and_methods_answer_in_json(api):
    r = await api.get("/api/v1/nope")
    assert r.status_code == 404 and "error" in r.json()
    r = await api.put("/api/v1/overview")
    assert r.status_code == 405 and "error" in r.json()
    r = await api.post("/api/v1/entries", content=b"not json")
    assert r.status_code == 400 and r.json() == {"error": "The body must be JSON."}


async def test_overview_counts_match_the_tables(api, conn):
    r = await api.get("/api/v1/overview")
    assert r.status_code == 200
    o = r.json()
    assert o["health"]["db"] is True and o["health"]["arms"] == config.arms
    assert o["health"]["embedding_model"] == config.embed_model and isinstance(o["health"]["vector"], bool)
    cur = await conn.execute(
        "select (select count(*) from entry_current) as entries, (select count(*) from link) as links, "
        "(select count(*) from kb_session) as mcp_sessions, (select count(*) from retrieval) as recalls")
    want = await cur.fetchone()
    counts = o["counts"]
    assert {k: counts[k] for k in want} == want
    assert counts["sources"] == 2 and counts["projects"] == 1 and counts["superseded"] == 1 and counts["private"] == 1
    assert o["embeddings"]["embedded"] + o["embeddings"]["stale_or_missing"] == counts["entries"]
    assert set(o["last"]) == {"event", "hook", "recall", "message", "feedback"}
    assert o["health"]["sync"] is None  # no sync has run in this app

    assert (await api.post("/api/v1/messages", json={"to": "claude", "body": "apitest overview"})).status_code == 201
    after = (await api.get("/api/v1/overview")).json()["counts"]
    assert after["messages"] == counts["messages"] + 1
    assert after["unread"]["claude"] == counts["unread"]["claude"] + 1
    assert after["unread"]["codex"] == counts["unread"]["codex"]
    assert after["unread_messages"] == counts["unread_messages"] + 1
    # A message to all waits for both agents but is one message, so it counts once.
    assert (await api.post("/api/v1/messages", json={"to": "all", "body": "apitest overview all"})).status_code == 201
    again = (await api.get("/api/v1/overview")).json()["counts"]
    assert again["unread_messages"] == after["unread_messages"] + 1
    assert again["unread"]["claude"] + again["unread"]["codex"] == after["unread"]["claude"] + after["unread"]["codex"] + 2
    assert again["unread_messages"] <= again["messages"]


async def test_last_hook_leaves_out_get_entry_opens(api, conn):
    await service.get_entry(conn, f"apitest-{uuid.uuid4()}", "tea-zh")
    last = (await api.get("/api/v1/overview")).json()["last"]
    cur = await conn.execute("select max(received_at) as at from event where event <> 'get_entry'")
    hook = (await cur.fetchone())["at"]
    assert last["hook"] == (hook.isoformat() if hook else None) and last["event"] != last["hook"]


async def test_activity_has_every_day_and_meta_lists_the_choices(api):
    r = await api.get("/api/v1/activity", params={"days": 3})
    days = r.json()["days"]
    assert [d["day"] for d in days] == [(datetime.now(timezone.utc).date() - timedelta(days=n)).isoformat()
                                        for n in (2, 1, 0)]
    assert set(days[0]) == {"day", "events", "recalls", "feedback", "messages"}
    assert {"events_by_type", "clients"} <= set(r.json())
    assert (await api.get("/api/v1/activity", params={"days": 0})).status_code == 400
    assert (await api.get("/api/v1/activity", params={"days": 91})).status_code == 400
    # Days follow tz. Kiritimati is UTC+14 and Pago Pago is UTC-11, neither with daylight saving.
    for tz, hours in (("Pacific/Kiritimati", 14), ("Pacific/Pago_Pago", -11)):
        local = (await api.get("/api/v1/activity", params={"days": 2, "tz": tz})).json()["days"]
        today = datetime.now(timezone(timedelta(hours=hours))).date()
        assert [d["day"] for d in local] == [(today - timedelta(days=1)).isoformat(), today.isoformat()]
    # Etc/GMT-14 is the IANA name for UTC+14. Postgres reads a POSIX UTC+14 as UTC-14, so it is refused.
    kiritimati = (await api.get("/api/v1/activity", params={"days": 2, "tz": "Pacific/Kiritimati"})).json()["days"]
    assert (await api.get("/api/v1/activity", params={"days": 2, "tz": "Etc/GMT-14"})).json()["days"] == kiritimati
    for tz in ("Mars/Olympus", "UTC; drop table entry", "UTC+14", "UTC+167", "EST+5"):
        r = await api.get("/api/v1/activity", params={"tz": tz})
        assert r.status_code == 400 and r.json() == {"error": "tz must be a time zone like America/New_York."}, tz
    m = (await api.get("/api/v1/meta")).json()
    assert m["authorities"] == ["approved", "observed", "draft"] and m["sensitivities"] == ["normal", "private"]
    assert "decisions" in m["patterns"] and {"part_of", "relates", "supersedes"} <= set(m["link_types"])
    assert m["projects"] == [{"id": "proj-tea", "title": "Tea brewing"}]
    assert {s["id"] for s in m["sources"]} == {"src-a", "src-b"}
    assert {"index", "hybrid"} <= set(m["arms"]) and m["live_arms"] == config.arms


async def test_entries_filter_and_page(api, conn):
    async def get(**params):
        return await api.get("/api/v1/entries", params=params)

    current = (await get()).json()
    ids = [e["id"] for e in current["items"]]
    assert "tea-oolong-temp" in ids and "tea-oolong-old" not in ids and current["total"] == len(ids) == 5
    assert ids == sorted(ids) and current["limit"] == 50 and current["offset"] == 0
    temp = next(e for e in current["items"] if e["id"] == "tea-oolong-temp")
    assert temp["project_title"] == "Tea brewing" and temp["links"] == 3 and temp["superseded_by"] == []
    assert [e["id"] for e in (await get(superseded="superseded")).json()["items"]] == ["tea-oolong-old"]
    assert (await get(superseded="all")).json()["total"] == 6
    assert [e["id"] for e in (await get(authority="draft")).json()["items"]] == ["tea-draft-cold"]
    assert [e["id"] for e in (await get(sensitivity="private")).json()["items"]] == ["tea-supplier"]
    assert "tea-oolong-temp" in [e["id"] for e in (await get(q="oolong")).json()["items"]]
    assert [e["id"] for e in (await get(q="water temperature", superseded="all")).json()["items"]] == [
        "tea-oolong-old", "tea-oolong-temp"]
    assert (await get(q="100%")).json()["total"] == 0
    assert (await get(project="proj-tea", pattern="decisions")).json()["total"] == 1
    first, second = (await get(limit=2)).json(), (await get(limit=2, offset=2)).json()
    assert len(first["items"]) == len(second["items"]) == 2 and first["total"] == second["total"] == 5
    assert not {e["id"] for e in first["items"]} & {e["id"] for e in second["items"]}
    assert (await get(limit=500)).json()["limit"] == 200
    titles = [e["title"] for e in (await get(sort="title")).json()["items"]]
    cur = await conn.execute("select title from entry_current order by title, id")  # the database's collation decides
    assert titles == [r["title"] for r in await cur.fetchall()]
    for bad in ({"limit": "x"}, {"offset": -1}, {"superseded": "maybe"}, {"sort": "random"}, {"authority": "boss"}):
        r = await get(**bad)
        assert r.status_code == 400 and "error" in r.json()


async def test_search_reads_the_title_and_body_not_the_project_title(api):
    """Every tea entry's search text carries its project's title, Tea brewing. Only entries that say brew match."""
    found = [e["id"] for e in (await api.get("/api/v1/entries", params={"q": "brewing", "superseded": "all"})).json()["items"]]
    assert "proj-tea" in found and "tea-oolong-temp" in found
    assert "tea-supplier" not in found and "tea-zh" not in found


async def test_offset_has_a_ceiling(api):
    for path in ("/api/v1/entries", "/api/v1/events", "/api/v1/audit", "/api/v1/messages", "/api/v1/feedback",
                 "/api/v1/retrievals", "/api/v1/sessions"):
        for big in ("99999999999999999999", "9223372036854775808"):
            r = await api.get(path, params={"offset": big})
            assert r.status_code == 400 and r.json() == {"error": "offset must be 0 to 1000000000."}, path
    assert (await api.get("/api/v1/entries", params={"offset": 10 ** 9})).json()["items"] == []


async def test_entry_detail_shows_what_replaced_it(api):
    r = await api.get("/api/v1/entries/tea-oolong-old")
    d = r.json()
    assert d["superseded_by"] == ["tea-oolong-temp"] and d["current"] is False and d["supersedes"] == []
    assert not {"tsv_en", "tsv_zh", "search_text"} & set(d["entry"])
    assert d["entry"]["project_title"] == "Tea brewing" and d["entry"]["valid_from"] == "2026-09-01"
    assert d["source"]["id"] == "src-a"
    assert {"type": "supersedes", "src": "tea-oolong-temp", "title": "Brew oolong at 90C", "authority": "approved"} \
        in d["links_in"]
    assert set(d["usage"]) == {"delivered", "candidate", "last_delivered", "feedback"}
    new = (await api.get("/api/v1/entries/tea-oolong-temp")).json()
    assert new["supersedes"] == ["tea-oolong-old"] and new["current"] is True
    private = (await api.get("/api/v1/entries/tea-supplier")).json()
    assert private["entry"]["evidence"] == "my supplier is secret co"
    r = await api.get("/api/v1/entries/no-such-entry")
    assert r.status_code == 404 and r.json() == {"error": "No entry no-such-entry."}


async def test_create_patch_delete_leave_an_audit_trail(api):
    d = await make(api, "apitest-a", project="proj-tea", source_id="src-a", evidence_kind="quote", evidence="said it")
    assert d["entry"]["evidence_sha256"] == hashlib.sha256(b"said it").hexdigest()
    assert d["entry"]["sensitivity"] == "normal" and d["entry"]["lang"] == "en" and d["entry"]["valid_from"]
    assert {"type": "part_of", "dst": "proj-tea", "title": "Tea brewing", "authority": "approved"} in d["links_out"]
    assert (await api.post("/api/v1/entries", json={"id": "apitest-a", "title": "t", "body": "b", "pattern": "decisions",
                                                     "authority": "draft", "scope": "global"})).status_code == 409
    base = {"title": "t", "body": "b", "pattern": "decisions", "authority": "draft", "scope": "global"}
    for bad in ({"id": "Bad_Id"}, {"id": "apitest-x", "project": "nope"}, {"id": "apitest-x", "source_id": "nope"},
                {"id": "apitest-x", "links": [{"dst": "nope", "type": "relates"}]},
                {"id": "apitest-x", "authority": "boss"}, {"id": "apitest-x", "scope": "anywhere"},
                {"id": "apitest-x", "project": "tea-zh"}, {"id": "apitest-x", "evidence_sha256": "abc"}):
        r = await api.post("/api/v1/entries", json={**base, **bad})
        assert r.status_code == 422, (bad, r.text)
    r = await api.post("/api/v1/entries", json={"id": "apitest-x", "title": "t"})
    assert r.status_code == 422 and r.json() == {"error": "Missing body, pattern, authority, scope."}

    r = await api.patch("/api/v1/entries/apitest-a", json={"title": "Renamed", "evidence": "said it again"})
    assert r.status_code == 200
    assert r.json()["entry"]["title"] == "Renamed"
    assert r.json()["entry"]["evidence_sha256"] == hashlib.sha256(b"said it again").hexdigest()
    assert (await api.patch("/api/v1/entries/apitest-a", json={"colour": "red"})).status_code == 422
    assert (await api.patch("/api/v1/entries/apitest-a", json={"title": None})).status_code == 422
    assert (await api.patch("/api/v1/entries/apitest-a", json={})).status_code == 422
    assert (await api.patch("/api/v1/entries/apitest-missing", json={"title": "x"})).status_code == 404
    r = await api.patch("/api/v1/entries/apitest-a", json={"project": None})
    assert r.json()["entry"]["project"] is None and r.json()["links_out"] == []

    await make(api, "apitest-b", links=[{"dst": "apitest-a", "type": "relates"}])
    r = await api.delete("/api/v1/entries/apitest-a")
    assert r.status_code == 409 and "link" in r.json()["error"]
    assert (await api.delete("/api/v1/entries/tea-zh")).status_code == 409
    assert (await api.delete("/api/v1/entries/apitest-b/links/relates/apitest-a")).status_code == 200
    assert (await api.delete("/api/v1/entries/apitest-a")).json() == {"deleted": "apitest-a"}
    assert (await api.get("/api/v1/entries/apitest-a")).status_code == 404
    assert (await api.delete("/api/v1/entries/apitest-a")).status_code == 404

    trail = await audit_rows(api, "entry:apitest-a")
    assert [a["action"] for a in trail] == ["entry.delete", "entry.update", "entry.update", "entry.create"]
    assert trail[0]["before"]["title"] == "Renamed" and trail[0]["after"] is None
    assert trail[2]["before"] == {"title": "Title apitest-a", "evidence": "said it",
                                  "evidence_sha256": hashlib.sha256(b"said it").hexdigest()}
    assert trail[3]["after"]["links"] == [{"src": "apitest-a", "dst": "proj-tea", "type": "part_of"}]


async def test_delivered_entries_cannot_be_deleted(api, conn):
    await make(api, "apitest-said", title="Zanzibar teapot rule", body="Zanzibar teapots get rinsed twice.")
    text = await service.recall(conn, f"apitest-{uuid.uuid4()}", "zanzibar teapot")
    cur = await conn.execute("select delivered from retrieval where id = %s", (uuid.UUID(text.split()[1]),))
    assert "apitest-said" in (await cur.fetchone())["delivered"]
    r = await api.delete("/api/v1/entries/apitest-said")
    assert r.status_code == 409 and "Supersede it instead" in r.json()["error"]
    d = (await api.get("/api/v1/entries/apitest-said")).json()
    assert d["usage"]["delivered"] == 1 and d["usage"]["candidate"] == 1 and d["usage"]["last_delivered"]


async def test_links_add_and_remove(api):
    await make(api, "apitest-c", pattern="preferences")
    link = {"dst": "tea-oolong-temp", "type": "relates"}
    r = await api.post("/api/v1/entries/apitest-c/links", json=link)
    assert r.status_code == 201 and r.json() == {"src": "apitest-c", **link}
    assert (await api.post("/api/v1/entries/apitest-c/links", json=link)).status_code == 409
    assert (await api.post("/api/v1/entries/apitest-c/links", json={"dst": "apitest-c", "type": "relates"})).status_code == 422
    assert (await api.post("/api/v1/entries/apitest-c/links", json={"dst": "nope", "type": "relates"})).status_code == 422
    assert (await api.post("/api/v1/entries/apitest-c/links", json={"dst": "tea-zh", "type": "Relates!"})).status_code == 422
    assert (await api.post("/api/v1/entries/apitest-none/links", json=link)).status_code == 404
    d = (await api.get("/api/v1/entries/apitest-c")).json()
    assert [(l["type"], l["dst"]) for l in d["links_out"]] == [("relates", "tea-oolong-temp")]
    r = await api.delete("/api/v1/entries/apitest-c/links/relates/tea-oolong-temp")
    assert r.status_code == 200 and r.json() == {"deleted": {"src": "apitest-c", **link}}
    assert (await api.delete("/api/v1/entries/apitest-c/links/relates/tea-oolong-temp")).status_code == 404
    assert [a["action"] for a in await audit_rows(api, "entry:apitest-c")] == ["link.delete", "link.create", "entry.create"]


async def test_supersede_hides_the_old_entry(api):
    await make(api, "apitest-old", title="Apitest rule one")
    await make(api, "apitest-new", title="Apitest rule two")
    r = await api.post("/api/v1/entries/apitest-old/supersede", json={"by": "apitest-new"})
    assert r.status_code == 201
    assert r.json()["superseded_by"] == ["apitest-new"] and r.json()["current"] is False
    listed = [e["id"] for e in (await api.get("/api/v1/entries", params={"q": "apitest"})).json()["items"]]
    assert listed == ["apitest-new"]
    everything = (await api.get("/api/v1/entries", params={"q": "apitest", "superseded": "all"})).json()["items"]
    assert {e["id"]: e["superseded_by"] for e in everything} == {"apitest-new": [], "apitest-old": ["apitest-new"]}
    assert (await api.post("/api/v1/entries/apitest-old/supersede", json={"by": "apitest-new"})).status_code == 409
    assert (await api.post("/api/v1/entries/apitest-new/supersede", json={"by": "apitest-old"})).status_code == 409
    assert (await api.post("/api/v1/entries/apitest-old/supersede", json={"by": "apitest-old"})).status_code == 422
    assert (await api.post("/api/v1/entries/apitest-old/supersede", json={"by": "nope"})).status_code == 422
    assert (await api.post("/api/v1/entries/apitest-old/supersede", json={})).status_code == 422
    assert (await audit_rows(api, "entry:apitest-old"))[0]["action"] == "entry.supersede"


async def test_graph_keeps_links_inside_its_nodes(api):
    g = (await api.get("/api/v1/graph", params={"project": "proj-tea"})).json()
    nodes = {n["id"]: n for n in g["nodes"]}
    assert "proj-tea" in nodes and "tea-oolong-temp" in nodes and "tea-oolong-old" not in nodes
    assert nodes["tea-supplier"]["private"] is True and nodes["tea-zh"]["project_title"] == "Tea brewing"
    assert all(l["src"] in nodes and l["dst"] in nodes for l in g["links"])
    assert {"src": "tea-zh", "dst": "proj-tea", "type": "part_of"} in g["links"]
    full = (await api.get("/api/v1/graph", params={"include_superseded": "true"})).json()
    assert {n["id"]: n["current"] for n in full["nodes"]}["tea-oolong-old"] is False
    assert {"src": "tea-oolong-temp", "dst": "tea-oolong-old", "type": "supersedes"} in full["links"]
    assert (await api.get("/api/v1/graph", params={"include_superseded": "perhaps"})).status_code == 400


async def test_sessions_and_events_after_hooks(api, conn):
    sid, csid = f"apitest-{uuid.uuid4()}", f"claude-{uuid.uuid4()}"
    text = await service.recall(conn, sid, "oolong", client="apitest-client")
    await service.get_entry(conn, sid, "tea-zh")
    prompt = {"session_id": csid, "prompt": "p" * 300, "cwd": "/work/tea"}
    assert (await api.post("/hooks/UserPromptSubmit", json=prompt, headers=AGENT, params={"agent": "codex"})).status_code == 200
    used = {"session_id": csid, "tool_name": "mcp__kb__recall", "tool_response": [{"type": "text", "text": text}]}
    assert (await api.post("/hooks/PostToolUse", json=used, headers=AGENT, params={"agent": "Not an agent!"})).status_code == 200

    s = (await api.get("/api/v1/sessions", params={"client": "apitest-client"})).json()
    row = next(i for i in s["items"] if i["id"] == sid)
    assert row["claude_session_id"] == csid and row["recalls"] == 1 and row["events"] == 2 and row["last_recall"]
    d = (await api.get(f"/api/v1/sessions/{sid}")).json()
    assert d["session"]["id"] == sid
    kinds = [t["kind"] for t in d["timeline"]]
    assert sorted(kinds) == ["event", "event", "get_entry", "recall"] and kinds[0] == "recall"
    assert [t["at"] for t in d["timeline"]] == sorted(t["at"] for t in d["timeline"])
    assert next(t for t in d["timeline"] if t["kind"] == "get_entry")["summary"] == "tea-zh"
    assert (await api.get("/api/v1/sessions/nope")).status_code == 404

    e = (await api.get("/api/v1/events", params={"session_id": csid})).json()
    assert e["total"] == 2
    by = {i["event"]: i for i in e["items"]}
    assert by["UserPromptSubmit"]["summary"] == "p" * 160 and by["UserPromptSubmit"]["cwd"] == "/work/tea"
    assert by["PostToolUse"]["summary"] == "mcp__kb__recall" == by["PostToolUse"]["tool_name"]
    assert by["UserPromptSubmit"]["agent"] == "codex" and by["PostToolUse"]["agent"] is None
    codex = (await api.get("/api/v1/events", params={"session_id": csid, "agent": "codex"})).json()["items"]
    assert [i["event"] for i in codex] == ["UserPromptSubmit"]
    agents = {a["agent"]: a for a in (await api.get("/api/v1/activity", params={"days": 1})).json()["agents"]}
    assert agents["codex"]["events"] >= 1 and agents["codex"]["sessions"] >= 1 and agents["codex"]["last"]
    one = (await api.get(f"/api/v1/events/{by['UserPromptSubmit']['id']}")).json()["event"]
    assert one["payload"] == prompt and one["session_id"] == csid and one["agent"] == "codex"
    assert (await api.get("/api/v1/events/999999999")).status_code == 404
    r = await api.get("/api/v1/events/abc")
    assert r.status_code == 404 and r.json() == {"error": "No event abc."}
    assert (await api.get("/api/v1/events/99999999999999999999999")).status_code == 404
    later = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    assert (await api.get("/api/v1/events", params={"session_id": csid, "since": later})).json()["total"] == 0
    assert (await api.get("/api/v1/events", params={"since": "yesterday"})).status_code == 400


async def test_retrieval_detail_after_a_recall(api, conn):
    sid = f"apitest-{uuid.uuid4()}"
    text = await service.recall(conn, sid, "oolong temperature", client="apitest-client")
    rid = text.split()[1]
    d = (await api.get(f"/api/v1/retrievals/{rid}")).json()
    assert d["client"] == "apitest-client" and d["retrieval"]["kb_session"] == sid
    cands = d["candidates"]
    assert [c["rank"] for c in cands] == list(range(1, len(cands) + 1)) and all(c["exists"] for c in cands)
    assert [c["id"] for c in cands if c["delivered"]] == d["retrieval"]["delivered"]
    assert all(c["title"] for c in cands)
    assert all(c["current"] is (not c["superseded_by"]) for c in cands)
    listed = (await api.get("/api/v1/retrievals", params={"client": "apitest-client", "q": "temperature"})).json()
    row = next(i for i in listed["items"] if i["id"] == rid)
    assert row["delivered_count"] == len(d["retrieval"]["delivered"]) and row["feedback"] == 0
    assert (await api.get("/api/v1/retrievals/not-a-uuid")).status_code == 404
    assert (await api.get(f"/api/v1/retrievals/{uuid.uuid4()}")).status_code == 404


async def test_feedback_and_messages_go_through_the_service(api, conn):
    text = await service.recall(conn, f"apitest-{uuid.uuid4()}", "oolong")
    rid = text.split()[1]
    r = await api.post("/api/v1/feedback", json={"retrieval_id": rid, "verdict": "helpful", "note": "apitest"})
    assert r.status_code == 201 and r.json() == {"ok": True}
    before = len(await audit_rows(api, f"retrieval:{rid}"))
    r = await api.post("/api/v1/feedback", json={"retrieval_id": rid, "verdict": "great"})
    assert r.status_code == 422 and r.json() == {"error": "verdict must be helpful, irrelevant or wrong."}
    assert (await api.post("/api/v1/feedback", json={"retrieval_id": "nope", "verdict": "wrong"})).status_code == 422
    assert len(await audit_rows(api, f"retrieval:{rid}")) == before == 1
    f = (await api.get("/api/v1/feedback", params={"source": "wen"})).json()["items"]
    assert any(i["retrieval_id"] == rid and i["query"] == "oolong" and i["verdict"] == "helpful" for i in f)
    assert (await api.get(f"/api/v1/retrievals/{rid}")).json()["feedback"][0]["source"] == "wen"

    r = await api.post("/api/v1/messages", json={"to": "Claude", "body": "apitest ping"})
    assert r.status_code == 201 and r.json()["to"] == "claude"
    mid = r.json()["id"]
    assert (await api.post("/api/v1/messages", json={"to": "claud", "body": "apitest typo"})).status_code == 422
    assert (await api.post("/api/v1/messages", json={"to": "claude", "body": "  "})).status_code == 422
    board = (await api.get("/api/v1/messages")).json()["items"]
    mine = next(m for m in board if m["id"] == mid)
    assert mine["sender"] == "wen" and mine["recipient"] == "claude" and mine["read_by"] == []
    cur = await conn.execute("select read_by from message where id = %s", (mid,))
    assert (await cur.fetchone())["read_by"] == []
    assert (await audit_rows(api, f"message:{mid}"))[0]["after"] == {"to": "Claude", "body": "apitest ping"}


async def test_recall_preview_writes_nothing(api, conn):
    tables = ("retrieval", "kb_session", "event", "feedback", "admin_audit")
    count = "select " + ", ".join(f"(select count(*) from {t}) as {t}" for t in tables)
    before = await (await conn.execute(count)).fetchone()
    await conn.commit()
    r = await api.post("/api/v1/recall/preview", json={"query": "oolong temperature"})
    assert r.status_code == 200
    arms = {a["arm"]: a for a in r.json()["arms"]}
    assert set(arms) == {"index", "hybrid"}
    assert arms["hybrid"]["degraded"] and arms["hybrid"]["packet"][0] == "tea-oolong-temp"
    for a in arms.values():
        ranked = [x["id"] for x in a["ranked"]]
        assert len(ranked) <= 25 and set(a["packet"]) <= set(ranked)
        assert [x["id"] for x in a["ranked"] if x["in_packet"]] == a["packet"]
    assert "tea-oolong-old" not in arms["hybrid"]["packet"]
    # index delivers the replaced entry struck through. The preview marks it and shows the text the agent reads.
    old = next(x for x in arms["index"]["ranked"] if x["id"] == "tea-oolong-old")
    assert old["superseded_by"] == ["tea-oolong-temp"] and old["current"] is False
    assert "~~Brew oolong at 100C~~ → tea-oolong-temp" in arms["index"]["text"]
    temp = next(x for x in arms["hybrid"]["ranked"] if x["id"] == "tea-oolong-temp")
    assert temp["superseded_by"] == [] and temp["current"] is True
    assert arms["hybrid"]["text"].startswith("[1] tea-oolong-temp: Brew oolong at 90C")
    one = (await api.post("/api/v1/recall/preview", json={"query": "oolong", "task": "brew", "arms": ["index"]})).json()
    assert [a["arm"] for a in one["arms"]] == ["index"]
    assert (await api.post("/api/v1/recall/preview", json={"query": "oolong", "arms": ["telepathy"]})).status_code == 422
    assert (await api.post("/api/v1/recall/preview", json={"task": "brew"})).status_code == 422
    assert await (await conn.execute(count)).fetchone() == before


async def test_embedding_sync_runs_once_at_a_time_and_fails_quietly(api, monkeypatch):
    gate = asyncio.Event()

    async def slow_pull():
        await gate.wait()

    monkeypatch.setattr(admin_service, "pull_model", slow_pull)
    seen = {a["id"] for a in await audit_rows(api, "embeddings")}
    r = await api.post("/api/v1/embeddings/sync")
    assert r.status_code == 202 and r.json() == {"started": True}
    r = await api.post("/api/v1/embeddings/sync")
    assert r.status_code == 409 and "error" in r.json()
    gate.set()
    for _ in range(100):
        done = [a for a in await audit_rows(api, "embeddings") if a["id"] not in seen]
        if done:
            break
        await asyncio.sleep(0.05)
    assert done[0]["action"] == "embeddings.sync" and "ConnectError" in done[0]["after"]["error"]
    sync = (await api.get("/api/v1/overview")).json()["health"]["sync"]
    assert sync["running"] is False and sync["trigger"] == "console" and "ConnectError" in sync["error"]
    assert sync["finished_at"] >= sync["started_at"] and sync["embedded"] is None
    assert (await api.post("/api/v1/embeddings/sync")).status_code == 202
    for _ in range(100):
        if len([a for a in await audit_rows(api, "embeddings") if a["id"] not in seen]) == 2:
            break
        await asyncio.sleep(0.05)


async def test_the_startup_sync_and_the_console_share_one_guard(app, api, monkeypatch):
    """The server's own sync at startup counts as running, so the console can't start a second one beside it."""
    gate = asyncio.Event()

    async def slow_pull():
        await gate.wait()

    monkeypatch.setattr(admin_service, "pull_model", slow_pull)
    seen = {a["id"] for a in await audit_rows(api, "embeddings")}
    assert app.app.state.sync.start("startup")
    r = await api.post("/api/v1/embeddings/sync")
    assert r.status_code == 409 and r.json() == {"error": "An embedding sync is already running."}
    sync = (await api.get("/api/v1/overview")).json()["health"]["sync"]
    assert sync["running"] is True and sync["trigger"] == "startup" and sync["finished_at"] is None
    gate.set()
    await app.app.state.sync.task
    sync = (await api.get("/api/v1/overview")).json()["health"]["sync"]
    assert sync["running"] is False and "ConnectError" in sync["error"]
    assert not [a for a in await audit_rows(api, "embeddings") if a["id"] not in seen]  # startup isn't an API write


async def test_bodies_and_fields_have_a_size_limit(api):
    from kb import api as kb_api
    big = b'{"id": "apitest-big", "junk": "' + b"x" * kb_api.MAX_BODY + b'"}'
    r = await api.post("/api/v1/entries", content=big, headers={"content-type": "application/json"})
    assert r.status_code == 413 and r.json() == {"error": "The body is too large."}

    async def chunks():
        yield b'{"query": "'
        for _ in range(20):
            yield b"y" * 65536
        yield b'"}'

    r = await api.post("/api/v1/recall/preview", content=chunks())
    assert r.status_code == 413 and "content-length" not in r.request.headers
    r = await api.post("/hooks/Stop", content=b'{"x": "' + b"z" * server.MAX_HOOK_BODY + b'"}', headers=AGENT)
    assert r.status_code == 413
    for body, field in (({"title": "t" * 501}, "title"), ({"body": "b" * 50001}, "body"), ({"scope": "domain:" + "a" * 300}, "scope")):
        r = await api.post("/api/v1/entries", json={"id": "apitest-long", "title": "t", "body": "b", "pattern": "decisions",
                                                    "authority": "draft", "scope": "global", **body})
        assert r.status_code == 422 and r.json()["error"].startswith(f"{field} must be at most"), field
    r = await api.post("/api/v1/feedback", json={"retrieval_id": str(uuid.uuid4()), "verdict": "wrong", "note": "n" * 4001})
    assert r.status_code == 422 and r.json()["error"] == "note must be at most 4,000 characters."
    assert (await api.post("/api/v1/recall/preview", json={"query": "q" * 4001})).status_code == 422
    assert (await api.get("/api/v1/entries/apitest-long")).status_code == 404


async def test_text_the_database_cant_store_is_refused_up_front(api, conn):
    nul, lone = "a\u0000b", "a\ud800b"

    async def send(path, body, method="POST"):
        """httpx can't encode a lone surrogate. json.dumps escapes it, as a browser's JSON.stringify does."""
        return await api.request(method, path, content=json.dumps(body), headers={"content-type": "application/json"})

    for value in (nul, lone):
        r = await send("/api/v1/entries", {"id": "apitest-nul", "title": value, "body": "b", "pattern": "decisions",
                                           "authority": "draft", "scope": "global"})
        assert r.status_code == 422 and r.json() == {"error": "title has a character the database can't store."}
    for path, body in (("/api/v1/entries", {"id": "apitest-nul", "title": "t", "body": "b", "pattern": "decisions",
                                             "authority": "draft", "scope": "global",
                                             "links": [{"dst": nul, "type": "relates"}]}),
                       ("/api/v1/messages", {"to": "all", "body": "apitest " + nul}),
                       ("/api/v1/recall/preview", {"query": nul}),
                       ("/api/v1/entries/tea-zh/supersede", {"by": lone}),
                       ("/api/v1/feedback", {"retrieval_id": nul, "verdict": "wrong"})):
        r = await send(path, body)
        assert r.status_code == 422 and r.json()["error"].endswith("has a character the database can't store."), path
    for value in (nul, lone):
        r = await send("/api/v1/entries/tea-zh", {"evidence": value}, "PATCH")
        assert r.status_code == 422 and r.json() == {"error": "evidence has a character the database can't store."}
    assert (await send("/api/v1/entries", {"id": "apitest-nul", nul: "x"})).status_code == 422
    for url in ("/api/v1/entries?q=a%00b", "/api/v1/events?session_id=a%00b", "/api/v1/retrievals?q=%00"):
        r = await api.get(url)
        assert r.status_code == 400 and r.json()["error"].endswith("has a character the database can't store."), url
    for url in ("/api/v1/entries/a%00b", "/api/v1/sessions/a%00b", "/api/v1/entries/tea-zh/links/relates/a%00b"):
        r = await api.request("DELETE" if "links" in url else "GET", url)
        assert r.status_code == 400 and r.json()["error"].endswith("has a character the database can't store."), url
    cur = await conn.execute("select (select count(*) from entry where id like 'apitest-%') as e, "
                             "(select count(*) from message where body like 'apitest a%') as m")
    assert await cur.fetchone() == {"e": 0, "m": 0}


async def test_supersession_never_loops(api, conn):
    for x in ("a", "b", "c"):
        await make(api, f"apitest-cyc-{x}")
    # The links endpoint takes the same checks as /supersede and lands in the audit the same way.
    r = await api.post("/api/v1/entries/apitest-cyc-a/supersede", json={"by": "apitest-cyc-b"})
    assert r.status_code == 201
    r = await api.post("/api/v1/entries/apitest-cyc-a/links", json={"dst": "apitest-cyc-b", "type": "supersedes"})
    assert r.status_code == 409 and r.json()["error"] == (
        "That would make a supersession loop. apitest-cyc-b already leads to apitest-cyc-a.")
    r = await api.post("/api/v1/entries/apitest-cyc-c/links", json={"dst": "apitest-cyc-b", "type": "supersedes"})
    assert r.status_code == 201
    assert (await audit_rows(api, "entry:apitest-cyc-b"))[0]["action"] == "entry.supersede"
    # c supersedes b supersedes a. a superseding c would close the loop.
    r = await api.post("/api/v1/entries/apitest-cyc-c/supersede", json={"by": "apitest-cyc-a"})
    assert r.status_code == 409 and "loop" in r.json()["error"]
    cur = await conn.execute("select array_agg(id order by id) as ids from entry_current where id like 'apitest-cyc-%'")
    assert (await cur.fetchone())["ids"] == ["apitest-cyc-c"]


async def test_a_draft_never_supersedes_an_approved_entry(api):
    r = await api.post("/api/v1/entries/tea-oolong-temp/supersede", json={"by": "tea-draft-cold"})
    assert r.status_code == 422 and r.json()["error"] == "A draft cannot supersede an approved entry. Approve tea-draft-cold first."
    r = await api.post("/api/v1/entries/tea-draft-cold/links", json={"dst": "tea-zh", "type": "supersedes"})
    assert r.status_code == 422
    r = await api.post("/api/v1/entries", json={"id": "apitest-dr", "title": "t", "body": "b", "pattern": "decisions",
                                                "authority": "draft", "scope": "global",
                                                "links": [{"dst": "tea-zh", "type": "supersedes"}]})
    assert r.status_code == 422 and (await api.get("/api/v1/entries/apitest-dr")).status_code == 404
    # From the other side: authority changes that would break the rule.
    r = await api.patch("/api/v1/entries/tea-oolong-temp", json={"authority": "draft"})
    assert r.status_code == 422 and r.json()["error"] == "tea-oolong-temp supersedes an approved entry, so it can't be a draft."
    await make(api, "apitest-seen", authority="observed")
    await make(api, "apitest-guess", authority="draft")
    assert (await api.post("/api/v1/entries/apitest-seen/supersede", json={"by": "apitest-guess"})).status_code == 201
    r = await api.patch("/api/v1/entries/apitest-seen", json={"authority": "approved"})
    assert r.status_code == 422 and r.json()["error"] == "A draft supersedes apitest-seen, so it can't be approved."
    assert (await api.patch("/api/v1/entries/apitest-guess", json={"authority": "approved"})).status_code == 200
    assert (await api.patch("/api/v1/entries/apitest-seen", json={"authority": "approved"})).status_code == 200
