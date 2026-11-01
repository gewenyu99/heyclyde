"""Load a nightly backup back into memory, through the console API's import. No database credentials needed.

  gh run download <run-id> -n memory-<run-id>
  python memory/backup/restore.py memory.ndjson.gz.enc

The key comes from MEMORY_BACKUP_KEY or ~/.config/memory/backup-key, the admin token from MEMORY_ADMIN_TOKEN or
~/.config/memory/admin-token. Rows go in the order the export wrote them, parents first, under 4 MB a request. A row
whose key already exists is skipped, so a restore can run over a partly filled store. Embeddings aren't backed up, so the
next embed sync rebuilds them.
"""
import gzip
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

URL = os.environ.get("MEMORY_URL", "https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory")
CAP = 4 * 1024 * 1024


def secret(env, name):
    return os.environ.get(env) or (Path.home() / ".config/memory" / name).read_text().strip()


def lines(path):
    plain = subprocess.run(["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "600000", "-pass", "env:KEY",
                            "-in", path], env={**os.environ, "KEY": secret("MEMORY_BACKUP_KEY", "backup-key")},
                           capture_output=True, check=True).stdout
    return gzip.decompress(plain).decode("utf-8").splitlines(keepends=True)


def send(chunk, token, totals):
    req = urllib.request.Request(f"{URL}/api/v1/import", data="".join(chunk).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/x-ndjson"})
    with urllib.request.urlopen(req, timeout=120) as r:
        for table, n in json.load(r)["imported"].items():
            totals[table] = totals.get(table, 0) + n


def main(path):
    token, totals, chunk, size = secret("MEMORY_ADMIN_TOKEN", "admin-token"), {}, [], 0
    for line in lines(path):
        if chunk and size + len(line.encode()) > CAP:
            send(chunk, token, totals)
            chunk, size = [], 0
        chunk.append(line)
        size += len(line.encode())
    if chunk:
        send(chunk, token, totals)
    print(json.dumps({"imported": totals}))


if __name__ == "__main__":
    main(sys.argv[1])
