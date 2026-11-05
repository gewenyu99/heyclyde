-- R29 (#33): an agent digs deeper when a recall misses. recall_more(retrieval_id) logs each page as a child retrieval of the recall
-- it pages past, with parent_id set and depth 'deep'. A recall with depth "deep" logs one row, depth 'deep' and no parent. Every
-- other recall is depth 'packet'.
alter table memory.retrieval add column if not exists parent_id uuid references memory.retrieval(id) on delete cascade;
alter table memory.retrieval add column if not exists depth text not null default 'packet';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'retrieval_depth_check' and conrelid = 'memory.retrieval'::regclass) then
    alter table memory.retrieval add constraint retrieval_depth_check check (depth in ('packet', 'deep'));
  end if;
end $$;
create index if not exists retrieval_parent on memory.retrieval (parent_id) where parent_id is not null;

-- A recall_more page that found nothing has no result to judge, so it waits for no feedback.
create or replace view memory.unanswered_recall as
  select r.id as retrieval_id, r.mcp_session, r.created_at
  from memory.retrieval r join memory.mcp_session s on s.id = r.mcp_session
  where s.client is distinct from 'http'
    and not (r.parent_id is not null and r.delivered = '[]'::jsonb)
    and not exists (select 1 from memory.feedback f where f.retrieval_id = r.id and f.source = 'agent');
