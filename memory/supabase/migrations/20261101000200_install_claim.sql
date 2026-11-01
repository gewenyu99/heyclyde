-- A new computer's sign-in in flight. The installer makes the id, the sign-in link lands its PKCE auth code here, and the
-- installer collects it once. The code alone signs nobody in: the exchange needs the verifier only the installer holds.
create table if not exists memory.install_claim (
  id text primary key, auth_code text, created_at timestamptz not null default now());
-- The one email whose sign-in may mint a device token.
insert into memory.setting (name, value) values ('owner_email', 'gewenyu99@gmail.com')
  on conflict (name) do update set value = excluded.value;
