#!/usr/bin/env python3
"""Ablate what search_text carries, so each addition earns its place alone. Train split only.

  DATABASE_URL=... OLLAMA_URL=... python eval/index_ablation.py [--variants base,pattern,scope+links] [--to both|keyword|vector]

A variant names additions to the base text (title, body, evidence, project title), joined by +. For each variant this
rewrites search_text on every entry, re-embeds what changed with bge-m3 and runs retrieval_eval on the train split.
--to keyword or vector gives the additions to one ranker only, to tell which ranker an addition helps. At the end the
schema's trigger rewrites search_text and the embeddings follow it again.

It writes, so it refuses a database named kb or with prod in its name. Run it on a copy:
createdb -T kb_prod_copy kb_dev_<you>. The test split is never read here (README, Fair arms).
"""
import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

import psycopg  # noqa: E402
from psycopg.rows import dict_row  # noqa: E402

from kb.config import config  # noqa: E402
from kb.embed import content_sha, embed, sync_embeddings, to_pgvector  # noqa: E402
from retrieval_eval import run  # noqa: E402

PROJECT = "(select p.title from entry p where p.id = e.project and p.id <> e.id)"
FORWARD = {"supersedes": "supersedes", "supports": "supports", "contradicts": "contradicts",
           "derived_from": "derived from", "relates": "relates to", "corrects": "corrects"}
BACKWARD = {"supersedes": "superseded by", "supports": "supported by", "contradicts": "contradicted by",
            "derived_from": "source of", "relates": "relates to", "corrects": "corrected by"}


def phrase(words, fallback):
    return ("case l.type " + " ".join(f"when '{t}' then '{w}'" for t, w in words.items())
            + f" else {fallback} end")


def links(item):
    """Every link but part_of, read from both ends: "corrects pref-x: <title>" at the source, "corrected by y: <title>"
    at the target. Ordered, so the text and its embedding hash stay stable."""
    return ("(select string_agg(" + item + ", '. ' order by l.dir, l.type, l.other) from ("
            "select 'f' as dir, l.type, l.dst as other from link l where l.src = e.id "
            "union all select 'b', l.type, l.src from link l where l.dst = e.id) l "
            "join entry o on o.id = l.other where l.type <> 'part_of')")


TYPE_WORDS = "replace(l.type, '_', ' ')"  # a type outside the seed's fixed set, added through the console
INVERSE_WORDS = "'inverse of ' || " + TYPE_WORDS
WORDS = f"case l.dir when 'f' then {phrase(FORWARD, TYPE_WORDS)} else {phrase(BACKWARD, INVERSE_WORDS)} end"
PARTS = {
    "pattern": "e.pattern",
    "scope": "regexp_replace(e.scope, '^(domain|repo):', '')",
    "authority": "e.authority",
    "link_words": links(f"concat_ws(' ', {WORDS}, o.id)"),
    "link_titles": links("o.title"),
    "links": links(f"concat_ws(' ', {WORDS}, o.id || ':', o.title)"),
}


def text_sql(variant):
    parts = [] if variant == "base" else variant.split("+")
    unknown = set(parts) - set(PARTS)
    if unknown:
        raise SystemExit(f"unknown parts {sorted(unknown)}; pick from {sorted(PARTS)}")
    return "concat_ws(' ', " + ", ".join(["e.title", "e.body", "e.evidence", PROJECT] + [PARTS[p] for p in parts]) + ")"


async def embed_texts(conn, expr, cache):
    """Embed each entry's text under expr where its stored hash differs. cache keeps vectors across variants."""
    cur = await conn.execute(f"select e.id, {expr} as text, x.content_sha256 from entry e "
                             "left join entry_embedding x on x.entry_id = e.id")
    stale = [r for r in await cur.fetchall() if r["content_sha256"] != content_sha(r["text"])]
    todo = [r for r in stale if content_sha(r["text"]) not in cache]
    for i in range(0, len(todo), 16):
        chunk = todo[i:i + 16]
        for r, v in zip(chunk, await embed([r["text"] for r in chunk])):
            cache[content_sha(r["text"])] = v
    for r in stale:
        sha = content_sha(r["text"])
        await conn.execute(
            "insert into entry_embedding (entry_id, model, content_sha256, embedding) values (%s, %s, %s, %s::vector) "
            "on conflict (entry_id) do update set model = excluded.model, content_sha256 = excluded.content_sha256, "
            "embedding = excluded.embedding, updated_at = now()", (r["id"], config.embed_model, sha, to_pgvector(cache[sha])))
    await conn.commit()
    return len(stale)


async def settle():
    """Every variant rewrites every row, and the dead tuples tip the planner onto the HNSW index. Its ef_search window
    then holds mostly dead rows, so the vector ranker returns 15 to 31 entries instead of 50. Vacuum before each run, so
    every variant's vector ranks come from the same exact scan."""
    async with await psycopg.AsyncConnection.connect(config.database_url, autocommit=True) as c:
        await c.execute("vacuum analyze entry, entry_embedding")
        vec = (await (await c.execute("select embedding::text from entry_embedding limit 1")).fetchone())[0]
        plan = await (await c.execute(
            "explain select x.entry_id from entry_embedding x join entry_current e on e.id = x.entry_id "
            "order by x.embedding <=> %s::vector limit %s", (vec, config.candidates))).fetchall()
        if any("hnsw" in r[0] for r in plan):
            raise SystemExit("the vector ranker plans an HNSW scan, which caps it below 50: the numbers would not compare")


def mrr(per_query, key=None):
    ranks = [(p["ranker_ranks"].get(key) if key else p["gold_rank"]) for p in per_query if p["gold"]]
    return sum(1 / r for r in ranks if r) / max(len(ranks), 1)


def summary(name, report):
    out = [name]
    for arm, r in report.items():
        stages = ", ".join(f"{k} {v}" for k, v in sorted(r["misses_by_stage"].items())) or "none"
        line = (f"  {arm}: gold hit {r['gold_hit_rate']:.0%} of {r['answerable']}, misses: {stages}, "
                f"leaks in {r['queries_with_leaks']}/{r['n']}, MRR {mrr(r['per_query']):.3f}")
        if arm == "hybrid":
            line += f" (en {mrr(r['per_query'], 'en'):.3f}, vec {mrr(r['per_query'], 'vec'):.3f})"
        out.append(line + (f", degraded: {', '.join(r['degraded'])}" if r["degraded"] else ""))
        for p in r["per_query"]:
            if p["stage"] or p["leaks"]:
                extra = f" rankers {p['ranker_ranks']}" if "ranker_ranks" in p else ""
                out.append(f"    {p['id']} {p['stage'] or 'hit'} rank {p['gold_rank']}{extra} leaks {p['leaks']}")
    return "\n".join(out)


async def main(variants, to, arms):
    cache = {}
    async with await psycopg.AsyncConnection.connect(config.database_url, row_factory=dict_row) as conn:
        db = (await (await conn.execute("select current_database() as d")).fetchone())["d"]
        if db == "kb" or "prod" in db:
            raise SystemExit(f"refusing to rewrite search_text in {db}: run this on a copy")
        try:
            for v in variants:
                expr, base = text_sql(v), text_sql("base")
                await conn.execute(f"update entry e set search_text = {expr if to != 'vector' else base}")
                await conn.commit()
                n = await embed_texts(conn, expr if to != "keyword" else base, cache)
                await settle()
                print(summary(f"{v} (to {to}, {n} re-embedded)", await run(arms, "train")), flush=True)
        finally:
            await conn.rollback()
            await conn.execute("update entry set title = title")
            await conn.commit()
            await sync_embeddings(conn)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--variants", default="base,pattern,scope,authority,link_words,link_titles,links")
    ap.add_argument("--to", default="both", choices=["both", "keyword", "vector"])
    ap.add_argument("--arms", default="index,hybrid")
    a = ap.parse_args()
    asyncio.run(main(a.variants.split(","), a.to, a.arms.split(",")))
