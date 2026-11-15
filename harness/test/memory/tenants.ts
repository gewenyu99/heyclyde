/**
 * Tier 3 support for R48 to R50 (#53 to #55): Clyde's tables, split into the 16 global ones and the 31 an owner holds, and
 * SQL that writes one row into every owned table for whoever memory.owner names. The SQL never names owner_id except on the
 * four billing tables whose key always was the owner, so it runs both before the tenancy migration (to check its backfill)
 * and after it (where each row's owner comes from memory.owner).
 */

export const GLOBAL_TABLES = [
  'setting', 'link_type_weight', 'param_set', 'allocation', 'auth_miss', 'question', 'qrel', 'allowed_email', 'plan',
  'billing_event', 'billing_action', 'signup_attempt', 'oauth_consent', 'install_claim', 'openai_usage', 'embed_usage',
]

export const OWNED_TABLES = [
  'account', 'admin_audit', 'agent', 'agent_binding', 'blob', 'board_seen', 'burst', 'co_use', 'confidence_log', 'device',
  'entitlement', 'entry', 'entry_blob', 'entry_embedding', 'entry_provenance', 'event', 'feedback', 'judge_cache', 'link',
  'mcp_client', 'mcp_session', 'message', 'message_delivery', 'quest', 'quest_blob', 'quest_note', 'retrieval',
  'shadow_retrieval', 'source', 'upload', 'usage',
]

export const VIEWS = ['entry_current', 'unanswered_recall', 'entries_overview', 'links_readable', 'recalls_recent', 'events_recent']

/** One row in every owned table, for the owner memory.owner names when it runs. tag keeps ids that are unique across
 * owners (device tokens) apart. */
export function seedEveryTable(tag: string): string {
  const t = tag.replace(/[^a-z0-9]/g, '')
  const sha = (n: number) => `'${String(n).repeat(64).slice(0, 64)}'`
  return `do $seed$
declare me uuid := nullif(current_setting('memory.owner', true), '')::uuid; rid uuid := gen_random_uuid(); mid bigint; qid bigint;
begin
  insert into memory.account (owner_id, email, email_confirmed) values (me, 'seed-${t}@example.com', true);
  insert into memory.entitlement (owner_id, provider, state, event_at) values (me, 'polar', 'pending', now());
  insert into memory.usage (owner_id, period, kind, amount) values (me, date_trunc('month', now())::date, 'recalls_month', 1);
  insert into memory.burst (owner_id) values (me);
  insert into memory.admin_audit (action, target) values ('seed', 'seed');
  insert into memory.agent (name, context, surface, description) values ('seed-agent', 'both', 'test', 'seed');
  insert into memory.agent_binding (principal, client, agent) values ('seed-device', 'seed-client', 'seed-agent');
  insert into memory.blob (sha256, media_type, size, content) values (${sha(1)}, 'text/plain', 4, 'seed'::bytea);
  insert into memory.board_seen (principal, agent) values ('seed-device', 'seed-agent');
  insert into memory.source (id, kind) values ('seed-src', 'test');
  insert into memory.entry (id, title, body, source_id) values ('seed-a', 'Seed A', 'seed', 'seed-src'), ('seed-b', 'Seed B', 'seed', 'seed-src');
  insert into memory.link (src, dst, type) values ('seed-a', 'seed-b', 'co_used');
  insert into memory.co_use (src, dst) values ('seed-a', 'seed-b');
  insert into memory.confidence_log (target, reason) values ('entry:seed-a', 'seed');
  insert into memory.device (name, token_sha256, owner_id) values ('seed-device', md5('${t}' || random()::text), me);
  insert into memory.entry_blob (entry_id, name, sha256, kind) values ('seed-a', 'seed.txt', ${sha(1)}, 'document');
  insert into memory.entry_embedding (entry_id, model, content_sha256, embedding)
    values ('seed-a', 'seed', 'seed', array_fill(0.1, array[1024])::extensions.vector);
  insert into memory.entry_provenance (entry_id, device, agent) values ('seed-a', 'seed-device', 'seed-agent');
  insert into memory.event (event, payload) values ('seed', '{}');
  insert into memory.mcp_session (id, arm) values ('seed-session-${t}', 'hybrid');
  insert into memory.mcp_client (session_id, client) values ('seed-session-${t}', 'seed-client');
  insert into memory.retrieval (id, mcp_session, arm, query) values (rid, 'seed-session-${t}', 'hybrid', 'seed');
  insert into memory.feedback (retrieval_id, source, verdict, entry_id) values (rid, 'agent', 'used', 'seed-a');
  insert into memory.judge_cache (query_sha, entry_id, content_sha, judge_version, p) values ('q', 'seed-a', 'c', 'v', 0.5);
  insert into memory.shadow_retrieval (retrieval_id, param_set, status) values (rid, 'hybrid.v1', 'ranked');
  insert into memory.message (sender, recipient, body) values ('seed', 'seed-agent', 'seed') returning id into mid;
  insert into memory.message_delivery (message_id, recipient) values (mid, 'seed-agent');
  insert into memory.quest (title, brief, done_when, posted_by, posted_device, result_entry)
    values ('Seed', 'seed', 'seed', 'seed-agent', 'seed-device', 'seed-a') returning id into qid;
  insert into memory.quest_blob (quest_id, name, sha256) values (qid, 'seed.txt', ${sha(1)});
  insert into memory.quest_note (quest_id, author, kind) values (qid, 'seed-agent', 'post');
  insert into memory.upload (sha256, principal, size, media_type) values (${sha(2)}, 'seed-device', 4, 'text/plain');
end $seed$;`
}

/** A statement that counts each owned table's rows: total, null owners, and the rows of owner a and of owner b. */
export function countsBy(a = '', b = '', withOwner = true): string {
  return OWNED_TABLES.map((t) => withOwner
    ? `select '${t}' as t, count(*)::int as n, count(*) filter (where owner_id is null)::int as nulls,
        count(distinct owner_id)::int as owners, min(owner_id::text) as owner,
        count(*) filter (where owner_id::text = '${a}')::int as a, count(*) filter (where owner_id::text = '${b}')::int as b from memory.${t}`
    : `select '${t}' as t, count(*)::int as n from memory.${t}`).join(' union all ')
}
