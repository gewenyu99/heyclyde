#!/bin/sh
# Nightly: pg_dump plus the seed directory, encrypted with restic, to DigitalOcean Spaces. Keeps 7 daily and 4 weekly.
set -eu
cd /opt/kb/deploy
. ./restic-env.sh

restic cat config >/dev/null 2>&1 || restic init
restic unlock  # clears locks left by a dead process or a destroyed Droplet. Live locks stay.
docker compose exec -T db pg_dump -U kb -Fc kb | restic backup --stdin --stdin-filename kb.dump --tag pg
[ -d /opt/kb/seed-out ] && restic backup /opt/kb/seed-out --tag seed
restic forget --keep-daily 7 --keep-weekly 4 --prune
