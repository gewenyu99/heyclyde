-- R47 (#52): the message board becomes a quest board. An agent posts a quest, another claims it under a lease, reports
-- progress, and completes it with evidence and the entry its work produced. Fan-out to all stops reaching junk names, and the
-- live deliveries those names were given go. Additive: three new tables, one new function for fan-out, and the functions that
-- fanned out by agent_names() switched to it. Idempotent: safe to rerun.
set search_path = memory, extensions, public;

-- One row per quest. A claim is a lease: lease_until is set while it's claimed, and an expired one reopens the quest.
-- assignee is who may claim it: any, the claude or codex family, or one agent's name.
create table if not exists memory.quest (
  id bigserial primary key,
  title text not null check (char_length(title) between 1 and 120),
  brief text not null check (char_length(brief) between 1 and 500),
  done_when text not null check (char_length(done_when) between 1 and 300),
  tags text[] not null default '{}' check (cardinality(tags) <= 8),
  priority text not null default 'normal' check (priority in ('high', 'normal', 'low')),
  context text not null default 'both' check (context in ('work', 'personal', 'both')),
  assignee text not null default 'any' check (assignee ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  state text not null default 'open' check (state in ('open', 'claimed', 'done', 'abandoned')),
  posted_by text not null,
  posted_device text not null,
  posted_session text,
  claimed_by text,
  claimed_device text,
  claimed_session text,
  claimed_at timestamptz,
  lease_minutes integer not null default 120 check (lease_minutes between 15 and 480),
  lease_until timestamptz,
  evidence text check (char_length(evidence) <= 2000),
  result_entry text references memory.entry(id) on delete set null,
  history_entry text references memory.entry(id) on delete set null,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((state = 'claimed') = (lease_until is not null)),
  check (state <> 'done' or evidence is not null));
-- The board: what's open or claimed, by priority and age. And the leases to expire.
create index if not exists quest_live on memory.quest (id) where state in ('open', 'claimed');
create index if not exists quest_lease on memory.quest (lease_until) where state = 'claimed';
create index if not exists quest_claimer on memory.quest (claimed_by, id);
create index if not exists quest_poster on memory.quest (posted_by, id);

-- What happened to a quest, in order: posted, claimed, progress, released, reopened, done, abandoned.
create table if not exists memory.quest_note (
  id bigserial primary key,
  quest_id bigint not null references memory.quest(id) on delete cascade,
  author text not null,
  device text,
  kind text not null check (kind in ('post', 'claim', 'progress', 'release', 'reopen', 'done', 'abandon')),
  body text not null default '' check (char_length(body) <= 2000),
  created_at timestamptz not null default now());
create index if not exists quest_note_quest on memory.quest_note (quest_id, id);

-- Artifacts a quest links (R42 blobs memory already holds): the poster's detail, or the evidence of its completion.
create table if not exists memory.quest_blob (
  quest_id bigint not null references memory.quest(id) on delete cascade,
  name text not null,
  sha256 text not null references memory.blob(sha256),
  role text not null default 'brief' check (role in ('brief', 'evidence')),
  primary key (quest_id, name));

-- The newest quest id each computer's agent has seen on the board, so the hook inbox shows a quest once.
create table if not exists memory.board_seen (
  principal text not null,
  agent text not null,
  last_quest bigint not null default 0,
  seen_at timestamptz not null default now(),
  primary key (principal, agent));

-- Reopens every quest whose lease ran out, with a note on each. skip locked leaves a quest a claim holds right now to it.
-- Returns how many.
create or replace function memory.reopen_expired_quests() returns integer language sql as $$
  with gone as (
    update memory.quest q set state = 'open', claimed_by = null, claimed_device = null, claimed_session = null, claimed_at = null,
      lease_until = null, updated_at = now()
    where q.id in (select id from memory.quest where state = 'claimed' and lease_until < now() for update skip locked)
    returning q.id),
  noted as (
    insert into memory.quest_note (quest_id, author, kind, body)
    select id, 'memory', 'reopen', 'The lease ran out, so the quest is open again.' from gone returning 1)
  select count(*)::integer from gone $$;

-- Who a message to all reaches: registered agents seen in the last 30 days, and claude and codex when that family was seen in
-- the last 30 days, by a hook event, a message it sent or an MCP session. An unregistered client name never counts, so test
-- clients like check or install-sh get nothing. Never wen, memory or all.
create or replace function memory.board_agents() returns setof text language sql stable as $$
  select s.n from (
    select a.name as n from memory.agent a where a.last_seen > now() - interval '30 days'
    union
    select f.n from (values ('claude'), ('codex')) f(n) where
      exists (select 1 from memory.event e where e.agent = f.n and e.received_at > now() - interval '30 days')
      or exists (select 1 from memory.message m where m.sender = f.n and m.created_at > now() - interval '30 days')
      or exists (select 1 from memory.mcp_client c where c.created_at > now() - interval '30 days' and memory.agent_name(c.client) = f.n)
  ) s where s.n not in ('wen', 'memory', 'all') $$;

-- deliver_legacy and post_to_all fanned out by agent_names(). They fan out by board_agents() now, like post_message.
create or replace function memory.deliver_legacy(mid bigint, readers text[]) returns void language sql as $$
  insert into memory.message_delivery (message_id, recipient, delivered_count, acked_at)
  select m.id, r.name, case when r.name = any(readers) then 1 else 0 end, case when r.name = any(readers) then now() end
  from memory.message m
  cross join lateral (
    select x.name from (
      select unnest(readers) as name
      union select m.recipient where m.recipient <> 'all'
      union select a from memory.board_agents() a where m.recipient = 'all') x
    where x.name <> m.sender) r
  where m.id = mid and not exists (select 1 from memory.message_delivery d where d.message_id = m.id)
  on conflict do nothing $$;

create or replace function memory.post_to_all(note text) returns bigint language sql as $$
  with r as (select a as name from memory.board_agents() a),
  m as (insert into memory.message (sender, recipient, body) select 'memory', 'all', note where exists (select 1 from r) returning id),
  d as (insert into memory.message_delivery (message_id, recipient) select m.id, r.name from m, r returning 1)
  select id from m
$$;

-- The junk purge: live deliveries of messages to all, to a name that isn't registered and isn't claude or codex.
delete from memory.message_delivery d using memory.message m
where m.id = d.message_id and m.recipient = 'all' and d.acked_at is null and d.dropped_at is null
  and d.recipient not in ('claude', 'codex') and not exists (select 1 from memory.agent a where a.name = d.recipient);
