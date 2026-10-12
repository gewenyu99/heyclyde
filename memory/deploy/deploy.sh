#!/bin/sh
# Ship memory/ to the Droplet over SSH, then run deploy/install.sh there.
#   [KB_SEED=1] deploy/deploy.sh [path/to/pkg-seed/out]
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

# KB_SEED=1 loads seed.sql into a store that already has entries. See install.sh.
$SSH "${KB_SEED:+KB_SEED=1 }sh /opt/kb/deploy/install.sh"
echo "https://$KB_DOMAIN/healthz"
