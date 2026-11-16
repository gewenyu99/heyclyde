-- R48 (#53): every owned table's row count, its rows with no owner, and its distinct owners, in one read-only statement.
-- Run it on production just before `supabase db push` applies 20261116000000_tenancy.sql and again just after: every count
-- matches (less rows written in between), no row lacks an owner, and each table has one owner, Wen's auth uid. Before the
-- migration most tables have no owner_id yet, so those columns read null.
with owned(t) as (values ('account'), ('admin_audit'), ('agent'), ('agent_binding'), ('blob'), ('board_seen'), ('burst'),
  ('co_use'), ('confidence_log'), ('device'), ('entitlement'), ('entry'), ('entry_blob'), ('entry_embedding'),
  ('entry_provenance'), ('event'), ('feedback'), ('judge_cache'), ('link'), ('mcp_client'), ('mcp_session'), ('message'),
  ('message_delivery'), ('quest'), ('quest_blob'), ('quest_note'), ('retrieval'), ('shadow_retrieval'), ('source'),
  ('upload'), ('usage')),
has as (
  select o.t, exists (select 1 from information_schema.columns c
    where c.table_schema = 'memory' and c.table_name = o.t and c.column_name = 'owner_id') as has_owner
  from owned o)
select h.t as table,
  (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from memory.%I', h.t), false, true, '')))[1]::text::bigint as rows,
  case when h.has_owner then (xpath('/row/n/text()', query_to_xml(
    format('select count(*) as n from memory.%I where owner_id is null', h.t), false, true, '')))[1]::text::bigint end as no_owner,
  case when h.has_owner then (xpath('/row/n/text()', query_to_xml(
    format('select count(distinct owner_id) as n from memory.%I', h.t), false, true, '')))[1]::text::bigint end as owners,
  case when h.has_owner then (xpath('/row/n/text()', query_to_xml(
    format('select string_agg(distinct owner_id::text, '','') as n from memory.%I', h.t), false, true, '')))[1]::text end as owner_ids
from has h order by h.t;
