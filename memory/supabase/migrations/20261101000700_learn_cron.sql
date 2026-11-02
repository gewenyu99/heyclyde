-- Every 5 minutes pg_cron asks the memory function to learn from recalls it hasn't learned from yet (learn.ts). It
-- carries the cron secret from Vault, which only /learn and /embeddings/sync take.
select cron.unschedule('memory-learn') where exists (select 1 from cron.job where jobname = 'memory-learn');
select cron.schedule('memory-learn', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory/learn',
    headers := jsonb_build_object('Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 60000)
$$);
