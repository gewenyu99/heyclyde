"""Retrieval arms. Every arm reads the same store and returns the same packet shape; only ranking differs."""
import re

from .config import config
from .embed import embed, has_vector, to_pgvector

CJK = re.compile(r"[㐀-鿿豈-﫿]")
WORD = re.compile(r"[a-z0-9][a-z0-9.+-]*")
STOP = set("a an and are as at be but by can do does for from how i if in is it its me my of on or so that the this "
           "to use using was we what when where which who why will with you your".split())


def tokens(text):
    """Lowercase words plus 中文 bigrams, for the index arm's grep."""
    text = text.lower()
    out = {w.strip(".+-") for w in WORD.findall(text)} - STOP
    for run in re.findall(r"[㐀-鿿豈-﫿]+", text):
        out |= {run} if len(run) == 1 else {run[i:i + 2] for i in range(len(run) - 1)}
    return {t for t in out if t}


def estimate_tokens(text):
    cjk = len(CJK.findall(text))
    return cjk + (len(text) - cjk) // 4


# ---------------------------------------------------------------- scope: a run's entries reach only that run's recalls
def scope_filter(alias=""):
    """Leave out run: entries unless they're in the asked-for scope. Every arm's SQL takes this, with %(scope)s bound."""
    return f"({alias}scope not like 'run:%%' or {alias}scope = %(scope)s)"


def boost(scored, ids):
    """Multiply the scores of entries in the asked-for scope by KB_SCOPE_BOOST and re-sort, so a run's notes lead."""
    out = [(eid, s * config.scope_boost if eid in ids else s, line) for eid, s, line in scored]
    return sorted(out, key=lambda x: (-x[1], x[0]))


# ---------------------------------------------------------------- index: grep the index map
async def index_lines(conn, scope=None):
    """The INDEX.md map, one line per entry, superseded entries struck through, as build.py writes it."""
    cur = await conn.execute(
        "select e.id, e.title, e.authority, e.scope, e.sensitivity, e.pattern, p.title as project_title, "
        "(select string_agg(l.src, ', ' order by l.src) from link l where l.dst = e.id and l.type = 'supersedes') as superseded_by "
        f"from entry e left join entry p on p.id = e.project where e.pattern <> 'projects' and {scope_filter('e.')} "
        "order by e.project, e.pattern, e.id", {"scope": scope})
    lines = []
    for r in await cur.fetchall():
        title = f"~~{r['title']}~~ → {r['superseded_by']}" if r["superseded_by"] else r["title"]
        lock = " 🔒" if r["sensitivity"] == "private" else ""
        lines.append((r["id"], f"- `{r['id']}` {title} [{r['authority']}, {r['scope']}]{lock} ({r['project_title']})",
                      r["authority"], r["scope"], bool(r["superseded_by"])))
    return lines


async def index_search(conn, query, scope=None):
    """grep over the index map. Drafts rank at half weight, so a confirmed decision beats a suggestion on a tie.

    A superseded line stays, struck through, but gets no scope boost. Its line names its replacement, so it matches
    every word the replacement does and would otherwise outrank it.

    Stemming and IDF weighting were tried on the train split. Stemming cost two hits, IDF changed nothing."""
    q = tokens(query)
    scored, scoped = [], set()
    for eid, line, authority, entry_scope, superseded in await index_lines(conn, scope):
        hit = len(q & tokens(line + " " + eid.replace("-", " ")))
        if hit:
            scored.append((eid, hit * (config.index_draft_factor if authority == "draft" else 1.0), line))
            if scope and entry_scope == scope and not superseded:
                scoped.add(eid)
    return boost(scored, scoped)[:config.candidates], None


# ---------------------------------------------------------------- hybrid: keyword plus vector search
def or_query(cfg):
    # plainto_tsquery ANDs every term, which a natural-language question rarely satisfies. OR them instead.
    return f"nullif(replace(plainto_tsquery('{cfg}', %(q)s)::text, ' & ', ' | '), '')::tsquery"


async def keyword_ranks(conn, query, cfg, column, scope=None):
    cur = await conn.execute(
        f"select id, ts_rank_cd({column}, t.q) as score from entry_current cross join (select {or_query(cfg)} as q) t "
        f"where t.q is not null and {column} @@ t.q and {scope_filter()} order by score desc, id limit %(k)s",
        {"q": query, "k": config.candidates, "scope": scope})
    return [r["id"] for r in await cur.fetchall()]


_query_vectors = {}


async def query_vector(query):
    """bge-m3 on 2 vCPUs takes a few hundred ms per query, so keep the last 512."""
    key = (config.embed_model, query)
    if key not in _query_vectors:
        if len(_query_vectors) >= 512:
            _query_vectors.pop(next(iter(_query_vectors)))
        [_query_vectors[key]] = await embed([query])
    return _query_vectors[key]


async def vector_ranks(conn, query, scope=None):
    if not await has_vector(conn):
        return [], "no-vector"
    try:
        vec = await query_vector(query)
    except Exception as exc:  # Ollama down or model missing: keyword ranks still answer.
        return [], f"embed-failed: {type(exc).__name__}"
    # The HNSW scan stops at hnsw.ef_search (40) candidates, and the scope and superseded filters run after it. When run
    # notes crowd those 40, few or none survive. An iterative scan keeps going until the limit is met. pgvector 0.8+.
    await conn.execute("set local hnsw.iterative_scan = strict_order")
    cur = await conn.execute(
        f"select x.entry_id as id from entry_embedding x join entry_current e on e.id = x.entry_id where {scope_filter('e.')} "
        "order by x.embedding <=> %(v)s::vector limit %(k)s", {"v": to_pgvector(vec), "k": config.candidates, "scope": scope})
    return [r["id"] for r in await cur.fetchall()], None


def rrf(*rankings, weights=None, k=None):
    k = config.rrf_k if k is None else k
    score = {}
    for ranking, w in zip(rankings, weights or [1.0] * len(rankings)):
        for rank, eid in enumerate(ranking, 1):
            score[eid] = score.get(eid, 0.0) + w / (k + rank)
    return sorted(score.items(), key=lambda kv: (-kv[1], kv[0]))


async def hybrid_components(conn, query, scope=None):
    """Each ranker's list on its own, so an eval can tell which one lost an entry.

    jieba also segments English, so the 中文 ranker only runs on queries with 中文 in them. Running it on English
    queries counted the same keyword evidence twice and buried entries both keyword and vector search ranked first."""
    vec, degraded = await vector_ranks(conn, query, scope)
    en = await keyword_ranks(conn, query, "english", "tsv_en", scope)
    if CJK.search(query):
        zh = await keyword_ranks(conn, query, "kb_zh", "tsv_zh", scope)
        keyword = [eid for eid, _ in rrf(en, zh)]
    else:
        zh, keyword = [], en
    return {"en": en, "zh": zh, "keyword": keyword, "vec": vec}, degraded


async def hybrid_search(conn, query, scope=None):
    parts, degraded = await hybrid_components(conn, query, scope)
    fused = [(eid, s, None) for eid, s in rrf(parts["keyword"], parts["vec"], weights=[1.0, config.vec_weight])]
    if scope and fused:
        cur = await conn.execute("select id from entry where id = any(%s) and scope = %s", ([e for e, _, _ in fused], scope))
        fused = boost(fused, {r["id"] for r in await cur.fetchall()})
    return fused[:config.candidates], degraded


ARMS = {"index": index_search, "hybrid": hybrid_search}


# ---------------------------------------------------------------- packing
async def fetch_entries(conn, ids):
    if not ids:
        return {}
    cur = await conn.execute(
        "select e.*, s.title as source_title, s.uri as source_uri, "
        "(select string_agg(l.src, ', ' order by l.src) from link l where l.dst = e.id and l.type = 'supersedes') as superseded_by "
        "from entry e left join source s on s.id = e.source_id where e.id = any(%s)", (list(ids),))
    return {r["id"]: r for r in await cur.fetchall()}


def redact(row):
    """Private entries never leave the Droplet unredacted: the agent sees the title and the id only."""
    if row["sensitivity"] != "private":
        return row
    return dict(row, body="[private entry: ask Wen]", evidence="")


def render_item(n, row):
    row = redact(row)
    head = f"[{n}] {row['id']}: {row['title']}"
    meta = f"    {row['authority']} · {row['scope']} · {row['valid_from']}"
    if row.get("superseded_by"):
        meta += f" · replaced by {row['superseded_by']}"
    parts = [head, meta, f"    {row['body']}"]
    if row["evidence"] and row["evidence_kind"] == "quote":
        parts.append(f"    Wen: “{row['evidence']}”")
    return "\n".join(parts)


CLIPPED = "\n    [Cut to fit the packet. get_entry has the rest.]"


def clip(text, budget):
    """The longest start of text that fits budget tokens with the cut marked."""
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        lo, hi = (mid, hi) if estimate_tokens(text[:mid] + CLIPPED) <= budget else (lo, mid - 1)
    return text[:lo] + CLIPPED


def pack(ranked, rows, lines=None):
    """Fill the packet in rank order up to the item and token budgets. Returns (delivered ids, text).

    The first item always goes in, cut to the budget when it's bigger, so one huge entry can't fill an agent's context."""
    delivered, chunks, used = [], [], 0
    for eid, _, line in ranked:
        if eid not in rows and line is None:
            continue
        chunk = line if line is not None else render_item(len(delivered) + 1, rows[eid])
        cost = estimate_tokens(chunk)
        if used + cost > config.packet_tokens:
            if delivered:
                break
            chunk = clip(chunk, config.packet_tokens)
            cost = estimate_tokens(chunk)
        delivered.append(eid)
        chunks.append(chunk)
        used += cost
        if len(delivered) == config.packet_items:
            break
    return delivered, chunks


def render_entry(row, links, blobs=()):
    row = redact(row)
    out = [f"{row['id']}: {row['title']}",
           f"pattern {row['pattern']} · {row['authority']} · {row['scope']} · valid from {row['valid_from']} · project {row['project']}",
           "", row["body"]]
    if row["evidence"]:
        who = "Wen" if row["evidence_kind"] == "quote" else row["evidence_kind"]
        out += ["", f"Evidence ({who}): “{row['evidence']}”"]
    out += ["", f"Source: {row['source_title']} {row['source_uri'] or ''}".rstrip()]
    if row.get("superseded_by"):
        out.append(f"Replaced by: {row['superseded_by']}")
    if links:
        out += ["", "Links:"] + [f"- {l['dir']} {l['type']} {l['other']}: {l['title']}" for l in links]
    if blobs and row["sensitivity"] == "private":
        # A name or sha256 can give away a private blob, since its content may be short enough to guess and hash.
        out += ["", f"Blobs: {len(blobs)}, private. Ask Wen."]
    elif blobs:
        out += ["", "Blobs. Open one with get_blob(sha256):"] + [
            f"- {b['name']}: {b['sha256']} · {b['media_type']} · {b['size']} bytes" for b in blobs]
    return "\n".join(out)
