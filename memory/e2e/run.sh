#!/bin/sh
# memory's end-to-end test bed (R30, item 1). It makes a short-lived Supabase preview branch of the memory project,
# brings it up to this checkout (migrations, auth config, the function), seeds test credentials, runs suite.py against
# the branch's own function, and deletes the branch, even when something fails.
#
#   memory/e2e/run.sh                     # create a branch, test, delete it
#   E2E_BRANCH=e2e-dev memory/e2e/run.sh  # test on an existing branch, and leave it for its owner to delete
#
# Production is only ever the branch's parent: this script creates and deletes a branch of it, and nothing else. Every
# other command targets the branch's own ref, from a scratch copy of memory/supabase that is linked to nothing, and the
# script stops if that ref is production's.
#
# OpenAI is never called. The branch also gets fake-openai, a deterministic stand-in function, and memory's
# MEMORY_OPENAI_URL points at it. Generated tokens stay in a mode-700 temp dir that is removed at the end, and are never
# printed.
set -eu
PROD=wlhlncmgjqyidosunugv
REGION=${E2E_REGION:-ca-central-1}
HERE=$(cd "$(dirname "$0")" && pwd)
MEM=$(dirname "$HERE")
TMP=$(mktemp -d "${TMPDIR:-/tmp}/memory-e2e.XXXXXX")
chmod 700 "$TMP"
# Two scratch workdirs, so the CLI's cache never lands in the caller's folder: P for the commands on production's
# branch list (create, get, list, delete), W, a copy of memory/supabase, for everything aimed at the branch itself.
P=$TMP/parent
W=$TMP/work
mkdir -p "$P/supabase" "$W/supabase/functions"
STARTED=$(date +%s)

# Hide anything that could be a credential in tool output we show: passwords in URLs, JWTs, and the tokens we made.
mask() {
  python3 -u -c '
import re, sys, pathlib
secrets = []
for name in sys.argv[1:]:
    p = pathlib.Path(name)
    if p.exists():
        secrets += [l.split("=", 1)[1].strip().strip(chr(39)).strip(chr(34)) for l in p.read_text().splitlines() if "=" in l]
secrets = [s for s in sorted(set(secrets), key=len, reverse=True) if len(s) >= 8 and not s.startswith("http")]
for line in sys.stdin:
    if "new version of Supabase CLI" in line or "recommend updating" in line:
        continue
    for s in secrets:
        line = line.replace(s, "***")
    line = re.sub(r"://[^/@\s]+@", "://***@", line)
    line = re.sub(r"eyJ[\w-]+\.[\w-]+\.[\w-]+", "***", line)
    sys.stdout.write(line)' "$TMP/secrets.env" "$TMP/branch.sh"
}

log() { printf '[e2e %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# Run the Supabase CLI quietly. Its output is shown, masked, only when it fails.
sb() {
  if supabase "$@" >"$TMP/sb.log" 2>&1 </dev/null; then return 0; fi
  echo "supabase $1 $2 failed:" >&2
  mask <"$TMP/sb.log" >&2
  return 1
}

# SQL on the branch, through the CLI's login role. Never against production: REF is checked below.
q() { sb db query --linked --project-ref "$REF" --workdir "$W" "$@"; }

CREATED=
cleanup() {
  rc=$?
  trap - EXIT INT TERM HUP
  if [ -n "$CREATED" ]; then
    log "deleting branch $CREATED"
    for _ in 1 2 3; do
      supabase branches delete "$CREATED" --project-ref "$PROD" --workdir "$P" --yes >"$TMP/del.log" 2>&1 </dev/null || true
      if ! supabase branches list --project-ref "$PROD" --workdir "$P" -o json 2>/dev/null </dev/null | python3 -c '
import json, sys
t = sys.stdin.read(); d = json.loads(t[min(i for i in (t.find("{"), t.find("[")) if i >= 0):])
b = d["branches"] if isinstance(d, dict) else d
sys.exit(0 if any(x["name"] == sys.argv[1] for x in b) else 1)' "$CREATED"; then
        log "branch $CREATED deleted"
        break
      fi
      sleep 10
    done
  fi
  log "branch time: $(( ($(date +%s) - STARTED) / 60 )) min $(( ($(date +%s) - STARTED) % 60 )) s"
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

# 1. The branch.
NAME=${E2E_BRANCH:-e2e-$(date -u +%Y%m%d-%H%M%S)}
if [ -z "${E2E_BRANCH:-}" ]; then
  CREATED=$NAME  # set first, so a create that dies halfway still gets cleaned up
  log "creating branch $NAME of $PROD in $REGION"
  sb branches create "$NAME" --project-ref "$PROD" --workdir "$P" --region "$REGION"
else
  log "reusing branch $NAME (it stays when this ends)"
fi

log "waiting for the branch"
for i in $(seq 1 60); do
  if supabase branches get "$NAME" --project-ref "$PROD" --workdir "$P" -o env >"$TMP/branch.env" 2>/dev/null </dev/null \
    && grep -q '^SUPABASE_URL=' "$TMP/branch.env"; then break; fi
  [ "$i" = 60 ] && { echo "the branch never came up" >&2; exit 1; }
  sleep 10
done
# Re-quote the branch's values for sh, so a password with a $ in it stays a string.
python3 - "$TMP/branch.env" >"$TMP/branch.sh" <<'PY'
import shlex, sys
for line in open(sys.argv[1]):
    if "=" in line:
        k, v = line.rstrip("\n").split("=", 1)
        if k.isidentifier():
            print(f"{k}={shlex.quote(v.strip().strip(chr(34)))}")
PY
. "$TMP/branch.sh"
REF=$(printf '%s' "$SUPABASE_URL" | sed -E 's#^https://([a-z]{20})\.supabase\.co/?$#\1#')
case $REF in
  "$PROD") echo "refusing: the branch resolved to production" >&2; exit 1 ;;
  *[!a-z]* | "") echo "couldn't read the branch's ref" >&2; exit 1 ;;
esac
[ "${#REF}" = 20 ] || { echo "couldn't read the branch's ref" >&2; exit 1; }
URL=https://$REF.supabase.co/functions/v1/memory
log "branch ref $REF"

# A scratch copy of memory/supabase, linked to nothing, with fake-openai beside the memory function.
mkdir -p "$W/supabase/functions"
cp "$MEM/supabase/config.toml" "$W/supabase/"
cp -R "$MEM/supabase/migrations" "$MEM/supabase/templates" "$W/supabase/"
cp -R "$MEM/supabase/functions/memory" "$W/supabase/functions/memory"
cp -R "$HERE/fake-openai" "$W/supabase/functions/fake-openai"
# The same bake as memory/deploy.sh: the installer's files go into client/files.ts.
python3 - "$W/supabase/functions/memory/client" <<'PY'
import json, sys
from pathlib import Path
client = Path(sys.argv[1])
files = {p.name: p.read_text() for p in sorted(client.iterdir()) if p.name != "files.ts" and p.is_file()}
(client / "files.ts").write_text("// Generated by memory/e2e/run.sh.\n"
    f"export const FILES: Record<string, string> = {json.dumps(files, indent=2, ensure_ascii=False)};\n")
PY

# The migrations schedule pg_cron jobs that call production's function. On a branch they must call the branch's.
repoint() {
  q "select cron.alter_job(jobid, command := replace(command, 'https://$PROD.supabase.co', 'https://$REF.supabase.co'))
     from cron.job where command like '%$PROD%'"
}

# Supabase replays production's migration history onto a new branch, and its database answers before that's done.
# Wait for the replay, then for the database.
log "waiting for the branch's migrations"
for i in $(seq 1 90); do
  st=$(supabase branches list --project-ref "$PROD" --workdir "$P" -o json 2>/dev/null </dev/null | python3 -c '
import json, sys
t = sys.stdin.read(); d = json.loads(t[min(i for i in (t.find("{"), t.find("[")) if i >= 0):])
b = d["branches"] if isinstance(d, dict) else d
print(next((x["status"] for x in b if x["name"] == sys.argv[1]), "MISSING"))' "$NAME" || echo UNKNOWN)
  case $st in
    MIGRATIONS_PASSED | FUNCTIONS_DEPLOYED) break ;;
    *FAILED | MISSING) echo "the branch is $st" >&2; exit 1 ;;
  esac
  [ "$i" = 90 ] && { echo "the branch is still $st after 15 minutes" >&2; exit 1; }
  sleep 10
done
# The status can read done early, so also wait until the branch's migration history stops growing.
last=-1
for i in $(seq 1 60); do
  n=$(supabase db query --linked --project-ref "$REF" --workdir "$W" \
      "select count(*) as n from supabase_migrations.schema_migrations where exists (select 1 from cron.job)" 2>/dev/null </dev/null |
    python3 -c '
import json, sys
t = sys.stdin.read()
print(json.JSONDecoder().raw_decode(t[t.index("{"):])[0]["rows"][0]["n"])' 2>/dev/null || echo -1)
  [ "$n" -gt 0 ] && [ "$n" = "$last" ] && break
  last=$n
  [ "$i" = 60 ] && { echo "the branch's migrations never settled" >&2; exit 1; }
  sleep 10
done
log "branch status $st"
repoint

# 2. Migrations. The branch starts with production's migration history already applied. Production recorded it under
# other version numbers than the files here, so `db push` refuses it, and not every file is safe to rerun on a database
# that has the later ones (dashboard_views can't drop the columns dashboard_confidence added). So a file is applied
# when its name (the part after the version) isn't in the branch's history yet, and then recorded there.
log "applying migrations"
q "select name from supabase_migrations.schema_migrations"
applied=$(python3 -c '
import json, sys
t = open(sys.argv[1]).read()
print(" ".join(r["name"] for r in json.JSONDecoder().raw_decode(t[t.index("{"):])[0]["rows"]))' "$TMP/sb.log")
n=0
for f in "$W"/supabase/migrations/*.sql; do
  base=$(basename "$f" .sql); version=${base%%_*}; name=${base#*_}
  case " $applied " in *" $name "*) continue ;; esac
  log "  $base"
  q -f "$f" || { echo "migration $base failed" >&2; exit 1; }
  q "insert into supabase_migrations.schema_migrations (version, name) values ('$version', '$name') on conflict do nothing"
  n=$((n + 1))
done
log "  $n new, the rest were in production's history"
repoint

# 3. Auth config: no sign-ups, the OAuth server, the redirect URLs and the sign-in email template.
log "pushing auth config"
sb config push --project-ref "$REF" --workdir "$W" --yes

# 4. The functions, with the branch's own secrets. Supabase sets SUPABASE_URL, SUPABASE_DB_URL and the keys per project.
log "setting function secrets"
sb secrets set --project-ref "$REF" --workdir "$W" "MEMORY_OPENAI_URL=https://$REF.supabase.co/functions/v1/fake-openai" \
  "MEMORY_ARMS=${E2E_ARMS:-index,hybrid}"
log "deploying memory and fake-openai"
sb functions deploy memory fake-openai --project-ref "$REF" --workdir "$W" --no-verify-jwt --use-api

# 5. Seed what the suite needs, stored the way production stores it: an allowlisted test email (the only one, so the
# branch can never email Wen), three device tokens and an admin token as SHA-256, and a cron secret in Vault.
log "seeding test credentials"
python3 - "$TMP/secrets.env" "$TMP/seed.sql" <<'PY'
import hashlib, secrets, sys
names = ["DEVICE_TOKEN_A", "DEVICE_TOKEN_B", "INSTALL_TOKEN", "ADMIN_TOKEN", "CRON_SECRET"]
tok = {n: secrets.token_urlsafe(32) for n in names}
h = lambda s: hashlib.sha256(s.encode()).hexdigest()
open(sys.argv[1], "w").write("".join(f"{n}={v}\n" for n, v in tok.items()) + "TEST_EMAIL=e2e@example.com\n")
devices = [("e2e-a", "DEVICE_TOKEN_A"), ("e2e-b", "DEVICE_TOKEN_B"), ("e2e-install", "INSTALL_TOKEN")]
open(sys.argv[2], "w").write(f"""
delete from memory.allowed_email;
insert into memory.allowed_email (email) values ('e2e@example.com');
insert into memory.device (name, token_sha256, hooks) values
  {", ".join(f"('{d}', '{h(tok[t])}', 'full')" for d, t in devices)}
  on conflict (name) do update set token_sha256 = excluded.token_sha256, revoked_at = null, last_seen = null, created_at = now();
insert into memory.setting (name, value) values ('admin_token_sha256', '{h(tok["ADMIN_TOKEN"])}')
  on conflict (name) do update set value = excluded.value;
select vault.update_secret(id, '{tok["CRON_SECRET"]}') from vault.secrets where name = 'cron_secret';
select vault.create_secret('{tok["CRON_SECRET"]}', 'cron_secret') where not exists (select 1 from vault.secrets where name = 'cron_secret');
""")
PY
q -f "$TMP/seed.sql"
rm -f "$TMP/seed.sql"

log "waiting for the function"
for i in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$URL/healthz")" = 200 ] && break
  [ "$i" = 30 ] && { echo "$URL/healthz never answered 200" >&2; exit 1; }
  sleep 5
done

# 6. The suite.
log "running the suite against $URL"
# A pipe's status is its last command's, so suite.py leaves its own in a file.
E2E_URL=$URL E2E_REF=$REF E2E_WORKDIR=$W E2E_SECRETS=$TMP/secrets.env E2E_RC=$TMP/suite.rc \
  python3 -u "$HERE/suite.py" 2>&1 | mask
exit "$(cat "$TMP/suite.rc" 2>/dev/null || echo 1)"
