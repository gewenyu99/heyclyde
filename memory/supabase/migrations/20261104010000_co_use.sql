-- R43 (#47): memories used together get linked together. When one recall's feedback marks two or more entries used, the learner
-- adds or strengthens a co_used link between each pair (memory.link, type co_used, src < dst, weight +0.1 a co-use, capped at 1,
-- at most 6 pairs a recall), and between their projects when they differ. co_use keeps what the learner needs besides the weight:
-- the sessions that co-used the pair (a link ranks only once 2 have) and the recalls on the clock since the pair was last co-used
-- in which either end was shown without it (every 200 take 0.05 off, and at 0 the link goes). Nothing here moves by calendar time;
-- updated_at only records when the learner last touched the row.
create table if not exists memory.co_use (
  src text not null,
  dst text not null,
  type text not null default 'co_used' check (type = 'co_used'),
  sessions text[] not null default '{}',
  uses integer not null default 0,
  misses integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (src, dst),
  foreign key (src, dst, type) references memory.link (src, dst, type) on delete cascade,
  check (src < dst));
create index if not exists co_use_dst on memory.co_use (dst);

-- spreading.v6 is v4 spreading along co_used links at weight 1 ("*|co_used|*": every pattern pair). A set that names no co_used
-- weight gives the links 0, so v1 to v5 rank as before. It exists only where a v4 does, and it is not allocated here, so no
-- recall is served by it until an allocation says so.
insert into memory.param_set (id, arm, params, parent, note, created_by)
select 'spreading.v6', p.arm,
  p.params || jsonb_build_object('linkTypeWeights', coalesce(p.params->'linkTypeWeights', '{}'::jsonb) || '{"*|co_used|*": 1}'::jsonb),
  p.id, 'v4 spreading along co_used links (R43) at weight 1, once 2 sessions have co-used a pair.', 'migration'
from memory.param_set p where p.id = 'spreading.v4'
on conflict (id) do nothing;
