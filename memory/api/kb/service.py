"""What the MCP tools and hook endpoints do, independent of transport, so tests can call it directly."""
import json
import re
import secrets
import time
import uuid

from .config import config
from .search import ARMS, fetch_entries, pack, render_entry
from .write import SCOPE_RE, Refused

RID = re.compile(r"retrieval ([0-9a-f-]{36})")
PRIVATE_BLOB = "[private blob: ask Wen]"
PAGE_MAX = 100_000


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


async def recall(conn, kb_session, query, task="", client=None, scope=None):
    """Search memory. With a scope like run:abc, that run's entries are candidates too and rank first."""
    if scope and not SCOPE_RE.fullmatch(scope):
        raise Refused(f"scope {scope!r} must look like run:<id>, or be left out.")
    started = time.monotonic()
    arm = await session_arm(conn, kb_session, client)
    ranked, degraded = await ARMS[arm](conn, f"{task}\n{query}".strip() if task else query, scope or None)
    lines = all(line is not None for _, _, line in ranked)
    rows = {} if lines else await fetch_entries(conn, [eid for eid, _, _ in ranked[:config.packet_items * 2]])
    delivered, chunks = pack(ranked, rows)
    rid = uuid.uuid4()
    await conn.execute(
        "insert into retrieval (id, kb_session, arm, query, task, scope, candidates, delivered, latency_ms, degraded) "
        "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (rid, kb_session, arm, query, task or None, scope or None, json.dumps([{"id": e, "score": s} for e, s, _ in ranked]),
         json.dumps(delivered), int((time.monotonic() - started) * 1000), degraded))
    await conn.commit()
    if not chunks:
        body = "Nothing in memory matches. Ask Wen rather than guessing."
    elif lines:
        body = "Index lines that match. Open any with get_entry(id).\n" + "\n".join(chunks)
    else:
        body = "\n\n".join(chunks)
    return f"retrieval {rid}\n\n{body}"


async def get_entry(conn, kb_session, entry_id):
    """The entry rendered for an agent, with its links and blobs. None when there is no such entry."""
    rows = await fetch_entries(conn, [entry_id])
    if entry_id not in rows:
        return None
    cur = await conn.execute(
        "select 'to' as dir, l.type, l.dst as other, e.title from link l join entry e on e.id = l.dst where l.src = %(id)s "
        "union all select 'from', l.type, l.src, e.title from link l join entry e on e.id = l.src where l.dst = %(id)s "
        "order by 1, 2, 3", {"id": entry_id})
    links = await cur.fetchall()
    cur = await conn.execute(
        "select x.name, x.sha256, b.media_type, b.size from entry_blob x join blob b on b.sha256 = x.sha256 "
        "where x.entry_id = %s order by x.name", (entry_id,))
    blobs = await cur.fetchall()
    await conn.execute(
        "insert into event (session_id, event, payload) values (%s, 'get_entry', %s)",
        (kb_session, json.dumps({"entry_id": entry_id})))
    await conn.commit()
    return render_entry(rows[entry_id], links, blobs)


async def read_blob(conn, sha):
    """The blob and whether some public entry attaches it. A blob only private entries reach stays on the Droplet,
    and so does one no entry reaches any more. None when kb has no such blob."""
    cur = await conn.execute(
        "select b.media_type, b.size, b.content, coalesce(bool_or(e.sensitivity <> 'private'), false) as public "
        "from blob b left join entry_blob x on x.sha256 = b.sha256 left join entry e on e.id = x.entry_id "
        "where b.sha256 = %s group by b.sha256", (sha.strip().lower(),))
    return await cur.fetchone()


async def get_blob(conn, sha, offset=0, limit=20000):
    """A blob's text, one page of characters at a time, with the call for the next page."""
    sha = sha.strip().lower()
    row = await read_blob(conn, sha)
    if row is None:
        return f"No blob {sha}."
    if not row["public"]:
        return PRIVATE_BLOB
    try:
        text = bytes(row["content"]).decode("utf-8")
    except UnicodeDecodeError:
        return f"Blob {sha} is {row['size']} bytes of binary {row['media_type']}. get_blob only pages text."
    if offset < 0 or limit < 1:
        return "offset must be 0 or more, and limit 1 or more."
    if offset and offset >= len(text):
        return f"Blob {sha} has {len(text)} characters, so offset {offset} is past the end."
    end = min(offset + min(limit, PAGE_MAX), len(text))
    head = f"Blob {sha}: {row['media_type']}, characters {offset} to {end} of {len(text)}."
    if end < len(text):
        head += f'\nNext page: get_blob("{sha}", offset={end})'
    return f"{head}\n\n{text[offset:end]}"


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


async def hook(conn, event, payload):
    """Store a lifecycle hook payload. A recall's PostToolUse also ties the MCP session to the client's session id."""
    session_id = payload.get("session_id")
    await conn.execute(
        "insert into event (session_id, event, payload) values (%s, %s, %s)",
        (session_id, event, json.dumps(payload)))
    if event == "PostToolUse" and str(payload.get("tool_name", "")).endswith("recall") and session_id:
        m = RID.search(json.dumps(payload.get("tool_response", "")))
        if m:
            await conn.execute(
                "update kb_session set claude_session_id = %s where id = (select kb_session from retrieval where id = %s)",
                (session_id, uuid.UUID(m.group(1))))
    await conn.commit()
