-- R67 (#72): whether an MCP session's client renders cards (MCP Apps). Set at initialize, read by tools/list and tools/call
-- in any isolate. A session from before this column is a coding app's: no cards.
alter table memory.mcp_client add column if not exists ui boolean not null default false;
