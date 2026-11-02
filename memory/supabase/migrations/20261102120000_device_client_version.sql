-- The memory-hook version each computer last reported (R31), written with last_seen, so the console shows who has updated.
alter table memory.device add column if not exists client_version text;
