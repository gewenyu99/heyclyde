#!/usr/bin/env python3
"""Run each arm on the practice queries and score the packets against their known answers, through the live memory
function's admin eval routes.

  python eval/retrieval_eval.py [--arms index,hybrid] [--split train|test|all] [--misses] [--json] [--params <id|file.json>]
  python eval/retrieval_eval.py --replay [--params <id|file.json>] [--limit 50] [--json]

--params runs one parameter set instead of each arm's v1. An id names a stored set (hybrid.v1, or a researcher's hybrid.v2), and
the arm is the set's own. A file is a POST /param-sets body without the id, {"arm": "hybrid", "parent": "hybrid.v1",
"params": {"tiltBase": 0.8}}: its params lay over the parent (the arm's v1 by default), and nothing is stored. Without --params
the arms run on their v1 sets, which is what the code ranked by before parameter sets.

The admin token comes from MEMORY_ADMIN_TOKEN or ~/.config/memory/admin-token. Tune on train. Read test once, after
the knobs are frozen.

Gold hit: a gold entry was delivered in the packet. must_not leak: a replaced or draft item the query names was delivered.

Every miss is placed in the funnel, so a loss points at a stage rather than at the arm:
  not-retrieved   no gold entry in the arm's candidates
  ranked-out      a gold entry was a candidate but ranked below the packet's item cap
  budget-cut      a gold entry ranked inside the item cap but the token budget cut it
For hybrid the gold entry's rank in each ranker (en, zh, vec) shows which ranker found it and which didn't.
No session is written: the eval routes read the arms directly.

--replay is the as-of replay (R32): the last --limit logged recalls, each re-scored under --params (or under the set it was
served by), with temperature and age rebuilt from events as of that recall's own clock reading, never today's values. The
report gives, over the replayed top PACKET_ITEMS, how much of what was served it keeps and how many entries the recall's
feedback marked used, irrelevant or wrong, and the largest gap from the logged final scores (0 when replaying a recall's
own set).
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
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


def resolve_params(spec):
    """The arm a --params spec names (None for a file that names none), what to send the eval route, and how to label it."""
    path = Path(spec)
    if path.is_file():
        d = json.loads(path.read_text())
        return d.get("arm"), {"params": d.get("params", {}), **({"parent": d["parent"]} if d.get("parent") else {})}, spec
    try:
        stored = call(f"/param-sets/{urllib.parse.quote(spec)}")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            sys.exit(f"memory has no parameter set {spec}, and no file by that name.")
        raise
    return stored["arm"], {"param_set": spec}, spec


def run(arms, split, probes=None, filter=True, tilt=None, params=None):
    questions = json.loads(Path(probes).read_text()) if probes else call(f"/eval/questions?split={split}")
    report = {}
    only_arm, extra, label = resolve_params(params) if params else (None, {}, None)
    for arm in [only_arm] if only_arm else arms:
        per_q = []
        for q in questions:
            r = call("/eval/rank", {"query": q["text"], "arm": arm, "filter": filter, **extra, **({"tilt": tilt} if tilt is not None else {})})
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
        report[arm] = {"param_set": label, "gold_hit_rate": round(sum(p["gold_hit"] for p in answerable) / max(len(answerable), 1), 3),
                       "answerable": len(answerable), "misses_by_stage": stages,
                       "queries_with_leaks": sum(bool(p["leaks"]) for p in per_q), "n": len(per_q),
                       "degraded": sorted({p["degraded"] for p in per_q if p["degraded"]}), "per_query": per_q}
    return report


def replay(params=None, limit=50):
    extra, label = {}, "logged"
    if params:
        arm, extra, label = resolve_params(params)
        if "params" in extra and arm:
            extra["arm"] = arm
    rows = call(f"/retrievals?limit={limit}")["items"]
    per, skipped = [], 0
    for row in rows:
        try:
            r = call("/eval/replay", {"retrieval_id": row["id"], **extra})
        except urllib.error.HTTPError as e:
            if e.code in (404, 422):
                skipped += 1
                continue
            raise
        top = [c["id"] for c in r["candidates"][:PACKET_ITEMS]]
        served = r["delivered"] or []
        verdicts = r["outcomes"]
        count = lambda *vs: sum(1 for i in top if verdicts.get(i) in vs)
        per.append({"retrieval_id": r["retrieval_id"], "c_now": r["c_now"], "param_set": r["param_set"], "top": top,
                    "kept": round(len(set(top) & set(served)) / len(served), 3) if served else None,
                    "used": count("used", "helpful"), "irrelevant": count("irrelevant"), "wrong": count("wrong"),
                    "max_score_diff": max((abs(c["final_score"] - c["logged_score"]) for c in r["candidates"]), default=0.0)})
    kept = [p["kept"] for p in per if p["kept"] is not None]
    return {"param_set": label, "replayed": len(per), "skipped": skipped,
            "mean_kept": round(sum(kept) / len(kept), 3) if kept else None,
            "used_at_k": sum(p["used"] for p in per), "irrelevant_at_k": sum(p["irrelevant"] for p in per),
            "wrong_at_k": sum(p["wrong"] for p in per),
            "max_score_diff": max((p["max_score_diff"] for p in per), default=0.0), "per_recall": per}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arms", default="index,hybrid")
    ap.add_argument("--split", default="train", choices=["all", "train", "test"])
    ap.add_argument("--misses", action="store_true", help="list every miss and leak with its stage")
    ap.add_argument("--json", action="store_true", help="print per-query detail")
    ap.add_argument("--tilt", type=float, help="try a confidence tilt base (0 to 1) instead of the deployed one")
    ap.add_argument("--no-filter", action="store_true", help="skip the relevance filter, to compare against it")
    ap.add_argument("--params", help="a stored parameter set id like hybrid.v1, or a JSON file {arm, parent, params} to try without storing it")
    ap.add_argument("--probes", help="a JSON file of {id, qtype, text, gold, must_not} to run instead, like labels/zh-probes.json")
    ap.add_argument("--replay", action="store_true", help="re-score logged recalls as of each one's clock, under --params or its own set")
    ap.add_argument("--limit", type=int, default=50, help="how many of the latest recalls --replay reads (at most 200)")
    a = ap.parse_args()
    if a.replay:
        r = replay(a.params, a.limit)
        if a.json:
            print(json.dumps(r, ensure_ascii=False, indent=2))
        else:
            print(f"replay ({r['param_set']}): {r['replayed']} recalls, {r['skipped']} skipped, kept {r['mean_kept']} of what was served, "
                  f"used {r['used_at_k']}, irrelevant {r['irrelevant_at_k']}, wrong {r['wrong_at_k']} in the top {PACKET_ITEMS}, "
                  f"max score diff {r['max_score_diff']:.3g}")
        return
    report = run(a.arms.split(","), a.split, a.probes, not a.no_filter, a.tilt, a.params)
    if a.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return
    for arm, r in report.items():
        stages = ", ".join(f"{k} {v}" for k, v in sorted(r["misses_by_stage"].items())) or "none"
        name = f"{arm} ({r['param_set']})" if r["param_set"] else arm
        print(f"{name}: gold hit {r['gold_hit_rate']:.0%} of {r['answerable']} answerable, misses: {stages}, "
              f"leaks in {r['queries_with_leaks']}/{r['n']}" + (f", degraded: {', '.join(r['degraded'])}" if r["degraded"] else ""))
        if a.misses:
            for p in r["per_query"]:
                if p["stage"] or p["leaks"]:
                    extra = f" rankers {p['ranker_ranks']}" if "ranker_ranks" in p else ""
                    print(f"  {p['id']} [{p['qtype']}] {p['stage'] or 'hit'} gold {p['gold']} rank {p['gold_rank']}"
                          f"{extra} leaks {p['leaks']}  | {p['text']}")


if __name__ == "__main__":
    main()
