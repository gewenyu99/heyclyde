"""The write path against a real Postgres: remember, run scopes, supersession, blobs, the MCP tool and clyde-flow's routes.

Each test writes into a fresh run scope, and a fixture deletes every runtime entry afterwards, so test_db.py's counts
hold whatever order the files run in."""
import asyncio
import base64
import hashlib
import json
import random
import re
import uuid
from contextlib import asynccontextmanager
from dataclasses import replace

import httpx
import pytest
from mcp.server.fastmcp.exceptions import ToolError
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from kb import embed, search, server, service, write
from kb.config import config
from kb.server import BearerAuth, Credential

pytestmark = pytest.mark.asyncio
QUERY = "what temperature for oolong?"
AGENT = {"Authorization": "Bearer tok"}
RUNTIME = {"Authorization": "Bearer rt"}


@pytest.fixture(autouse=True)
async def forget_runtime_writes(conn):
    yield
    await conn.rollback()
    await conn.execute("delete from link where src in (select id from entry where origin = 'runtime') "
                       "or dst in (select id from entry where origin = 'runtime')")
    await conn.execute("delete from entry where origin = 'runtime'")
    await conn.execute("delete from blob b where not exists (select 1 from entry_blob x where x.sha256 = b.sha256)")
    await conn.execute("delete from source s where not exists (select 1 from entry e where e.source_id = s.id)")
    await conn.commit()


@pytest.fixture
async def pool(db_url):
    """A pool on the test database, as the server holds one. remember checks out its own connections from it."""
    p = AsyncConnectionPool(db_url, open=False, min_size=1, max_size=4, kwargs={"row_factory": dict_row})
    await p.open(wait=True)
    yield p
    await p.close()


def run_source(run):
    return {"kind": "run", "title": f"clyde {run}"}


def run_project(run):
    return {"id": run.replace(":", "-"), "pattern": "projects", "title": f"clyde {run}", "body": "A test run.",
            "authority": "observed", "scope": run, "evidence_kind": "summary", "evidence": "clyde started the run",
            "source": run_source(run)}


def note(run, **change):
    """A valid draft handoff note in the run, as an agent sends it. Each test changes the fields it is about."""
    return {"pattern": "observations", "title": "Gate evidence: oolong brewed", "body": "The brew test passed.",
            "authority": "draft", "scope": run, "evidence_kind": "summary", "evidence": "pytest passed",
            "project": run.replace(":", "-")} | change


def verdict(run, **change):
    """The runtime's observed verdict in the run, under the source clyde-flow names."""
    return note(run, title="Oolong gate verdict", authority="observed", source=run_source(run)) | change


async def new_run(pool):
    run = f"run:t{uuid.uuid4().hex[:8]}"
    await write.remember(pool, run_project(run), "runtime")
    return run


async def ids(arm, conn, scope=None):
    ranked, _ = await arm(conn, QUERY, scope)
    return [e for e, _, _ in ranked]


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


# ---------------------------------------------------------------- scope
async def test_scoped_recall_puts_the_run_entry_first_in_both_arms(conn, pool, monkeypatch):
    run = await new_run(pool)
    eid = (await write.remember(pool, note(run), "agent"))["id"]
    for arm in (search.index_search, search.hybrid_search):
        assert (await ids(arm, conn, run))[0] == eid
        assert eid not in await ids(arm, conn)
    # The words alone rank it below the seeded oolong entries, so the boost is what puts it first.
    monkeypatch.setattr(search, "config", replace(config, scope_boost=1.0))
    for arm in (search.index_search, search.hybrid_search):
        got = await ids(arm, conn, run)
        assert eid in got and got[0] != eid


async def test_recall_serves_a_run_entry_only_when_asked_and_logs_the_scope(conn, pool):
    run = await new_run(pool)
    eid = (await write.remember(pool, note(run), "agent"))["id"]
    for arm in ("index", "hybrid"):
        sid = f"t-{uuid.uuid4()}"
        await conn.execute("insert into kb_session (id, arm) values (%s, %s)", (sid, arm))
        assert eid in await service.recall(conn, sid, QUERY, scope=run)
        assert eid not in await service.recall(conn, sid, QUERY)
        cur = await conn.execute("select scope from retrieval where kb_session = %s order by created_at", (sid,))
        assert [r["scope"] for r in await cur.fetchall()] == [run, None]
    for scope in ("t123", run + "\n"):  # a run id read from a file keeps its newline
        with pytest.raises(write.Refused, match="must look like run:<id>"):
            await service.recall(conn, "t-bad-scope", QUERY, scope=scope)


async def test_a_run_never_sees_another_runs_entries(conn, pool):
    mine, theirs = await new_run(pool), await new_run(pool)
    a = (await write.remember(pool, note(mine), "agent"))["id"]
    b = (await write.remember(pool, note(theirs), "agent"))["id"]
    for arm in (search.index_search, search.hybrid_search):
        got = await ids(arm, conn, mine)
        assert a in got and b not in got


async def test_vector_recall_keeps_its_candidates_when_run_notes_crowd_the_index(conn, monkeypatch):
    if not await embed.has_vector(conn):
        pytest.skip("needs pgvector: without it hybrid never runs a vector query")
    rnd = random.Random(7)
    q = [rnd.gauss(0, 1) for _ in range(embed.DIM)]
    run = f"run:t{uuid.uuid4().hex[:8]}"
    # Run notes sit nearer the query than the global entries, so they fill the HNSW scan's first 40 candidates.
    rows = [(f"vec-global-{i}", "global", 0.9) for i in range(20)] + [(f"vec-run-{i}", run, 0.5) for i in range(60)]
    for eid, scope, spread in rows:
        await conn.execute(
            "insert into entry (id, pattern, title, body, authority, scope, sensitivity, lang, valid_from, source_id, "
            "evidence_kind, evidence, project, origin) values (%s, 'observations', 'v', 'v', 'observed', %s, 'normal', "
            "'en', current_date, 'src-a', 'summary', 'v', 'proj-tea', 'runtime')", (eid, scope))
        await conn.execute("insert into entry_embedding (entry_id, model, content_sha256, embedding) "
                           "values (%s, 'test', 'test', %s::vector)",
                           (eid, embed.to_pgvector([x + rnd.gauss(0, spread) for x in q])))
    await conn.commit()

    async def query_vector(query):
        return q
    monkeypatch.setattr(search, "query_vector", query_vector)
    # Postgres sorts a table this small in full. These make it take the HNSW index, as it does once kb holds thousands.
    await conn.execute("set local enable_seqscan = off")
    await conn.execute("set local enable_sort = off")
    got, _ = await search.vector_ranks(conn, QUERY)
    assert sorted(got) == sorted(e for e, scope, _ in rows if scope == "global")


# ---------------------------------------------------------------- supersession and ids
async def test_supersedes_hides_the_old_entry(conn, pool):
    run = await new_run(pool)
    old = (await write.remember(pool, note(run, title="Oolong gate failed", body="The brew test failed."), "agent"))["id"]
    new = (await write.remember(pool, note(run, title="Oolong gate passed", supersedes=[old]), "agent"))["id"]
    got = await ids(search.hybrid_search, conn, run)
    assert new in got and old not in got
    lines = {e: line for e, _, line in (await search.index_search(conn, QUERY, run))[0]}
    assert f"~~Oolong gate failed~~ → {new}" in lines[old]
    assert f"Replaced by: {new}" in await service.get_entry(conn, "t", old)
    cur = await conn.execute("select src, dst from link where type = 'supersedes' and src = %s", (new,))
    assert await cur.fetchall() == [{"src": new, "dst": old}]


async def test_index_never_boosts_a_replaced_note_over_its_replacement(conn, pool):
    run = await new_run(pool)
    old = (await write.remember(pool, note(run, title="Oolong gate failed", body="The brew test failed."), "agent"))["id"]
    new = (await write.remember(pool, note(run, title="Oolong gate passed", supersedes=[old]), "agent"))["id"]
    # The old line matches all three words, since it names its replacement too. The new one matches two.
    got = [e for e, _, _ in (await search.index_search(conn, "oolong gate failed", run))[0]]
    assert got.index(new) < got.index(old)


async def test_supersession_never_hides_an_entry_from_a_recall_that_could_see_it(conn, pool):
    mine, theirs = await new_run(pool), await new_run(pool)
    failed = (await write.remember(pool, verdict(mine, title="Oolong gate failed"), "runtime"))["id"]
    their_note = (await write.remember(pool, note(theirs), "agent"))["id"]
    for payload, caller, message in [
        (note(mine, title="Oolong gate passed", supersedes=[failed]), "agent",
         f"A draft entry can't supersede observed {failed}."),
        (note(mine, supersedes=[their_note]), "agent", f"can only supersede entries in {mine}, and {their_note} is in {theirs}."),
        (verdict(mine, supersedes=["tea-supplier"]), "runtime", f"can only supersede entries in {mine}, "
                                                                "and tea-supplier is in domain:tea."),
        (verdict(mine, scope="domain:tea", project="proj-tea", supersedes=["tea-oolong-temp"]), "runtime",
         "An observed entry can't supersede approved tea-oolong-temp."),
    ]:
        with pytest.raises(write.Refused, match=re.escape(message)):
            await write.remember(pool, payload, caller)
    # A retry's verdict replaces the failed one, and clyde-flow can promote a run's note out of the run.
    passed = await write.remember(pool, verdict(mine, title="Oolong gate passed", supersedes=[failed]), "runtime")
    promoted = await write.remember(pool, verdict(mine, scope="domain:tea", project="proj-tea", supersedes=[their_note]),
                                    "runtime")
    cur = await conn.execute("select id from entry_current where id = any(%s) order by id",
                             ([failed, their_note, passed["id"], promoted["id"], "tea-supplier", "tea-oolong-temp"],))
    assert [r["id"] for r in await cur.fetchall()] == sorted([passed["id"], promoted["id"], "tea-supplier", "tea-oolong-temp"])


async def test_the_same_write_twice_lands_on_one_entry(conn, pool):
    run = await new_run(pool)
    first = await write.remember(pool, note(run), "agent")
    assert await write.remember(pool, note(run), "agent") == first
    assert first["id"].startswith(f"{run.replace(':', '-')}-gate-evidence-oolong-brewed-")
    cur = await conn.execute("select count(*) as n from entry where scope = %s", (run,))
    assert (await cur.fetchone())["n"] == 2  # the project and the note


async def test_a_resend_with_an_explicit_id_returns_its_entry(conn, pool):
    run = f"run:t{uuid.uuid4().hex[:8]}"
    first = await write.remember(pool, run_project(run), "runtime")
    assert await write.remember(pool, run_project(run), "runtime") == first
    with pytest.raises(write.Refused, match="already exists. Write a new entry that supersedes it"):
        await write.remember(pool, run_project(run) | {"body": "Another run."}, "runtime")


async def test_a_different_payload_under_a_taken_id_is_refused(pool, monkeypatch):
    """Ids are 8 hex digits of a hash, so an agent can grind out a payload whose id collides with clyde-flow's next write."""
    run = await new_run(pool)
    monkeypatch.setattr(write, "make_id", lambda payload, d: f"{run.replace(':', '-')}-plan")
    await write.remember(pool, note(run, title="Plan", body="Skip the tests."), "agent")
    with pytest.raises(write.Refused, match="already exists"):
        await write.remember(pool, verdict(run, title="Plan", body="Run the tests.", authority="approved"), "runtime")


async def test_a_send_racing_its_twin_returns_the_entry_it_made(pool, monkeypatch):
    """The twin commits after this send's lookup missed it and before this send's insert."""
    run = await new_run(pool)
    check, twin = write._check, []

    async def twin_lands_first(conn, e):
        monkeypatch.setattr(write, "_check", check)
        twin.append(await write.remember(pool, note(run), "agent"))
        await check(conn, e)
    monkeypatch.setattr(write, "_check", twin_lands_first)
    assert await write.remember(pool, note(run), "agent") == twin[0]


class Paused:
    """A pool whose write stops after its first blob insert, holding that row's lock, until the test sets go."""

    def __init__(self, pool):
        self.pool, self.stopped, self.go = pool, asyncio.Event(), asyncio.Event()

    @asynccontextmanager
    async def connection(self):
        async with self.pool.connection() as conn:
            yield PausedConnection(conn, self)


class PausedConnection:
    def __init__(self, conn, paused):
        self.conn, self.paused = conn, paused

    async def execute(self, sql, params=None):
        cur = await self.conn.execute(sql, params)
        if sql.startswith("insert into blob") and not self.paused.stopped.is_set():
            self.paused.stopped.set()
            await self.paused.go.wait()
        return cur

    def __getattr__(self, name):
        return getattr(self.conn, name)


async def test_writers_attaching_two_new_blobs_in_opposite_orders_both_land(conn, pool):
    run = await new_run(pool)
    a, b = {"name": "a", "text": f"blob a {uuid.uuid4()}"}, {"name": "b", "text": f"blob b {uuid.uuid4()}"}
    first = Paused(pool)
    one = asyncio.create_task(write.remember(
        first, verdict(run, title="One", blobs=[a, b], source={"kind": "run", "title": "one"}), "runtime"))
    await asyncio.wait_for(first.stopped.wait(), 5)
    two = asyncio.create_task(write.remember(
        pool, verdict(run, title="Two", blobs=[b, a], source={"kind": "run", "title": "two"}), "runtime"))
    for _ in range(250):  # until the second writer waits on a row the first holds
        cur = await conn.execute("select count(*) as n from pg_locks where not granted")
        if (await cur.fetchone())["n"]:
            break
        await asyncio.sleep(0.02)
    else:
        pytest.fail("the second writer never waited on the first")
    first.go.set()
    one, two = await asyncio.wait_for(asyncio.gather(one, two), 10)
    assert {x["sha256"] for x in one["blobs"]} == {x["sha256"] for x in two["blobs"]} == {sha(a["text"]), sha(b["text"])}


async def test_a_new_entry_is_marked_runtime_and_searchable_by_its_project(conn, pool):
    run = await new_run(pool)
    eid = (await write.remember(pool, note(run), "agent"))["id"]
    cur = await conn.execute("select origin, project, search_text, created_at from entry where id = %s", (eid,))
    r = await cur.fetchone()
    assert r["origin"] == "runtime" and r["project"] == run.replace(":", "-") and r["created_at"]
    assert f"clyde {run}" in r["search_text"]
    cur = await conn.execute("select origin from entry where id = 'tea-oolong-temp'")
    assert (await cur.fetchone())["origin"] == "seed"


async def test_an_agent_write_is_recorded_as_an_agent_session(conn, pool):
    run = await new_run(pool)
    eid = (await write.remember(pool, note(run), "agent"))["id"]
    cur = await conn.execute("select s.kind, s.title from entry e join source s on s.id = e.source_id where e.id = %s",
                             (eid,))
    assert await cur.fetchone() == write.AGENT_SOURCE


async def test_an_embedding_failure_never_fails_the_write(conn, pool, monkeypatch):
    run = await new_run(pool)
    if not await embed.has_vector(conn):
        calls = []

        async def fake_embed(texts, client=None):
            calls.append(texts)
            raise AssertionError("no vector table, so nothing to embed")
        monkeypatch.setattr(embed, "embed", fake_embed)
        assert (await write.remember(pool, note(run), "agent"))["embedded"] is False
        assert calls == []
        monkeypatch.undo()

    async def has_vector(conn):
        return True
    monkeypatch.setattr(embed, "has_vector", has_vector)  # Ollama sits on a dead port, so embed() raises
    r = await write.remember(pool, note(run, title="Second note"), "agent")
    assert r["embedded"] is False
    cur = await conn.execute("select 1 from entry where id = %s", (r["id"],))
    assert await cur.fetchone()


async def test_a_slow_embedding_holds_no_connection(db_url, monkeypatch):
    """With one connection in the pool, a recall still gets it while Ollama works on the write's embedding."""
    one = AsyncConnectionPool(db_url, open=False, min_size=1, max_size=1, kwargs={"row_factory": dict_row})
    await one.open(wait=True)
    try:
        run = await new_run(one)
        recalled = []

        async def has_vector(conn):
            return True

        async def slow_embed(texts, client=None):
            async with one.connection(timeout=2) as conn:
                recalled.append(await service.recall(conn, f"t-{uuid.uuid4()}", QUERY))
            raise httpx.ConnectError("Ollama gave up")
        monkeypatch.setattr(embed, "has_vector", has_vector)
        monkeypatch.setattr(embed, "embed", slow_embed)
        assert (await write.remember(one, note(run), "agent"))["embedded"] is False
        assert recalled and recalled[0].startswith("retrieval ")
    finally:
        await one.close()


# ---------------------------------------------------------------- invariants the graph decides
@pytest.mark.parametrize("change, message", [
    ({"project": "no-such-project"},
     "Project no-such-project doesn't exist. Create the run's project entry first, with pattern projects and scope run:"),
    ({"scope": "domain:tea", "project": "no-such-project"}, "Project no-such-project doesn't exist."),
    ({"project": "tea-oolong-temp"}, "tea-oolong-temp is a decisions entry, not a project."),
    ({"links": [{"type": "supports", "to": "no-such-entry"}]}, "Dangling link: supports no-such-entry"),
    ({"supersedes": ["no-such-entry"]}, "Can't supersede no-such-entry: it doesn't exist."),
    ({"supersedes": ["tea-oolong-temp"]}, "A draft entry can't supersede approved tea-oolong-temp."),
    ({"source": {"id": "no-such-source"}}, "Source no-such-source is new, so it needs a kind and a title."),
    ({"id": "tea-oolong-temp"}, "Entry tea-oolong-temp already exists."),
])
async def test_the_graph_refuses_and_nothing_is_written(conn, pool, change, message):
    run = await new_run(pool)
    text = f"never stored {uuid.uuid4()}"
    with pytest.raises(write.Refused, match=re.escape(message)):
        await write.remember(pool, note(run, source=run_source(run), blobs=[{"name": "log", "text": text}]) | change,
                             "runtime")
    cur = await conn.execute("select (select count(*) from blob where sha256 = %s) as blobs, "
                             "(select count(*) from entry where scope = %s) as entries", (sha(text), run))
    assert await cur.fetchone() == {"blobs": 0, "entries": 1}


async def test_a_failure_partway_through_leaves_nothing_behind(conn, pool, monkeypatch):
    import psycopg

    async def no_check(conn, e):
        pass
    monkeypatch.setattr(write, "_check", no_check)  # so the dangling link fails at its insert, after the blob and entry
    run = await new_run(pool)
    text = f"never stored {uuid.uuid4()}"
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        await write.remember(pool, note(run, source={"kind": "run", "title": text}, blobs=[{"name": "log", "text": text}],
                                        links=[{"type": "supports", "to": "no-such-entry"}]), "runtime")
    cur = await conn.execute("select (select count(*) from blob where sha256 = %s) as blobs, "
                             "(select count(*) from source where title = %s) as sources, "
                             "(select count(*) from entry where scope = %s) as entries", (sha(text), text, run))
    assert await cur.fetchone() == {"blobs": 0, "sources": 0, "entries": 1}


async def test_an_existing_source_is_reused_and_a_new_one_is_stored(conn, pool):
    run = await new_run(pool)
    await write.remember(pool, note(run, source={"id": "src-a"}), "runtime")
    cur = await conn.execute("select title from source where id = 'src-a'")
    assert (await cur.fetchone())["title"] == "Test chat"
    cur = await conn.execute("select kind, uri from source where title = %s", (f"clyde {run}",))
    assert await cur.fetchall() == [{"kind": "run", "uri": None}]


# ---------------------------------------------------------------- blobs
async def test_blobs_are_stored_once_and_listed_on_the_entry(conn, pool):
    run = await new_run(pool)
    text = "# Gate evidence\n\npytest: 30 passed\n"
    a = await write.remember(pool, note(run, title="A", blobs=[{"name": "gate-evidence", "media_type": "text/markdown",
                                                                "text": text}]), "agent")
    b = await write.remember(pool, note(run, title="B", blobs=[{"name": "log", "text": text}]), "agent")
    assert a["blobs"] == [{"name": "gate-evidence", "sha256": sha(text)}]
    assert b["blobs"] == [{"name": "log", "sha256": sha(text)}]
    cur = await conn.execute("select media_type, size from blob where sha256 = %s", (sha(text),))
    assert await cur.fetchall() == [{"media_type": "text/markdown", "size": len(text.encode())}]
    page = await service.get_entry(conn, "t", a["id"])
    assert f"- gate-evidence: {sha(text)} · text/markdown · {len(text.encode())} bytes" in page
    assert "Open one with get_blob(sha256)" in page


async def test_get_blob_pages_characters(conn, pool):
    run = await new_run(pool)
    text = "".join(f"第{i}行 line {i}\n" for i in range(4000))  # 中文 makes characters and bytes differ
    await write.remember(pool, note(run, blobs=[{"name": "log", "text": text}]), "agent")
    first = await service.get_blob(conn, sha(text))
    assert first.endswith("\n\n" + text[:20000])
    assert f'Next page: get_blob("{sha(text)}", offset=20000)' in first
    last = await service.get_blob(conn, sha(text).upper(), offset=40000, limit=50000)
    assert last.endswith("\n\n" + text[40000:]) and "Next page" not in last
    assert f"characters 40000 to {len(text)} of {len(text)}" in last
    assert "past the end" in await service.get_blob(conn, sha(text), offset=len(text))
    assert "limit 1 or more" in await service.get_blob(conn, sha(text), limit=0)
    assert await service.get_blob(conn, "0" * 64) == f"No blob {'0' * 64}."


async def test_get_blob_says_so_for_binary_content(conn, pool):
    run = await new_run(pool)
    data = b"\x89PNG\r\n\x1a\n\x00\x00"
    r = await write.remember(pool, note(run, blobs=[{"name": "shot", "media_type": "image/png",
                                                     "base64": base64.b64encode(data).decode()}]), "agent")
    assert r["blobs"][0]["sha256"] == hashlib.sha256(data).hexdigest()
    text = await service.get_blob(conn, r["blobs"][0]["sha256"])
    assert "10 bytes of binary image/png" in text and "only pages text" in text


async def test_a_blob_only_private_entries_reach_stays_private(conn, pool):
    run = await new_run(pool)
    secret = "supplier invoice: secret co"
    await write.remember(pool, note(run, title="Private", sensitivity="private",
                                    blobs=[{"name": "invoice", "text": secret}]), "agent")
    assert await service.get_blob(conn, sha(secret)) == "[private blob: ask Wen]"
    await write.remember(pool, note(run, title="Public", blobs=[{"name": "invoice", "text": secret}]), "agent")
    assert secret in await service.get_blob(conn, sha(secret))


async def test_get_entry_counts_a_private_entrys_blobs_without_naming_them(conn, pool):
    """A short private blob, like an offer's base pay, can be guessed and checked against its sha256 offline."""
    run = await new_run(pool)
    secret = f"base: {random.randrange(10**6)}"
    r = await write.remember(pool, note(run, sensitivity="private", blobs=[{"name": "offer", "text": secret}]), "agent")
    page = await service.get_entry(conn, "t", r["id"])
    assert "Blobs: 1, private. Ask Wen." in page and sha(secret) not in page and "offer" not in page


# ---------------------------------------------------------------- the MCP tools
@pytest.fixture
def served(pool, monkeypatch):
    """The server module with its pool on the test database."""
    monkeypatch.setattr(server, "pool", pool)
    return server


async def tool(name, args):
    content, _ = await server.mcp.call_tool(name, args)
    return content[0].text


async def test_mcp_remember_writes_drafts_only_in_a_run(conn, served):
    run = await new_run(served.pool)
    args = {"pattern": "observations", "title": "Oolong gate passed", "body": "The brew test passed.", "scope": run,
            "evidence": "pytest passed", "project": run.replace(":", "-")}
    for authority in ("observed", "approved"):
        with pytest.raises(ToolError, match=f"authority {authority} is above draft"):
            await tool("remember", args | {"authority": authority})
    with pytest.raises(ToolError, match="An agent writes only in a run scope, run:<id>, not global"):
        await tool("remember", args | {"scope": "global"})
    text = await tool("remember", args | {"blobs": [{"name": "log", "text": "30 passed"}]})
    eid = re.match(r"Remembered (\S+)\.", text).group(1)
    assert f"Blob log: {sha('30 passed')}" in text
    cur = await conn.execute("select authority, evidence_kind from entry where id = %s", (eid,))
    assert await cur.fetchone() == {"authority": "draft", "evidence_kind": "summary"}
    assert (await tool("get_blob", {"sha256": sha("30 passed")})).endswith("\n\n30 passed")
    [remember] = [t for t in await server.mcp.list_tools() if t.name == "remember"]
    assert not {"source", "id"} & set(remember.inputSchema["properties"])


# ---------------------------------------------------------------- clyde-flow's HTTP routes
@pytest.fixture
async def http(served):
    app = BearerAuth(server.app.app, Credential("tok"), runtime=Credential("rt"), max_body=server.MAX_REQUEST_BYTES)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://kb") as client:
        yield client


async def test_http_routes_need_the_token(http):
    for method, path in [("POST", "/entries"), ("GET", "/entries/tea-zh"), ("GET", f"/blobs/{'0' * 64}"),
                         ("POST", "/recall")]:
        assert (await http.request(method, path)).status_code == 401
        assert (await http.request(method, path, headers={"Authorization": "Bearer nope"})).status_code == 401


async def test_http_write_read_and_recall(http):
    run = f"run:t{uuid.uuid4().hex[:8]}"
    assert (await http.post("/entries", json=run_project(run), headers=RUNTIME)).status_code == 200
    r = await http.post("/entries", json=verdict(run, blobs=[{"name": "verdict", "media_type": "text/markdown",
                                                               "text": "# Pass"}]), headers=RUNTIME)
    assert r.status_code == 200
    body = r.json()
    assert body["blobs"] == [{"name": "verdict", "sha256": sha("# Pass")}] and body["embedded"] is False

    r = await http.get(f"/entries/{body['id']}", headers=AGENT)
    assert r.status_code == 200 and "Oolong gate verdict" in r.text and sha("# Pass") in r.text
    assert (await http.get("/entries/no-such-entry", headers=AGENT)).status_code == 404

    r = await http.get(f"/blobs/{sha('# Pass')}", headers=AGENT)
    assert r.status_code == 200 and r.content == b"# Pass" and r.headers["content-type"].startswith("text/markdown")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert (await http.get(f"/blobs/{'0' * 64}", headers=AGENT)).status_code == 404

    r = await http.post("/recall", json={"query": QUERY, "task": "check the gate", "scope": run}, headers=RUNTIME)
    assert r.status_code == 200 and r.text.startswith("retrieval ") and body["id"] in r.text
    r = await http.post("/recall", json={"query": QUERY}, headers=RUNTIME)
    assert r.status_code == 200 and body["id"] not in r.text


async def test_http_writes_with_the_agent_token_as_an_agent(conn, http):
    """Every agent's shell holds KB_TOKEN, so curl to /entries gets no more than the remember tool does."""
    run = f"run:t{uuid.uuid4().hex[:8]}"
    r = await http.post("/entries", json=run_project(run), headers=AGENT)
    assert r.status_code == 400 and "authority observed is above draft" in r.json()["error"]
    assert "An agent can't name a source" in r.json()["error"] and "An agent can't choose an id" in r.json()["error"]
    assert (await http.post("/entries", json=run_project(run), headers=RUNTIME)).status_code == 200
    failed = (await http.post("/entries", json=verdict(run, title="Gate failed"), headers=RUNTIME)).json()["id"]
    r = await http.post("/entries", json=note(run, title="Gate passed", supersedes=[failed]), headers=AGENT)
    assert r.status_code == 400 and f"A draft entry can't supersede observed {failed}." in r.json()["error"]
    r = await http.post("/entries", json=note(run), headers=AGENT)
    assert r.status_code == 200
    cur = await conn.execute("select authority from entry where id = %s", (r.json()["id"],))
    assert (await cur.fetchone())["authority"] == "draft"


async def test_http_refuses_bad_input_with_the_reason(http):
    run = f"run:t{uuid.uuid4().hex[:8]}"
    r = await http.post("/entries", json=note(run), headers=AGENT)
    assert r.status_code == 400 and "Create the run's project entry first" in r.json()["error"]
    r = await http.post("/entries", json=run_project(run) | {"evidence_kind": "quote", "authority": "draft"}, headers=RUNTIME)
    assert r.status_code == 400 and r.json()["error"] == "A quote of Wen can't back a draft."
    assert (await http.post("/entries", content=b"not json", headers=RUNTIME)).status_code == 400
    assert (await http.post("/entries", json=["a list"], headers=RUNTIME)).status_code == 400
    assert (await http.post("/recall", json={"task": "no query"}, headers=RUNTIME)).status_code == 400
    r = await http.post("/recall", json={"query": QUERY, "scope": "t123"}, headers=RUNTIME)
    assert r.status_code == 400 and "run:<id>" in r.json()["error"]
    # Each of these used to reach Postgres or the encoder and come back as a 500 with no reason.
    for change, message in [({"blobs": [{"name": "log", "base64": "日志"}]}, "Blob log has base64 that doesn't decode."),
                            ({"title": "captured \x00 output"}, "title has a NUL character"),
                            ({"body": "half an emoji \ud83d"}, "body has a lone surrogate")]:
        r = await http.post("/entries", content=json.dumps(note(run) | change), headers=AGENT)
        assert r.status_code == 400 and message in r.json()["error"]


async def test_http_refuses_an_oversized_body_before_parsing_it(http):
    r = await http.post("/entries", content=b" " * (server.MAX_REQUEST_BYTES + 1), headers=RUNTIME)
    assert r.status_code == 413


async def test_http_redacts_a_private_blob(http):
    run = f"run:t{uuid.uuid4().hex[:8]}"
    await http.post("/entries", json=run_project(run), headers=RUNTIME)
    secret = f"secret co {uuid.uuid4()}"
    r = await http.post("/entries", json=note(run, sensitivity="private", blobs=[{"name": "invoice", "text": secret}]),
                        headers=AGENT)
    assert r.status_code == 200
    r = await http.get(f"/blobs/{sha(secret)}", headers=AGENT)
    assert r.status_code == 403 and secret not in r.text and r.json()["error"] == "[private blob: ask Wen]"
