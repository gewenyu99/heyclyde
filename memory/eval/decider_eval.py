#!/usr/bin/env python3
"""Phase 0 decider run-off: which candidate spots Wen's pushback best?

  PKG_SEED_DIR=/path/to/pkg-seed OPEN_AI=... python eval/decider_eval.py [--candidates keywords,openai] [--out results.json]

Positives: the seeded reactions that quote Wen verbatim.
Negatives: Wen's other turns in vault/_inbox/*.jsonl. These are weak labels: a turn the curator never drafted as a
reaction may still be pushback, so read the false alarms before trusting the false-alarm rate.
The output holds Wen's words, so write it outside the repo.
"""
import argparse
import asyncio
import json
import os
import statistics
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
from kb.decider import CANDIDATES  # noqa: E402


def load(seed_dir):
    vault = Path(seed_dir) / "vault"
    positives = []
    for p in sorted((vault / "reactions").glob("*.md")):
        fm = yaml.safe_load(p.read_text(encoding="utf-8").split("---\n")[1])
        if fm["evidence_kind"] == "quote":
            positives.append({"id": fm["id"], "text": fm["evidence"], "label": True})
    quotes = [x["text"] for x in positives]
    negatives = []
    for f in sorted((vault / "_inbox").glob("*.jsonl")):
        for line in f.read_text(encoding="utf-8").splitlines():
            m = json.loads(line)
            if m.get("role") == "user" and m["text"].strip() and not any(q in m["text"] or m["text"] in q for q in quotes):
                negatives.append({"id": f"{f.stem}:{m['turn']}", "text": m["text"], "label": False})
    return positives + negatives


async def score(candidate, cases, concurrency):
    sem = asyncio.Semaphore(concurrency)

    async def one(c):
        async with sem:
            try:
                return dict(c, **await candidate.pushback(c["text"]))
            except Exception as exc:
                return dict(c, error=f"{type(exc).__name__}: {exc}")

    rows = await asyncio.gather(*(one(c) for c in cases))
    ok = [r for r in rows if "error" not in r]
    pos, neg = [r for r in ok if r["label"]], [r for r in ok if not r["label"]]
    lat = sorted(r["latency_ms"] for r in ok) or [0]
    return {
        "candidate": candidate.name,
        "positives": len(pos), "negatives": len(neg), "errors": len(rows) - len(ok),
        "misses": [r["id"] for r in pos if not r["pushback"]],
        "false_alarms": [r["id"] for r in neg if r["pushback"]],
        "recall": round(sum(r["pushback"] for r in pos) / max(len(pos), 1), 3),
        "false_alarm_rate": round(sum(r["pushback"] for r in neg) / max(len(neg), 1), 3),
        "latency_ms_p50": statistics.median(lat), "latency_ms_p95": lat[int(0.95 * (len(lat) - 1))],
        "rows": rows,
    }


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", default="keywords,openai")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--out", help="write per-case results here (contains Wen's words; keep it out of git)")
    a = ap.parse_args()
    cases = load(os.environ["PKG_SEED_DIR"])
    results = [await score(CANDIDATES[n](), cases, a.concurrency) for n in a.candidates.split(",")]
    for r in results:
        print(f"{r['candidate']}: recall {r['recall']:.0%} ({r['positives'] - len(r['misses'])}/{r['positives']}), "
              f"false alarms {r['false_alarm_rate']:.0%} ({len(r['false_alarms'])}/{r['negatives']}), "
              f"p50 {r['latency_ms_p50']} ms, p95 {r['latency_ms_p95']} ms, errors {r['errors']}")
    if a.out:
        Path(a.out).write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main())
