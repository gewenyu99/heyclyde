-- R65 (#70), Clyde slice C18: connected OAuth apps tracking on account, and lapsed_at / lapse warning tracking
-- for 90-day lapsed account deletion (day 60 and day 83 email warnings, day 90 deletion).
-- Adds no new tables or views (preserves R48's exact 31 owned + 16 global table counts). Idempotent: safe to rerun.
set search_path = memory, extensions, public;

alter table memory.entitlement add column if not exists lapsed_at timestamptz;
alter table memory.entitlement add column if not exists lapse_emails_sent integer[] not null default '{}';

update memory.entitlement
set lapsed_at = coalesce(lapsed_at, event_at, updated_at, now())
where state = 'lapsed' and lapsed_at is null;

alter table memory.account add column if not exists oauth_apps jsonb not null default '{}'::jsonb;

select cron.unschedule('memory-lapse-cleanup') where exists (select 1 from cron.job where jobname = 'memory-lapse-cleanup');
select cron.schedule('memory-lapse-cleanup', '17 4 * * *', $$
  select net.http_post(
    url := 'https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory/billing/lapse',
    headers := jsonb_build_object('Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 60000)
$$);
