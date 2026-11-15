-- R38 (#42): billing and entitlement. Who may use Clyde, on which plan, and how much. Plans are data: each plan and its
-- limits are one memory.plan row, so the Clyde design (memory/CLYDE-DESIGN.md) fills them in with SQL, never a deploy.
-- Wen, 2026-11-15: one paid plan, clyde, with included limits and pay-per-usage past them at a 50% gross margin over cost;
-- a free allocation for the first 1,000 users; Wen on the comp owner plan with no limits.
-- Billing stays dormant until a provider's secrets are in Vault and memory.setting open_signup = 'on' (BILLING.md):
-- until then only allowlisted emails sign in, exactly as before.

-- A plan. A null limit is no limit. open = false means a principal on this plan gets in nowhere (402 with a checkout
-- link). With overage, a limit is what the price includes: past it the call goes on, and its cost is metered as overage
-- (billing/limits.ts), up to overage_ceiling_micro_usd_month a month; without, the limit is a hard cap. seats caps how many
-- accounts the plan takes (the free plan's first 1,000). listed = true means it is sold at checkout, and the margin test
-- (harness/test/memory/limits.test.ts) holds it to margin_floor. product_ids maps a provider to its product id there.
create table if not exists memory.plan (
  id text primary key check (id ~ '^[a-z][a-z0-9_-]{1,30}$'),
  name text not null,
  price_micro_usd_month bigint not null default 0 check (price_micro_usd_month >= 0),
  open boolean not null default true,
  listed boolean not null default false,
  margin_floor numeric not null default 0.70 check (margin_floor between 0 and 1),
  recalls_month integer check (recalls_month >= 0),
  remembers_month integer check (remembers_month >= 0),
  blob_bytes_total bigint check (blob_bytes_total >= 0),
  openai_tokens_month bigint check (openai_tokens_month >= 0),
  connected_agents integer check (connected_agents >= 0),
  burst_calls integer check (burst_calls > 0),
  burst_seconds integer check (burst_seconds between 1 and 3600),
  artifacts boolean not null default true,
  overage boolean not null default false,
  overage_ceiling_micro_usd_month bigint check (overage_ceiling_micro_usd_month >= 0),
  seats integer check (seats >= 0),
  features jsonb not null default '{}'::jsonb,
  product_ids jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now());

-- The values memory/CLYDE-DESIGN.md set (R50 #55, R59 #64). free: the first 1,000 accounts, 300 recalls and 50 remembers a
-- month, no artifacts, 2 computers. clyde: $12.99 including 2,000 recalls, 500 remembers, 5 GiB of artifacts and 1.5M
-- OpenAI tokens, then overage to a $20 monthly ceiling; billing/cost.ts gives it 75.4% worst case, over its 0.75 floor.
-- owner: Wen's comp plan, no limits. All of it stays dormant until open_signup is on (BILLING.md).
insert into memory.plan (id, name, price_micro_usd_month, open, listed, margin_floor, recalls_month, remembers_month, blob_bytes_total,
    openai_tokens_month, connected_agents, burst_calls, burst_seconds, artifacts, overage, overage_ceiling_micro_usd_month, seats)
values
  ('free', 'Free', 0, true, false, 0.70, 300, 50, 0, null, 2, 20, 10, false, false, null, 1000),
  ('clyde', 'Clyde', 12990000, true, true, 0.75, 2000, 500, 5368709120, 1500000, 10, 20, 10, true, true, 20000000, null),
  ('owner', 'Owner', 0, true, false, 0.70, null, null, null, null, null, null, null, true, false, null, null)
on conflict (id) do nothing;

-- Allowlisted emails get in free, on their own plan: clyde's limits by default, Wen's owner plan none.
alter table memory.allowed_email add column if not exists plan text not null default 'clyde' references memory.plan (id);
update memory.allowed_email set plan = 'owner' where email = 'gewenyu99@gmail.com';

-- A signed-in person, by Supabase Auth user id. The owner id here is the seam for tenancy (R25): every billing row is keyed
-- by it, and R25 adds it to the data tables.
create table if not exists memory.account (
  owner_id uuid primary key,
  email text not null check (email = lower(email)),
  email_confirmed boolean not null default false,
  country text,
  region text,
  -- One of the free plan's seats, taken at sign-up while any are left.
  free_slot boolean not null default false,
  created_at timestamptz not null default now());

-- A device token belongs to the owner whose sign-in claimed it. Null is a device from before R38, which is Wen's.
alter table memory.device add column if not exists owner_id uuid;
create index if not exists device_owner on memory.device (owner_id) where owner_id is not null;

-- What a provider says an owner holds. state paid is access; anything else isn't. event_at is the newest event applied,
-- so an older one arriving late never re-grants.
create table if not exists memory.entitlement (
  owner_id uuid primary key,
  provider text not null,
  customer_id text,
  subscription_id text,
  plan text not null default 'clyde' references memory.plan (id),
  state text not null check (state in ('pending', 'paid', 'lapsed', 'refunded', 'blocked')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  refunded boolean not null default false,
  billing_country text,
  billing_region text,
  event_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());
create index if not exists entitlement_subscription on memory.entitlement (provider, subscription_id);

-- Each delivery applied once, by the provider's event id.
create table if not exists memory.billing_event (
  provider text not null,
  event_id text not null,
  type text not null,
  owner_id uuid,
  received_at timestamptz not null default now(),
  primary key (provider, event_id));

-- Each cancel or refund memory asked a provider for, once it succeeded, so a redelivery retries only what failed.
create table if not exists memory.billing_action (
  provider text not null,
  action text not null check (action in ('cancel', 'refund')),
  target text not null,
  done_at timestamptz not null default now(),
  primary key (provider, action, target));

-- An owner's counters: monthly ones by the first of the month, and running totals (blob_bytes_total) on 1970-01-01.
-- overage_micro_usd_month is the cost of what went past the plan's included limits; overage_reported_micro_usd_month is
-- how much of it the provider's usage meter has heard (POST /billing/usage/report).
create table if not exists memory.usage (
  owner_id uuid not null,
  period date not null,
  kind text not null check (kind in ('recalls_month', 'remembers_month', 'openai_tokens_month', 'blob_bytes_total',
    'overage_micro_usd_month', 'overage_reported_micro_usd_month')),
  amount bigint not null default 0,
  primary key (owner_id, period, kind));

-- The burst limiter: each owner's calls inside the window, shared by every instance.
create table if not exists memory.burst (
  owner_id uuid primary key,
  hits timestamptz[] not null default '{}');

-- Sign-ins started on the open consent page, for the per-address and per-email hourly caps.
create table if not exists memory.signup_attempt (
  id bigserial primary key,
  client text not null,
  email text not null,
  at timestamptz not null default now());
create index if not exists signup_attempt_at on memory.signup_attempt (at);

-- Where a 402 sends someone: this, with ?owner=<auth uid>. /billing/checkout makes the provider's checkout from it.
insert into memory.setting (name, value) values ('checkout_url', 'https://memory.heyclyde.me/billing/checkout')
  on conflict (name) do nothing;
insert into memory.setting (name, value) values ('checkout_plan', 'clyde') on conflict (name) do nothing;

-- Every hour, report each owner's new overage to the provider's usage meter. It does nothing until billing is set up.
select cron.unschedule('memory-usage-report') where exists (select 1 from cron.job where jobname = 'memory-usage-report');
select cron.schedule('memory-usage-report', '7 * * * *', $$
  select net.http_post(
    url := 'https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory/billing/usage/report',
    headers := jsonb_build_object('Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 60000)
$$);
