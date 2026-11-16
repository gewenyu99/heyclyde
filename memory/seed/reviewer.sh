#!/bin/sh
# R55 (#60): makes the store reviewers' demo account, review@heyclyde.me, once. Run it only with Wen's OK: it creates an
# account with a password in production.
#
# 1. A random 32-character password goes to ~/.config/memory/review-password (mode 600). It is never printed.
# 2. Supabase Auth's admin API makes the user, confirmed, with that password and no MFA factor.
# 3. The address joins memory.allowed_email on plan owner, so its account holds a comp entitlement (R50), and setting
#    reviewer_owner_id names it, so memory.reseed_reviewer() seeds its 40 notes now and nightly.
#
# Give the password to a reviewer only through the channel the store asks for (memory/listing/SUBMIT.md).
set -eu
cd "$(dirname "$0")/.."
PROJECT=wlhlncmgjqyidosunugv
EMAIL=review@heyclyde.me
PW_FILE=$HOME/.config/memory/review-password
[ -e "$PW_FILE" ] && { echo "reviewer.sh: $PW_FILE exists; the account is made. Delete it only to start over." >&2; exit 1; }
umask 077
openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32 > "$PW_FILE"
KEY=$(supabase projects api-keys --project-ref "$PROJECT" -o json | python3 -c '
import json, sys
print(next(k["api_key"] for k in json.load(sys.stdin) if k.get("name") == "service_role"))')
ID=$(python3 - "$PW_FILE" "$KEY" "$EMAIL" "$PROJECT" <<'PY'
import json, sys, urllib.request
pw, key, email, ref = open(sys.argv[1]).read().strip(), sys.argv[2], sys.argv[3], sys.argv[4]
req = urllib.request.Request(f"https://{ref}.supabase.co/auth/v1/admin/users", method="POST",
    data=json.dumps({"email": email, "password": pw, "email_confirm": True}).encode(),
    headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"})
print(json.load(urllib.request.urlopen(req, timeout=30))["id"])
PY
)
supabase db query --linked "insert into memory.allowed_email (email, plan) values ('$EMAIL', 'owner') on conflict (email) do update set plan = 'owner';
  insert into memory.account (owner_id, email, email_confirmed) values ('$ID', '$EMAIL', true)
    on conflict (owner_id) do update set email_confirmed = true;
  insert into memory.setting (name, value) values ('reviewer_owner_id', '$ID') on conflict (name) do update set value = excluded.value;
  select memory.reseed_reviewer() as entries" >/dev/null
echo "reviewer.sh: $EMAIL made (owner $ID), 40 notes seeded, password in $PW_FILE"
