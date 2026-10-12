#!/bin/sh
# On the Droplet: start the stack, restore the latest backup (KB_RESTORE=1) or load the seed into an empty store, apply the schema and install the nightly backup.
# deploy.sh runs this over SSH. cloud-deploy.py runs it from cloud-init when SSH is out of reach.
set -e
cd /opt/kb/deploy
docker compose up -d --build
until docker compose exec -T db pg_isready -U kb -d kb >/dev/null 2>&1; do sleep 2; done
q() { docker compose exec -T db psql -U kb -d kb -tAc "$1"; }
# t once the store holds an entry. Plain assignments, so a psql failure stops the script under set -e.
seeded=$(q "select to_regclass('entry') is not null")
[ "$seeded" = f ] || seeded=$(q 'select exists (select 1 from entry)')
if [ -n "${KB_RESTORE:-}" ]; then
  # Rebuilding a box: the database is the store of record, so restore its latest backup rather than the seed.
  . ./restic-env.sh
  restic dump --tag pg latest /kb.dump | docker compose exec -T db pg_restore -U kb -d kb --no-owner
elif [ -f /opt/kb/seed-out/seed.sql ] && { [ -n "${KB_SEED:-}" ] || [ "$seeded" = f ]; }; then
  # The seed fills an empty store only. Its inserts skip rows that exist, so loading it again would bring back every
  # seed entry and link the console deleted. KB_SEED=1 loads it anyway, to import new vault entries.
  docker compose exec -T db psql -q -U kb -d kb -v ON_ERROR_STOP=1 < /opt/kb/seed-out/seed.sql
elif [ -f /opt/kb/seed-out/seed.sql ]; then
  echo "seed.sql skipped: the store has entries. KB_SEED=1 loads it anyway."
fi
docker compose exec -T db psql -q -U kb -d kb -v ON_ERROR_STOP=1 < /opt/kb/db/schema.sql
docker compose restart api
chmod +x /opt/kb/deploy/*.sh
( crontab -l 2>/dev/null | grep -v kb/deploy/backup.sh; echo "17 8 * * * /opt/kb/deploy/backup.sh >> /var/log/kb-backup.log 2>&1" ) | crontab -
docker compose ps
