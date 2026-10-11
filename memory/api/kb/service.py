"""What the MCP tools and hook endpoints do, independent of transport, so tests can call it directly."""
import json
import re
import secrets
import time
import uuid

from .config import config
from .search import ARMS, fetch_entries, pack, render_entry

RID = re.compile(r"retrieval ([0-9a-f-]{36})")


async def session_arm(conn, kb_session, client=None):
    """The session's arm, drawn once at random on first use. The agent and Wen never see it."""
    arm = secrets.choice(config.arms)
    cur = await conn.execute(
        "insert into kb_session (id, arm, client) values (%s, %s, %s) on conflict (id) do nothing returning arm",
        (kb_session, arm, client))
    row = await cur.fetchone()
    if row is None:
        cur = await conn.execute("select arm from kb_session where id = %s", (kb_session,))
        row = await cur.fetchone()
    return row["arm"]


async def rank_and_pack(conn, arm, query, task=""):
    """One arm's ranking and the packet recall delivers from it. Writes nothing, so the console can preview an arm."""
    ranked, degraded = await ARMS[arm](conn, f"{task}\n{query}".strip() if task else query)
    lines = all(line is not None for _, _, line in ranked)
    rows = {} if lines else await fetch_entries(conn, [eid for eid, _, _ in ranked[:config.packet_items * 2]])
    delivered, chunks = pack(ranked, rows)
    return ranked, degraded, delivered, chunks, lines


async def recall(conn, kb_session, query, task="", client=None):
    started = time.monotonic()
    arm = await session_arm(conn, kb_session, client)
    ranked, degraded, delivered, chunks, lines = await rank_and_pack(conn, arm, query, task)
    rid, text = uuid.uuid4(), packet_text(chunks, lines)
    await conn.execute(
        "insert into retrieval (id, kb_session, arm, query, task, candidates, delivered, latency_ms, degraded, packet) "
        "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (rid, kb_session, arm, query, task or None, json.dumps([{"id": e, "score": s} for e, s, _ in ranked]),
         json.dumps(delivered), int((time.monotonic() - started) * 1000), degraded, text))
    await conn.commit()
    return f"retrieval {rid}\n\n{text}"


def packet_text(chunks, lines):
    """What the agent reads under the retrieval id. The console's preview shows the same text."""
    if not chunks:
        return "Nothing in memory matches. Ask Wen rather than guessing."
    if lines:
        return "Index lines that match. Open any with get_entry(id).\n" + "\n".join(chunks)
    return "\n\n".join(chunks)


async def get_entry(conn, kb_session, entry_id):
    rows = await fetch_entries(conn, [entry_id])
    if entry_id not in rows:
        return f"No entry {entry_id}."
    cur = await conn.execute(
        "select 'to' as dir, l.type, l.dst as other, e.title from link l join entry e on e.id = l.dst where l.src = %(id)s "
        "union all select 'from', l.type, l.src, e.title from link l join entry e on e.id = l.src where l.dst = %(id)s "
        "order by 1, 2, 3", {"id": entry_id})
    links = await cur.fetchall()
    await conn.execute(
        "insert into event (session_id, event, payload) values (%s, 'get_entry', %s)",
        (kb_session, json.dumps({"entry_id": entry_id})))
    await conn.commit()
    return render_entry(rows[entry_id], links)


async def feedback(conn, retrieval_id, verdict, entry_id=None, note=None, source="agent"):
    """The agent's own report is logged and never moves weights alone."""
    if verdict not in ("helpful", "irrelevant", "wrong"):
        return "verdict must be helpful, irrelevant or wrong."
    try:
        rid = uuid.UUID(retrieval_id)
    except ValueError:
        return f"No retrieval {retrieval_id}."
    cur = await conn.execute("select 1 from retrieval where id = %s", (rid,))
    if await cur.fetchone() is None:
        return f"No retrieval {retrieval_id}."
    await conn.execute(
        "insert into feedback (retrieval_id, source, verdict, entry_id, note) values (%s, %s, %s, %s, %s)",
        (rid, source, verdict, entry_id, note))
    await conn.commit()
    return "Logged."


async def hook(conn, event, payload, agent=None):
    """Store a lifecycle hook payload, with the agent kb-hook names. A recall's PostToolUse also ties the MCP session to
    the client's session id."""
    event, payload, agent = no_nul(event), no_nul(payload), no_nul(agent)
    session_id = payload.get("session_id")
    await conn.execute(
        "insert into event (session_id, event, payload, agent) values (%s, %s, %s, %s)",
        (session_id, event, json.dumps(payload), agent))
    if event == "PostToolUse" and str(payload.get("tool_name", "")).endswith("recall") and session_id:
        m = RID.search(json.dumps(payload.get("tool_response", "")))
        if m:
            await conn.execute(
                "update kb_session set claude_session_id = %s where id = (select kb_session from retrieval where id = %s)",
                (session_id, uuid.UUID(m.group(1))))
    await conn.commit()


def no_nul(value):
    """Postgres text and jsonb refuse NUL, and one in a prompt or tool output would lose the whole event. Drop them."""
    if isinstance(value, str):
        return value.replace("\x00", "")
    if isinstance(value, dict):
        return {no_nul(k): no_nul(v) for k, v in value.items()}
    if isinstance(value, list):
        return [no_nul(v) for v in value]
    return value


def agent_name(client):
    """claude or codex from an MCP client name like claude-code or codex-mcp-client. Anything else keeps its own name."""
    c = (client or "").lower()
    return "claude" if "claude" in c else "codex" if "codex" in c else c or "agent"


AGENTS = ("claude", "codex", "all")


async def post_message(conn, sender, to, body):
    to, body = to.strip().lower(), body.strip()
    if to not in AGENTS or not body:
        return "Need a recipient (claude, codex or all) and a body."
    cur = await conn.execute(
        "insert into message (sender, recipient, body) values (%s, %s, %s) returning id", (sender, to, body))
    mid = (await cur.fetchone())["id"]
    await conn.commit()
    return f"Posted message {mid} to {to}."


async def read_messages(conn, me):
    """Unread messages for me or all, oldest first, as text, marked read for me only. One statement claims them, so
    two readers at once never get the same message."""
    cur = await conn.execute(
        "update message set read_by = array_append(read_by, %s) where id in ("
        "  select id from message where recipient in (%s, 'all') and sender <> %s and not (%s = any(read_by))"
        "  order by id limit 20 for update skip locked) "
        "returning id, sender, recipient, body, created_at",
        (me, me, me, me))
    rows = sorted(await cur.fetchall(), key=lambda r: r["id"])
    await conn.commit()
    if not rows:
        return ""
    lines = [f"- #{r['id']} from {r['sender']} to {r['recipient']} at {r['created_at']:%Y-%m-%d %H:%M} UTC: {r['body']}"
             for r in rows]
    return "Messages from your other agents (reply with post_message):\n" + "\n".join(lines) + "\n"
