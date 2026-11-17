-- R44 (#48): spreading.v5 is the v4 set spreading best-first: a priority queue by path strength (seed strength times the link
-- weight and link type weight along the path), seeded by keywords, vectors and exact 2- and 3-word phrases of the query. It stops
-- at maxHops 3 or a path below minPath 0.05. wPath weighs the best path strength in the score. v1 to v4 spread as before.
-- Not allocated here, so no recall is served by it until an allocation says so.
insert into memory.param_set (id, arm, params, parent, note, created_by)
select 'spreading.v5', p.arm, p.params || jsonb_build_object('spreadMode', 'bestfirst', 'maxHops', 3, 'minPath', 0.05, 'wPath', 1), p.id,
  'v4 spreading best-first by path strength, seeded by words and phrases, stopping at 3 hops or a path below 0.05.', 'migration'
from memory.param_set p where p.id = 'spreading.v4'
on conflict (id) do nothing;
