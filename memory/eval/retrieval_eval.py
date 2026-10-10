#!/usr/bin/env python3
"""Run each arm on the practice queries in the database and score the packets against their known answers.

  DATABASE_URL=... python eval/retrieval_eval.py [--arms A0,A1] [--split all|train|test]

Gold hit: a gold entry was delivered in the packet. must_not leak: a replaced or draft item the query names was delivered.
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
from kb.search import ARMS, fetch_entries, pack  # noqa: E402


async def run(arms, split):
    async with await psycopg.AsyncConnection.connect(config.database_url, row_factory=dict_row) as conn:
        cur = await conn.execute(
            "select q.id, q.text, q.split, coalesce(array_agg(r.entry_id) filter (where r.grade = 2), '{}') as gold, "
            "coalesce(array_agg(r.entry_id) filter (where r.grade = -1), '{}') as must_not "
            "from question q left join qrel r on r.question_id = q.id where %(s)s = 'all' or q.split = %(s)s "
            "group by q.id order by q.id", {"s": split})
        questions = await cur.fetchall()
        report = {}
        for arm in arms:
            per_q = []
            for q in questions:
                ranked, degraded = await ARMS[arm](conn, q["text"])
                rows = await fetch_entries(conn, [e for e, _, line in ranked[:config.packet_items * 2] if line is None])
                delivered, _ = pack(ranked, rows)
                per_q.append({"id": q["id"], "gold_hit": bool(set(q["gold"]) & set(delivered)) if q["gold"] else None,
                              "leaks": sorted(set(q["must_not"]) & set(delivered)), "delivered": delivered, "degraded": degraded})
            answerable = [p for p in per_q if p["gold_hit"] is not None]
            report[arm] = {"gold_hit_rate": round(sum(p["gold_hit"] for p in answerable) / max(len(answerable), 1), 3),
                           "queries_with_leaks": sum(bool(p["leaks"]) for p in per_q), "n": len(per_q),
                           "degraded": sorted({p["degraded"] for p in per_q if p["degraded"]}), "per_query": per_q}
        return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arms", default=",".join(ARMS))
    ap.add_argument("--split", default="all", choices=["all", "train", "test"])
    ap.add_argument("--json", action="store_true", help="print per-query detail")
    a = ap.parse_args()
    report = asyncio.run(run(a.arms.split(","), a.split))
    if a.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return
    for arm, r in report.items():
        print(f"{arm}: gold hit {r['gold_hit_rate']:.0%} of answerable, leaks in {r['queries_with_leaks']}/{r['n']} queries"
              + (f", degraded: {', '.join(r['degraded'])}" if r["degraded"] else ""))


if __name__ == "__main__":
    main()
