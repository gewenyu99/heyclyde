-- R19 and R41: agent profiles, and provenance on every memory. Idempotent: safe to rerun.
--
-- Every agent that uses memory over MCP can register once: who it is, where it runs, and whether it works on Wen's work, his
-- personal life, or both. Registration is gentle. An unregistered session works, and hears a one-line nudge until it
-- registers. Its notes' source and its messages carry its name.
create table if not exists memory.agent (
  name text primary key check (name ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  context text not null check (context in ('work', 'personal', 'both')),
  surface text not null,
  description text not null,
  registered_by text,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now());

-- The agent a credential and MCP client name last registered as, so its next session is that agent without asking again.
create table if not exists memory.agent_binding (
  principal text not null, client text not null, agent text not null references memory.agent(name) on delete cascade,
  updated_at timestamptz not null default now(), primary key (principal, client));

-- Which credential opened the session, and the agent it is. A deleted agent leaves its sessions unregistered.
alter table memory.mcp_client add column if not exists principal text;
alter table memory.mcp_client add column if not exists agent text references memory.agent(name) on delete set null;

-- Where a note came from, recorded by memory and never taken from the payload: the machine (the token's device), the agent
-- (its profile, else its client name), the agent's work context, the folder and repo the hooks reported for the session, the
-- MCP session, and the run scope. One row per entry, read by primary key.
create table if not exists memory.entry_provenance (
  entry_id text primary key references memory.entry(id) on delete cascade,
  device text not null,
  agent text not null,
  agent_context text,
  repo text,
  cwd text,
  session text,
  run_scope text,
  created_at timestamptz not null default now());
-- A hook that arrives after a write fills in the folder, by the session.
create index if not exists entry_provenance_session on memory.entry_provenance (session) where cwd is null;
