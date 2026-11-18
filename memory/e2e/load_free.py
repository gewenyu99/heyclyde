#!/usr/bin/env python3
"""R66 (#71), Clyde slice C19: seed 1,000 free owners at their caps plus Wen's rows on an e2e preview branch,
check pg_database_size <= 5,000,000,000 bytes, and measure P95 latency of 200 recalls across 50 owners (<= 1,500 ms).

Invoked via: E2E_SCRIPT=load_free.py E2E_ARMS=hybrid sh memory/e2e/run.sh
Never run against production (wlhlncmgjqyidosunugv). Python stdlib only. Never prints a token.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

URL = os.environ["E2E_URL"].rstrip("/")
REF = os.environ["E2E_REF"]
WORKDIR = os.environ["E2E_WORKDIR"]
RC = os.environ.get("E2E_RC")
PROD = "wlhlncmgjqyidosunugv"
assert REF != PROD and PROD not in URL, "load_free.py runs on a branch, never on production"

FREE_OWNERS = int(os.environ.get("E2E_FREE_OWNERS", "1000"))
ENTRIES_PER_OWNER = int(os.environ.get("E2E_FREE_ENTRIES", "100"))
RECALLS_PER_OWNER = int(os.environ.get("E2E_FREE_RECALLS", "300"))
WRITES_PER_OWNER = int(os.environ.get("E2E_FREE_WRITES", "50"))
PROBE_OWNERS = int(os.environ.get("E2E_PROBE_OWNERS", "50"))
PROBE_RECALLS = int(os.environ.get("E2E_PROBE_RECALLS", "200"))
MAX_DB_BYTES = int(os.environ.get("E2E_MAX_DB_BYTES", "5000000000"))
P95_MS = float(os.environ.get("E2E_FREE_P95_MS", "1500"))
BATCH_OWNERS = int(os.environ.get("E2E_BATCH_OWNERS", "100"))

WEN_TARGET = {
    "entries": 1477,
    "retrievals": 1361,
    "events": 40445,
}
FREE_POOL_OWNER = "00000000-0000-0000-0000-00000000f4ee"


def log(msg: str) -> None:
    print(f"[load-free {time.strftime('%H:%M:%S', time.gmtime())}] {msg}", flush=True)


def sql(statement: str, timeout: int = 900):
    r = subprocess.run(
        ["supabase", "db", "query", "--linked", "--project-ref", REF, "--workdir", WORKDIR, statement],
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        timeout=timeout,
    )
    if r.returncode != 0:
        raise SystemExit(f"SQL on branch {REF} failed: {r.stderr.strip()[-500:]}")
    out = r.stdout
    return json.JSONDecoder().raw_decode(out[out.index("{"):])[0].get("rows", []) if "{" in out else []


def prepare_basis() -> None:
    sql("""
      insert into memory.setting (name, value) values ('embed_budget_tokens', '1000000000')
        on conflict (name) do update set value = excluded.value;
      delete from memory.usage
        where owner_id = '00000000-0000-0000-0000-00000000f4ee'::uuid
          and kind = 'free_pool_micro_usd_month';
      drop table if exists memory._r66_vecs;
      create table memory._r66_vecs (idx integer primary key, v extensions.halfvec(1024) not null);
      insert into memory._r66_vecs (idx, v)
      select i,
        ('[' || array_to_string(array(select round((random() - 0.5)::numeric, 4) from generate_series(1, 1024 + 0 * i)), ',') || ']')::extensions.halfvec(1024)
      from generate_series(0, 255) i;
    """)


def ensure_wen_rows() -> None:
    rows = sql("select value::uuid as wen_id from memory.setting where name = 'owner_id'")
    if not rows or not rows[0].get("wen_id"):
        raise SystemExit("memory.setting owner_id missing on branch")
    wen_id = rows[0]["wen_id"]
    cur = sql(f"""
      select
        (select count(*)::int from memory.entry where owner_id = '{wen_id}') as entries,
        (select count(*)::int from memory.entry_embedding where owner_id = '{wen_id}') as embeds,
        (select count(*)::int from memory.retrieval where owner_id = '{wen_id}') as retrievals,
        (select count(*)::int from memory.event where owner_id = '{wen_id}') as events
    """)[0]
    log(f"Wen rows currently on branch: {cur}")
    need_entries = max(0, WEN_TARGET["entries"] - int(cur["entries"]))
    need_retrievals = max(0, WEN_TARGET["retrievals"] - int(cur["retrievals"]))
    need_events = max(0, WEN_TARGET["events"] - int(cur["events"]))
    if need_entries > 0:
        sql(f"""
          insert into memory.entry (owner_id, id, pattern, title, body, authority, scope, sensitivity, lang, evidence_kind, evidence, kind)
          select '{wen_id}', 'wen-r66-' || g, 'observations', 'Wen note ' || g || ' deploy memory',
            'Body ' || g || ' covering deploys, migrations, oolong tea and release notes.', 'observed', 'global', 'normal', 'en', 'summary', 'seed', 'observation'
          from generate_series(1, {need_entries}) g
          on conflict (owner_id, id) do nothing;
        """)
    sql(f"""
      insert into memory.entry_embedding (owner_id, entry_id, model, content_sha256, embedding)
      select e.owner_id, e.id, 'text-embedding-3-large', 'r66-wen', v.v
      from memory.entry e
      join memory._r66_vecs v on v.idx = abs(hashtext(e.id)) % 256
      where e.owner_id = '{wen_id}'
      on conflict (owner_id, entry_id) do nothing;
    """)
    if need_retrievals > 0:
        sql(f"""
          insert into memory.retrieval (owner_id, id, arm, query, candidates, delivered, rejected, latency_ms)
          select '{wen_id}', gen_random_uuid(), 'hybrid', 'wen recall query ' || g,
            '[{{"id":"wen-r66-1","score":0.8}}]'::jsonb, '["wen-r66-1"]'::jsonb, '[]'::jsonb, 120
          from generate_series(1, {need_retrievals}) g;
        """)
    if need_events > 0:
        sql(f"""
          insert into memory.event (owner_id, session_id, event, payload, agent)
          select '{wen_id}', 'wen-sess-' || (g % 200), 'PostToolUse',
            '{{"tool_name":"recall","ok":true}}'::jsonb, 'claude'
          from generate_series(1, {need_events}) g;
        """)


def seed_free_owners() -> list[tuple[str, str]]:
    """Seed FREE_OWNERS free owners at caps and return [(owner_id, plaintext_token)] for the first PROBE_OWNERS."""
    probed: list[tuple[str, str]] = []
    tokens_by_idx: dict[int, tuple[str, str]] = {}
    for idx in range(PROBE_OWNERS):
        tok = "r66-" + secrets.token_hex(24)
        tokens_by_idx[idx] = (tok, hashlib.sha256(tok.encode()).hexdigest())

    for start in range(0, FREE_OWNERS, BATCH_OWNERS):
        end = min(FREE_OWNERS, start + BATCH_OWNERS)
        owner_values = []
        probe_sql = []
        usage_values = []
        for idx in range(start, end):
            oid = str(uuid.uuid4())
            email = f"r66-free-{idx}@example.com"
            owner_values.append(f"({idx}, '{oid}'::uuid, '{email}')")
            if idx < PROBE_OWNERS:
                tok, thash = tokens_by_idx[idx]
                probed.append((oid, tok))
                probe_sql.append(
                    f"('{oid}'::uuid, 'free-box-{idx}', '{thash}', 'none')"
                )
                probe_recall_usage = max(0, RECALLS_PER_OWNER - (PROBE_RECALLS // PROBE_OWNERS + 1))
                usage_values.append(f"('{oid}'::uuid, date_trunc('month', now() at time zone 'utc')::date, 'recalls_month', {probe_recall_usage})")
                usage_values.append(f"('{oid}'::uuid, date_trunc('month', now() at time zone 'utc')::date, 'remembers_month', {WRITES_PER_OWNER})")
            else:
                usage_values.append(f"('{oid}'::uuid, date_trunc('month', now() at time zone 'utc')::date, 'recalls_month', {RECALLS_PER_OWNER})")
                usage_values.append(f"('{oid}'::uuid, date_trunc('month', now() at time zone 'utc')::date, 'remembers_month', {WRITES_PER_OWNER})")

        probe_block = ""
        if probe_sql:
            probe_block = f"""
              insert into memory.device (owner_id, name, token_sha256, hooks) values {", ".join(probe_sql)};
              insert into memory.mcp_session (owner_id, id, arm, param_set, unit)
              select oid, 'http-global', 'hybrid', 'hybrid.v1', 'global'
              from owners where idx < {PROBE_OWNERS};
            """

        sql(f"""
          with owners(idx, oid, email) as (values {", ".join(owner_values)}),
          ins_acc as (
            insert into memory.account (owner_id, email, email_confirmed, free_slot)
            select oid, email, true, true from owners
            on conflict (owner_id) do update set free_slot = true
          ),
          ins_entry as (
            insert into memory.entry (owner_id, id, pattern, title, body, authority, scope, sensitivity, lang, evidence_kind, evidence, kind)
            select o.oid, 'free-' || g, 'observations',
              'Free note ' || g || ' oolong deploy flight garden',
              'Details ' || g || ' about coffee, deploy pipeline, vector scan and notes.',
              'observed', 'global', 'normal', 'en', 'summary', 'free seed', 'observation'
            from owners o cross join generate_series(1, {ENTRIES_PER_OWNER}) g
          ),
          ins_emb as (
            insert into memory.entry_embedding (owner_id, entry_id, model, content_sha256, embedding)
            select o.oid, 'free-' || g, 'text-embedding-3-large', 'r66', v.v
            from owners o
            cross join generate_series(1, {ENTRIES_PER_OWNER}) g
            join memory._r66_vecs v on v.idx = ((o.idx + g) % 256)
          ),
          ins_ret as (
            insert into memory.retrieval (owner_id, id, arm, query, candidates, delivered, rejected, latency_ms)
            select o.oid, gen_random_uuid(), 'hybrid', 'free query ' || g,
              '[{{"id":"free-1","score":0.7}}]'::jsonb, '["free-1"]'::jsonb, '[]'::jsonb, 95
            from owners o cross join generate_series(1, {RECALLS_PER_OWNER}) g
          ),
          ins_evt as (
            insert into memory.event (owner_id, session_id, event, payload, agent)
            select o.oid, 'free-sess-' || (g % 5), 'remember',
              '{{"tool_name":"remember"}}'::jsonb, 'claude'
            from owners o cross join generate_series(1, {WRITES_PER_OWNER}) g
          )
          insert into memory.usage (owner_id, period, kind, amount)
          values {", ".join(usage_values)}
          on conflict (owner_id, period, kind) do update set amount = excluded.amount;
          {probe_block}
        """)
        log(f"seeded free owners {start + 1}..{end}")
    return probed


def recall(token: str, query: str) -> tuple[int, float, str]:
    req = urllib.request.Request(
        URL + "/recall",
        data=json.dumps({"query": query}).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            r.read()
            elapsed = (time.perf_counter() - started) * 1000.0
            return r.status, elapsed, r.headers.get("server-timing") or ""
    except urllib.error.HTTPError as e:
        elapsed = (time.perf_counter() - started) * 1000.0
        return e.code, elapsed, e.read().decode()[:200]


def main() -> int:
    started = time.time()
    log(f"seeding {FREE_OWNERS} free owners ({ENTRIES_PER_OWNER} entries, {RECALLS_PER_OWNER} retrievals, {WRITES_PER_OWNER} writes) + Wen on {REF}")
    prepare_basis()
    ensure_wen_rows()
    probed = seed_free_owners()
    sql("drop table if exists memory._r66_vecs;")
    sql("analyze memory.entry; analyze memory.entry_embedding; analyze memory.retrieval; analyze memory.event;")

    stats = sql("""
      select
        pg_database_size(current_database())::bigint as db_bytes,
        (select count(*)::bigint from memory.account where free_slot) as free_accounts,
        (select count(*)::bigint from memory.entry) as entries,
        (select count(*)::bigint from memory.entry_embedding) as embeddings,
        (select count(*)::bigint from memory.retrieval) as retrievals,
        (select count(*)::bigint from memory.event) as events
    """)[0]
    db_bytes = int(stats["db_bytes"])
    log(
        f"seeded in {time.time() - started:.1f}s: db_bytes={db_bytes:,} (limit {MAX_DB_BYTES:,}), "
        f"free_accounts={stats['free_accounts']}, entries={stats['entries']:,}, embeddings={stats['embeddings']:,}, "
        f"retrievals={stats['retrievals']:,}, events={stats['events']:,}"
    )

    words = ["oolong", "deploy", "flight", "garden", "coffee", "vector", "notes", "pipeline", "scan", "memory"]
    warm_status, warm_ms, _ = recall(probed[0][1], "warm up free capacity isolate")
    log(f"warmup status={warm_status} in {warm_ms:.1f} ms")

    latencies: list[float] = []
    vec_times: list[float] = []
    failures = 0
    for i in range(PROBE_RECALLS):
        _, tok = probed[i % len(probed)]
        query = f"{words[i % len(words)]} {words[(i * 3) % len(words)]} {i}"
        status, ms, timing = recall(tok, query)
        if status != 200:
            failures += 1
            if failures <= 5:
                log(f"recall {i} failed: status={status} body={timing}")
            continue
        latencies.append(ms)
        m = re.search(r"vector;dur=([\d.]+)", timing)
        if m:
            vec_times.append(float(m.group(1)))

    if failures > 0 or len(latencies) < PROBE_RECALLS:
        log(f"FAIL: {failures} of {PROBE_RECALLS} recalls returned non-200")
        return 1

    latencies.sort()
    p50 = statistics.median(latencies)
    p95 = latencies[max(0, int(round(0.95 * len(latencies))) - 1)]
    vec_p95 = sorted(vec_times)[max(0, int(round(0.95 * len(vec_times))) - 1)] if vec_times else 0.0
    log(
        f"{len(latencies)} recalls across {len(probed)} free owners: "
        f"P50={p50:.1f} ms, P95={p95:.1f} ms (limit <= {P95_MS:.0f} ms), max={latencies[-1]:.1f} ms, "
        f"vector P95={vec_p95:.2f} ms"
    )
    ok = db_bytes <= MAX_DB_BYTES and p95 <= P95_MS
    return 0 if ok else 1


if __name__ == "__main__":
    rc = main()
    if RC:
        open(RC, "w").write(str(rc))
    sys.exit(rc)
