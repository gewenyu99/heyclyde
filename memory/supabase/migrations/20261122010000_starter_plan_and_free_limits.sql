-- Add the hard-capped Starter plan ($2.99 USD/month) and tighten the Free demo tier.
-- Idempotent: safe to rerun; preserves product_ids on Starter so live Polar mappings stay intact.
set search_path = memory, extensions, public;

update memory.plan
set entries_total = 25,
    recalls_month = 50,
    remembers_month = 15,
    openai_tokens_month = 50000,
    blob_bytes_total = 0,
    connected_agents = 2,
    artifacts = false,
    quests = false,
    overage = false,
    overage_ceiling_micro_usd_month = null,
    seats = 1000,
    free_per_paid_n = 10,
    free_per_paid_m = 1,
    pool_spend_cap_micro_usd_month = 5000000,
    updated_at = now()
where id = 'free';

insert into memory.plan (
  id, name, price_micro_usd_month, open, listed, margin_floor,
  recalls_month, remembers_month, blob_bytes_total, openai_tokens_month,
  connected_agents, burst_calls, burst_seconds, overage, overage_ceiling_micro_usd_month,
  seats, artifacts, quests, entries_total
) values (
  'starter', 'Starter', 2990000, true, true, 0.20,
  600, 200, 524288000, 500000,
  3, 20, 10, false, null,
  null, true, false, 600
)
on conflict (id) do update set
  name = excluded.name,
  price_micro_usd_month = excluded.price_micro_usd_month,
  open = excluded.open,
  listed = excluded.listed,
  margin_floor = excluded.margin_floor,
  recalls_month = excluded.recalls_month,
  remembers_month = excluded.remembers_month,
  blob_bytes_total = excluded.blob_bytes_total,
  openai_tokens_month = excluded.openai_tokens_month,
  connected_agents = excluded.connected_agents,
  burst_calls = excluded.burst_calls,
  burst_seconds = excluded.burst_seconds,
  overage = excluded.overage,
  overage_ceiling_micro_usd_month = excluded.overage_ceiling_micro_usd_month,
  seats = excluded.seats,
  artifacts = excluded.artifacts,
  quests = excluded.quests,
  entries_total = excluded.entries_total,
  updated_at = now();
