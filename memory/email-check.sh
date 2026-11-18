#!/bin/sh
# Verify Clyde's email DNS, Resend domain state, and Supabase Auth SMTP config.
# Subcommands:
#   dns          Public DNS checks (no secrets; run by CI)
#   resend       Resend domain & email-dns.json parity (needs RESEND_ADMIN_KEY)
#   auth-config  Supabase Auth SMTP & config.toml parity (needs SUPABASE_ACCESS_TOKEN)
set -eu
cd "$(dirname "$0")/.."

DNS_JSON="memory/email-dns.json"
CONFIG_TOML="memory/supabase/config.toml"
PROJECT_REF="wlhlncmgjqyidosunugv"
MODE="${1:-dns}"

strip_txt() {
  sed 's/" "//g; s/^"//; s/"$//'
}

check_dns() {
  [ -r "$DNS_JSON" ] || { echo "Missing $DNS_JSON" >&2; exit 1; }
  mismatches=0

  # 1. Every expected record in memory/email-dns.json resolves cleanly on 1.1.1.1.
  while IFS= read -r row; do
    rtype=$(printf '%s' "$row" | jq -r '.type')
    rname=$(printf '%s' "$row" | jq -r '.name')
    rval=$(printf '%s' "$row" | jq -r '.value')
    rprio=$(printf '%s' "$row" | jq -r '.priority // ""')
    out=$(dig @1.1.1.1 +short "$rtype" "$rname")
    case "$rtype" in
      TXT)
        norm=$(printf '%s\n' "$out" | strip_txt)
        if ! printf '%s\n' "$norm" | grep -Fxq -- "$rval"; then
          echo "DNS mismatch ($rtype $rname): expected '$rval', got '$norm'" >&2
          mismatches=$((mismatches + 1))
        fi
        ;;
      CNAME)
        expected="${rval%.}."
        if ! printf '%s\n' "$out" | grep -Fxq -- "$expected"; then
          echo "DNS mismatch ($rtype $rname): expected '$expected', got '$out'" >&2
          mismatches=$((mismatches + 1))
        fi
        ;;
      MX)
        expected="${rprio} ${rval%.}."
        if ! printf '%s\n' "$out" | grep -Fxq -- "$expected"; then
          echo "DNS mismatch ($rtype $rname): expected '$expected', got '$out'" >&2
          mismatches=$((mismatches + 1))
        fi
        ;;
      *)
        echo "Unsupported record type: $rtype" >&2
        mismatches=$((mismatches + 1))
        ;;
    esac
  done <<EOF
$(jq -c '.[]' "$DNS_JSON")
EOF

  # 2. Effective SPF on send.heyclyde.me (Resend Forge CNAME to rmta.net or legacy SES TXT).
  spf_ok=0
  for spf_host in $(jq -r '.[] | select(.record=="SPF") | .name' "$DNS_JSON"); do
    txt=$(dig @1.1.1.1 +short TXT "$spf_host" | strip_txt)
    if printf '%s\n' "$txt" | grep -q 'v=spf1'; then
      spf_ok=1
    fi
  done
  if [ "$spf_ok" -ne 1 ]; then
    echo "SPF check failed: no v=spf1 record resolved for send.heyclyde.me SPF hosts" >&2
    mismatches=$((mismatches + 1))
  fi

  # 3. Apex DMARC TXT record and Cloudflare Email Routing MX records.
  dmarc_lines=$(dig @1.1.1.1 +short TXT _dmarc.heyclyde.me | strip_txt | grep -v '^$' || true)
  dmarc_count=$(printf '%s\n' "$dmarc_lines" | grep -c '^' || true)
  if [ "$dmarc_count" -ne 1 ]; then
    echo "DMARC check failed: expected 1 TXT record on _dmarc.heyclyde.me, got $dmarc_count" >&2
    mismatches=$((mismatches + 1))
  else
    if ! printf '%s\n' "$dmarc_lines" | grep -Eq '^v=DMARC1; *p=(none|quarantine|reject)' ||
       ! printf '%s\n' "$dmarc_lines" | grep -Eq 'rua=mailto:[^;@ ]+@heyclyde\.me'; then
      echo "DMARC record missing required policy or rua on heyclyde.me: $dmarc_lines" >&2
      mismatches=$((mismatches + 1))
    fi
    today=$(date -u +%F)
    if [ ! "$today" \< "2026-12-02" ]; then
      if ! printf '%s\n' "$dmarc_lines" | grep -Eq 'p=(quarantine|reject)'; then
        echo "DMARC policy must be quarantine or reject on or after 2026-12-02 (got: $dmarc_lines)" >&2
        mismatches=$((mismatches + 1))
      fi
    fi
  fi

  cf_mx=$(dig @1.1.1.1 +short MX heyclyde.me | grep -c '\.mx\.cloudflare\.net\.$' || true)
  if [ "$cf_mx" -lt 1 ]; then
    echo "Apex MX check failed: expected >= 1 .mx.cloudflare.net. record on heyclyde.me" >&2
    mismatches=$((mismatches + 1))
  fi

  # 4. Sending records remain isolated to send.heyclyde.me, away from the apex.
  apex_leak=$( { dig @1.1.1.1 +short MX heyclyde.me; dig @1.1.1.1 +short TXT heyclyde.me; } | grep -ci -e amazonses.com -e resend -e rmta.net || true )
  if [ "$apex_leak" -ne 0 ]; then
    echo "Apex leak check failed: found sending host strings on apex heyclyde.me" >&2
    mismatches=$((mismatches + 1))
  fi

  echo "$mismatches mismatches"
  [ "$mismatches" -eq 0 ]
}

check_resend() {
  : "${RESEND_ADMIN_KEY:?Set RESEND_ADMIN_KEY}"
  domains_json=$(curl -fsS https://api.resend.com/domains -H "Authorization: Bearer $RESEND_ADMIN_KEY")
  printf '%s' "$domains_json" | jq -e '[.data[] | select(.name=="send.heyclyde.me" and .status=="verified")] | length == 1' >/dev/null
  domain_id=$(printf '%s' "$domains_json" | jq -r '.data[] | select(.name=="send.heyclyde.me") | .id')
  detail=$(curl -fsS "https://api.resend.com/domains/$domain_id" -H "Authorization: Bearer $RESEND_ADMIN_KEY")
  printf '%s' "$detail" | jq -e '(.records | map(select(.record=="SPF")) | length) >= 1 and (.records | map(select(.record=="DKIM")) | length) >= 1 and (.records | all(.status=="verified"))' >/dev/null

  mismatches=$(python3 - "$DNS_JSON" "$detail" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    expected = sorted(
        [(r["type"], r["name"], r["value"], r.get("priority")) for r in json.load(f)]
    )
raw = json.loads(sys.argv[2])["records"]
actual = sorted([
    (
        r["type"],
        r["name"] if r["name"].endswith("heyclyde.me") else f"{r['name']}.heyclyde.me",
        r["value"],
        r.get("priority"),
    )
    for r in raw
])
if expected == actual:
    print(0)
else:
    print("Expected:", expected, file=sys.stderr)
    print("Actual:", actual, file=sys.stderr)
    print(max(1, abs(len(expected) - len(actual)) + sum(1 for a, b in zip(expected, actual) if a != b)))
PY
)
  echo "$mismatches mismatches"
  [ "$mismatches" -eq 0 ]
}

check_auth_config() {
  : "${SUPABASE_ACCESS_TOKEN:?Set SUPABASE_ACCESS_TOKEN}"
  auth_json=$(curl -fsS "https://api.supabase.com/v1/projects/$PROJECT_REF/config/auth" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN")
  printf '%s' "$auth_json" | jq -e '
    .smtp_host == "smtp.resend.com"
    and (.smtp_port | tostring) == "465"
    and .smtp_user == "resend"
    and .smtp_admin_email == "clyde@send.heyclyde.me"
    and .smtp_sender_name == "Clyde"
    and (.rate_limit_email_sent >= 30 and .rate_limit_email_sent <= 100)
  ' >/dev/null

  mismatches=$(python3 - "$CONFIG_TOML" "$auth_json" <<'PY'
import json, re, sys

def parse_toml(path):
    secs = {}
    cur = ""
    with open(path) as f:
        for raw in f:
            line = re.sub(r'#(?=(?:[^"]*"[^"]*")*[^"]*$).*', "", raw).strip()
            if not line:
                continue
            m = re.match(r"^\[([^\]]+)\]$", line)
            if m:
                cur = m.group(1).strip()
                secs.setdefault(cur, {})
                continue
            kv = re.match(r"^([A-Za-z0-9_]+)\s*=\s*(.+)$", line)
            if kv and cur:
                val = kv.group(2).strip()
                if val.startswith('"') and val.endswith('"'):
                    val = val[1:-1]
                elif val == "true":
                    val = True
                elif val == "false":
                    val = False
                elif val.isdigit():
                    val = int(val)
                secs[cur][kv.group(1)] = val
    return secs

cfg = parse_toml(sys.argv[1])
live = json.loads(sys.argv[2])
smtp = cfg.get("auth.email.smtp", {})
rl = cfg.get("auth.rate_limit", {})
pairs = [
    ("smtp_host", smtp.get("host"), live.get("smtp_host")),
    ("smtp_port", str(smtp.get("port")), str(live.get("smtp_port"))),
    ("smtp_user", smtp.get("user"), live.get("smtp_user")),
    ("smtp_admin_email", smtp.get("admin_email"), live.get("smtp_admin_email")),
    ("rate_limit_email_sent", rl.get("email_sent"), live.get("rate_limit_email_sent")),
]
bad = 0
for name, a, b in pairs:
    if a != b:
        print(f"Auth mismatch for {name}: config.toml={a!r}, live={b!r}", file=sys.stderr)
        bad += 1
print(bad)
PY
)
  echo "$mismatches mismatches"
  [ "$mismatches" -eq 0 ]
}

case "$MODE" in
  dns) check_dns ;;
  resend) check_resend ;;
  auth-config) check_auth_config ;;
  *) echo "Usage: $0 {dns|resend|auth-config}" >&2; exit 2 ;;
esac
