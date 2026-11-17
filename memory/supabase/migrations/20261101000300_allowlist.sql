-- memory is allowlist only. An email signs in to connect a computer only if it's here: the function checks before it
-- asks Supabase Auth to send a link, and again after the sign-in, and Supabase Auth itself takes no sign-ups.
create table if not exists memory.allowed_email (
  email text primary key check (email = lower(email)), added_at timestamptz not null default now());
insert into memory.allowed_email (email) values ('gewenyu99@gmail.com') on conflict do nothing;
delete from memory.setting where name = 'owner_email';
