"""Against a real Postgres (pgvector and pg_jieba optional). Ollama is pointed at a dead port, so A1 runs keyword-only."""
import json
import uuid

import pytest

from kb import service
from kb.config import config
from kb.search import a0, a1

pytestmark = pytest.mark.asyncio


async def test_a1_serves_current_entries_only(conn):
    ranked, degraded = await a1(conn, "what temperature for oolong?")
    ids = [e for e, _, _ in ranked]
    assert "tea-oolong-temp" in ids and "tea-oolong-old" not in ids
    assert degraded


async def test_a0_shows_replaced_entries_struck_through(conn):
    ranked, _ = await a0(conn, "oolong temperature")
    lines = {e: line for e, _, line in ranked}
    assert "~~Brew oolong at 100C~~ → tea-oolong-temp" in lines["tea-oolong-old"]


async def test_chinese_query_finds_chinese_entry(conn):
    cur = await conn.execute("select exists (select 1 from pg_extension where extname = 'pg_jieba') as ok")
    if not (await cur.fetchone())["ok"]:
        pytest.skip("needs pg_jieba: the simple fallback cannot segment 中文")
    ranked, _ = await a1(conn, "乌龙茶")
    assert "tea-zh" in [e for e, _, _ in ranked]


async def test_session_keeps_its_arm(conn):
    sid = f"t-{uuid.uuid4()}"
    first = await service.session_arm(conn, sid)
    assert all([await service.session_arm(conn, sid) == first for _ in range(5)])
    assert first in config.arms


async def test_recall_logs_and_hides_private_text(conn):
    sid = f"t-{uuid.uuid4()}"
    await conn.execute("insert into kb_session (id, arm) values (%s, 'A1')", (sid,))
    text = await service.recall(conn, sid, "oolong supplier")
    rid = text.split()[1]
    assert "secret co" not in text
    cur = await conn.execute("select arm, delivered from retrieval where id = %s", (uuid.UUID(rid),))
    r = await cur.fetchone()
    assert r["arm"] == "A1" and r["delivered"]
    assert "secret co" not in await service.get_entry(conn, sid, "tea-supplier")


async def test_hook_ties_mcp_session_to_client_session(conn):
    sid = f"t-{uuid.uuid4()}"
    text = await service.recall(conn, sid, "oolong")
    await service.hook(conn, "PostToolUse", {"session_id": "claude-abc", "tool_name": "mcp__kb__recall",
                                             "tool_response": [{"type": "text", "text": text}]})
    cur = await conn.execute("select claude_session_id from kb_session where id = %s", (sid,))
    assert (await cur.fetchone())["claude_session_id"] == "claude-abc"


async def test_feedback_validates_inputs(conn):
    text = await service.recall(conn, f"t-{uuid.uuid4()}", "oolong")
    rid = text.split()[1]
    assert await service.feedback(conn, rid, "great") == "verdict must be helpful, irrelevant or wrong."
    assert (await service.feedback(conn, "not-a-uuid", "helpful")).startswith("No retrieval")
    assert await service.feedback(conn, rid, "irrelevant", "tea-zh") == "Logged."


async def test_schema_reapplies_cleanly(conn, db_url):
    import psycopg
    from conftest import MEMORY
    with psycopg.connect(db_url, autocommit=True) as c:
        c.execute((MEMORY / "db" / "schema.sql").read_text(encoding="utf-8"))
    cur = await conn.execute("select count(*) as n from link_type_weight")
    assert (await cur.fetchone())["n"] == 2  # decisions supersedes decisions, preferences relates decisions


async def test_english_query_skips_the_chinese_ranker(conn):
    from kb.search import a1_components
    parts, _ = await a1_components(conn, "oolong temperature")
    assert parts["zh"] == [] and parts["keyword"] == parts["en"]


async def test_search_text_carries_the_project_title(conn):
    cur = await conn.execute("select search_text from entry where id = 'tea-supplier'")
    assert "Tea brewing" in (await cur.fetchone())["search_text"]
