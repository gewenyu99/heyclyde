-- Reusable partner invitations granting unlimited usage on the unlisted 'partner' comp plan.
-- Idempotent and least-privilege: memory.invite and memory.invite_redemption are service-role only.
set search_path = memory, extensions, public;

insert into memory.plan (
  id, name, price_micro_usd_month, open, listed, margin_floor,
  recalls_month, remembers_month, blob_bytes_total, openai_tokens_month,
  connected_agents, burst_calls, burst_seconds, overage, overage_ceiling_micro_usd_month,
  seats, artifacts, quests, entries_total
) values (
  'partner', 'Partner', 0, true, false, 0.70,
  null, null, null, null,
  null, null, null, false, null,
  null, true, true, null
)
on conflict (id) do update set
  name = excluded.name,
  price_micro_usd_month = 0,
  open = true,
  listed = false,
  recalls_month = null,
  remembers_month = null,
  blob_bytes_total = null,
  openai_tokens_month = null,
  connected_agents = null,
  burst_calls = null,
  burst_seconds = null,
  overage = false,
  overage_ceiling_micro_usd_month = null,
  seats = null,
  artifacts = true,
  quests = true,
  entries_total = null,
  updated_at = now();

-- Keep allowlist sync scoped to provider = 'comp' so partner invite entitlements (provider = 'invite') are preserved.
create or replace function memory.sync_comp(emails text[]) returns void language plpgsql security definer
  set search_path = memory, pg_temp as $$
begin
  delete from memory.entitlement e using memory.account a
  where e.owner_id = a.owner_id and e.state = 'comp' and e.provider = 'comp' and a.email = any(emails)
    and not (a.email_confirmed and exists (select 1 from memory.allowed_email al where al.email = a.email));
  insert into memory.entitlement (owner_id, provider, plan, state, event_at)
  select a.owner_id, 'comp', al.plan, 'comp', now()
  from memory.account a join memory.allowed_email al on al.email = a.email
  where a.email = any(emails) and a.email_confirmed
  on conflict (owner_id) do update set plan = excluded.plan, updated_at = now()
    where memory.entitlement.state = 'comp' and memory.entitlement.provider = 'comp'
      and memory.entitlement.plan is distinct from excluded.plan;
  update memory.account a set free_slot = false
  from memory.entitlement e where e.owner_id = a.owner_id and e.state = 'comp' and a.email = any(emails) and a.free_slot;
end $$;

create table if not exists memory.invite (
  code text primary key check (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'),
  plan text not null default 'partner' references memory.plan (id),
  label text not null default 'Partner invite',
  invited_by text not null default 'Wen',
  note text,
  max_uses integer check (max_uses is null or max_uses > 0),
  uses integer not null default 0 check (uses >= 0),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists memory.invite_redemption (
  code text not null references memory.invite (code) on delete cascade,
  owner_id uuid not null,
  email text not null,
  redeemed_at timestamptz not null default now(),
  primary key (code, owner_id)
);

do $$
declare
  r text;
begin
  revoke all on table memory.invite, memory.invite_redemption from public;
  foreach r in array array['memory_tenant', 'anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table memory.invite, memory.invite_redemption from %I', r);
    end if;
  end loop;
end $$;
