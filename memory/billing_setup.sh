#!/bin/sh
# Set Polar up for Clyde (R38, #42, BILLING.md): the product for the plan, the webhook endpoint, and the secrets in
# Vault. Run it once per Polar organization, sandbox first. It is safe to rerun: it reuses a product or endpoint that is
# already there, and stores the secrets again.
#
#   POLAR_TOKEN=<organization access token> ./billing_setup.sh            # production, https://api.polar.sh
#   POLAR_TOKEN=<sandbox token> POLAR_API=https://sandbox-api.polar.sh MEMORY_URL=<branch function URL> ./billing_setup.sh
#
# The token is read from the environment and sent only to Polar and to memory's console API, which stores it in Vault as
# polar_api_token. Nothing secret is printed. The console token is ~/.config/memory/admin-token.
set -eu
: "${POLAR_TOKEN:?set POLAR_TOKEN to a Polar organization access token}"
POLAR_API=${POLAR_API:-https://api.polar.sh}
MEMORY_URL=${MEMORY_URL:-https://memory.heyclyde.me}
ADMIN=${MEMORY_ADMIN_TOKEN:-$(cat "$HOME/.config/memory/admin-token")}
PLAN=${PLAN:-clyde}
EVENTS='["subscription.created","subscription.active","subscription.updated","subscription.canceled","subscription.uncanceled","subscription.past_due","subscription.revoked","order.refunded"]'

polar() { curl -sS --fail-with-body -H "Authorization: Bearer $POLAR_TOKEN" -H 'content-type: application/json' "$@"; }
memory() { curl -sS --fail-with-body -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' "$@"; }

# The plan's price and name come from memory.plan, so the product matches what memory enforces.
plan=$(memory "$MEMORY_URL/api/v1/billing/plans" | jq -c --arg id "$PLAN" '.plans[] | select(.id == $id)')
[ -n "$plan" ] || { echo "billing_setup.sh: no plan $PLAN in memory.plan" >&2; exit 1; }
cents=$(printf '%s' "$plan" | jq '.price_micro_usd_month / 10000 | floor')
name=$(printf '%s' "$plan" | jq -r '.name')

product=$(polar "$POLAR_API/v1/products/?is_recurring=true&limit=100" | jq -r --arg n "$name" '[.items[] | select(.name == $n and .is_archived != true)][0].id // empty')
if [ -z "$product" ]; then
  product=$(polar -X POST "$POLAR_API/v1/products/" -d "$(jq -n --arg n "$name" --argjson c "$cents" \
    '{name: $n, recurring_interval: "month", prices: [{amount_type: "fixed", price_amount: $c, price_currency: "usd"}]}')" | jq -r .id)
  echo "created product $name ($product) at $cents cents a month"
else
  echo "product $name is $product"
fi

hook="$MEMORY_URL/billing/polar"
endpoint=$(polar "$POLAR_API/v1/webhooks/endpoints?limit=100" | jq -c --arg u "$hook" '[.items[] | select(.url == $u)][0] // empty')
if [ -z "$endpoint" ]; then
  endpoint=$(polar -X POST "$POLAR_API/v1/webhooks/endpoints" -d "$(jq -n --arg u "$hook" --argjson e "$EVENTS" '{url: $u, format: "raw", events: $e}')")
  echo "created webhook endpoint for $hook"
else
  echo "webhook endpoint for $hook exists"
fi
secret=$(printf '%s' "$endpoint" | jq -r '.secret // empty')
[ -n "$secret" ] || { echo "billing_setup.sh: Polar returned no webhook secret; reset it in the dashboard and rerun" >&2; exit 1; }

memory -X PUT "$MEMORY_URL/api/v1/secrets/polar_webhook_secret" -d "$(jq -n --arg v "$secret" '{value: $v}')" >/dev/null
memory -X PUT "$MEMORY_URL/api/v1/secrets/polar_api_token" -d "$(jq -n --arg v "$POLAR_TOKEN" '{value: $v}')" >/dev/null
memory -X PUT "$MEMORY_URL/api/v1/billing/plans/$PLAN" -d "$(jq -n --arg p "$product" '{product_ids: {polar: $p}}')" >/dev/null
echo "stored polar_webhook_secret and polar_api_token in Vault, and plan $PLAN sells product $product"
echo "next, in the Polar dashboard: a meter clyde_overage (sum of metadata.charge_micro_usd) and a metered price of"
echo "0.0001 cents per unit on $name. BILLING.md, Overage and the usage meter."
