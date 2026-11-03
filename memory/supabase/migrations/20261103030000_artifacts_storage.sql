-- R20 and R42: artifacts in Storage, and short memories.
--
-- Small text blobs stay in memory.blob.content. Images, video, audio, PDFs, zipped skills and long text go to the private
-- Storage bucket memory-blobs under their sha256, with content null and stored = 'storage'. The setting blob_quota_bytes caps
-- all of it (blobs.ts has the 10 GiB default).
alter table memory.blob alter column content drop not null;
alter table memory.blob add column if not exists stored text not null default 'db' check (stored in ('db', 'storage'));

-- The bucket is private, with no policy on storage.objects, so only the function's service role reaches it. Where the
-- storage schema doesn't exist (a bare Postgres), the function runs with Storage off and nothing is needed.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit)
      values ('memory-blobs', 'memory-blobs', false, 524288000)
      on conflict (id) do update set public = false, file_size_limit = 524288000;
  end if;
end $$;

-- What the artifact is to its entry: image, video, audio, document, skill, artifact, data or other. Existing rows get the
-- kind blobs.ts kindOf gives their media type and name.
alter table memory.entry_blob add column if not exists kind text;
update memory.entry_blob x set kind = case
    when split_part(b.media_type, '/', 1) in ('image', 'video', 'audio') then split_part(b.media_type, '/', 1)
    when x.name ~* '(^|/)skill\.md$' then 'skill'
    when b.media_type = 'text/html' then 'artifact'
    when b.media_type = 'application/pdf' then 'document'
    when b.media_type in ('application/json', 'text/csv') then 'data'
    when split_part(b.media_type, '/', 1) = 'text' then 'document'
    else 'other' end
  from memory.blob b where b.sha256 = x.sha256 and x.kind is null;
alter table memory.entry_blob alter column kind set not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'memory.entry_blob'::regclass and conname = 'entry_blob_kind') then
    alter table memory.entry_blob add constraint entry_blob_kind
      check (kind in ('image', 'video', 'audio', 'document', 'skill', 'artifact', 'data', 'other'));
  end if;
end $$;

-- A file an agent was told where to PUT (upload_blob): what it declared, and who. remember checks the file against this
-- row, so a file bigger or smaller than declared is refused before it is read. At most 10 wait per device, and the sweep
-- drops what nobody cited after two hours.
create table if not exists memory.upload (
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  principal text not null,
  size integer not null check (size > 0),
  media_type text not null,
  created_at timestamptz not null default now(),
  primary key (principal, sha256));
create index if not exists upload_created on memory.upload (created_at);

-- Every hour pg_cron asks the memory function to delete uploads nobody cited (blobs.ts, /blobs/sweep). It carries the cron
-- secret from Vault.
select cron.unschedule('memory-blob-sweep') where exists (select 1 from cron.job where jobname = 'memory-blob-sweep');
select cron.schedule('memory-blob-sweep', '17 * * * *', $$
  select net.http_post(
    url := 'https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory/blobs/sweep',
    headers := jsonb_build_object('Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 60000)
$$);

-- hybrid.v4 and spreading.v4 are the v3 sets with each packet item's body cut to 500 characters ("… more in get_entry").
-- Not allocated here, so no recall is served by them until an allocation says so. v1 to v3 are unchanged.
insert into memory.param_set (id, arm, params, parent, note, created_by)
select replace(p.id, '.v3', '.v4'), p.arm, p.params || jsonb_build_object('itemChars', 500), p.id,
  'v3 with each packet item cut to 500 characters, so a recall of many items stays short.', 'migration'
from memory.param_set p where p.id in ('hybrid.v3', 'spreading.v3')
on conflict (id) do nothing;
