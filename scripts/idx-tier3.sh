#!/usr/bin/env bash
# Starts or reuses the supabase/postgres container from .github/workflows/harness.yml and runs Tier 3.
# Usage:
#   scripts/idx-tier3.sh                                    # full memory + Tier 3 suite
#   scripts/idx-tier3.sh test/memory/entitlement.test.ts    # single Tier 3 test file (<5s on a warm container)
#   scripts/idx-tier3.sh harness/test/memory/params_test.ts # single Deno unit test file
#   scripts/idx-tier3.sh --db-only                          # start/verify Postgres and print URL
#   scripts/idx-tier3.sh --stop                             # stop and remove the Postgres container
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Must match .github/workflows/harness.yml (enforced by harness/test/idx-workspace.test.ts).
POSTGRES_IMAGE="supabase/postgres:17.6.1.011"
CONTAINER_NAME="${MEMORY_TEST_PG_CONTAINER:-clyde-tier3-pg}"
PG_PORT="${MEMORY_TEST_PG_PORT:-5432}"
PG_PASSWORD="${MEMORY_TEST_PG_PASSWORD:-postgres}"
MAX_TRIES="${MEMORY_TEST_PG_RETRIES:-60}"
POLL_SEC="${MEMORY_TEST_PG_POLL_SEC:-1}"

case "${1:-}" in
  -h|--help)
    sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  --stop)
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    exit 0
    ;;
esac

DB_ONLY=0
if [ "${1:-}" = "--db-only" ]; then
  DB_ONLY=1
  shift
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "idx-tier3: Docker is not running. In Firebase Studio, check services.docker.enable = true in .idx/dev.nix." >&2
  exit 1
fi

state="$(docker inspect --format '{{.State.Running}} {{.Config.Image}}' "$CONTAINER_NAME" 2>/dev/null || true)"
if [ "$state" = "true $POSTGRES_IMAGE" ]; then
  :
elif [ "$state" = "false $POSTGRES_IMAGE" ]; then
  docker start "$CONTAINER_NAME" >/dev/null
else
  if [ -n "$state" ]; then
    docker rm -f "$CONTAINER_NAME" >/dev/null
  fi
  docker run -d \
    --name "$CONTAINER_NAME" \
    -e "POSTGRES_PASSWORD=$PG_PASSWORD" \
    -p "127.0.0.1:${PG_PORT}:5432" \
    "$POSTGRES_IMAGE" >/dev/null
fi

pg_ready() {
  if command -v pg_isready >/dev/null 2>&1; then
    pg_isready -h 127.0.0.1 -p "$PG_PORT" -U postgres >/dev/null 2>&1 || return 1
  else
    docker exec "$CONTAINER_NAME" pg_isready -h 127.0.0.1 -p 5432 -U postgres >/dev/null 2>&1 || return 1
  fi
  if command -v psql >/dev/null 2>&1; then
    [ "$(PGPASSWORD="$PG_PASSWORD" psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -d postgres -Atqc "select 1" 2>/dev/null || true)" = "1" ]
  else
    [ "$(docker exec -e "PGPASSWORD=$PG_PASSWORD" "$CONTAINER_NAME" psql -h 127.0.0.1 -U postgres -d postgres -Atqc "select 1" 2>/dev/null || true)" = "1" ]
  fi
}

try=0
until pg_ready; do
  try=$((try + 1))
  if [ "$try" -ge "$MAX_TRIES" ]; then
    echo "idx-tier3: Postgres ($POSTGRES_IMAGE) did not become ready after $MAX_TRIES checks." >&2
    docker logs --tail 50 "$CONTAINER_NAME" >&2 || true
    exit 1
  fi
  [ "$POLL_SEC" != "0" ] && sleep "$POLL_SEC"
done

DB_URL="${MEMORY_TEST_DATABASE_URL:-${MEMORY_TEST_DB_URL:-postgresql://postgres:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/postgres}}"
export MEMORY_TEST_DATABASE_URL="$DB_URL"
export MEMORY_TEST_DB_URL="$DB_URL"
export MEMORY_REQUIRE_DENO=1

if [ -z "${CHROME:-}" ]; then
  for candidate in chromium chromium-browser google-chrome google-chrome-stable "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    if resolved="$(command -v "$candidate" 2>/dev/null)" && [ -x "$resolved" ]; then
      export CHROME="$resolved"
      break
    elif [ -x "$candidate" ]; then
      export CHROME="$candidate"
      break
    fi
  done
fi
if [ -n "${CHROME:-}" ]; then
  export CHROME_BIN="${CHROME_BIN:-$CHROME}"
fi

if [ "$DB_ONLY" -eq 1 ]; then
  echo "MEMORY_TEST_DATABASE_URL=$MEMORY_TEST_DATABASE_URL"
  exit 0
fi

if [ ! -d "$ROOT/harness/node_modules" ]; then
  npm --prefix "$ROOT/harness" ci --ignore-scripts
fi

if [ "$#" -eq 0 ]; then
  deno test --allow-env --allow-read --node-modules-dir=none "$ROOT"/harness/test/memory/*_test.ts
  (cd "$ROOT" && python3 -m unittest memory/eval/test_retrieval_eval.py memory/research/test_research.py)
  exec npm --prefix "$ROOT/harness" run test:memory
fi

deno_files=()
node_args=()
for arg in "$@"; do
  if [[ "$arg" == *_test.ts ]]; then
    if [ -f "$ROOT/$arg" ]; then
      deno_files+=("$ROOT/$arg")
    else
      deno_files+=("$ROOT/harness/${arg#harness/}")
    fi
  elif [[ "$arg" == harness/* ]]; then
    node_args+=("${arg#harness/}")
  else
    node_args+=("$arg")
  fi
done

if [ "${#deno_files[@]}" -gt 0 ] && [ "${#node_args[@]}" -eq 0 ]; then
  exec deno test --allow-env --allow-read --node-modules-dir=none "${deno_files[@]}"
fi

if [ "${#deno_files[@]}" -gt 0 ]; then
  deno test --allow-env --allow-read --node-modules-dir=none "${deno_files[@]}"
fi

cd "$ROOT/harness"
exec node --test --test-concurrency=1 "${node_args[@]}"
