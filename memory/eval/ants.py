#!/usr/bin/env python3
"""Train the spreading arm's per-link-type weights with an ant colony on the train questions, then save them as a new
spreading parameter set.

  python eval/ants.py [--iterations 30] [--ants 15] [--id spreading.ants-<time>] [--dry-run]

Wen's design: ants start at hybrid's seeds for a question and walk up to 3 hops over typed links. Each step picks a
neighbor with probability ∝ τ^α · η^β, where τ is the link type's pheromone and η favors entries hybrid also ranked
(α=1, β=2), with 10% exploration. An ant that reaches a gold entry deposits 1/hops on every link type it walked.
Pheromone evaporates 10% a round. The final pheromone, scaled to a mean of 1 and clamped to 0.2 to 5, becomes the
linkTypeWeights of a new parameter set whose parent is spreading.v1. Nothing goes live: allocate the set, or run it offline
with retrieval_eval.py --params <id>. Train split only: the test split stays unread until the knobs freeze.
"""
import argparse, json, os, random, urllib.request
from datetime import datetime, timezone
from collections import defaultdict
from pathlib import Path

URL = os.environ.get("MEMORY_URL", "https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory") + "/api/v1"
TOKEN = os.environ.get("MEMORY_ADMIN_TOKEN") or (Path.home() / ".config/memory/admin-token").read_text().strip()
ALPHA, BETA, EXPLORE, HOPS, EVAPORATE = 1.0, 2.0, 0.10, 3, 0.10


def call(path, body=None, method=None):
    req = urllib.request.Request(URL + path, data=None if body is None else json.dumps(body).encode(),
                                 method=method or ("GET" if body is None else "POST"),
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--iterations", type=int, default=30)
    ap.add_argument("--ants", type=int, default=15)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--id", help="the new parameter set's id, default spreading.ants-<UTC time>")
    ap.add_argument("--dry-run", action="store_true", help="print the weights without saving a set")
    a = ap.parse_args()
    rng = random.Random(a.seed)

    g = call("/graph?include_superseded=true")
    pattern = {n["id"]: n["pattern"] for n in g["nodes"]}
    edges = defaultdict(list)   # node -> [(neighbor, key)], key = (src_pattern, type, dst_pattern) as the link is stored
    for l in g["links"]:
        if l["src"] not in pattern or l["dst"] not in pattern:
            continue
        key = (pattern[l["src"]], l["type"], pattern[l["dst"]])
        if l["type"] == "supersedes":
            edges[l["dst"]].append((l["src"], key))   # old -> new only, as the arm spreads
        else:
            edges[l["src"]].append((l["dst"], key))
            edges[l["dst"]].append((l["src"], key))

    questions = [q for q in call("/eval/questions?split=train") if q["gold"]]
    seeds = {}
    for q in questions:
        cand = call("/eval/rank", {"query": q["text"], "arm": "hybrid", "filter": False})["candidates"]
        seeds[q["id"]] = {eid: i + 1 for i, eid in enumerate(cand)}

    tau = defaultdict(lambda: 1.0)
    for it in range(a.iterations):
        deposit = defaultdict(float)
        found = 0
        for q in questions:
            rank, gold = seeds[q["id"]], set(q["gold"])
            starts = [eid for eid, r in sorted(rank.items(), key=lambda kv: kv[1])[:10]]
            if not starts:
                continue
            weights = [1 / rank[s] for s in starts]
            for _ in range(a.ants):
                node, used, seen = rng.choices(starts, weights)[0], [], set()
                seen.add(node)
                for hop in range(1, HOPS + 1):
                    options = [(n, k) for n, k in edges.get(node, []) if n not in seen]
                    if not options:
                        break
                    if rng.random() < EXPLORE:
                        node, key = rng.choice(options)
                    else:
                        score = [tau[k] ** ALPHA * (1 + (1 / rank[n] if n in rank else 0)) ** BETA for n, k in options]
                        node, key = rng.choices(options, score)[0]
                    used.append(key)
                    seen.add(node)
                    if node in gold:
                        found += 1
                        for k in used:
                            deposit[k] += 1 / hop
                        break
        for k in list(tau):
            tau[k] *= 1 - EVAPORATE
        for k, d in deposit.items():
            tau[k] += d / max(1, len(questions))
        if it % 10 == 9 or it == a.iterations - 1:
            print(f"round {it + 1}: {found} ants reached gold")

    keys = set(tau) | {k for es in edges.values() for _, k in es}
    mean = sum(tau[k] for k in keys) / max(1, len(keys))
    rows = [{"src_pattern": k[0], "link_type": k[1], "dst_pattern": k[2],
             "weight": round(min(5, max(0.2, tau[k] / mean)), 3)} for k in keys if k[1] != "part_of"]
    rows.sort(key=lambda r: -r["weight"])
    for r in rows[:8]:
        print(f"  {r['weight']:5.2f}  {r['src_pattern']} -{r['link_type']}-> {r['dst_pattern']}")
    print(f"  ... {len(rows)} link types in all")
    if not a.dry_run:
        set_id = a.id or "spreading.ants-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
        made = call("/param-sets", {
            "id": set_id, "parent": "spreading.v1", "by": "ants",
            "note": f"ant colony weights: {a.iterations} rounds of {a.ants} ants on {len(questions)} train questions, seed {a.seed}",
            "params": {"linkTypeWeights": {f"{r['src_pattern']}|{r['link_type']}|{r['dst_pattern']}": r["weight"] for r in rows}}})
        print(f"saved parameter set {made['id']} with {len(rows)} link type weights")


if __name__ == "__main__":
    main()
