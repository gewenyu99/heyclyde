-- The unit a session's parameter set was drawn for (allocation.ts). A session row holds its draw only for that unit, so an
-- unscoped HTTP recall, which shares one session row across every device and day, redraws for each unit instead of keeping
-- the first caller's set. Rows from before this column have no unit and pin nothing. Idempotent.
alter table memory.mcp_session add column if not exists unit text;
