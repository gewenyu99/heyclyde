#!/usr/bin/env python3
"""Run each arm on the practice queries in the database and score the packets against their known answers.

  DATABASE_URL=... python eval/retrieval_eval.py [--arms index,hybrid] [--split all|train|test] [--misses] [--json]

Gold hit: a gold entry was delivered in the packet. must_not leak: a replaced or draft item the query names was delivered.

Every miss is placed in the funnel, so a loss points at a stage rather than at the arm:
  not-retrieved   no gold entry in the arm's candidates
  ranked-out      a gold entry was a candidate but ranked below the packet's item cap
  budget-cut      a gold entry ranked inside the item cap but the token budget cut it
For hybrid the gold entry's rank in each ranker (en, zh, vec) shows which ranker found it and which didn't.
No session is written: this reads the arms directly.
"""
import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

import psycopg  # noqa: E402
from psycopg.rows import dict_row  # noqa: E402

from kb.config import config  # noqa: E402
from kb.search import ARMS, hybrid_components, fetch_entries, pack  # noqa: E402


def rank_of(ids, wanted):
    ranks = [i for i, e in enumerate(ids, 1) if e in wanted]
    return ranks[0] if ranks else None


def stage(gold, candidates, delivered):
    if not gold or set(gold) & set(delivered):
        return None
    r = rank_of(candidates, gold)
    if r is None:
        return "not-retrieved"
    return "ranked-out" if r > config.packet_items else "budget-cut"


async def run(arms, split):
    async with await psycopg.AsyncConnection.connect(config.database_url, row_factory=dict_row) as conn:
        cur = await conn.execute(
            "select q.id, q.text, q.qtype, q.split, coalesce(array_agg(r.entry_id) filter (where r.grade = 2), '{}') as gold, "
            "coalesce(array_agg(r.entry_id) filter (where r.grade = -1), '{}') as must_not "
            "from question q left join qrel r on r.question_id = q.id where %(s)s = 'all' or q.split = %(s)s "
            "group by q.id order by q.id", {"s": split})
        questions = await cur.fetchall()
        report = {}
        for arm in arms:
            per_q = []
            for q in questions:
                ranked, degraded = await ARMS[arm](conn, q["text"])
                candidates = [e for e, _, _ in ranked]
                rows = await fetch_entries(conn, [e for e, _, line in ranked[:config.packet_items * 2] if line is None])
                delivered, _ = pack(ranked, rows)
                p = {"id": q["id"], "text": q["text"], "qtype": q["qtype"], "gold": q["gold"],
                     "gold_hit": bool(set(q["gold"]) & set(delivered)) if q["gold"] else None,
                     "gold_rank": rank_of(candidates, q["gold"]), "stage": stage(q["gold"], candidates, delivered),
                     "leaks": sorted(set(q["must_not"]) & set(delivered)), "delivered": delivered, "degraded": degraded}
                if arm == "hybrid" and q["gold"]:
                    parts, _ = await hybrid_components(conn, q["text"])
                    p["ranker_ranks"] = {k: rank_of(v, q["gold"]) for k, v in parts.items()}
                per_q.append(p)
            answerable = [p for p in per_q if p["gold_hit"] is not None]
            stages = {}
            for p in per_q:
                if p["stage"]:
                    stages[p["stage"]] = stages.get(p["stage"], 0) + 1
            report[arm] = {"gold_hit_rate": round(sum(p["gold_hit"] for p in answerable) / max(len(answerable), 1), 3),
                           "answerable": len(answerable), "misses_by_stage": stages,
                           "queries_with_leaks": sum(bool(p["leaks"]) for p in per_q), "n": len(per_q),
                           "degraded": sorted({p["degraded"] for p in per_q if p["degraded"]}), "per_query": per_q}
        return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arms", default=",".join(ARMS))
    ap.add_argument("--split", default="all", choices=["all", "train", "test"])
    ap.add_argument("--misses", action="store_true", help="list every miss and leak with its stage")
    ap.add_argument("--json", action="store_true", help="print per-query detail")
    a = ap.parse_args()
    report = asyncio.run(run(a.arms.split(","), a.split))
    if a.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return
    for arm, r in report.items():
        stages = ", ".join(f"{k} {v}" for k, v in sorted(r["misses_by_stage"].items())) or "none"
        print(f"{arm}: gold hit {r['gold_hit_rate']:.0%} of {r['answerable']} answerable, misses: {stages}, "
              f"leaks in {r['queries_with_leaks']}/{r['n']}" + (f", degraded: {', '.join(r['degraded'])}" if r["degraded"] else ""))
        if a.misses:
            for p in r["per_query"]:
                if p["stage"] or p["leaks"]:
                    extra = f" rankers {p['ranker_ranks']}" if "ranker_ranks" in p else ""
                    print(f"  {p['id']} [{p['qtype']}] {p['stage'] or 'hit'} gold {p['gold']} rank {p['gold_rank']}"
                          f"{extra} leaks {p['leaks']}  | {p['text']}")


if __name__ == "__main__":
    main()
