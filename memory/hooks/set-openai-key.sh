#!/bin/sh
# Store the OpenAI key memory embeds with, in Supabase Vault. Paste it at the hidden prompt. It goes straight to the
# memory function under the admin token from ~/.config/memory/admin-token and is never written to disk.
set -eu
URL=${MEMORY_URL:-https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory}
ADMIN=$(cat "$HOME/.config/memory/admin-token")
printf 'OpenAI API key (input hidden): ' >/dev/tty
stty -echo </dev/tty; read -r KEY </dev/tty; stty echo </dev/tty; printf '\n' >/dev/tty
printf '{"value": "%s"}' "$KEY" | curl -fsS -X PUT "$URL/api/v1/secrets/openai_key" \
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" --data-binary @- && echo
unset KEY
curl -fsS -X POST "$URL/api/v1/embeddings/sync" -H "Authorization: Bearer $ADMIN" && echo
echo "Stored. Embedding sync started."
