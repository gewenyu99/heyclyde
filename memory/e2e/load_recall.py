#!/usr/bin/env python3
"""R49 (#54): recall's vector scan stays fast when one owner holds 10,000 notes among 99 others' 99,000.

run.sh runs it in place of suite.py with E2E_SCRIPT=load_recall.py, on a fresh preview branch, never production. It seeds
100 owners straight into the tables (one with E2E_LOAD_BIG notes, 99 with E2E_LOAD_SMALL each), every note with a random
halfvec(1024) embedding, gives the big owner a computer's token, and runs E2E_LOAD_RECALLS sequential hybrid recalls as that
owner. Each answer's Server-Timing carries a `vector;dur=<ms>` entry: the exact scan of that owner's vectors. It prints the
P50, P95 and max, and passes when the P95 is at most E2E_LOAD_P95_MS (50). Python stdlib only. It never prints a token.
"""
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
assert REF != PROD and PROD not in URL, "the load test runs on a branch, never on production"
BIG = int(os.environ.get("E2E_LOAD_BIG", "10000"))
SMALL = int(os.environ.get("E2E_LOAD_SMALL", "1000"))
OWNERS = int(os.environ.get("E2E_LOAD_OWNERS", "99"))
RECALLS = int(os.environ.get("E2E_LOAD_RECALLS", "100"))
P95_MS = float(os.environ.get("E2E_LOAD_P95_MS", "50"))


def log(msg):
    print(f"[load {time.strftime('%H:%M:%S', time.gmtime())}] {msg}", flush=True)


def sql(statement, timeout=900):
    r = subprocess.run(["supabase", "db", "query", "--linked", "--project-ref", REF, "--workdir", WORKDIR, statement],
                       capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=timeout)
    if r.returncode != 0:
        raise SystemExit(f"SQL on the branch failed: {r.stderr.strip()[-400:]}")
    out = r.stdout
    return json.JSONDecoder().raw_decode(out[out.index("{"):])[0].get("rows", []) if "{" in out else []


def seed(owner, n, tag):
    """n notes for owner, each with a random embedding, in one statement."""
    sql(f"""
      insert into memory.entry (owner_id, id, pattern, title, body, authority, scope, sensitivity, lang, evidence_kind, evidence, kind)
      select '{owner}', '{tag}-' || g, 'observations', 'Load note ' || g || ' about tea, code and travel',
        'Body ' || g || ' with words like oolong, deploy, flight and garden.', 'observed', 'global', 'normal', 'en', 'summary', 'load', 'observation'
      from generate_series(1, {n}) g;
      insert into memory.entry_embedding (owner_id, entry_id, model, content_sha256, embedding)
      select '{owner}', '{tag}-' || g, 'load', 'load',
        ('[' || array_to_string(array(select (random() - 0.5)::real from generate_series(1, 1024 + 0 * g)), ',') || ']')::extensions.halfvec(1024)
      from generate_series(1, {n}) g;""")


def recall(token, query):
    req = urllib.request.Request(URL + "/recall", data=json.dumps({"query": query}).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.headers.get("server-timing") or ""
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


def main():
    big = str(uuid.uuid4())
    email = f"load-{big[:8]}@example.com"
    token = "load-" + secrets.token_hex(24)
    started = time.time()
    log(f"seeding {BIG} notes for one owner and {SMALL} for each of {OWNERS} others")
    sql(f"""insert into memory.allowed_email (email, plan) values ('{email}', 'owner') on conflict do nothing;
      insert into memory.account (owner_id, email, email_confirmed) values ('{big}', '{email}', true);
      insert into memory.device (owner_id, name, token_sha256) values ('{big}', 'load-box', '{hashlib.sha256(token.encode()).hexdigest()}');
      insert into memory.mcp_session (owner_id, id, arm, param_set, unit) values ('{big}', 'http-global', 'hybrid', 'hybrid.v1', 'global');""")
    seed(big, BIG, "big")
    for i in range(OWNERS):
        seed(str(uuid.uuid4()), SMALL, f"o{i}")
    sql("analyze memory.entry; analyze memory.entry_embedding;")
    total = sql("select count(*) as n, count(distinct owner_id) as owners from memory.entry_embedding")[0]
    log(f"seeded in {time.time() - started:.0f}s: {total['n']} embeddings across {total['owners']} owners")
    words = ["oolong", "deploy", "flight", "garden", "tea", "code", "travel", "note", "body", "words"]
    times, misses = [], 0
    recall(token, "warm up the isolate")
    for i in range(RECALLS):
        status, timing = recall(token, f"{words[i % 10]} {words[(i * 3) % 10]} load {i}")
        m = re.search(r"vector;dur=([\d.]+)", timing)
        if status != 200 or not m:
            misses += 1
            log(f"recall {i}: {status} {timing[:120]}")
            continue
        times.append(float(m.group(1)))
    if len(times) < RECALLS * 0.95:
        log(f"only {len(times)} of {RECALLS} recalls carried a vector timing")
        return 1
    times.sort()
    p95 = times[max(0, int(round(0.95 * len(times))) - 1)]
    log(f"vector scan over {BIG} of {total['n']} embeddings, {len(times)} recalls: "
        f"P50 {statistics.median(times):.2f} ms, P95 {p95:.2f} ms, max {times[-1]:.2f} ms (limit P95 <= {P95_MS} ms)")
    return 0 if p95 <= P95_MS else 1


if __name__ == "__main__":
    rc = main()
    if RC:
        open(RC, "w").write(str(rc))
    sys.exit(rc)
