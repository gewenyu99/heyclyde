#!/usr/bin/env python3
"""R66 (#71), Clyde slice C19: check that N free accounts at their SQL caps plus Wen fit inside Supabase Pro.

Reads the included Pro quotas directly from memory/supabase/functions/memory/billing/cost.ts (SUPABASE_PRO) and the
free plan caps directly from memory/supabase/migrations/*.sql. Python stdlib only.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COST_TS = ROOT / "memory/supabase/functions/memory/billing/cost.ts"
MIGRATIONS_DIR = ROOT / "memory/supabase/migrations"

# Wen's measured monthly baseline from CLYDE-DESIGN.md (L2: capacity and margin).
WEN_BASELINE = {
    "database": 900_000_000,         # 0.9 GB projected at 12 months with 180-day event retention
    "storage": 10 * 1024 ** 3,       # 10 GiB cap
    "egress": 4_000_000_000,         # 4 GB (nightly backups + reads)
    "invocations": 100_000,          # ~100k function calls/month
    "mau": 1,                        # Wen
}


def _parse_num(expr: str) -> int:
    token = expr.strip().replace("_", "")
    return int(round(float(token)))


def load_pro_quotas(cost_path: Path = COST_TS) -> dict[str, int]:
    """Read SUPABASE_PRO.included limits from cost.ts so there is one source of truth."""
    text = cost_path.read_text()
    m = re.search(r"export\s+const\s+SUPABASE_PRO\s*=\s*\{(?P<body>.*?)\}\s*as\s+const", text, re.S)
    if not m:
        raise ValueError(f"SUPABASE_PRO block not found in {cost_path}")
    body = m.group("body")
    key_map = {
        "db_bytes": "database",
        "storage_bytes": "storage",
        "egress_bytes": "egress",
        "invocations": "invocations",
        "mau": "mau",
    }
    quotas: dict[str, int] = {}
    for ts_key, metric in key_map.items():
        km = re.search(rf"{ts_key}\s*:\s*\{{[^}}]*?\bincluded\s*:\s*([0-9_eE.+]+)", body)
        if not km:
            raise ValueError(f"missing SUPABASE_PRO.{ts_key}.included in {cost_path}")
        quotas[metric] = _parse_num(km.group(1))
    return quotas


def _split_sql_tuple(tuple_body: str) -> list[str]:
    items: list[str] = []
    cur: list[str] = []
    in_str = False
    i = 0
    while i < len(tuple_body):
        ch = tuple_body[i]
        if ch == "'":
            in_str = not in_str
            cur.append(ch)
        elif ch == "," and not in_str:
            items.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
        i += 1
    if cur:
        items.append("".join(cur).strip())
    return items


def load_free_plan(migrations_dir: Path = MIGRATIONS_DIR) -> dict[str, int | bool | None]:
    """Replay free-row definitions and updates across memory/supabase/migrations in order."""
    free: dict[str, int | bool | None] = {}
    insert_re = re.compile(
        r"insert\s+into\s+memory\.plan\s*\((?P<cols>[^)]+)\)\s*values\s*(?P<vals>.*?)(?:on\s+conflict|;)",
        re.I | re.S,
    )
    tuple_re = re.compile(r"\(\s*'free'\s*,(?P<rest>[^)]+)\)", re.I | re.S)
    update_re = re.compile(
        r"update\s+memory\.plan\s+set\s+(?P<sets>.*?)\s+where\s+id\s*=\s*'free'(?=\s|;)[^;]*;",
        re.I | re.S,
    )
    assign_re = re.compile(r"(\w+)\s*=\s*(null|true|false|-?\d+)", re.I)

    def decode(raw: str) -> int | bool | None:
        low = raw.strip().lower()
        if low == "null":
            return None
        if low == "true":
            return True
        if low == "false":
            return False
        if re.fullmatch(r"-?\d+", low):
            return int(low)
        return None

    for path in sorted(migrations_dir.glob("*.sql")):
        sql_text = path.read_text()
        for im in insert_re.finditer(sql_text):
            cols = [c.strip() for c in im.group("cols").split(",")]
            for tm in tuple_re.finditer(im.group("vals")):
                vals = ["'free'"] + _split_sql_tuple(tm.group("rest"))
                if len(vals) == len(cols):
                    for k, v in zip(cols[1:], vals[1:]):
                        free[k] = decode(v)
        for um in update_re.finditer(sql_text):
            for k, v in assign_re.findall(um.group("sets")):
                free[k.lower()] = decode(v)

    required = ("entries_total", "recalls_month", "remembers_month", "blob_bytes_total", "seats")
    missing = [k for k in required if k not in free]
    if missing:
        raise ValueError(f"missing free plan fields from migrations: {', '.join(missing)}")
    return free


def evaluate(free_count: int, cost_path: Path = COST_TS, migrations_dir: Path = MIGRATIONS_DIR) -> tuple[bool, dict]:
    """Compute per-resource totals for free_count free accounts at cap + Wen vs Pro included quotas."""
    quotas = load_pro_quotas(cost_path)
    plan = load_free_plan(migrations_dir)

    entries_total = int(plan["entries_total"] or 0)
    recalls_month = int(plan["recalls_month"] or 0)
    remembers_month = int(plan["remembers_month"] or 0)
    blob_bytes_total = int(plan["blob_bytes_total"] or 0)

    # Per-user worst-case monthly footprint under 180d retention and halfvec(1024):
    # ~6.2 KB/entry+halfvec+index, ~10.5 KB/retrieval+context, ~4.6 KB/remember write+events (= 4.0 MB at 100/300/50).
    free_db_per_user = entries_total * 6_200 + recalls_month * 10_500 + remembers_month * 4_600
    free_egress_per_user = recalls_month * 8_000 + remembers_month * 4_000
    free_invocations_per_user = recalls_month * 2 + remembers_month * 8

    free_usage = {
        "database": free_count * free_db_per_user,
        "storage": free_count * blob_bytes_total,
        "egress": free_count * free_egress_per_user,
        "invocations": free_count * free_invocations_per_user,
        "mau": free_count,
    }

    metrics = {}
    all_ok = True
    for name in ("database", "storage", "egress", "invocations", "mau"):
        free_val = free_usage[name]
        wen_val = WEN_BASELINE[name]
        total = free_val + wen_val
        included = quotas[name]
        ok = total <= included
        if not ok:
            all_ok = False
        metrics[name] = {
            "free": free_val,
            "wen": wen_val,
            "total": total,
            "pro_included": included,
            "headroom": included - total,
            "ok": ok,
        }
    return all_ok, {"free_accounts": free_count, "free_plan": plan, "metrics": metrics, "ok": all_ok}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify N capped free accounts + Wen fit within Supabase Pro quotas.")
    parser.add_argument("--free", type=int, default=1000, help="Number of capped free accounts (default: 1000)")
    parser.add_argument("--json", action="store_true", help="Print JSON summary")
    args = parser.parse_args(argv)
    if args.free < 0:
        parser.error("--free must be >= 0")

    ok, report = evaluate(args.free)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"Supabase Pro margin check (--free {args.free}): {'PASS' if ok else 'FAIL'}")
        for name, m in report["metrics"].items():
            status = "OK" if m["ok"] else "OVER"
            print(
                f"  {name:<12} free={m['free']:>13,}  wen={m['wen']:>11,}  "
                f"total={m['total']:>13,}  pro={m['pro_included']:>13,}  "
                f"headroom={m['headroom']:>13,}  [{status}]"
            )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
