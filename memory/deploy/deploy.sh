#!/bin/sh
# Ship memory/ to the Droplet, start the stack, load the seed, apply the schema and install the nightly backup.
#   deploy/deploy.sh [path/to/pkg-seed/out]
# The seed directory is optional and private. It is copied straight to the Droplet and never into git.
set -eu
cd "$(dirname "$0")/.."
. deploy/.env
SEED_OUT=${1:-}
KEY=${KB_SSH_KEY:-$HOME/.ssh/kb_ed25519}
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new root@$KB_HOST"

$SSH 'cloud-init status --wait >/dev/null; mkdir -p /opt/kb/seed-out'
tar czf - --exclude=__pycache__ --exclude=deploy/.env db api deploy seed eval | $SSH 'tar xzf - -C /opt/kb'
$SSH 'umask 077; cat > /opt/kb/deploy/.env' < deploy/.env
if [ -n "$SEED_OUT" ]; then
  tar czf - -C "$SEED_OUT" . | $SSH 'tar xzf - -C /opt/kb/seed-out'
fi

$SSH 'set -e
cd /opt/kb/deploy
docker compose up -d --build
until docker compose exec -T db pg_isready -U kb -d kb >/dev/null 2>&1; do sleep 2; done
if [ -f /opt/kb/seed-out/seed.sql ]; then
  docker compose exec -T db psql -q -U kb -d kb -v ON_ERROR_STOP=1 < /opt/kb/seed-out/seed.sql
fi
docker compose exec -T db psql -q -U kb -d kb -v ON_ERROR_STOP=1 < /opt/kb/db/schema.sql
docker compose restart api
chmod +x /opt/kb/deploy/backup.sh /opt/kb/deploy/restore-test.sh
( crontab -l 2>/dev/null | grep -v kb/deploy/backup.sh; echo "17 8 * * * /opt/kb/deploy/backup.sh >> /var/log/kb-backup.log 2>&1" ) | crontab -
docker compose ps'
echo "https://$KB_DOMAIN/healthz"
