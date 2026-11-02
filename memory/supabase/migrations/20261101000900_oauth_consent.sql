-- Connecting memory to claude.ai (or any MCP client that signs in with OAuth). Supabase Auth's OAuth server runs the
-- protocol; the function stands in for the consent page, which Supabase can't serve as HTML. One row per sign-in in
-- flight: the PKCE verifier for the email link the function sent, and, once the owner clicks it, where the waiting
-- window goes next. Rows older than 15 minutes are dead.
create table if not exists memory.oauth_consent (
  authorization_id text primary key,
  code_verifier text not null,
  client_name text,
  redirect_url text,
  created_at timestamptz not null default now()
);
