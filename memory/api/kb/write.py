"""remember(): the runtime write path. One entry with its source, links and blobs, held to the invariants seed/build.py
enforces on the vault, written in one transaction.

The API image ships kb/ alone, so the constants below copy build.py's rather than import them, plus run:<id> scopes.
tests/test_units.py fails when the two drift.
"""
import base64
import hashlib
import json
import logging
import re
from datetime import date

from .embed import embed_entry

log = logging.getLogger("kb")

AUTHORITY = {"approved", "observed", "draft"}
LINK_TYPES = {"supersedes", "supports", "contradicts", "derived_from", "relates", "part_of", "corrects"}
PATTERNS = {"projects", "decisions", "observations", "preferences", "recommendations", "references", "reactions"}
EVIDENCE_KINDS = {"quote", "assistant", "summary", "memory"}
# Use fullmatch with these. re.match lets `$` match before a trailing newline, so "run:abc\n" would pass.
SCOPE_RE = re.compile(r"^(global|domain:[a-z0-9-]+|repo:[A-Za-z0-9._/-]+|run:[A-Za-z0-9._-]+)$")
SENSITIVITY = {"normal", "private"}

RANK = {"draft": 0, "observed": 1, "approved": 2}
# part_of comes from `project` and supersedes from `supersedes`, so `links` takes the other types.
FREE_LINKS = LINK_TYPES - {"part_of", "supersedes"}
FIELDS = {"id", "pattern", "title", "body", "authority", "scope", "sensitivity", "lang", "valid_from", "source",
          "evidence_kind", "evidence", "project", "links", "supersedes", "blobs"}
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")
MEDIA_TYPE_RE = re.compile(r"[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}")
SURROGATE = re.compile("[\ud800-\udfff]")

# One entry can't flood a recall packet or the api container's 384 MB. Long material goes in blobs.
MAX_CHARS = {"title": 300, "body": 4000, "evidence": 20000}
# 4 MiB is the most the MCP route carries, so both write paths agree. server.py caps the HTTP body to fit 8 MiB of blobs.
MAX_BLOBS, MAX_BLOB_BYTES, MAX_BLOBS_BYTES = 16, 4 * 1024 * 1024, 8 * 1024 * 1024

# The most each caller may write. Every agent session holds KB_TOKEN, so an agent writes drafts in a run scope, under
# AGENT_SOURCE, with an id kb generates. Only lv-flow holds KB_RUNTIME_TOKEN. It records plans, verdicts and Wen's answers.
CALLERS = {"agent": "draft", "runtime": "approved"}
AGENT_SOURCE = {"kind": "session", "title": "An agent session, through remember"}


class Refused(ValueError):
    """The payload breaks an invariant. Nothing was written. The message has one line per problem."""


def sha(data):
    return hashlib.sha256(data).hexdigest()


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60].rstrip("-")


def digest(payload):
    """sha256 of the payload without its id. Stored on the entry, so a resend can tell its own entry from another."""
    return sha(json.dumps({k: v for k, v in payload.items() if k != "id"}, sort_keys=True, default=str).encode())


def make_id(payload, payload_digest):
    """A slug of the scope and title plus the payload's digest. The same write always gets the same id, so a retry
    lands on the entry it already made, and two notes sharing a title don't collide."""
    head = slug(f"{payload.get('scope', '')} {payload.get('title', '')}")
    return f"{head}-{payload_digest[:8]}" if head else payload_digest[:8]


def _text(value):
    return value.strip() if isinstance(value, str) and value.strip() else None


def _one_of(value, allowed):
    return isinstance(value, str) and value in allowed


def _unstorable(value, path=""):
    """A refusal for each string kb can't store. Postgres text can't hold NUL, though blob text can, since it's stored
    as bytes. A lone surrogate, like half an emoji cut by a JS slice, has no UTF-8 encoding at all."""
    if isinstance(value, str):
        if SURROGATE.search(value):
            yield f"{path} has a lone surrogate, half of a character. Send valid UTF-8."
        elif "\x00" in value and not re.fullmatch(r"blobs\[\d+\]\.text", path):
            yield f"{path} has a NUL character, which kb can't store."
    elif isinstance(value, dict):
        for k, v in value.items():
            yield from _unstorable(v, f"{path}.{k}" if path else str(k))
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from _unstorable(v, f"{path}[{i}]")


# ---------------------------------------------------------------- checks that need no database
def validate(payload, caller):
    """Every check that needs no database. Returns the entry with its defaults filled in, or raises Refused."""
    if caller not in CALLERS:
        raise ValueError(f"caller {caller!r} must be one of {sorted(CALLERS)}")
    if not isinstance(payload, dict):
        raise Refused("An entry is a JSON object.")
    errs = [f"Unknown field {k}." for k in sorted(set(payload) - FIELDS, key=str)]
    if bad := list(_unstorable(payload)):
        raise Refused("\n".join(errs + bad))
    max_authority, agent = CALLERS[caller], caller == "agent"
    p = {k: v for k, v in payload.items() if v is not None}
    e = {"pattern": p.get("pattern"), "title": _text(p.get("title")), "body": _text(p.get("body")),
         "authority": p.get("authority"), "scope": p.get("scope"), "sensitivity": p.get("sensitivity", "normal"),
         "lang": _text(p.get("lang", "en")), "evidence_kind": p.get("evidence_kind"), "evidence": _text(p.get("evidence")),
         "project": p.get("project") or None}

    if not _one_of(e["pattern"], PATTERNS): errs.append(f"pattern must be one of {', '.join(sorted(PATTERNS))}.")
    if not e["title"]: errs.append("title is required.")
    if not e["body"]: errs.append("body is required. It's the summary recall ranks on.")
    for field, cap in MAX_CHARS.items():
        if e[field] and len(e[field]) > cap:
            errs.append(f"{field} is {len(e[field])} characters. The limit is {cap}, so put long material in a blob.")
    if not _one_of(e["authority"], AUTHORITY): errs.append("authority must be draft, observed or approved.")
    elif RANK[e["authority"]] > RANK[max_authority]:
        errs.append(f"authority {e['authority']} is above {max_authority}, the most this caller may write.")
    if not (isinstance(e["scope"], str) and SCOPE_RE.fullmatch(e["scope"])):
        errs.append(f"scope {e['scope']!r} must be global, domain:<x>, repo:<x> or run:<id>.")
    elif agent and not e["scope"].startswith("run:"):
        errs.append(f"An agent writes only in a run scope, run:<id>, not {e['scope']}. Wen or lv-flow promotes notes wider.")
    if not _one_of(e["sensitivity"], SENSITIVITY): errs.append("sensitivity must be normal or private.")
    if not e["lang"]: errs.append("lang must be a language code like en.")
    if not _one_of(e["evidence_kind"], EVIDENCE_KINDS):
        errs.append(f"evidence_kind must be one of {', '.join(sorted(EVIDENCE_KINDS))}.")
    if not e["evidence"]: errs.append("evidence is required and can't be empty.")
    if e["evidence_kind"] == "quote" and e["authority"] == "draft": errs.append("A quote of Wen can't back a draft.")

    try:
        e["valid_from"] = date.fromisoformat(p["valid_from"]) if "valid_from" in p else date.today()
    except (TypeError, ValueError):
        errs.append(f"valid_from {p['valid_from']!r} must be a YYYY-MM-DD date.")

    if e["project"] is not None and not isinstance(e["project"], str):
        errs.append("project must be an entry id.")
    elif e["project"] is None and e["pattern"] != "projects":
        errs.append("project is required unless pattern is projects. It's the id of the projects entry this belongs to."
                    + (f" For a run, create its projects entry in scope {e['scope']} first."
                       if str(e["scope"]).startswith("run:") else ""))

    explicit_id = p.get("id", "") != ""
    if agent and "source" in p: errs.append("An agent can't name a source. kb records the write as an agent session.")
    if agent and explicit_id: errs.append("An agent can't choose an id. kb generates one from the payload.")
    e["source"] = _source(AGENT_SOURCE if agent else p.get("source"), errs)
    e["links"] = _links(p.get("links", []), errs)
    e["supersedes"] = _ids(p.get("supersedes", []), "supersedes", errs)
    e["blobs"] = _blobs(p.get("blobs", []), errs)

    e["digest"] = digest(payload)
    e["id"] = p["id"] if explicit_id and not agent else make_id(payload, e["digest"])
    if not (isinstance(e["id"], str) and ID_RE.fullmatch(e["id"])):
        errs.append("id must be letters, digits, '.', '_' and '-', starting with a letter or digit.")
    if e["project"] is not None and e["project"] == e["id"]: errs.append("An entry can't be part of itself.")
    if any(to == e["id"] for _, to in e["links"]): errs.append("An entry can't link to itself.")
    if e["id"] in e["supersedes"]: errs.append("An entry can't supersede itself.")
    if errs:
        raise Refused("\n".join(errs))
    return e


def _source(src, errs):
    if not isinstance(src, dict):
        errs.append("source is required: {kind, title, uri} for a new one, or {id} for one kb already has.")
        return None
    s = {"id": src.get("id") or None, "kind": _text(src.get("kind")), "title": _text(src.get("title")),
         "uri": _text(src.get("uri"))}
    if s["id"] is None:
        if not (s["kind"] and s["title"]):
            errs.append("A new source needs a kind and a title.")
        s["id"] = f"{slug(s['kind'] or 'source')}-{sha(json.dumps([s['kind'], s['title'], s['uri']]).encode())[:10]}"
    elif not (isinstance(s["id"], str) and ID_RE.fullmatch(s["id"])):
        errs.append("source.id must be letters, digits, '.', '_' and '-'.")
    return s


def _ids(value, field, errs):
    if not (isinstance(value, list) and all(isinstance(v, str) and v for v in value)):
        errs.append(f"{field} must be a list of entry ids.")
        return []
    return list(dict.fromkeys(value))


def _links(value, errs):
    if not (isinstance(value, list) and all(isinstance(l, dict) for l in value)):
        errs.append("links must be a list of {type, to}.")
        return []
    out = []
    for l in value:
        t, to = l.get("type"), l.get("to")
        if t == "part_of": errs.append("Set part_of with project, not links.")
        elif t == "supersedes": errs.append("Set supersedes with supersedes, not links.")
        elif not _one_of(t, FREE_LINKS): errs.append(f"link type {t!r} must be one of {', '.join(sorted(FREE_LINKS))}.")
        if not (isinstance(to, str) and to): errs.append("Every link needs a `to` entry id.")
        elif _one_of(t, FREE_LINKS): out.append((t, to))
    return list(dict.fromkeys(out))


def _blobs(value, errs):
    """Each blob carries `text`, or `base64` for binary content. Returns the decoded bytes and their sha256."""
    if not (isinstance(value, list) and all(isinstance(b, dict) for b in value)):
        errs.append("blobs must be a list of {name, media_type, text}.")
        return []
    if len(value) > MAX_BLOBS:
        errs.append(f"An entry has {len(value)} blobs. The limit is {MAX_BLOBS}.")
        return []
    out, names = [], set()
    for b in value:
        name = _text(b.get("name"))
        if not name: errs.append("Every blob needs a name.")
        elif name in names: errs.append(f"Two blobs are named {name}.")
        names.add(name)
        label = name or "without a name"
        if ("text" in b) == ("base64" in b):
            errs.append(f"Blob {label} needs text or base64, not both or neither.")
            continue
        if "text" in b:
            if not isinstance(b["text"], str):
                errs.append(f"Blob {label} has text that isn't a string.")
                continue
            data, default_type = b["text"].encode("utf-8"), "text/plain"
        else:
            try:
                data, default_type = base64.b64decode(b["base64"], validate=True), "application/octet-stream"
            except (TypeError, ValueError):  # binascii.Error is a ValueError, and so is a non-ASCII string
                errs.append(f"Blob {label} has base64 that doesn't decode.")
                continue
        if len(data) > MAX_BLOB_BYTES:
            errs.append(f"Blob {label} is {len(data)} bytes. The limit is {MAX_BLOB_BYTES}.")
        # The first writer's media type is the one GET /blobs sends, so it has to be a valid header value.
        media_type = b.get("media_type", default_type)
        if not (isinstance(media_type, str) and MEDIA_TYPE_RE.fullmatch(media_type.lower())):
            errs.append(f"Blob {label} needs a media_type like text/markdown, not {media_type!r}.")
        else:
            media_type = media_type.lower()
        out.append({"name": name, "media_type": media_type, "content": data, "sha256": sha(data)})
    total = sum(len(b["content"]) for b in out)
    if total > MAX_BLOBS_BYTES:
        errs.append(f"The blobs add up to {total} bytes. The limit for one entry is {MAX_BLOBS_BYTES}.")
    return out


# ---------------------------------------------------------------- checks against the graph, then the write
async def _check(conn, e):
    """The invariants that need the graph: targets exist, the project is a project, and supersession never hides an
    entry from anyone who could see it before. So a writer supersedes only at or below its own authority, and a run
    entry supersedes only entries in its run, since recall outside that run would lose both."""
    targets = {e["project"], *(to for _, to in e["links"]), *e["supersedes"]} - {None}
    cur = await conn.execute("select id, pattern, authority, scope from entry where id = any(%s)", (list(targets),))
    known = {r["id"]: r for r in await cur.fetchall()}
    errs = []
    p = e["project"]
    if p is not None and p not in known:
        if e["scope"].startswith("run:"):
            errs.append(f"Project {p} doesn't exist. Create the run's project entry first, "
                        f"with pattern projects and scope {e['scope']}.")
        else:
            errs.append(f"Project {p} doesn't exist.")
    elif p is not None and known[p]["pattern"] != "projects":
        errs.append(f"{p} is a {known[p]['pattern']} entry, not a project.")
    errs += [f"Dangling link: {t} {to}, which doesn't exist." for t, to in e["links"] if to not in known]
    for old in e["supersedes"]:
        o = known.get(old)
        if o is None:
            errs.append(f"Can't supersede {old}: it doesn't exist.")
            continue
        if RANK[o["authority"]] > RANK[e["authority"]]:
            article = "An" if e["authority"] == "observed" else "A"
            errs.append(f"{article} {e['authority']} entry can't supersede {o['authority']} {old}.")
        if e["scope"].startswith("run:") and o["scope"] != e["scope"]:
            errs.append(f"A {e['scope']} entry can only supersede entries in {e['scope']}, and {old} is in {o['scope']}.")
    s = e["source"]
    if not (s["kind"] and s["title"]):
        cur = await conn.execute("select 1 from source where id = %s", (s["id"],))
        if await cur.fetchone() is None:
            errs.append(f"Source {s['id']} is new, so it needs a kind and a title.")
    if errs:
        raise Refused("\n".join(errs))


async def _landed(conn, e):
    """True when this payload already landed. Refused when its id holds an entry with different content."""
    cur = await conn.execute("select payload_sha256 from entry where id = %s", (e["id"],))
    row = await cur.fetchone()
    if row is None:
        return False
    if row["payload_sha256"] != e["digest"]:
        raise Refused(f"Entry {e['id']} already exists. Write a new entry that supersedes it.")
    return True


async def _write(conn, e):
    """Insert every row. False, with the transaction to roll back, when another write took the id first."""
    s = e["source"]
    await conn.execute("insert into source (id, kind, title, uri, date) values (%s, %s, %s, %s, current_date) "
                       "on conflict (id) do nothing", (s["id"], s["kind"], s["title"], s["uri"]))
    # Two writers inserting the same new blobs in opposite orders would each wait on the other. One order can't deadlock.
    for b in sorted(e["blobs"], key=lambda b: b["sha256"]):
        await conn.execute("insert into blob (sha256, media_type, size, content) values (%s, %s, %s, %s) "
                           "on conflict (sha256) do nothing", (b["sha256"], b["media_type"], len(b["content"]), b["content"]))
    cur = await conn.execute(
        "insert into entry (id, pattern, title, body, authority, scope, sensitivity, lang, valid_from, source_id, "
        "evidence_kind, evidence, evidence_sha256, project, origin, payload_sha256) "
        "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'runtime', %s) on conflict (id) do nothing returning id",
        (e["id"], e["pattern"], e["title"], e["body"], e["authority"], e["scope"], e["sensitivity"], e["lang"],
         e["valid_from"], s["id"], e["evidence_kind"], e["evidence"], sha(e["evidence"].encode()),
         e["project"] or e["id"], e["digest"]))
    if await cur.fetchone() is None:
        return False
    links = [("part_of", e["project"])] if e["project"] else []
    links += [("supersedes", old) for old in e["supersedes"]] + e["links"]
    for t, to in links:
        await conn.execute("insert into link (src, dst, type) values (%s, %s, %s)", (e["id"], to, t))
    for b in e["blobs"]:
        await conn.execute("insert into entry_blob (entry_id, name, sha256) values (%s, %s, %s)",
                           (e["id"], b["name"], b["sha256"]))
    return True


async def remember(pool, payload, caller):
    """Write one entry as `caller`, agent or runtime. Returns {id, blobs: [{name, sha256}], embedded}. Raises Refused,
    having written nothing, when the payload breaks an invariant. Sending the same payload again returns its entry.

    It takes the pool rather than a connection, so the write holds one only while it writes, never while Ollama embeds."""
    e = validate(payload, caller)
    async with pool.connection() as conn:  # commits when the block ends, rolls back on any error
        if not await _landed(conn, e):
            await _check(conn, e)
            if not await _write(conn, e):
                # A send of the same payload committed between the lookup and the insert. Answer with its entry.
                await conn.rollback()
                await _landed(conn, e)
    return {"id": e["id"], "blobs": [{"name": b["name"], "sha256": b["sha256"]} for b in e["blobs"]],
            "embedded": await _embed(pool, e["id"])}


async def _embed(pool, entry_id):
    """A failed embedding never fails the write. The entry stays keyword-searchable and the next sync embeds it."""
    try:
        return await embed_entry(pool, entry_id)
    except Exception:
        log.warning("couldn't embed %s, so the next sync will", entry_id, exc_info=True)
        return False
