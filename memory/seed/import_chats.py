#!/usr/bin/env python3
"""
Import chat exports (Grok, Codex, claude.ai, anything JSON/JSONL) into vault/_inbox/.

  python import_chats.py --source grok   path/to/export.json
  python import_chats.py --source codex  ~/.codex/sessions            # walks *.jsonl
  python import_chats.py --source claude path/to/conversations.json

Exports differ between tools and change over time, so this does NOT guess entries.
It walks every JSON object, keeps anything that looks like a message (a role/author
plus text), and writes one inbox line per message:
  {source, file, conversation, turn, role, ts, text, sha256}
Drafting entries from the inbox (decisions, observations, reactions) is the agent's job;
every draft quotes its inbox line, and nothing becomes `approved` until Wen confirms it.
Re-running is idempotent: lines are keyed by sha256 of (source, file, conversation, turn, text).
"""
import argparse, hashlib, json, os, sys
from pathlib import Path

ROLE_KEYS = ("role", "author", "sender", "speaker", "from")
TEXT_KEYS = ("text", "content", "message", "body", "value", "parts")
TS_KEYS = ("timestamp", "created_at", "create_time", "ts", "time", "date")
CONV_KEYS = ("conversation_id", "conversationId", "session_id", "id", "uuid")


def text_of(v):
    if isinstance(v, str): return v
    if isinstance(v, list): return "\n".join(t for t in (text_of(x) for x in v) if t)
    if isinstance(v, dict):
        for k in TEXT_KEYS:
            if k in v: return text_of(v[k])
    return ""


def role_of(o):
    for k in ROLE_KEYS:
        v = o.get(k)
        if isinstance(v, str): return v.lower()
        if isinstance(v, dict) and isinstance(v.get("role"), str): return v["role"].lower()
    return None


def walk(o, conv=None):
    if isinstance(o, dict):
        conv = next((str(o[k]) for k in CONV_KEYS if k in o and isinstance(o[k], (str, int))), conv)
        r = role_of(o)
        t = next((text_of(o[k]) for k in TEXT_KEYS if k in o), "")
        if r and t.strip():
            yield conv, r, next((str(o[k]) for k in TS_KEYS if k in o), None), t.strip()
        for v in o.values():
            if isinstance(v, (dict, list)): yield from walk(v, conv)
    elif isinstance(o, list):
        for v in o: yield from walk(v, conv)


def load(path):
    raw = path.read_text(encoding="utf-8", errors="replace")
    try:
        yield json.loads(raw); return
    except json.JSONDecodeError:
        pass
    for line in raw.splitlines():
        line = line.strip()
        if line:
            try: yield json.loads(line)
            except json.JSONDecodeError: continue


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="grok | codex | claude | <name>")
    ap.add_argument("paths", nargs="+")
    a = ap.parse_args()
    inbox = Path(os.environ.get("PKG_SEED_DIR", Path(__file__).resolve().parent)) / "vault" / "_inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    out = inbox / f"{a.source}.jsonl"
    seen = set()
    if out.exists():
        seen = {json.loads(l)["sha256"] for l in out.read_text(encoding="utf-8").splitlines() if l.strip()}
    files = []
    for p in map(Path, a.paths):
        p = p.expanduser()
        files += sorted(p.rglob("*.json*")) if p.is_dir() else [p]
    added = 0
    with out.open("a", encoding="utf-8") as f:
        for fp in files:
            turn = 0
            for doc in load(fp):
                for conv, role, ts, text in walk(doc):
                    turn += 1
                    key = hashlib.sha256(f"{a.source}|{fp.name}|{conv}|{turn}|{text}".encode()).hexdigest()
                    if key in seen: continue
                    seen.add(key); added += 1
                    f.write(json.dumps({"source": a.source, "file": str(fp), "conversation": conv, "turn": turn,
                                        "role": role, "ts": ts, "text": text, "sha256": key}, ensure_ascii=False) + "\n")
    print(f"{added} new messages -> {out}  ({len(files)} files)")


if __name__ == "__main__":
    sys.exit(main())
