#!/bin/sh
# On the Droplet: start the stack, load the seed if present, apply the schema and install the nightly backup.
# deploy.sh runs this over SSH. cloud-deploy.py runs it from cloud-init when SSH is out of reach.
set -e
cd /opt/kb/deploy
docker compose up -d --build
until docker compose exec -T db pg_isready -U kb -d kb >/dev/null 2>&1; do sleep 2; done
if [ -f /opt/kb/seed-out/seed.sql ]; then
  docker compose exec -T db psql -q -U kb -d kb -v ON_ERROR_STOP=1 < /opt/kb/seed-out/seed.sql
fi
docker compose exec -T db psql -q -U kb -d kb -v ON_ERROR_STOP=1 < /opt/kb/db/schema.sql
docker compose restart api
chmod +x /opt/kb/deploy/*.sh
( crontab -l 2>/dev/null | grep -v kb/deploy/backup.sh; echo "17 8 * * * /opt/kb/deploy/backup.sh >> /var/log/kb-backup.log 2>&1" ) | crontab -
docker compose ps
