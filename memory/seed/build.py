#!/usr/bin/env python3
"""
Personal knowledge graph seed — bootstrap, validate, compile.

  python build.py bootstrap   # one-off: bootstrap/seed_source.yaml -> vault/ (refuses to overwrite)
  python build.py compile     # vault/ -> validate invariants -> out/ (JSONL, seed.sql, INDEX.md)

vault/ is the seed and import format (one Markdown file per entry, YAML front-matter, typed links).
Once loaded, the Postgres database on the Droplet is the store of record.
Everything in out/ is derived and can be deleted and rebuilt.

Invariants enforced by `compile` (from the memo + Wen's decisions):
  - every entry has a resolvable source and non-empty evidence (+ sha256 of the evidence text)
  - authority in {approved, observed, draft}; scope is global | domain:<x> | repo:<x>
  - no dangling links; link types from a fixed set; no self-links
  - supersession is acyclic; superseded_by is DERIVED from `supersedes` links, never stored
  - an approved entry may not be superseded by a draft
  - every non-project entry is part_of exactly one project
  - queries/probes reference existing entries; a query's must_not ids are superseded or draft
"""
import hashlib, json, os, re, sys
from collections import Counter, defaultdict
from pathlib import Path

import yaml

# PKG_SEED_DIR holds vault/, bootstrap/ and out/. The vault is private and never lives in this repo.
ROOT = Path(os.environ.get("PKG_SEED_DIR", Path(__file__).resolve().parent)).resolve()
VAULT, OUT, BOOT = ROOT / "vault", ROOT / "out", ROOT / "bootstrap" / "seed_source.yaml"
META = VAULT / "_meta"

AUTHORITY = {"approved", "observed", "draft"}
LINK_TYPES = {"supersedes", "supports", "contradicts", "derived_from", "relates", "part_of", "corrects"}
PATTERNS = {"projects", "decisions", "observations", "preferences", "recommendations", "references", "reactions"}
EVIDENCE_KINDS = {"quote", "assistant", "summary", "memory"}
SCOPE_RE = re.compile(r"^(global|domain:[a-z0-9-]+|repo:[A-Za-z0-9._/-]+)$")
FIELD_ORDER = ["id", "pattern", "title", "authority", "scope", "sensitivity", "lang", "valid_from",
               "source", "evidence_kind", "evidence", "evidence_sha256", "links"]


def sha(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- bootstrap
def bootstrap():
    if VAULT.exists() and any(VAULT.rglob("*.md")):
        sys.exit("vault/ already has entries; bootstrap refuses to overwrite canonical data.")
    data = yaml.safe_load(BOOT.read_text(encoding="utf-8"))
    META.mkdir(parents=True, exist_ok=True)
    for name in ("sources", "queries", "probes"):
        (META / f"{name}.yaml").write_text(
            yaml.safe_dump(data[name], allow_unicode=True, sort_keys=False, width=1000), encoding="utf-8")
    for e in data["entries"]:
        e.setdefault("sensitivity", "normal")
        e.setdefault("lang", "en")
        e.setdefault("links", [])
        e["valid_from"] = str(e["valid_from"])
        e["evidence_sha256"] = sha(e["evidence"])
        body = e.pop("body")
        fm = {k: e[k] for k in FIELD_ORDER if k in e}
        d = VAULT / e["pattern"]
        d.mkdir(parents=True, exist_ok=True)
        text = "---\n" + yaml.safe_dump(fm, allow_unicode=True, sort_keys=False, width=1000) + "---\n\n" + body.strip() + "\n"
        (d / f"{e['id']}.md").write_text(text, encoding="utf-8")
    print(f"bootstrapped {len(data['entries'])} entries into {VAULT}")


# ---------------------------------------------------------------- load
def load_vault():
    entries = {}
    for p in sorted(VAULT.rglob("*.md")):
        raw = p.read_text(encoding="utf-8")
        m = re.match(r"^---\n(.*?)\n---\n(.*)$", raw, re.S)
        if not m:
            raise SystemExit(f"{p}: missing front-matter")
        fm = yaml.safe_load(m.group(1))
        fm["body"] = m.group(2).strip()
        fm["path"] = str(p.relative_to(ROOT))
        fm["valid_from"] = str(fm["valid_from"])
        if fm["id"] in entries:
            raise SystemExit(f"duplicate id {fm['id']}")
        entries[fm["id"]] = fm
    meta = {n: yaml.safe_load((META / f"{n}.yaml").read_text(encoding="utf-8")) for n in ("sources", "queries", "probes")}
    return entries, meta


# ---------------------------------------------------------------- validate
def validate(entries, meta):
    errs = []
    sources = {s["id"]: s for s in meta["sources"]}
    links = []
    for e in entries.values():
        i = e["id"]
        if e["pattern"] not in PATTERNS: errs.append(f"{i}: bad pattern {e['pattern']}")
        if Path(e["path"]).parent.name != e["pattern"]: errs.append(f"{i}: file not under vault/{e['pattern']}/")
        if e["authority"] not in AUTHORITY: errs.append(f"{i}: bad authority")
        if not SCOPE_RE.match(e["scope"]): errs.append(f"{i}: bad scope {e['scope']}")
        if e.get("sensitivity", "normal") not in {"normal", "private"}: errs.append(f"{i}: bad sensitivity")
        if e["source"] not in sources: errs.append(f"{i}: unresolvable source {e['source']}")
        if e.get("evidence_kind") not in EVIDENCE_KINDS: errs.append(f"{i}: bad evidence_kind")
        if not str(e.get("evidence", "")).strip(): errs.append(f"{i}: empty evidence")
        elif e.get("evidence_sha256") != sha(e["evidence"]): errs.append(f"{i}: evidence_sha256 mismatch (evidence edited?)")
        if e["evidence_kind"] == "quote" and e["authority"] == "draft": errs.append(f"{i}: a quote of Wen cannot back a draft")
        parts = 0
        for l in e.get("links") or []:
            if l["type"] not in LINK_TYPES: errs.append(f"{i}: bad link type {l['type']}")
            if l["to"] not in entries: errs.append(f"{i}: dangling link -> {l['to']}")
            if l["to"] == i: errs.append(f"{i}: self-link")
            if l["type"] == "part_of":
                parts += 1
                if l["to"] in entries and entries[l["to"]]["pattern"] != "projects": errs.append(f"{i}: part_of non-project {l['to']}")
            links.append({"src": i, "dst": l["to"], "type": l["type"]})
        if e["pattern"] != "projects" and parts != 1: errs.append(f"{i}: needs exactly one part_of (has {parts})")

    sup = [(l["src"], l["dst"]) for l in links if l["type"] == "supersedes"]
    superseded_by = defaultdict(list)
    for s, d in sup:
        superseded_by[d].append(s)
        if s in entries and d in entries and entries[d]["authority"] == "approved" and entries[s]["authority"] == "draft":
            errs.append(f"{s}: a draft cannot supersede approved {d}")
    # acyclic supersession
    graph = defaultdict(list)
    for s, d in sup: graph[s].append(d)
    state = {}
    def dfs(n):
        state[n] = 1
        for m in graph[n]:
            if state.get(m) == 1: errs.append(f"supersession cycle through {n} -> {m}")
            elif m not in state: dfs(m)
        state[n] = 2
    for n in list(graph):
        if n not in state: dfs(n)

    for q in meta["queries"]:
        for g in q.get("gold", []) + q.get("must_not", []):
            if g not in entries: errs.append(f"query {q['id']}: unknown entry {g}")
        for g in q.get("must_not", []):
            if g in entries and not (superseded_by.get(g) or entries[g]["authority"] == "draft"):
                errs.append(f"query {q['id']}: must_not {g} is neither superseded nor draft")
        if q["qtype"] != "abstain" and not q.get("gold"): errs.append(f"query {q['id']}: no gold")
    for p in meta["probes"]:
        for g in p.get("governing", []):
            if g not in entries: errs.append(f"probe {p['id']}: unknown entry {g}")
        for c in p["checks"]:
            try: re.compile(c["pattern"])
            except re.error as ex: errs.append(f"probe {p['id']}: bad regex {c['pattern']}: {ex}")
    return errs, links, dict(superseded_by)


# ---------------------------------------------------------------- compile
def sql_str(v):
    if v is None: return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def compile_():
    entries, meta = load_vault()
    errs, links, superseded_by = validate(entries, meta)
    if errs:
        print("\n".join("ERROR " + e for e in errs)); sys.exit(1)
    OUT.mkdir(exist_ok=True)
    src_date = {s["id"]: str(s["date"]) for s in meta["sources"]}
    proj = {e["id"]: next((l["to"] for l in e.get("links") or [] if l["type"] == "part_of"), e["id"]) for e in entries.values()}

    rows = []
    for e in entries.values():
        r = {k: e.get(k) for k in FIELD_ORDER if k != "links"}
        r.update(body=e["body"], project=proj[e["id"]], superseded_by=sorted(superseded_by.get(e["id"], [])), path=e["path"])
        rows.append(r)
    write_jsonl(OUT / "entries.jsonl", rows)
    write_jsonl(OUT / "links.jsonl", [dict(l, weight=1.0) for l in links])
    write_jsonl(OUT / "sources.jsonl", [dict(s, date=str(s["date"])) for s in meta["sources"]])

    # time split: anything whose gold comes only from sources dated >= 2026-10-01 is test
    TEST_FROM = "2026-10-01"
    qrows = []
    for q in meta["queries"]:
        dates = [src_date[entries[g]["source"]] for g in q.get("gold", [])] or ["9999"]
        qrows.append(dict(q, lang=q.get("lang", "en"), must_not=q.get("must_not", []),
                          split="test" if min(dates) >= TEST_FROM else "train"))
    write_jsonl(OUT / "queries.jsonl", qrows)
    write_jsonl(OUT / "probes.jsonl", meta["probes"])

    # initial per-link-type weights (A2's learned parameters start at 1.0)
    pat = {e["id"]: e["pattern"] for e in entries.values()}
    ltw = Counter((pat[l["src"]], l["type"], pat[l["dst"]]) for l in links if l["type"] != "part_of")
    write_jsonl(OUT / "link_type_weights.jsonl",
                [{"src_pattern": a, "link_type": b, "dst_pattern": c, "n_links": n, "weight": 1.0}
                 for (a, b, c), n in sorted(ltw.items())])

    write_sql(rows, links, meta, qrows)
    write_index(rows)

    a = Counter(r["authority"] for r in rows); p = Counter(r["pattern"] for r in rows)
    print(f"OK  entries={len(rows)}  links={len(links)}  sources={len(meta['sources'])}  "
          f"queries={len(qrows)} (train {sum(q['split']=='train' for q in qrows)}, test {sum(q['split']=='test' for q in qrows)})  "
          f"probes={len(meta['probes'])}  link_type_weights={len(ltw)}")
    print("    authority:", dict(a)); print("    patterns:", dict(p))
    print("    superseded:", sum(1 for r in rows if r["superseded_by"]), " private:", sum(r["sensitivity"] == "private" for r in rows))


def write_jsonl(path, rows):
    with path.open("w", encoding="utf-8") as f:
        for r in rows: f.write(json.dumps(r, ensure_ascii=False) + "\n")


def write_sql(rows, links, meta, qrows):
    L = ["-- Derived from vault/ by build.py. Safe to drop and reload.",
         "-- create extension if not exists vector;  -- pgvector (chunk table, filled by the embedder)",
         "-- create extension if not exists pg_jieba; -- 中文 full-text search",
         "begin;",
         "create table if not exists source (id text primary key, kind text, title text, uri text, date date);",
         "create table if not exists entry (id text primary key, pattern text, title text, body text, authority text "
         "check (authority in ('approved','observed','draft')), scope text, sensitivity text, lang text, valid_from date, "
         "source_id text references source(id), evidence_kind text, evidence text, evidence_sha256 text, project text);",
         "create table if not exists link (src text references entry(id), dst text references entry(id), type text, "
         "weight real default 1.0, primary key (src, dst, type));",
         "create table if not exists question (id text primary key, text text, lang text, qtype text, split text, origin text);",
         "create table if not exists qrel (question_id text references question(id), entry_id text references entry(id), "
         "grade smallint, primary key (question_id, entry_id));  -- grade 2 = gold, -1 = must_not",
         "create or replace view entry_current as select e.* from entry e where not exists "
         "(select 1 from link l where l.dst = e.id and l.type = 'supersedes');"]
    for s in meta["sources"]:
        L.append(f"insert into source values ({sql_str(s['id'])},{sql_str(s['kind'])},{sql_str(s['title'])},{sql_str(s['uri'])},{sql_str(s['date'])}) on conflict do nothing;")
    for r in rows:
        vals = [r["id"], r["pattern"], r["title"], r["body"], r["authority"], r["scope"], r["sensitivity"], r["lang"],
                r["valid_from"], r["source"], r["evidence_kind"], r["evidence"], r["evidence_sha256"], r["project"]]
        L.append("insert into entry values (" + ",".join(sql_str(v) for v in vals) + ") on conflict do nothing;")
    for l in links:
        L.append(f"insert into link values ({sql_str(l['src'])},{sql_str(l['dst'])},{sql_str(l['type'])},1.0) on conflict do nothing;")
    for q in qrows:
        L.append(f"insert into question values ({sql_str(q['id'])},{sql_str(q['text'])},{sql_str(q['lang'])},{sql_str(q['qtype'])},{sql_str(q['split'])},{sql_str(q['origin'])}) on conflict do nothing;")
        for g in q.get("gold", []): L.append(f"insert into qrel values ({sql_str(q['id'])},{sql_str(g)},2) on conflict do nothing;")
        for g in q.get("must_not", []): L.append(f"insert into qrel values ({sql_str(q['id'])},{sql_str(g)},-1) on conflict do nothing;")
    L.append("commit;")
    (OUT / "seed.sql").write_text("\n".join(L) + "\n", encoding="utf-8")


def write_index(rows):
    by_proj = defaultdict(list)
    titles = {r["id"]: r["title"] for r in rows}
    for r in rows:
        if r["pattern"] != "projects": by_proj[r["project"]].append(r)
    L = ["# Knowledge index", "", "Generated by build.py — do not edit. One line per entry: `id` title [authority, scope].",
         "Drafts are Claude suggestions, never Wen's decisions. Struck-through entries are superseded.", ""]
    for pid in sorted(by_proj):
        L.append(f"## {titles[pid]} (`{pid}`)")
        for r in sorted(by_proj[pid], key=lambda r: (r["pattern"], r["id"])):
            t = f"~~{r['title']}~~ → {', '.join(r['superseded_by'])}" if r["superseded_by"] else r["title"]
            lock = " 🔒" if r["sensitivity"] == "private" else ""
            L.append(f"- `{r['id']}` {t} [{r['authority']}, {r['scope']}]{lock} — {r['path']}")
        L.append("")
    (OUT / "INDEX.md").write_text("\n".join(L), encoding="utf-8")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "compile"
    {"bootstrap": bootstrap, "compile": compile_}[cmd]()
