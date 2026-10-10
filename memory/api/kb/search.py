"""Retrieval arms. Every arm reads the same store and returns the same packet shape; only ranking differs."""
import re

from .config import config
from .embed import embed, has_vector, to_pgvector

CJK = re.compile(r"[㐀-鿿豈-﫿]")
WORD = re.compile(r"[a-z0-9][a-z0-9.+-]*")
STOP = set("a an and are as at be but by can do does for from how i if in is it its me my of on or so that the this "
           "to use using was we what when where which who why will with you your".split())


def tokens(text):
    """Lowercase words plus 中文 bigrams, for the A0 index grep."""
    text = text.lower()
    out = {w.strip(".+-") for w in WORD.findall(text)} - STOP
    for run in re.findall(r"[㐀-鿿豈-﫿]+", text):
        out |= {run} if len(run) == 1 else {run[i:i + 2] for i in range(len(run) - 1)}
    return {t for t in out if t}


def estimate_tokens(text):
    cjk = len(CJK.findall(text))
    return cjk + (len(text) - cjk) // 4


# ---------------------------------------------------------------- A0: files + index
async def index_lines(conn):
    """The INDEX.md map, one line per entry, superseded entries struck through, as build.py writes it."""
    cur = await conn.execute(
        "select e.id, e.title, e.authority, e.scope, e.sensitivity, e.pattern, p.title as project_title, "
        "(select string_agg(l.src, ', ' order by l.src) from link l where l.dst = e.id and l.type = 'supersedes') as superseded_by "
        "from entry e left join entry p on p.id = e.project where e.pattern <> 'projects' order by e.project, e.pattern, e.id")
    lines = []
    for r in await cur.fetchall():
        title = f"~~{r['title']}~~ → {r['superseded_by']}" if r["superseded_by"] else r["title"]
        lock = " 🔒" if r["sensitivity"] == "private" else ""
        lines.append((r["id"], f"- `{r['id']}` {title} [{r['authority']}, {r['scope']}]{lock} ({r['project_title']})",
                      r["authority"]))
    return lines


async def a0(conn, query):
    """grep over the index map. Drafts rank at half weight, so a confirmed decision beats a suggestion on a tie.

    Stemming and IDF weighting were tried on the train split. Stemming cost two hits, IDF changed nothing."""
    q = tokens(query)
    scored = []
    for eid, line, authority in await index_lines(conn):
        hit = len(q & tokens(line + " " + eid.replace("-", " ")))
        if hit:
            scored.append((eid, hit * (config.a0_draft_factor if authority == "draft" else 1.0), line))
    scored.sort(key=lambda s: (-s[1], s[0]))
    return scored[:config.candidates], None


# ---------------------------------------------------------------- A1: hybrid search
def or_query(cfg):
    # plainto_tsquery ANDs every term, which a natural-language question rarely satisfies. OR them instead.
    return f"nullif(replace(plainto_tsquery('{cfg}', %(q)s)::text, ' & ', ' | '), '')::tsquery"


async def keyword_ranks(conn, query, cfg, column):
    cur = await conn.execute(
        f"select id, ts_rank_cd({column}, t.q) as score from entry_current cross join (select {or_query(cfg)} as q) t "
        f"where t.q is not null and {column} @@ t.q order by score desc, id limit %(k)s",
        {"q": query, "k": config.candidates})
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


async def vector_ranks(conn, query):
    if not await has_vector(conn):
        return [], "no-vector"
    try:
        vec = await query_vector(query)
    except Exception as exc:  # Ollama down or model missing: keyword ranks still answer.
        return [], f"embed-failed: {type(exc).__name__}"
    cur = await conn.execute(
        "select x.entry_id as id from entry_embedding x join entry_current e on e.id = x.entry_id "
        "order by x.embedding <=> %s::vector limit %s", (to_pgvector(vec), config.candidates))
    return [r["id"] for r in await cur.fetchall()], None


def rrf(*rankings, weights=None, k=None):
    k = config.rrf_k if k is None else k
    score = {}
    for ranking, w in zip(rankings, weights or [1.0] * len(rankings)):
        for rank, eid in enumerate(ranking, 1):
            score[eid] = score.get(eid, 0.0) + w / (k + rank)
    return sorted(score.items(), key=lambda kv: (-kv[1], kv[0]))


async def a1_components(conn, query):
    """Each ranker's list on its own, so an eval can tell which one lost an entry.

    jieba also segments English, so the 中文 ranker only runs on queries with 中文 in them. Running it on English
    queries counted the same keyword evidence twice and buried entries both keyword and vector search ranked first."""
    vec, degraded = await vector_ranks(conn, query)
    en = await keyword_ranks(conn, query, "english", "tsv_en")
    if CJK.search(query):
        zh = await keyword_ranks(conn, query, "kb_zh", "tsv_zh")
        keyword = [eid for eid, _ in rrf(en, zh)]
    else:
        zh, keyword = [], en
    return {"en": en, "zh": zh, "keyword": keyword, "vec": vec}, degraded


async def a1(conn, query):
    parts, degraded = await a1_components(conn, query)
    fused = rrf(parts["keyword"], parts["vec"], weights=[1.0, config.vec_weight])
    return [(eid, s, None) for eid, s in fused[:config.candidates]], degraded


ARMS = {"A0": a0, "A1": a1}


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


def pack(ranked, rows, lines=None):
    """Fill the packet in rank order up to the item and token budgets. Returns (delivered ids, text)."""
    delivered, chunks, used = [], [], 0
    for eid, _, line in ranked:
        if eid not in rows and line is None:
            continue
        chunk = line if line is not None else render_item(len(delivered) + 1, rows[eid])
        cost = estimate_tokens(chunk)
        if used + cost > config.packet_tokens and delivered:
            break
        delivered.append(eid)
        chunks.append(chunk)
        used += cost
        if len(delivered) == config.packet_items:
            break
    return delivered, chunks


def render_entry(row, links):
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
    return "\n".join(out)
