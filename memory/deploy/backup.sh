#!/bin/sh
# Nightly: pg_dump plus the seed directory, encrypted with restic, to DigitalOcean Spaces. Keeps 7 daily and 4 weekly.
set -eu
cd /opt/kb/deploy
. ./.env
export RESTIC_PASSWORD AWS_ACCESS_KEY_ID="$SPACES_KEY" AWS_SECRET_ACCESS_KEY="$SPACES_SECRET"
export RESTIC_REPOSITORY="s3:https://$SPACES_REGION.digitaloceanspaces.com/$SPACES_BUCKET/restic"

restic cat config >/dev/null 2>&1 || restic init
docker compose exec -T db pg_dump -U kb -Fc kb | restic backup --stdin --stdin-filename kb.dump --tag pg
[ -d /opt/kb/seed-out ] && restic backup /opt/kb/seed-out --tag seed
restic forget --keep-daily 7 --keep-weekly 4 --prune
