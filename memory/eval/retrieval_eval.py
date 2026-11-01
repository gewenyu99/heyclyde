#!/usr/bin/env python3
"""Run each arm on the practice queries and score the packets against their known answers, through the live memory
function's admin eval routes.

  python eval/retrieval_eval.py [--arms index,hybrid] [--split train|test|all] [--misses] [--json]

The admin token comes from MEMORY_ADMIN_TOKEN or ~/.config/memory/admin-token. Tune on train. Read test once, after
the knobs are frozen.

Gold hit: a gold entry was delivered in the packet. must_not leak: a replaced or draft item the query names was delivered.

Every miss is placed in the funnel, so a loss points at a stage rather than at the arm:
  not-retrieved   no gold entry in the arm's candidates
  ranked-out      a gold entry was a candidate but ranked below the packet's item cap
  budget-cut      a gold entry ranked inside the item cap but the token budget cut it
For hybrid the gold entry's rank in each ranker (en, zh, vec) shows which ranker found it and which didn't.
No session is written: the eval routes read the arms directly.
"""
import argparse
import json
import os
import urllib.request
from pathlib import Path

URL = os.environ.get("MEMORY_URL", "https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory")
PACKET_ITEMS = 8


def token():
    return os.environ.get("MEMORY_ADMIN_TOKEN") or (Path.home() / ".config/memory/admin-token").read_text().strip()


def call(path, body=None):
    req = urllib.request.Request(f"{URL}/api/v1{path}", data=None if body is None else json.dumps(body).encode(),
                                 method="GET" if body is None else "POST",
                                 headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def rank_of(ids, wanted):
    ranks = [i for i, e in enumerate(ids, 1) if e in wanted]
    return ranks[0] if ranks else None


def stage(gold, candidates, delivered):
    if not gold or set(gold) & set(delivered):
        return None
    r = rank_of(candidates, gold)
    if r is None:
        return "not-retrieved"
    return "ranked-out" if r > PACKET_ITEMS else "budget-cut"


def run(arms, split, probes=None):
    questions = json.loads(Path(probes).read_text()) if probes else call(f"/eval/questions?split={split}")
    report = {}
    for arm in arms:
        per_q = []
        for q in questions:
            r = call("/eval/rank", {"query": q["text"], "arm": arm})
            candidates, delivered = r["candidates"], r["delivered"]
            p = {"id": q["id"], "text": q["text"], "qtype": q["qtype"], "gold": q["gold"],
                 "gold_hit": bool(set(q["gold"]) & set(delivered)) if q["gold"] else None,
                 "gold_rank": rank_of(candidates, q["gold"]), "stage": stage(q["gold"], candidates, delivered),
                 "leaks": sorted(set(q["must_not"]) & set(delivered)), "delivered": delivered, "degraded": r["degraded"]}
            if r["parts"] and q["gold"]:
                p["ranker_ranks"] = {k: rank_of(v, q["gold"]) for k, v in r["parts"].items()}
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
    ap.add_argument("--arms", default="index,hybrid")
    ap.add_argument("--split", default="train", choices=["all", "train", "test"])
    ap.add_argument("--misses", action="store_true", help="list every miss and leak with its stage")
    ap.add_argument("--json", action="store_true", help="print per-query detail")
    ap.add_argument("--probes", help="a JSON file of {id, qtype, text, gold, must_not} to run instead, like labels/zh-probes.json")
    a = ap.parse_args()
    report = run(a.arms.split(","), a.split, a.probes)
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
