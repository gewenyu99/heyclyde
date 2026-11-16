#!/bin/sh
# Fetch the Gemini API key (or read from --key <path>), pre-flight test it against the Decisions API before touching
# Vault, and store it as gemini_key via PUT /api/v1/secrets/gemini_key. Never prints secrets or passes them in argv.
set -eu

URL=${MEMORY_URL:-https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory}
GEMINI_URL=${MEMORY_GEMINI_URL:-https://generativelanguage.googleapis.com/v1beta}
ADMIN_TOKEN_FILE=${MEMORY_ADMIN_TOKEN_FILE:-$HOME/.config/memory/admin-token}
KEY_ID="066d1492-d58e-4c01-8cb1-70c88a0a74"
PROJECT="pennywhistle-site"
PREPAY_MSG="Add the \$5 minimum Prepay balance on billing account WS at https://aistudio.google.com/billing, then re-run."

KEY_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --key)
      [ $# -ge 2 ] || { echo "usage: $0 [--key <path>]" >&2; exit 2; }
      KEY_FILE=$2
      shift 2
      ;;
    *)
      echo "usage: $0 [--key <path>]" >&2
      exit 2
      ;;
  esac
done

umask 077
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if [ -n "$KEY_FILE" ]; then
  [ -r "$KEY_FILE" ] || { echo "Cannot read key file: $KEY_FILE" >&2; exit 1; }
  KEY=$(tr -d '\r\n' < "$KEY_FILE")
else
  KEY=$(CLOUDSDK_METRICS_REQUEST_ATTRIBUTION="agent-skills/1.0 (skill:gcloud; plugin:google-cloud-developer)" \
    gcloud services api-keys get-key-string "$KEY_ID" --project="$PROJECT" --format='value(keyString)' --verbosity=none --quiet | tr -d '\r\n')
fi

[ -n "$KEY" ] || { echo "Empty Gemini API key." >&2; exit 1; }

# Pre-flight 1-question check against Gemini Decisions API before touching Vault.
printf '%s' "$KEY" | python3 -c '
import json, sys
print("header = " + json.dumps("x-goog-api-key: " + sys.stdin.read()))
' > "$TMP/gemini.cfg"

STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -m 20 \
  -K "$TMP/gemini.cfg" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemini-decision-1","input":"ping","questions":{"ok":{"type":"noul","instructions":"Answer true."}}}' \
  "${GEMINI_URL%/}/decisions" || echo 000)

if [ "$STATUS" != "200" ]; then
  if [ "$STATUS" = "402" ]; then
    echo "$PREPAY_MSG" >&2
  else
    echo "Gemini Decisions API pre-flight failed (HTTP $STATUS)." >&2
    echo "$PREPAY_MSG" >&2
  fi
  exit 1
fi

[ -r "$ADMIN_TOKEN_FILE" ] || { echo "Cannot read admin token: $ADMIN_TOKEN_FILE" >&2; exit 1; }
ADMIN=$(tr -d '\r\n' < "$ADMIN_TOKEN_FILE")
[ -n "$ADMIN" ] || { echo "Empty admin token." >&2; exit 1; }

printf '%s' "$ADMIN" | python3 -c '
import json, sys
print("header = " + json.dumps("Authorization: Bearer " + sys.stdin.read()))
' > "$TMP/admin.cfg"
printf '%s' "$KEY" | python3 -c '
import json, sys
print(json.dumps({"value": sys.stdin.read()}))
' > "$TMP/secret.json"

curl -fsS -o /dev/null -X PUT \
  -K "$TMP/admin.cfg" \
  -H 'Content-Type: application/json' \
  --data-binary "@$TMP/secret.json" \
  "${URL%/}/api/v1/secrets/gemini_key"

unset KEY ADMIN
echo "Stored gemini_key."
