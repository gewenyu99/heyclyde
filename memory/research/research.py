"""The research-memory skill's hands (R35). Holds the research token, from MEMORY_RESEARCH_TOKEN or
~/.config/memory/research-token, and never prints it. It holds no other credential: without the research token it exits 2.

  python3 memory/research/research.py bundle               # what to read: variants compared over 30 days, the guardrails' 7-day
                                                           #   rollup, the allocation and every parameter set
  python3 memory/research/research.py train <set>          # the train split under a set: gold hits, leaks, MRR and every miss
  python3 memory/research/research.py replay <set> [n]     # as-of replay of the latest n recalls (default 50) under a set
  python3 memory/research/research.py propose '<json>'     # a new set: {"id", "parent", "params", "note": "<hypothesis>"}
  python3 memory/research/research.py shadow <set>         # a research set into shadow (at most 2 shadows in all)
  python3 memory/research/research.py off <set>            # a research set back to off
  python3 memory/research/research.py log <comment.md> <run id>   # the run's comment on the open research-log issue, made if missing

The server enforces the limits: the research token reads the train split only, makes at most 3 sets a UTC week, each with a parent
and a hypothesis of 20 characters or more, and moves only its own sets, only to off or shadow.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "eval"))
import retrieval_eval  # noqa: E402

REPO = os.environ.get("MEMORY_RESEARCH_REPO", "gewenyu99/like-vincent")
LOG_TITLE = "memory research log"
LOG_LABEL = "research-log"


def research_token():
    """The research token, or exit 2. Nothing else stands in for it."""
    token = os.environ.get("MEMORY_RESEARCH_TOKEN", "").strip()
    path = Path.home() / ".config/memory/research-token"
    if not token and path.is_file():
        token = path.read_text().strip()
    if not token:
        print("research.py needs the research token in MEMORY_RESEARCH_TOKEN or ~/.config/memory/research-token "
              "(memory/DEPLOY.md, The research token).", file=sys.stderr)
        sys.exit(2)
    return token


def call(path, body=None, method=None):
    req = urllib.request.Request(f"{retrieval_eval.URL}/api/v1{path}", data=None if body is None else json.dumps(body).encode(),
                                 method=method or ("GET" if body is None else "POST"),
                                 headers={"Authorization": f"Bearer {retrieval_eval.token()}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            error = json.loads(e.read() or b"{}").get("error")
        except ValueError:
            error = None
        return {"error": error or f"HTTP {e.code}", "status": e.code}


def bundle():
    return {"compare": call("/variants/compare?days=30"), "guard": call("/variants/guard"),
            "allocation": call("/allocation"), "param_sets": call("/param-sets")}


def train(param_set):
    """The train split under one set. The split is fixed here: research never reads test."""
    report = retrieval_eval.run([], "train", params=param_set)
    (arm, r), = report.items()
    answerable = [p for p in r["per_query"] if p["gold_hit"] is not None]
    rr = [1 / p["gold_rank"] if p["gold_rank"] else 0 for p in answerable]
    return {"param_set": param_set, "arm": arm, "n": len(answerable), "gold_hits": sum(p["gold_hit"] for p in answerable),
            "leaks": sum(len(p["leaks"]) for p in r["per_query"]), "mrr": round(sum(rr) / len(rr), 4) if rr else None,
            "misses_by_stage": r["misses_by_stage"], "degraded": r["degraded"],
            "misses": [{"id": p["id"], "qtype": p["qtype"], "stage": p["stage"], "gold": p["gold"], "gold_rank": p["gold_rank"],
                        "text": p["text"]} for p in r["per_query"] if p["stage"]],
            "leaked": [{"id": p["id"], "leaks": p["leaks"], "text": p["text"]} for p in r["per_query"] if p["leaks"]]}


def allocate(param_set, role):
    return call("/allocation", {"rows": [{"param_set": param_set, "role": role, "weight": 0}]}, method="PUT")


def with_marker(comment, run):
    """The comment with its run's marker on top, once, so a run's comment can be found and counted."""
    marker = f"<!-- research-memory run {run} -->"
    return comment if marker in comment else f"{marker}\n{comment}"


def gh(*args):
    return subprocess.run(["gh", *args, "--repo", REPO], check=True, capture_output=True, text=True).stdout.strip()


def log(path, run):
    """Comment on the open research-log issue, making the label and the issue first when they're missing."""
    found = json.loads(gh("issue", "list", "--label", LOG_LABEL, "--state", "open", "--json", "number,url"))
    if found:
        number = found[0]["number"]
    else:
        subprocess.run(["gh", "label", "create", LOG_LABEL, "--repo", REPO, "--color", "5319e7",
                        "--description", "The weekly memory researcher's log (R35)"], capture_output=True, text=True)
        url = gh("issue", "create", "--title", LOG_TITLE, "--label", LOG_LABEL, "--body",
                 "The weekly research-memory run (R35, #39) comments here: what it read, the sets it proposed with their "
                 "hypotheses, their train results against the default, and what it moved to shadow. Live and default stay Wen's.")
        number = int(url.rstrip("/").rsplit("/", 1)[1])
    body = with_marker(Path(path).read_text(), run)
    url = gh("issue", "comment", str(number), "--body", body)
    return {"issue": number, "comment": url}


def main(argv):
    if not argv or argv[0] not in ("bundle", "train", "replay", "propose", "shadow", "off", "log"):
        sys.exit(__doc__)
    cmd, args = argv[0], argv[1:]
    if cmd == "log":
        out = log(*args)
    else:
        token = research_token()
        retrieval_eval.token = lambda: token
        if cmd == "bundle":
            out = bundle()
        elif cmd == "train":
            out = train(args[0])
        elif cmd == "replay":
            out = retrieval_eval.replay(args[0], int(args[1]) if len(args) > 1 else 50)
        elif cmd == "propose":
            out = call("/param-sets", json.loads(args[0]))
        else:
            out = allocate(args[0], cmd)
    print(json.dumps(out, ensure_ascii=False, indent=1))
    if isinstance(out, dict) and "error" in out:
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1:])
