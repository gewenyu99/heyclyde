-- R55 (#60): the store reviewers' demo account. review@heyclyde.me (setting reviewer_owner_id, set by
-- memory/seed/reviewer.sh when the account is made) holds exactly 40 sample notes across 4 projects. memory.reseed_reviewer()
-- puts them back as they were, whatever a reviewer added, changed or deleted, and pg_cron runs it nightly. It touches only
-- that owner's rows, and does nothing while the setting is unset. Idempotent: safe to rerun.
set search_path = memory, extensions, public;

create or replace function memory.reseed_reviewer() returns integer language plpgsql security definer
  set search_path = memory, pg_temp as $$
declare
  o uuid := nullif((select value from memory.setting where name = 'reviewer_owner_id'), '')::uuid;
  projects text[][] := array[
    ['sample-lisbon', 'Trip to Lisbon in May', 'Planning a week in Lisbon with two friends, mostly walking and food.'],
    ['sample-garden', 'Balcony garden', 'A south-facing balcony with tomatoes, herbs and a small lemon tree.'],
    ['sample-recipes', 'Recipe app side project', 'A small web app that turns saved recipes into a weekly shopping list.'],
    ['sample-running', 'Half-marathon training', 'Twelve weeks of training for the October half marathon.']];
  notes text[][] := array[
    ['sample-lisbon', 'decisions', 'Stay in Alfama, not Bairro Alto', 'Alfama is quieter at night and close to the tram 28 stop.'],
    ['sample-lisbon', 'preferences', 'No more than two museums a day', 'Two museums a day is the limit before everyone gets tired.'],
    ['sample-lisbon', 'observations', 'Pasteis de nata are best warm', 'The bakery near the hotel sells them warm before 9am.'],
    ['sample-lisbon', 'decisions', 'Day trip to Sintra on Wednesday', 'Wednesday has the fewest tour buses; take the 9:11 train.'],
    ['sample-lisbon', 'references', 'Tram 28 timetable', 'Trams run every 10 to 15 minutes; the first leaves Martim Moniz at 7am.'],
    ['sample-lisbon', 'preferences', 'Sam is vegetarian', 'Pick restaurants with real vegetarian mains, not just salads.'],
    ['sample-lisbon', 'observations', 'Most shops close on Sunday afternoon', 'Buy gifts before Sunday lunch.'],
    ['sample-lisbon', 'decisions', 'Budget is 120 euros a day each', 'Covers food, transport and one paid sight.'],
    ['sample-lisbon', 'decisions', 'Book the fado dinner by April 20', 'The small fado house fills up three weeks ahead.'],
    ['sample-garden', 'decisions', 'Grow cherry tomatoes, not beefsteak', 'Cherry tomatoes ripen faster in pots and split less.'],
    ['sample-garden', 'observations', 'Basil bolts in full afternoon sun', 'Move the basil to the shadier corner after June.'],
    ['sample-garden', 'preferences', 'Water in the morning only', 'Evening watering left mildew on the leaves last year.'],
    ['sample-garden', 'references', 'Lemon tree feed schedule', 'Citrus feed every two weeks from March to September.'],
    ['sample-garden', 'decisions', 'Use 30 litre pots for tomatoes', 'Smaller pots dried out daily in July.'],
    ['sample-garden', 'observations', 'Aphids arrive in late May', 'A soap spray once a week kept them down.'],
    ['sample-garden', 'decisions', 'Sow coriander every three weeks', 'Coriander goes to seed fast, so stagger sowings.'],
    ['sample-garden', 'preferences', 'No chemical pesticides', 'Bees visit the balcony; keep it organic.'],
    ['sample-garden', 'observations', 'The lemon tree dropped flowers in a cold snap', 'Bring it inside below 5C.'],
    ['sample-recipes', 'decisions', 'Store recipes as Markdown', 'Markdown keeps recipes portable and easy to diff.'],
    ['sample-recipes', 'decisions', 'Group the shopping list by aisle', 'Aisles match the supermarket layout: produce, dairy, pantry.'],
    ['sample-recipes', 'preferences', 'Metric units first', 'Show grams and millilitres; imperial on request.'],
    ['sample-recipes', 'observations', 'Ingredient names need normalising', 'Spring onion, scallion and green onion are one item.'],
    ['sample-recipes', 'references', 'Parser handles fractions like 1 1/2', 'Mixed fractions parse to decimals before summing.'],
    ['sample-recipes', 'decisions', 'Add pantry staples to skip', 'Salt, pepper and oil never go on the list.'],
    ['sample-recipes', 'decisions', 'SQLite for the first version', 'One user, one file; no server database yet.'],
    ['sample-recipes', 'observations', 'Users plan meals on Sunday evening', 'Send the weekly list reminder at 6pm Sunday.'],
    ['sample-recipes', 'preferences', 'Keep the UI to one screen', 'A week view with the list beside it.'],
    ['sample-running', 'decisions', 'Three runs a week plus one cross-training day', 'Easy, tempo and long run, cycling on Saturday.'],
    ['sample-running', 'observations', 'Knee aches after runs over 16 km', 'Shorter strides and new shoes helped.'],
    ['sample-running', 'preferences', 'Run before work', 'Mornings are the only reliable time.'],
    ['sample-running', 'references', 'Target pace 5:40 per km', 'Goal is just under two hours.'],
    ['sample-running', 'decisions', 'Long run grows by 1.5 km a week', 'Cut back every fourth week.'],
    ['sample-running', 'observations', 'Gels upset the stomach', 'Dates and water work better on long runs.'],
    ['sample-running', 'decisions', 'Buy new shoes by week 6', 'Old pair has over 700 km.'],
    ['sample-running', 'preferences', 'Rest day is Friday', 'Keeps legs fresh for the Sunday long run.'],
    ['sample-running', 'observations', 'Heart rate drifts up in heat', 'Slow down 15 seconds per km above 25C.']];
  p text[]; n text[]; i integer := 0;
begin
  if o is null then return 0; end if;
  -- Everything the reviewer made or changed goes; the 40 notes come back as they were.
  delete from memory.co_use where owner_id = o;
  delete from memory.link where owner_id = o;
  delete from memory.quest where owner_id = o;
  delete from memory.entry where owner_id = o;
  insert into memory.source (owner_id, id, kind, title, uri, date)
    values (o, 'sample-source', 'sample', 'Clyde sample notes', 'https://heyclyde.me/docs', current_date)
    on conflict (owner_id, id) do nothing;
  foreach p slice 1 in array projects loop
    insert into memory.entry (owner_id, id, pattern, title, body, authority, scope, sensitivity, lang, valid_from, source_id,
        evidence_kind, evidence, evidence_sha256, project, origin, kind, confidence, chances_left)
      values (o, p[1], 'projects', p[2], p[3], 'approved', 'global', 'normal', 'en', current_date, 'sample-source',
        'summary', 'Sample note for store reviewers.', encode(sha256(convert_to('Sample note for store reviewers.', 'UTF8')), 'hex'),
        p[1], 'seed', 'observation', 0.9, 0);
  end loop;
  foreach n slice 1 in array notes loop
    i := i + 1;
    insert into memory.entry (owner_id, id, pattern, title, body, authority, scope, sensitivity, lang, valid_from, source_id,
        evidence_kind, evidence, evidence_sha256, project, origin, kind, confidence, chances_left)
      values (o, n[1] || '-' || i, n[2], n[3], n[4], 'approved', 'global', 'normal', 'en', current_date, 'sample-source',
        'summary', 'Sample note for store reviewers.', encode(sha256(convert_to('Sample note for store reviewers.', 'UTF8')), 'hex'),
        n[1], 'seed', 'observation', 0.8, 0);
    insert into memory.link (owner_id, src, dst, type) values (o, n[1] || '-' || i, n[1], 'part_of');
  end loop;
  return (select count(*)::integer from memory.entry where owner_id = o);
end $$;

-- Nightly at 06:23 UTC, in plain SQL, so it needs no route and no secret.
select cron.unschedule('memory-reviewer-reseed') where exists (select 1 from cron.job where jobname = 'memory-reviewer-reseed');
select cron.schedule('memory-reviewer-reseed', '23 6 * * *', $$select memory.reseed_reviewer()$$);
