#!/usr/bin/env bash
# Create, list, or revoke reusable Clyde partner unlimited invitations.
# Usage:
#   ./memory/partner_invite.sh --label "Partner name" [--from "Wen"] [--note "..."] [--max-uses N] [--days N] [--code custom-code]
#   ./memory/partner_invite.sh --list
#   ./memory/partner_invite.sh --revoke <code>
set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-wlhlncmgjqyidosunugv}"
MODE="create"
LABEL="Partner invite"
FROM="Wen"
NOTE=""
MAX_USES=""
DAYS=""
CODE=""
REVOKE_CODE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list) MODE="list"; shift ;;
    --revoke) MODE="revoke"; REVOKE_CODE="${2:?code required}"; shift 2 ;;
    --label) LABEL="${2:?label required}"; shift 2 ;;
    --from) FROM="${2:?from required}"; shift 2 ;;
    --note) NOTE="${2:?note required}"; shift 2 ;;
    --max-uses) MAX_USES="${2:?max-uses required}"; shift 2 ;;
    --days) DAYS="${2:?days required}"; shift 2 ;;
    --code) CODE="${2:?code required}"; shift 2 ;;
    -h|--help)
      sed -n '2,7p' "$0"
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

python3 - "$PROJECT_REF" "$MODE" "$LABEL" "$FROM" "$NOTE" "$MAX_USES" "$DAYS" "$CODE" "$REVOKE_CODE" <<'PY'
import base64, json, os, re, secrets, subprocess, sys, urllib.parse, urllib.request

project, mode, label, invited_by, note, max_uses, days, custom_code, revoke_code = sys.argv[1:10]

tok = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
if not tok:
    raw = subprocess.check_output(
        ["security", "find-generic-password", "-s", "Supabase CLI", "-w"], text=True
    ).strip()
    if raw.startswith("go-keyring-base64:"):
        tok = base64.b64decode(raw.split(":", 1)[1]).decode("utf-8").strip()
    else:
        tok = raw
if not tok:
    raise SystemExit("Missing SUPABASE_ACCESS_TOKEN and Supabase CLI keychain token.")

def run_sql(query):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{project}/database/query",
        data=json.dumps({"query": query}).encode(),
        headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json", "User-Agent": "curl/8.7.1"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())

def sq(s):
    return "'" + str(s).replace("'", "''") + "'"

if mode == "list":
    rows = run_sql(
        "select code, plan, label, invited_by, uses, max_uses, expires_at, revoked_at, created_at "
        "from memory.invite order by created_at desc limit 50"
    )
    if not rows:
        print("No partner invites found.")
        raise SystemExit(0)
    for r in rows:
        status = "REVOKED" if r.get("revoked_at") else "ACTIVE"
        cap = "unlimited" if r.get("max_uses") is None else str(r["max_uses"])
        print(f"[{status}] {r['code']}  uses={r['uses']}/{cap}  label={r['label']!r}  from={r['invited_by']!r}")
        if status == "ACTIVE":
            print(f"  https://heyclyde.me/invite?code={urllib.parse.quote(r['code'])}")
    raise SystemExit(0)

if mode == "revoke":
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$", revoke_code):
        raise SystemExit("Invalid invite code format.")
    rows = run_sql(
        f"update memory.invite set revoked_at = now() where code = {sq(revoke_code)} and revoked_at is null returning code, revoked_at"
    )
    if not rows:
        raise SystemExit(f"No active invite found for {revoke_code}")
    print(f"Revoked {rows[0]['code']} at {rows[0]['revoked_at']}")
    raise SystemExit(0)

code = custom_code.strip() if custom_code.strip() else ("partner-" + secrets.token_hex(8))
if not re.match(r"^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$", code):
    raise SystemExit("Code must be 8-64 URL-safe letters, digits, dashes, or underscores.")

max_uses_sql = "null"
if max_uses:
    n = int(max_uses)
    if n <= 0:
        raise SystemExit("--max-uses must be > 0")
    max_uses_sql = str(n)

expires_sql = "null"
if days:
    d = int(days)
    if d <= 0:
        raise SystemExit("--days must be > 0")
    expires_sql = f"now() + interval '{d} days'"

note_sql = sq(note) if note else "null"
rows = run_sql(
    f"insert into memory.invite (code, plan, label, invited_by, note, max_uses, expires_at) "
    f"values ({sq(code)}, 'partner', {sq(label)}, {sq(invited_by)}, {note_sql}, {max_uses_sql}, {expires_sql}) "
    f"returning code, plan, label, invited_by, max_uses, expires_at"
)
row = rows[0]
url = f"https://heyclyde.me/invite?code={urllib.parse.quote(row['code'])}"
print("Partner invite created:")
print("  URL:      ", url)
print("  Code:     ", row["code"])
print("  Plan:     ", row["plan"], "(unlimited)")
print("  Label:    ", row["label"])
print("  From:     ", row["invited_by"])
print("  Max uses: ", "unlimited" if row["max_uses"] is None else row["max_uses"])
print("  Expires:  ", row["expires_at"] or "never")
PY
