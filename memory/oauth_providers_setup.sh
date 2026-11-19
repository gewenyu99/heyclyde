#!/bin/sh
# Configure Google and/or GitHub OAuth sign-in on Supabase Auth for project wlhlncmgjqyidosunugv.
# Reads credentials from environment variables only (never CLI flags or echoed output):
#   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
#   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
# Callback URL to register in Google Cloud Console and GitHub OAuth App settings:
#   https://wlhlncmgjqyidosunugv.supabase.co/auth/v1/callback
# The consent page (memory.heyclyde.me/oauth/consent) and the workspace (heyclyde.me) show each provider's button once it
# is on here. memory/SIGN-IN.md has the rest of the setup and the cases that need a live login.
set -eu

PROJECT=wlhlncmgjqyidosunugv
CALLBACK="https://${PROJECT}.supabase.co/auth/v1/callback"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ] || { [ -z "${GOOGLE_CLIENT_ID:-}" ] && [ -z "${GITHUB_CLIENT_ID:-}" ]; }; then
  cat <<EOF
Usage:
  GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... $0

Register this OAuth callback URL in Google Cloud Console and GitHub OAuth App settings:
  $CALLBACK

Supabase Auth's redirect allow list must also hold https://heyclyde.me/** (the workspace's
/auth/callback) and https://memory.heyclyde.me/oauth/approve** (the consent page). See memory/SIGN-IN.md.
EOF
  exit 0
fi

if [ -n "${GOOGLE_CLIENT_ID:-}" ] && [ -z "${GOOGLE_CLIENT_SECRET:-}" ]; then
  echo "oauth_providers_setup.sh: GOOGLE_CLIENT_SECRET is required with GOOGLE_CLIENT_ID." >&2
  exit 1
fi

if [ -n "${GITHUB_CLIENT_ID:-}" ] && [ -z "${GITHUB_CLIENT_SECRET:-}" ]; then
  echo "oauth_providers_setup.sh: GITHUB_CLIENT_SECRET is required with GITHUB_CLIENT_ID." >&2
  exit 1
fi

python3 - <<'PY'
import base64, json, os, subprocess, sys, urllib.error, urllib.request
from pathlib import Path

tok = ""
try:
    tok = subprocess.check_output(
        ["security", "find-generic-password", "-s", "Supabase CLI", "-w"],
        stderr=subprocess.DEVNULL, text=True,
    ).strip()
except Exception:
    pass
if not tok:
    p = Path.home() / ".supabase/access-token"
    if p.exists():
        tok = p.read_text().strip()
if tok.startswith("go-keyring-base64:"):
    tok = base64.b64decode(tok.split(":", 1)[1]).decode().strip()
if not tok:
    sys.exit("oauth_providers_setup.sh: no Supabase CLI token found. Run `supabase login` first.")

payload = {}
if os.environ.get("GOOGLE_CLIENT_ID"):
    payload.update({
        "external_google_enabled": True,
        "external_google_client_id": os.environ["GOOGLE_CLIENT_ID"],
        "external_google_secret": os.environ["GOOGLE_CLIENT_SECRET"],
    })
if os.environ.get("GITHUB_CLIENT_ID"):
    payload.update({
        "external_github_enabled": True,
        "external_github_client_id": os.environ["GITHUB_CLIENT_ID"],
        "external_github_secret": os.environ["GITHUB_CLIENT_SECRET"],
    })

req = urllib.request.Request(
    f"https://api.supabase.com/v1/projects/wlhlncmgjqyidosunugv/config/auth",
    data=json.dumps(payload).encode(),
    method="PATCH",
    headers={
        "Authorization": f"Bearer {tok}",
        "Content-Type": "application/json",
        "User-Agent": "supabase-cli/2.122.0",
    },
)
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        res = json.loads(r.read())
except urllib.error.HTTPError as e:
    sys.exit(f"oauth_providers_setup.sh: Supabase PATCH failed ({e.code}): {e.read().decode('utf-8', 'replace')}")

print(
    f"Updated auth providers: google={bool(res.get('external_google_enabled'))}, "
    f"github={bool(res.get('external_github_enabled'))}"
)
PY
