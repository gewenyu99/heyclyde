"""Write a snapshot of memory as JSON documents for the Memory Console page's database.

  python memory/console/snapshot.py <out_dir>

Reads through the function with the admin and backup tokens in ~/.config/memory. Writes one file per document:
stats.json, entries_<n>.json (100 entries each), links_<n>.json (300 each), recalls.json and activity.json.
"""
import json, os, sys, urllib.request
from pathlib import Path

URL = os.environ.get("MEMORY_URL", "https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory")
CFG = Path.home() / ".config/memory"


def get(path, token_file):
    req = urllib.request.Request(URL + path, headers={"Authorization": "Bearer " + (CFG / token_file).read_text().strip()})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode()


def table(name):
    rows, offset = [], 0
    while True:
        page = [json.loads(l)["row"] for l in get(f"/export?table={name}&offset={offset}", "backup-token").splitlines() if l]
        rows += page
        offset += len(page)
        if len(page) < (20 if name == "blob" else 2000):
            return rows


def main(out):
    out = Path(out); out.mkdir(parents=True, exist_ok=True)
    entries, links = table("entry"), table("link")
    title = {e["id"]: e["title"] for e in entries}
    replaced = {}
    for l in links:
        if l["type"] == "supersedes":
            replaced.setdefault(l["dst"], []).append(l["src"])
    served = {}
    for r in table("retrieval"):
        for eid in r["delivered"]:
            served[eid] = served.get(eid, 0) + 1
    nlinks = {}
    for l in links:
        for eid in (l["src"], l["dst"]):
            nlinks[eid] = nlinks.get(eid, 0) + 1
    rows = sorted(({"id": e["id"], "title": e["title"], "pattern": e["pattern"], "authority": e["authority"], "scope": e["scope"],
                    "sensitivity": e["sensitivity"], "valid_from": e["valid_from"], "project": title.get(e["project"], e["project"]),
                    "body": e["body"], "evidence_kind": e["evidence_kind"], "evidence": (e["evidence"] or "")[:2000],
                    "links": nlinks.get(e["id"], 0), "times_delivered": served.get(e["id"], 0),
                    "replaced_by": ", ".join(replaced.get(e["id"], [])) or None} for e in entries),
                  key=lambda r: (-r["times_delivered"], -r["links"], r["id"]))
    for i in range(0, len(rows), 100):
        (out / f"entries_{i // 100}.json").write_text(json.dumps({"rows": rows[i:i + 100]}, ensure_ascii=False))
    lrows = [{"src": l["src"], "src_title": title.get(l["src"], l["src"]), "type": l["type"], "dst": l["dst"],
              "dst_title": title.get(l["dst"], l["dst"])} for l in links]
    for i in range(0, len(lrows), 300):
        (out / f"links_{i // 300}.json").write_text(json.dumps({"rows": lrows[i:i + 300]}, ensure_ascii=False))
    rec = json.loads(get("/api/v1/retrievals?limit=100", "admin-token"))["items"]
    full = {}
    for r in rec[:100]:
        full[r["id"]] = r
    (out / "recalls.json").write_text(json.dumps({"rows": [{"created_at": r["created_at"], "arm": r["arm"], "client": r["client"],
        "query": r["query"], "latency_ms": r["latency_ms"], "degraded": r["degraded"], "delivered": r["delivered_count"]} for r in rec]}, ensure_ascii=False))
    act = json.loads(get("/api/v1/activity?days=30", "admin-token"))
    (out / "activity.json").write_text(json.dumps({"rows": [{"day": d["day"], "hooks": d["events"], "recalls": d["recalls"]} for d in act["days"]]}))
    ov = json.loads(get("/api/v1/overview", "admin-token"))
    c = ov["counts"]
    stats = {"entries": c["entries"], "links": c["links"], "recalls": c["recalls"], "events": c["events"], "computers": c["devices"],
             "embedded": ov["embeddings"]["embedded"], "tokens": ov["health"]["budget"]["used"], "last_hook": ov["last"]["hook"],
             "last_recall": ov["last"]["recall"], "taken_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(), "entry_docs": (len(rows) + 99) // 100, "link_docs": (len(lrows) + 299) // 300}
    (out / "stats.json").write_text(json.dumps(stats))
    print(json.dumps(stats))


if __name__ == "__main__":
    main(sys.argv[1])
