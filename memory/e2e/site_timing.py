#!/usr/bin/env python3
"""R51 (#56) and R63 (#68): measure production P95 latency for Wen's /me/entries?q=deploy and /me/graph?depth=2.

Usage:
    python3 memory/e2e/site_timing.py            # runs entries (<= 800 ms) and graph (<= 1,000 ms)
    python3 memory/e2e/site_timing.py entries    # only 20x GET /me/entries?q=deploy
    python3 memory/e2e/site_timing.py graph      # only 20x GET /me/graph?center=<most-linked>&depth=2

Auth: reads CLYDE_JWT env var, or mints an ephemeral Wen sign-in JWT via Supabase Admin generate_link + verify
using `supabase projects api-keys` and Wen's address from `memory.setting`/`memory.allowed_email` (never sends email,
never prints or persists any token or key). Python stdlib only.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE = "https://heyclyde.me"
SUPA_PROJECT = "wlhlncmgjqyidosunugv"
SUPA_URL = f"https://{SUPA_PROJECT}.supabase.co"
DEFAULT_EMAIL = os.environ.get("CLYDE_TIMING_EMAIL", "gewenyu99@gmail.com")


def p95(values: list[float]) -> float:
    ordered = sorted(values)
    idx = max(0, min(len(ordered) - 1, math.ceil(0.95 * len(ordered)) - 1))
    return ordered[idx]


def mint_jwt(email: str) -> str:
    raw = subprocess.check_output(
        ["supabase", "projects", "api-keys", "--project-ref", SUPA_PROJECT, "-o", "json"],
        text=True,
        stderr=subprocess.DEVNULL,
        timeout=30,
    )
    keys = json.loads(raw)
    service_key = next((k["api_key"] for k in keys if k.get("name") == "service_role"), None)
    anon_key = next((k["api_key"] for k in keys if k.get("name") == "anon"), None)
    if not service_key or not anon_key:
        raise RuntimeError("Missing anon or service_role API key from supabase CLI.")

    req = urllib.request.Request(
        f"{SUPA_URL}/auth/v1/admin/generate_link",
        data=json.dumps({"type": "magiclink", "email": email}).encode("utf-8"),
        headers={"apikey": service_key, "authorization": f"Bearer {service_key}", "content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        link_data = json.loads(r.read().decode("utf-8"))
    token_hash = link_data.get("hashed_token") or (link_data.get("properties") or {}).get("hashed_token")
    if not token_hash:
        raise RuntimeError("generate_link returned no hashed_token.")

    vreq = urllib.request.Request(
        f"{SUPA_URL}/auth/v1/verify",
        data=json.dumps({"type": "magiclink", "token_hash": token_hash}).encode("utf-8"),
        headers={"apikey": anon_key, "content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(vreq, timeout=20) as r:
        sess = json.loads(r.read().decode("utf-8"))
    tok = sess.get("access_token")
    if not tok:
        raise RuntimeError("verify returned no access_token.")
    return str(tok)


def get_json(url: str, jwt: str) -> tuple[int, float, dict]:
    req = urllib.request.Request(url, headers={"authorization": f"Bearer {jwt}", "accept": "application/json"})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read()
        ms = (time.perf_counter() - t0) * 1000.0
        return r.status, ms, json.loads(body.decode("utf-8"))


def bench_entries(base: str, jwt: str, query: str, runs: int, limit_ms: float) -> bool:
    url = f"{base.rstrip('/')}/me/entries?q={urllib.parse.quote(query)}"
    times: list[float] = []
    totals: list[int] = []
    for _ in range(runs):
        status, ms, data = get_json(url, jwt)
        assert status == 200, f"GET {url} returned {status}"
        times.append(ms)
        totals.append(int(data.get("total", len(data.get("entries", [])))))
    p50_v = sorted(times)[len(times) // 2]
    p95_v = p95(times)
    max_v = max(times)
    ok = p95_v <= limit_ms
    print(f"entries q={query!r}: runs={runs} total={totals[-1]} p50={p50_v:.1f}ms p95={p95_v:.1f}ms max={max_v:.1f}ms limit={limit_ms:.0f}ms -> {'PASS' if ok else 'FAIL'}")
    return ok


def bench_graph(base: str, jwt: str, center: str | None, depth: int, runs: int, limit_ms: float) -> bool:
    if not center:
        _, _, seed = get_json(f"{base.rstrip('/')}/me/graph?depth=1", jwt)
        center = seed.get("center")
    if not center:
        print("graph: no entries with links found -> FAIL")
        return False
    url = f"{base.rstrip('/')}/me/graph?center={urllib.parse.quote(center)}&depth={depth}"
    times: list[float] = []
    nodes_n = 0
    edges_n = 0
    for _ in range(runs):
        status, ms, data = get_json(url, jwt)
        assert status == 200, f"GET {url} returned {status}"
        times.append(ms)
        nodes_n = len(data.get("nodes", []))
        edges_n = len(data.get("edges", []))
    p50_v = sorted(times)[len(times) // 2]
    p95_v = p95(times)
    max_v = max(times)
    ok = p95_v <= limit_ms
    print(f"graph center={center} depth={depth}: runs={runs} nodes={nodes_n} edges={edges_n} p50={p50_v:.1f}ms p95={p95_v:.1f}ms max={max_v:.1f}ms limit={limit_ms:.0f}ms -> {'PASS' if ok else 'FAIL'}")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description="Benchmark Clyde /me/entries and /me/graph P95 latency.")
    ap.add_argument("target", nargs="?", default="all", choices=["all", "entries", "graph"])
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--runs", type=int, default=20)
    ap.add_argument("--query", default="deploy")
    ap.add_argument("--depth", type=int, default=2)
    ap.add_argument("--center", default=None)
    args = ap.parse_args()

    jwt = os.environ.get("CLYDE_JWT", "").strip()
    if not jwt:
        jwt = mint_jwt(DEFAULT_EMAIL)

    ok = True
    if args.target in ("all", "entries"):
        ok = bench_entries(args.base, jwt, args.query, args.runs, 800.0) and ok
    if args.target in ("all", "graph"):
        ok = bench_graph(args.base, jwt, args.center, args.depth, args.runs, 1000.0) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
