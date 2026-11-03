"""Write every memory table to stdout as NDJSON, one {table, row} per line, page by page through /export.

  MEMORY_BACKUP_TOKEN=... python memory/backup/export.py | gzip -9 > memory.ndjson.gz

The token comes from MEMORY_BACKUP_TOKEN or ~/.config/memory/backup-token. It exits non-zero when a table comes back
with fewer rows than the function counted before the export began, so a cut-off export never passes for a backup. Rows
written during the export may add to a table, never take from it.
"""
import json
import os
import sys
import urllib.request
from pathlib import Path

URL = os.environ.get("MEMORY_URL", "https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory") + "/export"
TOKEN = os.environ.get("MEMORY_BACKUP_TOKEN") or (Path.home() / ".config/memory/backup-token").read_text().strip()


def get(query=""):
    req = urllib.request.Request(URL + query, headers={"Authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.headers.get("x-rows"), r.read().decode("utf-8"), r.headers.get("x-truncated")


def main():
    total = 0
    for t in json.loads(get()[1])["tables"]:
        got, offset = 0, 0
        while True:
            rows, body, truncated = get(f"?table={t['table']}&offset={offset}")
            n = int(rows)
            if body.count("\n") != n:
                sys.exit(f"{t['table']} page at {offset} said {n} rows and carried {body.count(chr(10))}")
            sys.stdout.write(body)
            got += n
            offset += n
            # A blob page is cut by bytes as well as rows, so a short page only ends the table when it wasn't cut.
            if n < t["page"] and not truncated:
                break
        if got < t["rows"]:
            sys.exit(f"{t['table']}: exported {got} of {t['rows']} rows")
        total += got
    print(f"exported {total} rows", file=sys.stderr)


if __name__ == "__main__":
    main()
