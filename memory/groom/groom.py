"""The groom-memory skill's hands. Reads the admin token from ~/.config/memory/admin-token and never prints it.

  python memory/groom/groom.py sessions                       # Wen's prompts since the last groom, as JSON
  python memory/groom/groom.py draft '<json>'                 # new entry from his words: {title, body, pattern, scope,
                                                              #   project, quote, event_id, links?, supersedes?, sensitivity?}
  python memory/groom/groom.py reinforce <entry_id> <event_id> '<quote>'
  python memory/groom/groom.py checkpoint <through>           # mark everything up to that event as groomed
"""
import json, os, sys, urllib.error, urllib.request
from pathlib import Path

URL = os.environ.get("MEMORY_URL", "https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory") + "/api/v1/groom"
TOKEN = (Path.home() / ".config/memory/admin-token").read_text().strip()


def call(path, body=None):
    req = urllib.request.Request(URL + path, data=None if body is None else json.dumps(body).encode(),
                                 method="GET" if body is None else "POST",
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {"error": json.loads(e.read() or b"{}").get("error", f"HTTP {e.code}"), "status": e.code}


def main(cmd, *args):
    if cmd == "sessions":
        out = call("/sessions")
    elif cmd == "draft":
        out = call("/draft", json.loads(args[0]))
    elif cmd == "reinforce":
        out = call("/reinforce", {"entry_id": args[0], "event_id": args[1], "quote": args[2]})
    elif cmd == "checkpoint":
        out = call("/checkpoint", {"through": args[0]})
    else:
        sys.exit(__doc__)
    print(json.dumps(out, ensure_ascii=False, indent=1))
    sys.exit(1 if isinstance(out, dict) and "error" in out else 0)


if __name__ == "__main__":
    main(*(sys.argv[1:] or ["help"]))
