-- What each computer's hook has told the server (R31), written with last_seen so the console shows who has updated.
-- client_version: the memory-hook version it last reported. client_update_failed: whether its last self-update failed,
-- as of its last hook call. hook_seen: whether a hook has ever called, which tells a computer with hooks from one that
-- only uses MCP. The function tolerates a database that lacks them (auth.ts), and deploy.sh will not deploy before they exist.
alter table memory.device
  add column if not exists client_version text,
  add column if not exists client_update_failed boolean not null default false,
  add column if not exists hook_seen boolean not null default false;
