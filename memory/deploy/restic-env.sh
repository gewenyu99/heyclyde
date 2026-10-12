# Sourced by the scripts that talk to the backup repo. Reads .env from the current directory.
. ./.env
export RESTIC_PASSWORD AWS_ACCESS_KEY_ID="$SPACES_KEY" AWS_SECRET_ACCESS_KEY="$SPACES_SECRET"
export RESTIC_REPOSITORY="s3:https://$SPACES_REGION.digitaloceanspaces.com/$SPACES_BUCKET/restic"
