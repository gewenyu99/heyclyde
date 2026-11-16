# Billing and entitlement (R38, #42)

Clyde has **one paid plan, `clyde`**. Its price includes a set of limits, and use past them is billed per use at a fixed 50% gross margin over cost, net of Polar's percentage. There is also a **free allocation for the first 1,000 users**, and Wen is on the comp **`owner`** plan with no limits (Wen, 2026-11-15). There are no other tiers. All user-facing text says Clyde, never "memory".

Clyde sells through a merchant of record: **Polar** first, **Paddle** as the fallback. Polar is the legal seller, so it handles sales tax, VAT, invoices, refunds and chargebacks. It pays out to Wen's Canadian bank through Stripe Connect Express. It charges 5% + 50¢ a sale, 1.5% more on non-US cards, and nothing a month.

Billing is **dormant** until two things are true:

1. the provider's secrets are in Vault, and
2. `memory.setting open_signup = 'on'`.

Until then, sign-in works exactly as before: only allowlisted emails get in, and nobody is charged or sees a 402. Turn `open_signup` on only once tenancy (R25, #29) gives each owner their own memory. Without tenancy, a paying stranger would read Wen's.

## The access rule

Every agent and owner request whose credential has an **owner** (a Supabase Auth user id) goes through one check, `entitled()`, called from `authenticate()` in `auth.ts`. The owner gets a plan:

| The owner is | Plan |
|---|---|
| a confirmed email on `memory.allowed_email` | that row's `plan`. Wen's is `owner`, which has no limits. Others default to `clyde`, with its limits as hard caps and no overage. |
| holding an entitlement in state `paid` that hasn't ended | the entitlement's `plan` (`clyde`) |
| holding one of the free plan's seats (`memory.account.free_slot`, taken at sign-up while `plan.seats`, 1,000, lasts) | `free` |
| anyone else | none: 402 |

A plan with `open = false` gets nowhere. MCP `tools/call` and every HTTP route answer **402** with a `checkout_url`. MCP `initialize` and `tools/list` still answer 200, so a client like claude.ai can connect and show the link. A request from a blocked country gets **451** with no link, and so does an owner whose billing country was blocked.

Some credentials have no owner, and the check never runs for them: Wen's runtime, admin, research, backup and cron tokens, and devices claimed before R38.

The answer is cached per owner for `MEMORY_ENTITLEMENT_TTL_MS`, 60,000 ms by default. A revoke, refund, plan change or allowlist removal therefore reaches every instance within a minute. The instance that receives a webhook drops its own cached answer at once. A lookup that fails answers 503, so the check fails closed. Each response carries `Server-Timing: entitlement;dur=<ms>;desc="db"|"cache"`.

## Plans are data

Each tier is one row of `memory.plan`, and each limit is a column. A null limit means no limit.

| Column | Enforced as |
|---|---|
| `open` | false: 402 everywhere |
| `recalls_month`, `remembers_month` | MCP recall and `POST /recall`; MCP remember and `POST /entries`. Counted in `memory.usage`, reset on the 1st (UTC) |
| `openai_tokens_month` | Every OpenAI token a request spends, embeds and judges alike, lands on its owner's counter. At the cap, remember is refused and recall serves keyword ranks, degraded, spending nothing. |
| `blob_bytes_total` | Artifact bytes stored, a running total |
| `connected_agents` | Computers claimed with `POST /devices/claim` and not revoked |
| `burst_calls` / `burst_seconds` | A sliding window shared by every instance, counting MCP `tools/call`, `POST /entries` and `POST /recall`. Hooks are never counted. |
| `artifacts` | false: remember with artifacts, `get_blob`, `upload_blob` and `GET /blobs` refused |
| `features` | jsonb, for flags the design adds |
| `overage` | true (clyde): a limit is what the price includes. Past it, the call goes on and its cost goes to `overage_micro_usd_month`. That cost is invocations at $2/M, OpenAI tokens at the highest price, and storage at $0.0213/GB-month. Only subscribers are billed. An allowlisted owner on clyde gets hard caps. |
| `overage_ceiling_micro_usd_month` | The most overage a month may run up; then 429. Seeded at $20. |
| `seats` | How many accounts the plan takes. The free plan's 1,000. |
| `price_micro_usd_month`, `listed`, `margin_floor` | The cost test holds every listed plan to its margin floor |
| `product_ids` | `{"polar": "<product id>", "paddle": "<price id>"}` |

On a plan without overage, a paid owner past a cap gets **429**, naming the cap and its reset date, and a free owner gets **402** with the checkout link. Reads such as `get_entry`, `get_blob` and `check_messages` never count.

The seeded rows follow memory/CLYDE-DESIGN.md (R50 #55, R59 #64):

- **free** has 1,000 seats. Each month it allows 300 recalls and 50 remembers. It has no artifacts, allows 2 computers, and has no overage.
- **clyde** costs $12.99 and includes 2,000 recalls, 500 remembers, 5 GiB of artifacts, 1.5M OpenAI tokens and 10 computers, with 20 calls per 10 s. Past that, overage is billed up to a ceiling of $20 a month. It is `listed`, with a `margin_floor` of 0.75.
- **owner** has no limits.

## Overage and the usage meter

Every hour, pg_cron calls `POST /billing/usage/report` with the cron secret. For each subscriber whose `overage_micro_usd_month` is ahead of `overage_reported_micro_usd_month`, this month or last, it sends one Polar event, `clyde_overage`, with:

- `external_customer_id`: the owner
- `metadata.cost_micro_usd`: the cost
- `metadata.charge_micro_usd = ceil(cost / (1 - 0.50 - 0.065))`

After the 6.5% Polar takes, that charge leaves a 50% gross margin. Once Polar accepts the event, the delta is recorded as reported, and a failed one is retried next hour.

In Polar, set this up once:

1. A meter named `clyde_overage`. It filters on event name `clyde_overage` and sums `metadata.charge_micro_usd`.
2. A metered price on the Clyde product: $0.000001 per unit, which is 0.0001 cents.

Paddle has no meter here.

Change a tier with SQL or the console: `PUT /api/v1/billing/plans/<id>` with any of the columns. A change takes hold within the cache's minute, with no deploy. The Clyde design (memory/CLYDE-DESIGN.md) sets the real tiers.

**Margin, worst case:** this is one subscriber using every cap, all tokens priced at $0.13 per million, and Supabase Pro's $25 shared by 20 users. `billing/cost.ts` holds the model, and `harness/test/memory/limits.test.ts` checks it against the plan table:

| Plan | Payout fee on 1 subscriber | Payout fee shared by 20 |
|---|---|---|
| `clyde`: $12.99, 1.5M tokens and 5 GiB included | costs $5.34 (≤ $7.00 ✓) | costs $3.20, a **75.4%** margin (floor 0.75 ✓) |
| $10 with 4M tokens included (R38's first draft) | $5.35 | 67.9%, under 70%, so the design moved off it |

Overage carries its own margin of 50%, so it never lowers this one.

## Webhooks

`POST https://memory.heyclyde.me/billing/polar` (also `/billing/polar/webhook`) and `/billing/paddle`. These routes take no bearer token, only the provider's signature:

- **Polar** uses Standard Webhooks. The headers are `webhook-id`, `webhook-timestamp` and `webhook-signature: v1,<base64>`, an HMAC-SHA256 over `id.timestamp.body`. The key is the base64 after `whsec_`. Endpoints made before 2026-09-08 instead use the UTF-8 bytes of the whole secret, and memory tries both.
- **Paddle** uses `Paddle-Signature: ts=…;h1=<hex>` over `ts:body`.

A delivery is refused when:

- its signature is wrong or missing: 400
- its timestamp is more than 300 s from now, either way: 400
- its body is over 2,000,000 bytes: 413
- the webhook secret isn't in Vault: 503

Each event id applies once (`memory.billing_event`). An event older than the newest one applied for that owner never changes access. An event for an owner with no `memory.account` row is acknowledged with 200 and stores nothing.

| Polar event | Effect |
|---|---|
| `subscription.created` (incomplete) | pending, no access |
| `subscription.active`, `.updated`, `.uncanceled`; status active, trialing or past_due | paid. `past_due` keeps access while Polar retries the card. |
| `subscription.canceled` with `cancel_at_period_end` | paid until `current_period_end` |
| `subscription.revoked` | lapsed |
| `order.refunded`, fully refunded | refunded, and memory revokes the subscription, since a refund alone keeps billing it |
| `order.refunded`, partial | no change |

A subscription whose billing country is blocked is cancelled and refunded through the provider API, and its state becomes `blocked`. The account is marked with the country, its computers are deleted, and its next call gets 451. Each cancel and refund is recorded once it succeeds (`memory.billing_action`). If one fails, the webhook answers 500, and a redelivery retries only what failed.

## Blocked regions

`billing/regions.ts` holds the one list: the EU 27, Iceland, Liechtenstein, Norway, the UK and Switzerland, plus Quebec (`CA-QC`). Every check asks `isBlocked()`:

- sign-up on the consent page: 451, with nothing written and no email sent
- an unpaid tool call: 451 instead of the 402 and its link
- checkout: 451
- the webhook's billing country: cancel and refund

The country comes from Cloudflare. The Worker at memory.heyclyde.me overwrites `cf-ipcountry` and `cf-region-code` from `request.cf`, and the function trusts them only on requests that carry the proxy's secret. Unknown (`XX`) and Tor (`T1`) count as blocked. Polar's checkout takes no country restriction, so the webhook is the backstop for a VPN. Paddle's subscription payload has no address, so for Paddle the check stops at sign-up and checkout.

## Sign-up (open_signup on)

`/oauth/consent` asks for an email, then sends a Supabase OTP link with `create_user: true`. Limits:

- **3 emails an hour** to one address, from anywhere.
- **5 sign-ins an hour** from one client address.
- A sign-up straight to the function, not through memory.heyclyde.me, is refused with 403 unless the email is allowlisted.

Approving then works for any confirmed user. With `open_signup` off, the consent page emails only the single allowlisted address, as before.

## Checkout

The 402's link is the `checkout_url` setting (`https://memory.heyclyde.me/billing/checkout`) plus `?owner=<auth uid>`.

`GET /billing/checkout`:

1. checks the country (451).
2. checks that the owner has an account (404).
3. creates a Polar checkout with `external_customer_id = <owner>` for the plan's product. The plan is `?plan=`, else the `checkout_plan` setting, which defaults to `clyde`.
4. answers 302 to it.

While no product id or API token is set, it answers 503 "checkout isn't open yet". `billing_provider = paddle` in `memory.setting` switches checkout to Paddle.

## Tenancy seam (R25)

Everything billing stores is keyed by the owner's Supabase Auth user id. That id lives in `Principal.owner` in `auth.ts`:

- for an OAuth client's JWT, its `sub`
- for a sign-in, its `sub`
- for a device token, `memory.device.owner_id`, set by `/devices/claim`

`memory.account` maps the id to its email. Tenancy adds `owner_id` to the data tables and scopes every query by `Principal.owner`. It also extends the blocked-country delete in `billing/webhooks.ts` to the owner's entries, blobs, messages, retrievals and events. Until then, keep `open_signup` off.

## Secrets (Vault)

| Name | What |
|---|---|
| `gemini_key` | Gemini Decisions API (`gemini-decision-1`) judge key; requires $5 minimum Prepay balance on AI Studio billing, set via `./memory/hooks/set-gemini-key.sh` (falls back to `openai_key` / `gpt-6-luna` when absent) |
| `polar_api_token` | Organization access token: checkout, revoke, refund, list orders |
| `polar_webhook_secret` | The endpoint's `whsec_…` |
| `paddle_api_key`, `paddle_webhook_secret` | Only for the fallback |

Set any of these with `PUT /api/v1/secrets/<name> {"value": "…"}` and the admin token. `billing_setup.sh` sets the Polar ones for you.

Environment variables:

- `POLAR_API_URL`: `https://sandbox-api.polar.sh` for the sandbox.
- `PADDLE_API_URL`
- `MEMORY_ENTITLEMENT_TTL_MS`

## Setting it up

Wen does steps 1 to 4. Each needs an account or bank details, which only he can enter:

1. **Sandbox account.** Go to https://sandbox.polar.sh and sign up with GitHub or email. Create an organization, `heyclyde`. Sandbox accounts are separate from production ones.
2. **Sandbox token.** In the sandbox, go to Settings → Developers → **New token**. Name it `memory`, with no expiry, and tick these scopes:
   - `products:read`, `products:write`
   - `checkouts:write`
   - `subscriptions:read`, `subscriptions:write`
   - `orders:read`
   - `refunds:write`
   - `webhooks:read`, `webhooks:write`

   Copy the token.
3. **Production account.** Go to https://polar.sh, sign up, and create the organization `heyclyde`. Under Settings → **Payouts**, connect Stripe: choose Canada, an individual, and your bank account. Then make a token as in step 2, in production.
4. **Hand over the tokens.** In a terminal, run this for production:

   ```sh
   cd memory && POLAR_TOKEN='<paste the production token>' ./billing_setup.sh
   ```

   For the sandbox, against a Supabase branch's function URL:

   ```sh
   POLAR_TOKEN='<sandbox token>' POLAR_API=https://sandbox-api.polar.sh MEMORY_URL=<branch url> ./billing_setup.sh
   ```

   The script creates the `Clyde` product at the plan's price, and the webhook endpoint `https://memory.heyclyde.me/billing/polar`, subscribed to the eight events above. It stores `polar_webhook_secret` and `polar_api_token` in Vault and sets the plan's `product_ids`. Polar requires a price in the organization's default currency, which for Pennywhistle software is CAD, so the product also carries CAD 17.99 (`CAD_CENTS`), and the metered overage price needs a CAD price too. Production: product `b71524f6-d19b-4912-8fd7-7a830c79a142`, set up 2026-11-15.

The lead agent then checks the result. It reads `select count(*) from vault.decrypted_secrets where name in ('polar_api_token','polar_webhook_secret')`, which should return 2. It also lists Polar's products and webhook endpoints.

Opening for customers is a separate step, done after tenancy lands:

```sql
insert into memory.setting (name, value) values ('open_signup', 'on') on conflict (name) do update set value = 'on';
```

## Console API

All of these take the admin token.

- `GET /api/v1/billing/plans`
- `PUT /api/v1/billing/plans/<id>`: creates or updates a plan, with an audit row.
- `GET /api/v1/billing/entitlements[?state=paid]`: each account with its allowlist plan and subscription.
- `GET /api/v1/billing/usage/<owner>`: that owner's counters.
- `PUT /api/v1/secrets/<openai_key|gemini_key|polar_api_token|polar_webhook_secret|paddle_api_key|paddle_webhook_secret>`
- `POST /billing/usage/report`: cron secret only. Pg_cron calls it hourly.
