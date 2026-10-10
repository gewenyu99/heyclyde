#!/bin/sh
# On the Droplet after install.sh: wait for every entry to be embedded, run the retrieval eval, back up once and
# restore-test. cloud-deploy.py runs it from cloud-init. Over SSH, run it by hand.
set -eu
cd /opt/kb/deploy
q() { docker compose exec -T db psql -U kb -d kb -tAc "$1"; }
for _ in $(seq 360); do
  [ "$(q 'select count(*) from entry')" -gt 0 ] && \
  [ "$(q 'select count(*) from entry e left join entry_embedding x on x.entry_id = e.id where x.entry_id is null')" -eq 0 ] && break
  sleep 5
done
echo "entries $(q 'select count(*) from entry'), embedded $(q 'select count(*) from entry_embedding')"
docker compose logs api | tail -20

api=$(docker compose ps -q api)
docker cp /opt/kb/eval "$api":/tmp/eval
for split in test train; do
  echo "== retrieval_eval --split $split"
  docker compose exec -T -e PYTHONPATH=/app api python /tmp/eval/retrieval_eval.py --split $split --misses
done

echo "== backup"
./backup.sh
echo "== restore-test"
./restore-test.sh
