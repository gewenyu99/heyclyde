-- Every 5 minutes pg_cron asks the memory function to embed what changed, so a write whose embedding failed gets one.
-- It carries the cron secret from Vault, which only /embeddings/sync takes.
select cron.unschedule('memory-embed-sync') where exists (select 1 from cron.job where jobname = 'memory-embed-sync');
select cron.schedule('memory-embed-sync', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory/embeddings/sync',
    headers := jsonb_build_object('Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb)
$$);
