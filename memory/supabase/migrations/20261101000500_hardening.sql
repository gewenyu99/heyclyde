-- How much of a computer's hook payloads memory keeps. 'metadata' keeps the event, session, folder and tool name and
-- drops prompts and tool output, for work machines.
alter table memory.device add column if not exists hooks text not null default 'full' check (hooks in ('full', 'metadata'));
