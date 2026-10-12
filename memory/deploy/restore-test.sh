#!/bin/sh
# Monthly: restore the latest dump into a throwaway Postgres and check the entries came back. Touches nothing live.
set -eu
cd /opt/kb/deploy
. ./restic-env.sh

name=kb-restore-test
docker rm -f $name >/dev/null 2>&1 || true
image=$(docker compose images -q db | head -1)
docker run -d --name $name -e POSTGRES_PASSWORD=x -e POSTGRES_USER=kb -e POSTGRES_DB=kb "$image" >/dev/null
trap 'docker rm -f $name >/dev/null' EXIT
# Wait on TCP: during first boot the image runs a socket-only temporary server, then restarts.
until docker exec $name pg_isready -h 127.0.0.1 -U kb -d kb >/dev/null 2>&1; do sleep 1; done
restic dump --tag pg latest /kb.dump | docker exec -i $name pg_restore -h 127.0.0.1 -U kb -d kb --no-owner
n=$(docker exec $name psql -h 127.0.0.1 -U kb -d kb -tAc "select count(*) from entry")
echo "restored $n entries"
[ "$n" -gt 0 ]
