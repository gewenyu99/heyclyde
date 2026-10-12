"""What the management API does, independent of transport, so tests can call it directly.

This is Wen's own console behind his token, so private entries show in full. Every write lands with an admin_audit row
in the same transaction. SQL is built from fixed fragments only. Input always travels as a parameter."""
import asyncio
import hashlib
import json
import logging
import re
import time
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal

from psycopg import errors, sql

from . import service
from .config import config
from .embed import content_sha, entry_text, has_vector, pull_model, sync_embeddings
from .search import ARMS

log = logging.getLogger("kb")

ENTRY_ID = re.compile(r"[a-z0-9][a-z0-9-]{1,100}")
LINK_TYPE = re.compile(r"[a-z_]{2,40}")
PATTERN = re.compile(r"[a-z][a-z_-]{1,40}")
SCOPE = re.compile(r"global|domain:[a-z0-9-]+|repo:[A-Za-z0-9._/-]+")  # build.py's SCOPE_RE
LANG = re.compile(r"[A-Za-z]{2,8}([-_][A-Za-z0-9]{1,8})*")
AUTHORITIES = ("approved", "observed", "draft")
SENSITIVITIES = ("normal", "private")
EVIDENCE_KINDS = ("quote", "assistant", "summary", "memory")
AGENTS = ("claude", "codex")
FIELDS = ("title", "body", "pattern", "authority", "scope", "sensitivity", "lang", "valid_from", "source_id",
          "evidence_kind", "evidence", "project")
REQUIRED = ("id", "title", "body", "pattern", "authority", "scope")
NULLABLE = ("valid_from", "source_id", "evidence_kind", "evidence", "project")
HIDDEN = ("tsv_en", "tsv_zh", "search_text")
# The most characters a text field takes. Anything not named takes 200. api.MAX_BODY caps the whole body first.
MAX_LEN = {"title": 500, "body": 50000, "evidence": 50000, "note": 4000, "query": 4000, "task": 4000}
SUPERSEDED = "exists (select 1 from link s where s.dst = e.id and s.type = 'supersedes')"
SUPERSEDED_BY = "array(select s.src from link s where s.dst = e.id and s.type = 'supersedes' order by s.src)"
EVENT_SUMMARY = ("case v.event when 'UserPromptSubmit' then left(coalesce(v.payload->>'prompt', ''), 160) "
                 "when 'PostToolUse' then coalesce(v.payload->>'tool_name', '') else '' end")


class ApiError(Exception):
    """A refusal the API returns as {"error": error} with this status."""

    def __init__(self, status, error):
        super().__init__(error)
        self.status, self.error = status, error


def jsonable(o):
    """json.dumps default. Times go out as ISO 8601 with their offset."""
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    if isinstance(o, Decimal):
        return float(o)
    if isinstance(o, uuid.UUID):
        return str(o)
    raise TypeError(f"{type(o).__name__} is not JSON serializable")


def dumps(o):
    return json.dumps(o, default=jsonable, ensure_ascii=False)


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest() if text else None


def _n(n, one, many=None):
    return f"{n} {one if n == 1 else many or one + 's'}"


def _like(q):
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _where(clauses):
    return " where " + " and ".join(clauses) if clauses else ""


async def _one(conn, query, params=()):
    cur = await conn.execute(query, params)
    return await cur.fetchone()


async def _all(conn, query, params=()):
    cur = await conn.execute(query, params)
    return await cur.fetchall()


async def _page(conn, query, params, order, limit, offset):
    """One page of a list and the total it came from. query and order are fixed SQL."""
    total = (await _one(conn, f"select count(*) as n from ({query}) q", params))["n"]
    items = await _all(conn, f"{query} order by {order} limit %(limit)s offset %(offset)s",
                       dict(params, limit=limit, offset=offset))
    return {"items": items, "total": total, "limit": limit, "offset": offset}


async def _audit(conn, action, target, before=None, after=None):
    row = await _one(conn, "insert into admin_audit (action, target, before, after) values (%s, %s, %s, %s) returning id",
                     (action, target, None if before is None else dumps(before), None if after is None else dumps(after)))
    return row["id"]


# ---------------------------------------------------------------- dashboard
async def _embedding_counts(conn):
    """Current entries whose stored embedding matches their text now, by the same hash sync_embeddings checks."""
    vector = await has_vector(conn)
    rows = await _all(conn, "select e.id, e.title, e.body, e.evidence, e.search_text, "
                            + ("x.content_sha256 from entry_current e left join entry_embedding x on x.entry_id = e.id"
                               if vector else "null as content_sha256 from entry_current e"))
    fresh = sum(r["content_sha256"] == content_sha(entry_text(r)) for r in rows)
    return vector, {"embedded": fresh, "stale_or_missing": len(rows) - fresh}


# check_messages' rule: to a.name or to all, from someone else, not yet read by a.name.
UNREAD = "m.recipient in (a.name, 'all') and m.sender <> a.name and not (a.name = any(m.read_by))"


async def overview(conn, sync=None):
    """sync is the server's last embedding sync, running or done, or None before the first."""
    c = await _one(conn, (
        "select (select count(*) from entry_current) as entries, "
        f"(select count(*) from entry e where {SUPERSEDED}) as superseded, "
        "(select count(*) from entry where sensitivity = 'private') as private, "
        "(select count(*) from link) as links, (select count(*) from source) as sources, "
        "(select count(*) from entry where pattern = 'projects') as projects, (select count(*) from event) as events, "
        "(select count(distinct session_id) from event where event <> 'get_entry') as client_sessions, "
        "(select count(*) from kb_session) as mcp_sessions, (select count(*) from retrieval) as recalls, "
        "(select count(*) from feedback) as feedback, (select count(*) from message) as messages, "
        "(select max(received_at) from event) as last_event, "
        "(select max(received_at) from event where event <> 'get_entry') as last_hook, "
        "(select max(created_at) from retrieval) as last_recall, "
        "(select max(created_at) from message) as last_message, (select max(created_at) from feedback) as last_feedback, "
        f"(select count(*) from message m where exists (select 1 from unnest(%(agents)s::text[]) a(name) "
        f"where {UNREAD})) as unread_messages"), {"agents": list(AGENTS)})
    unread = await _all(conn, (
        f"select a.name, count(m.id) as n from unnest(%s::text[]) a(name) left join message m on {UNREAD} group by a.name"),
        (list(AGENTS),))
    vector, embeddings = await _embedding_counts(conn)
    last = {k: c.pop(f"last_{k}") for k in ("event", "hook", "recall", "message", "feedback")}
    return {"health": {"db": True, "arms": config.arms, "embedding_model": config.embed_model, "vector": vector,
                       "sync": sync},
            "counts": dict(c, unread={r["name"]: r["n"] for r in unread}), "embeddings": embeddings, "last": last}


DAILY = (("events", "event", "received_at"), ("recalls", "retrieval", "created_at"),
         ("feedback", "feedback", "created_at"), ("messages", "message", "created_at"))


async def activity(conn, days=14, tz="UTC"):
    """Counts per day in the time zone tz, oldest first, with empty days present. The console sends its own zone, so
    an evening's work lands on today's bar, not tomorrow's.

    tz must be a name Postgres lists. Postgres also takes POSIX strings like UTC+14 and reads their sign backwards, so
    those get a 400 instead of the wrong days."""
    if not await _one(conn, "select 1 from pg_timezone_names where name = %s", (tz,)):
        raise ApiError(400, "tz must be a time zone like America/New_York.")
    w = await _one(conn, "select (now() at time zone %(tz)s)::date - %(n)s::int + 1 as first", {"tz": tz, "n": days})
    p = {"tz": tz, "n": days, "first": w["first"]}
    since = "(%(first)s::timestamp at time zone %(tz)s)"
    ctes = ", ".join(f"n_{name} as (select ({col} at time zone %(tz)s)::date as day, count(*) as n from {table} "
                     f"where {col} >= {since} group by 1)" for name, table, col in DAILY)
    rows = await _all(conn, (
        f"with {ctes} select %(first)s::date + i as day, "
        + ", ".join(f"coalesce(n_{name}.n, 0) as {name}" for name, _, _ in DAILY)
        + " from generate_series(0, %(n)s::int - 1) i "
        + " ".join(f"left join n_{name} on n_{name}.day = %(first)s::date + i" for name, _, _ in DAILY) + " order by 1"), p)
    by_type = await _all(conn, "select event, count(*) as count, max(received_at) as last from event "
                               f"where received_at >= {since} group by event order by count desc, event", p)
    clients = await _all(conn, (
        "select coalesce(s.client, 'unknown') as client, count(distinct s.id) as sessions, count(r.id) as recalls, "
        "greatest(max(r.created_at), max(s.created_at)) as last from kb_session s "
        f"left join retrieval r on r.kb_session = s.id and r.created_at >= {since} "
        f"where s.created_at >= {since} or r.id is not null group by 1 order by last desc"), p)
    agents = await _all(conn, (
        "select coalesce(agent, 'unknown') as agent, count(*) as events, count(distinct session_id) as sessions, "
        f"max(received_at) as last from event where event <> 'get_entry' and received_at >= {since} "
        "group by 1 order by last desc"), p)
    return {"days": rows, "events_by_type": by_type, "clients": clients, "agents": agents}


async def meta(conn):
    patterns = await _all(conn, "select distinct pattern from entry where pattern is not null order by 1")
    types = await _all(conn, "select distinct type from link")
    return {"authorities": list(AUTHORITIES), "sensitivities": list(SENSITIVITIES),
            "patterns": [r["pattern"] for r in patterns],
            "link_types": sorted({r["type"] for r in types} | {"part_of", "relates", "supersedes"}),
            "projects": await _all(conn, "select id, title from entry where pattern = 'projects' order by title, id"),
            "sources": await _all(conn, "select id, kind, title, date from source order by date desc nulls last, id"),
            "arms": list(ARMS), "live_arms": config.arms}


# ---------------------------------------------------------------- entries
ENTRY_SORTS = {"id": "e.id", "title": "e.title, e.id", "valid_from": "e.valid_from desc nulls last, e.id",
               "updated": "updated desc nulls last, e.id"}
STATES = {"current": f"not {SUPERSEDED}", "superseded": SUPERSEDED, "all": None}


async def entries(conn, q=None, project=None, authority=None, pattern=None, sensitivity=None, superseded="current",
                  sort="id", limit=50, offset=0):
    where = [STATES[superseded]] if STATES[superseded] else []
    params = {}
    for col, val in (("project", project), ("authority", authority), ("pattern", pattern), ("sensitivity", sensitivity)):
        if val:
            where.append(f"e.{col} = %({col})s")
            params[col] = val
    if q:
        # Full text over the title and body only. The stored tsvectors also carry the project's title, so a word from
        # it would match every entry in the project.
        where.append("(e.id ilike %(like)s or e.title ilike %(like)s or e.body ilike %(like)s "
                     "or to_tsvector('english', concat_ws(' ', e.title, e.body)) @@ plainto_tsquery('english', %(q)s) "
                     "or to_tsvector('kb_zh', concat_ws(' ', e.title, e.body)) @@ plainto_tsquery('kb_zh', %(q)s))")
        params.update(q=q, like=_like(q))
    query = ("select e.id, e.title, e.pattern, e.authority, e.scope, e.sensitivity, e.lang, e.valid_from, e.project, "
             f"p.title as project_title, {SUPERSEDED_BY} as superseded_by, "
             "(select count(*) from link l where l.src = e.id or l.dst = e.id) as links, "
             "(select count(*) from retrieval r where r.delivered ? e.id) as delivered, "
             "(select max(a.at) from admin_audit a where a.target = 'entry:' || e.id) as updated "
             "from entry e left join entry p on p.id = e.project" + _where(where))
    return await _page(conn, query, params, ENTRY_SORTS[sort], limit, offset)


async def _row(conn, eid):
    row = await _one(conn, "select * from entry where id = %s", (eid,))
    if row is None:
        raise ApiError(404, f"No entry {eid}.")
    return {k: v for k, v in row.items() if k not in HIDDEN}


async def entry(conn, eid):
    row = await _one(conn, "select e.*, p.title as project_title from entry e left join entry p on p.id = e.project "
                           "where e.id = %s", (eid,))
    if row is None:
        raise ApiError(404, f"No entry {eid}.")
    embedding = None
    if await has_vector(conn):
        embedding = await _one(conn, "select model, updated_at, content_sha256 from entry_embedding where entry_id = %s",
                               (eid,))
        if embedding:
            embedding["fresh"] = embedding.pop("content_sha256") == content_sha(entry_text(row))
    out = await _all(conn, "select l.type, l.dst, d.title, d.authority from link l join entry d on d.id = l.dst "
                           "where l.src = %s order by l.type, l.dst", (eid,))
    into = await _all(conn, "select l.type, l.src, s.title, s.authority from link l join entry s on s.id = l.src "
                            "where l.dst = %s order by l.type, l.src", (eid,))
    usage = await _one(conn, (
        "select (select count(*) from retrieval where delivered ? %(id)s) as delivered, "
        "(select count(*) from retrieval where candidates @> %(cand)s::jsonb) as candidate, "
        "(select max(created_at) from retrieval where delivered ? %(id)s) as last_delivered"),
        {"id": eid, "cand": json.dumps([{"id": eid}])})
    usage["feedback"] = await _all(conn, "select verdict, source, note, created_at, retrieval_id from feedback "
                                         "where entry_id = %s order by created_at desc limit 100", (eid,))
    by = [l["src"] for l in into if l["type"] == "supersedes"]
    source = await _one(conn, "select * from source where id = %s", (row["source_id"],)) if row["source_id"] else None
    return {"entry": {k: v for k, v in row.items() if k not in HIDDEN}, "source": source,
            "links_out": out, "links_in": into, "superseded_by": by,
            "supersedes": [l["dst"] for l in out if l["type"] == "supersedes"], "current": not by,
            "embedding": embedding, "usage": usage}


def _is_date(v):
    try:
        date.fromisoformat(v)
        return True
    except ValueError:
        return False


VALID = {
    "title": (lambda v: bool(v.strip()), "title cannot be empty."),
    "body": (lambda v: bool(v.strip()), "body cannot be empty."),
    "pattern": (PATTERN.fullmatch, "pattern must be a lowercase word like decisions."),
    "authority": (lambda v: v in AUTHORITIES, "authority must be approved, observed or draft."),
    "scope": (SCOPE.fullmatch, "scope must be global, domain:<name> or repo:<path>."),
    "sensitivity": (lambda v: v in SENSITIVITIES, "sensitivity must be normal or private."),
    "lang": (LANG.fullmatch, "lang must be a language code like en or zh."),
    "valid_from": (_is_date, "valid_from must be a date like 2026-10-10."),
    "evidence_kind": (lambda v: v in EVIDENCE_KINDS, "evidence_kind must be quote, assistant, summary or memory."),
}


def _short_enough(k, v):
    if len(v) > MAX_LEN.get(k, 200):
        raise ApiError(422, f"{k} must be at most {MAX_LEN.get(k, 200):,} characters.")


def _fields(data):
    """Type and format checks on writable entry fields. An empty string clears a nullable field."""
    out = {}
    for k, v in data.items():
        if k in NULLABLE and v in (None, ""):
            out[k] = None
            continue
        if not isinstance(v, str):
            raise ApiError(422, f"{k} must be a string.")
        _short_enough(k, v)
        ok, error = VALID.get(k, (bool, f"{k} cannot be empty."))
        if not ok(v):
            raise ApiError(422, error)
        out[k] = date.fromisoformat(v) if k == "valid_from" else v.strip() if k == "title" else v
    if "evidence" in out:
        out["evidence_sha256"] = sha(out["evidence"])
    return out


async def _check_refs(conn, eid, fields):
    if fields.get("source_id") and not await _one(conn, "select 1 from source where id = %s", (fields["source_id"],)):
        raise ApiError(422, f"No source {fields['source_id']}.")
    project = fields.get("project")
    if project and project != eid:
        row = await _one(conn, "select pattern from entry where id = %s", (project,))
        if row is None:
            raise ApiError(422, f"No project {project}.")
        if row["pattern"] != "projects":
            raise ApiError(422, f"{project} is not a project.")


def _link(src, dst, type_):
    if not isinstance(type_, str) or not LINK_TYPE.fullmatch(type_):
        raise ApiError(422, "type must be 2 to 40 lowercase letters or underscores.")
    if not isinstance(dst, str) or not dst or len(dst) > 200:
        raise ApiError(422, "dst must be an entry id.")
    if dst == src:
        raise ApiError(422, "An entry cannot link to itself.")
    return {"src": src, "dst": dst, "type": type_}


async def _check_dsts(conn, ids):
    found = {r["id"] for r in await _all(conn, "select id from entry where id = any(%s)", (list(ids),))}
    missing = sorted(set(ids) - found)
    if missing:
        raise ApiError(422, f"No entry {missing[0]} to link to.")


async def _check_supersedes(conn, by, old, authority=None):
    """seed/build.py's two rules for `by` supersedes `old`. Supersession never loops, since entry_current would hide
    every entry in the loop. A draft never supersedes an approved entry. authority stands in for by's own when by is
    not stored yet."""
    if await _one(conn, (
            "with recursive down(id) as (select %(old)s::text union "
            "select l.dst from link l join down on l.src = down.id where l.type = 'supersedes') "
            "select 1 from down where id = %(by)s"), {"old": old, "by": by}):
        raise ApiError(409, f"That would make a supersession loop. {old} already leads to {by}.")
    rows = {r["id"]: r["authority"] for r in await _all(conn, "select id, authority from entry where id = any(%s)",
                                                        ([by, old],))}
    if (authority or rows.get(by)) == "draft" and rows.get(old) == "approved":
        raise ApiError(422, f"A draft cannot supersede an approved entry. Approve {by} first.")


async def _check_authority(conn, eid, authority):
    """The draft rule from the other side. An entry that supersedes an approved one can't become a draft, and one a
    draft supersedes can't become approved."""
    if authority == "draft" and await _one(conn, (
            "select 1 from link l join entry o on o.id = l.dst where l.src = %s and l.type = 'supersedes' "
            "and o.authority = 'approved'"), (eid,)):
        raise ApiError(422, f"{eid} supersedes an approved entry, so it can't be a draft.")
    if authority == "approved" and await _one(conn, (
            "select 1 from link l join entry n on n.id = l.src where l.dst = %s and l.type = 'supersedes' "
            "and n.authority = 'draft'"), (eid,)):
        raise ApiError(422, f"A draft supersedes {eid}, so it can't be approved.")


async def create_entry(conn, data):
    """The vault's rule holds here too: an entry in a project is part_of it, so the link comes with the project."""
    unknown = set(data) - {"id", "links", *FIELDS}
    if unknown:
        raise ApiError(422, f"Unknown fields: {', '.join(sorted(unknown))}.")
    missing = [k for k in REQUIRED if data.get(k) in (None, "")]
    if missing:
        raise ApiError(422, f"Missing {', '.join(missing)}.")
    eid = data["id"]
    if not isinstance(eid, str) or not ENTRY_ID.fullmatch(eid):
        raise ApiError(422, "id must be 2 to 101 lowercase letters, digits or dashes, and start with a letter or digit.")
    fields = _fields({"sensitivity": "normal", "lang": "en", **{k: data[k] for k in FIELDS if k in data}})
    fields["valid_from"] = fields.get("valid_from") or datetime.now(timezone.utc).date()
    fields.setdefault("evidence_sha256", None)
    if fields.get("project") is None and fields["pattern"] == "projects":
        fields["project"] = eid
    links = data.get("links") or []
    if not isinstance(links, list) or not all(isinstance(l, dict) for l in links):
        raise ApiError(422, "links must be a list of {dst, type}.")
    links = [_link(eid, l.get("dst"), l.get("type")) for l in links]
    if fields.get("project") not in (None, eid):
        links.append({"src": eid, "dst": fields["project"], "type": "part_of"})
    links = list({(l["dst"], l["type"]): l for l in links}.values())
    if await _one(conn, "select 1 from entry where id = %s", (eid,)):
        raise ApiError(409, f"Entry {eid} already exists.")
    await _check_refs(conn, eid, fields)
    await _check_dsts(conn, {l["dst"] for l in links})
    for l in links:
        if l["type"] == "supersedes":
            await _check_supersedes(conn, eid, l["dst"], fields["authority"])
    cols = ["id", *fields]
    try:
        await conn.execute(sql.SQL("insert into entry ({}) values ({})").format(
            sql.SQL(", ").join(map(sql.Identifier, cols)), sql.SQL(", ").join(sql.Placeholder() * len(cols))),
            [eid, *fields.values()])
    except errors.UniqueViolation:
        raise ApiError(409, f"Entry {eid} already exists.") from None
    for l in links:
        await conn.execute("insert into link (src, dst, type) values (%s, %s, %s)", (l["src"], l["dst"], l["type"]))
    await _audit(conn, "entry.create", f"entry:{eid}", None, dict(await _row(conn, eid), links=links))
    await conn.commit()
    return await entry(conn, eid)


async def update_entry(conn, eid, data):
    """Moving an entry to another project moves its part_of link too. Renaming a project refreshes the search text of
    the entries in it, since theirs carries its title."""
    unknown = set(data) - set(FIELDS)
    if unknown:
        raise ApiError(422, f"Unknown fields: {', '.join(sorted(unknown))}.")
    if not data:
        raise ApiError(422, "Nothing to change.")
    before = await _row(conn, eid)
    fields = _fields(data)
    await _check_refs(conn, eid, fields)
    if fields.get("authority") not in (None, before["authority"]):
        await _check_authority(conn, eid, fields["authority"])
    await conn.execute(sql.SQL("update entry set {} where id = %s").format(
        sql.SQL(", ").join(sql.SQL("{} = %s").format(sql.Identifier(k)) for k in fields)), [*fields.values(), eid])
    if "project" in fields and fields["project"] != before["project"]:
        await conn.execute("delete from link where src = %s and dst = %s and type = 'part_of'", (eid, before["project"]))
        if fields["project"] not in (None, eid):
            await conn.execute("insert into link (src, dst, type) values (%s, %s, 'part_of') on conflict do nothing",
                               (eid, fields["project"]))
    if "title" in fields:
        await conn.execute("update entry set title = title where project = %s and id <> %s", (eid, eid))
    after = await _row(conn, eid)
    await _audit(conn, "entry.update", f"entry:{eid}", {k: before[k] for k in fields}, {k: after[k] for k in fields})
    await conn.commit()
    return await entry(conn, eid)


async def delete_entry(conn, eid):
    """Only an entry nothing points at goes. One that was ever delivered stays as evidence of what an agent saw."""
    before = await _row(conn, eid)
    c = await _one(conn, (
        "select (select count(*) from link where src = %(id)s or dst = %(id)s) as links, "
        "(select count(*) from retrieval where delivered ? %(id)s) as delivered, "
        "(select count(*) from entry where project = %(id)s and id <> %(id)s) as members, "
        "(select count(*) from qrel where entry_id = %(id)s) as qrels"), {"id": eid})
    if c["links"]:
        raise ApiError(409, f"{eid} still has {_n(c['links'], 'link')}. Remove the links first.")
    if c["delivered"]:
        raise ApiError(409, f"{eid} was delivered in {_n(c['delivered'], 'recall')}. Supersede it instead.")
    if c["members"]:
        raise ApiError(409, f"{eid} is still the project of {_n(c['members'], 'entry', 'entries')}.")
    if c["qrels"]:
        raise ApiError(409, f"{eid} is graded in the retrieval eval.")
    await _audit(conn, "entry.delete", f"entry:{eid}", before, None)
    try:
        await conn.execute("delete from entry where id = %s", (eid,))
    except errors.ForeignKeyViolation:
        raise ApiError(409, f"Something still references {eid}.") from None
    await conn.commit()
    return {"deleted": eid}


async def add_link(conn, src, dst, type_):
    """A supersedes link takes supersede()'s checks and lands in the audit as entry.supersede, the same as there."""
    await _row(conn, src)
    link = _link(src, dst, type_)
    await _check_dsts(conn, {dst})
    if type_ == "supersedes":
        await _check_supersedes(conn, src, dst)
    if not await _one(conn, "insert into link (src, dst, type) values (%s, %s, %s) on conflict do nothing returning src",
                      (src, dst, type_)):
        raise ApiError(409, f"{src} already has a {type_} link to {dst}.")
    if type_ == "supersedes":
        await _audit(conn, "entry.supersede", f"entry:{dst}", None, link)
    else:
        await _audit(conn, "link.create", f"entry:{src}", None, link)
    await conn.commit()
    return link


async def delete_link(conn, src, type_, dst):
    link = await _one(conn, "delete from link where src = %s and dst = %s and type = %s returning src, dst, type",
                      (src, dst, type_))
    if link is None:
        raise ApiError(404, f"No {type_} link from {src} to {dst}.")
    await _audit(conn, "link.delete", f"entry:{src}", link, None)
    await conn.commit()
    return {"deleted": link}


async def supersede(conn, eid, by):
    await _row(conn, eid)
    if not isinstance(by, str) or not by:
        raise ApiError(422, "by must be the id of the entry that replaces this one.")
    if by == eid:
        raise ApiError(422, "An entry cannot supersede itself.")
    if len(by) > 200:
        raise ApiError(422, "by must be the id of the entry that replaces this one.")
    link = {"src": by, "dst": eid, "type": "supersedes"}
    await _check_dsts(conn, {by})
    await _check_supersedes(conn, by, eid)
    if not await _one(conn, "insert into link (src, dst, type) values (%s, %s, 'supersedes') on conflict do nothing "
                            "returning src", (by, eid)):
        raise ApiError(409, f"{by} already supersedes {eid}.")
    await _audit(conn, "entry.supersede", f"entry:{eid}", None, link)
    await conn.commit()
    return await entry(conn, eid)


async def graph(conn, project=None, include_superseded=False):
    where = [] if include_superseded else [f"not {SUPERSEDED}"]
    if project:
        where.append("e.project = %(project)s")
    nodes = await _all(conn, (
        "select e.id, e.title, e.authority, e.pattern, e.project, p.title as project_title, "
        f"e.sensitivity = 'private' as private, not {SUPERSEDED} as current "
        "from entry e left join entry p on p.id = e.project" + _where(where) + " order by e.id"), {"project": project})
    ids = [n["id"] for n in nodes]
    links = await _all(conn, "select src, dst, type from link where src = any(%(ids)s) and dst = any(%(ids)s) "
                             "order by src, dst, type", {"ids": ids})
    return {"nodes": nodes, "links": links}


# ---------------------------------------------------------------- sessions, events, retrievals
async def sessions(conn, client=None, arm=None, limit=50, offset=0):
    where = [c for c, v in (("s.client = %(client)s", client), ("s.arm = %(arm)s", arm)) if v]
    query = ("select s.id, s.arm, s.client, s.claude_session_id, s.created_at, "
             "(select count(*) from retrieval r where r.kb_session = s.id) as recalls, "
             "(select max(r.created_at) from retrieval r where r.kb_session = s.id) as last_recall, "
             "(select count(*) from event v where v.session_id = s.claude_session_id) as events "
             "from kb_session s" + _where(where))
    return await _page(conn, query, {"client": client, "arm": arm}, "s.created_at desc, s.id", limit, offset)


async def session(conn, sid):
    """One MCP session's story: its recalls, its get_entry opens, its feedback, and the hook events of the client
    session it is tied to."""
    row = await _one(conn, "select * from kb_session where id = %s", (sid,))
    if row is None:
        raise ApiError(404, f"No session {sid}.")
    timeline = [{"kind": "recall", "at": r["created_at"], "id": str(r["id"]), "summary": r["query"], "arm": r["arm"],
                 "task": r["task"], "delivered": r["delivered"], "latency_ms": r["latency_ms"], "degraded": r["degraded"]}
                for r in await _all(conn, "select * from retrieval where kb_session = %s", (sid,))]
    for v in await _all(conn, f"select v.id, v.event, v.received_at, v.payload->>'tool_name' as tool_name, "
                              f"v.payload->>'entry_id' as entry_id, {EVENT_SUMMARY} as summary from event v "
                              "where v.session_id = any(%s)", ([s for s in (sid, row["claude_session_id"]) if s],)):
        opened = v["event"] == "get_entry"
        timeline.append({"kind": "get_entry" if opened else "event", "at": v["received_at"], "id": str(v["id"]),
                         "summary": v["entry_id"] if opened else v["summary"], "event": v["event"],
                         "tool_name": v["tool_name"], "entry_id": v["entry_id"]})
    for f in await _all(conn, "select f.* from feedback f join retrieval r on r.id = f.retrieval_id "
                              "where r.kb_session = %s", (sid,)):
        said = f["verdict"] + (f" on {f['entry_id']}" if f["entry_id"] else "") + (f": {f['note']}" if f["note"] else "")
        timeline.append({"kind": "feedback", "at": f["created_at"], "id": str(f["id"]), "summary": said,
                         "verdict": f["verdict"], "source": f["source"], "retrieval_id": f["retrieval_id"],
                         "entry_id": f["entry_id"], "note": f["note"]})
    return {"session": row, "timeline": sorted(timeline, key=lambda t: (t["at"], t["id"]))}


async def events(conn, event=None, session_id=None, agent=None, since=None, limit=50, offset=0):
    """agent is what kb-hook reported, claude or codex. Events from before it reported one have none."""
    where = [c for c, v in (("v.event = %(event)s", event), ("v.session_id = %(session_id)s", session_id),
                            ("v.agent = %(agent)s", agent), ("v.received_at >= %(since)s", since)) if v]
    query = ("select v.id, v.event, v.session_id, v.agent, v.received_at, v.payload->>'cwd' as cwd, "
             f"v.payload->>'tool_name' as tool_name, {EVENT_SUMMARY} as summary from event v" + _where(where))
    return await _page(conn, query, {"event": event, "session_id": session_id, "agent": agent, "since": since},
                       "v.received_at desc, v.id desc", limit, offset)


async def event(conn, event_id):
    """Event ids are whole numbers. Anything else is a missing event, the same as retrieval() treats a bad UUID."""
    row = None
    if re.fullmatch(r"[0-9]{1,18}", str(event_id)):
        row = await _one(conn, "select id, event, session_id, agent, received_at, payload from event where id = %s",
                         (int(event_id),))
    if row is None:
        raise ApiError(404, f"No event {event_id}.")
    return {"event": row}


async def retrievals(conn, arm=None, client=None, q=None, limit=50, offset=0):
    where = [c for c, v in (("r.arm = %(arm)s", arm), ("s.client = %(client)s", client),
                            ("(r.query ilike %(like)s or r.task ilike %(like)s)", q)) if v]
    query = ("select r.id, r.created_at, r.arm, s.client, r.kb_session, r.query, r.task, "
             "jsonb_array_length(r.delivered) as delivered_count, r.latency_ms, r.degraded, "
             "(select count(*) from feedback f where f.retrieval_id = r.id) as feedback "
             "from retrieval r left join kb_session s on s.id = r.kb_session" + _where(where))
    return await _page(conn, query, {"arm": arm, "client": client, "like": _like(q or "")},
                       "r.created_at desc, r.id", limit, offset)


async def _titles(conn, ids):
    """Title, authority and what supersedes each entry now. A recall's candidates show today's state, since the store
    keeps no history of it."""
    return {r["id"]: r for r in await _all(conn, f"select e.id, e.title, e.authority, {SUPERSEDED_BY} as superseded_by "
                                                 "from entry e where e.id = any(%s)", (list(ids),))}


def _known(rows, eid):
    r = rows.get(eid, {})
    by = r.get("superseded_by") or []
    return {"title": r.get("title"), "authority": r.get("authority"), "superseded_by": by, "current": not by}


async def retrieval(conn, rid):
    try:
        key = uuid.UUID(rid)
    except ValueError:
        raise ApiError(404, f"No retrieval {rid}.") from None
    row = await _one(conn, "select r.*, s.client from retrieval r left join kb_session s on s.id = r.kb_session "
                           "where r.id = %s", (key,))
    if row is None:
        raise ApiError(404, f"No retrieval {rid}.")
    client = row.pop("client")
    titles = await _titles(conn, [c["id"] for c in row["candidates"]])
    delivered = set(row["delivered"])
    candidates = [{"rank": i, "id": c["id"], "score": c["score"], **_known(titles, c["id"]), "delivered": c["id"] in delivered,
                   "exists": c["id"] in titles} for i, c in enumerate(row["candidates"], 1)]
    feedback = await _all(conn, "select id, source, verdict, entry_id, note, created_at from feedback "
                                "where retrieval_id = %s order by created_at, id", (key,))
    return {"retrieval": row, "client": client, "candidates": candidates, "feedback": feedback}


async def feedback_list(conn, verdict=None, source=None, limit=50, offset=0):
    where = [c for c, v in (("f.verdict = %(verdict)s", verdict), ("f.source = %(source)s", source)) if v]
    query = ("select f.id, f.retrieval_id, f.source, f.verdict, f.entry_id, f.note, f.created_at, r.query "
             "from feedback f left join retrieval r on r.id = f.retrieval_id" + _where(where))
    return await _page(conn, query, {"verdict": verdict, "source": source}, "f.created_at desc, f.id desc", limit, offset)


def _optional_text(data, *keys):
    for k in keys:
        if data.get(k) is not None:
            if not isinstance(data[k], str):
                raise ApiError(422, f"{k} must be a string.")
            _short_enough(k, data[k])
    return [data.get(k) or None for k in keys]


async def add_feedback(conn, data):
    """Wen's own verdict, logged through the same path as the agent's, with source wen."""
    retrieval_id, verdict, entry_id, note = _optional_text(data, "retrieval_id", "verdict", "entry_id", "note")
    if not retrieval_id or not verdict:
        raise ApiError(422, "Need a retrieval_id and a verdict.")
    await _audit(conn, "feedback.create", f"retrieval:{retrieval_id}", None,
                 {"verdict": verdict, "entry_id": entry_id, "note": note})
    said = await service.feedback(conn, retrieval_id, verdict, entry_id, note, source="wen")
    if said != "Logged.":
        await conn.rollback()
        raise ApiError(422, said)
    return {"ok": True}


async def messages(conn, limit=50, offset=0):
    """The whole board, newest first. Reading here marks nothing read, so the agents still get their mail."""
    return await _page(conn, "select id, created_at, sender, recipient, body, read_by from message", {},
                       "id desc", limit, offset)


async def add_message(conn, data):
    to, body = _optional_text(data, "to", "body")
    aid = await _audit(conn, "message.create", "message", None, {"to": to, "body": body})
    said = await service.post_message(conn, "wen", to or "", body or "")
    m = re.fullmatch(r"Posted message (\d+) to (\w+)\.", said)
    if not m:
        await conn.rollback()
        raise ApiError(422, said)
    await conn.execute("update admin_audit set target = %s where id = %s", (f"message:{m[1]}", aid))
    await conn.commit()
    return {"id": int(m[1]), "to": m[2]}


# ---------------------------------------------------------------- recall preview, embeddings, audit
async def recall_preview(conn, data):
    """What each arm would deliver for a query, through recall's own ranking and packing. No retrieval, no session."""
    query, task = _optional_text(data, "query", "task")
    arms = data.get("arms") or list(ARMS)
    if not query or not query.strip():
        raise ApiError(422, "Need a query.")
    if not isinstance(arms, list) or not all(isinstance(a, str) and a in ARMS for a in arms):
        raise ApiError(422, f"arms must be a list drawn from {', '.join(ARMS)}.")
    out = []
    for arm in arms:
        started = time.monotonic()
        ranked, degraded, packet, chunks, lines = await service.rank_and_pack(conn, arm, query, task or "")
        ms = int((time.monotonic() - started) * 1000)
        top = ranked[:25]
        rows = await _titles(conn, [eid for eid, _, _ in top])
        out.append({"arm": arm, "degraded": degraded, "latency_ms": ms, "packet": packet,
                    "text": service.packet_text(chunks, lines), "ranked": [
                        {"rank": i, "id": eid, "score": score, **_known(rows, eid), "in_packet": eid in packet}
                        for i, (eid, score, _) in enumerate(top, 1)]})
    await conn.rollback()
    return {"arms": out}


async def sync_embeddings_job(pool, audit=True):
    """Pull the model and embed what changed, on a connection of its own. A failure is logged, and audited when the
    console started it, never raised: hybrid keeps serving keyword ranks until a sync succeeds."""
    try:
        await pull_model()
        result = {"embedded": await sync_embeddings(pool)}
        log.info("embedded %d entries", result["embedded"])
    except Exception as exc:
        log.warning("embedding sync failed, hybrid serves keyword ranks until one succeeds: %s: %s",
                    type(exc).__name__, exc)
        result = {"error": f"{type(exc).__name__}: {exc}"[:300]}
    if audit:
        try:
            async with pool.connection() as conn:
                await _audit(conn, "embeddings.sync", "embeddings", None, result)
                await conn.commit()
        except Exception as exc:
            log.warning("could not audit the embedding sync: %s", exc)
    return result


class EmbeddingSync:
    """One embedding sync at a time, whoever starts it: the server at startup or Wen from the console. It keeps how the
    last run went, so the overview can say whether one is running, what it embedded or why it failed."""

    def __init__(self, pool):
        self.pool, self.task, self.last = pool, None, None

    @property
    def running(self):
        return self.task is not None and not self.task.done()

    def start(self, trigger):
        """False while a sync runs. trigger is startup or console. Only the console's lands in the audit, since it
        records writes made through the API. The task is kept here, so it isn't collected mid-run."""
        if self.running:
            return False
        self.last = {"running": True, "trigger": trigger, "started_at": datetime.now(timezone.utc), "finished_at": None,
                     "embedded": None, "error": None}
        self.task = asyncio.create_task(self._run(trigger))
        return True

    async def _run(self, trigger):
        result = await sync_embeddings_job(self.pool, audit=trigger == "console")
        self.last = dict(self.last, running=False, finished_at=datetime.now(timezone.utc), **result)

    def stop(self):
        if self.running:
            self.task.cancel()

    def status(self):
        return dict(self.last) if self.last else None


async def audit(conn, limit=50, offset=0):
    return await _page(conn, "select id, at, action, target, before, after from admin_audit", {}, "id desc", limit, offset)
