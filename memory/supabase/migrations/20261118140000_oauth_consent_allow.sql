-- Quest #37: hold a short-lived pending Allow decision before approving an MCP OAuth client.
alter table memory.oauth_consent
  add column if not exists pending_jwt text,
  add column if not exists pending_user jsonb,
  add column if not exists decision_token text,
  add column if not exists callback_uri text,
  add column if not exists direct boolean not null default false;

do $$
declare
  r text;
begin
  revoke all on table memory.oauth_consent from public;
  foreach r in array array['memory_tenant', 'anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table memory.oauth_consent from %I', r);
    end if;
  end loop;
end $$;
