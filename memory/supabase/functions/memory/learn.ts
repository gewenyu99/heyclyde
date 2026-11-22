// The learner. Every few minutes it reads recalls it hasn't learned from yet and moves confidence and link weights by
// what happened next, never by calendar time:
//   - each entry the recall showed, in the main list or On trial, gets at most one outcome, its strongest: Wen's pushback
//     blaming it (wrong), the agent's feedback naming it (used, irrelevant or wrong), or the agent opening it with get_entry
//   - an entry shown but named by no one, in a packet whose feedback named other entries, is ignored: a weak negative
//   - step() turns an outcome into a new confidence: a big step while the entry was on trial, a small one once settled
//   - his next prompt doesn't push back: every delivered item +0.03, links between delivered items +0.2. A dormant item gets
//     nothing for being shown (R29: recall_more shows them), only for an outcome
//   - the filter judged a candidate irrelevant: its miss streak grows, and past 5 in a row it eases ×0.98 per miss
//   - two or more entries used (R43): a co_used link between each pair of the top 4, +0.1 up to 1, and between their projects
//     when those differ. A recall on the clock that shows one end without the pair co-used counts a miss, and every 200 misses
//     take 0.05 off the link, which goes at 0
// An entry under 0.15 goes dormant: recall skips it, nothing deletes it. Every change lands in memory.confidence_log.
import { asTenant, currentOwner, root, type Row, type Sql, sql } from "./db.ts";
import { reaction } from "./judge.ts";
import { paramSet } from "./params.ts";
import { forgetGraph } from "./search.ts";
import {
  CAP,
  type CardVote,
  CO_USE,
  coPairs,
  coUsed,
  DORMANT,
  faded,
  LINK_CAP,
  LINK_DOWN,
  LINK_FLOOR,
  LINK_UP,
  MISS_EASE,
  MISS_FREE,
  type Outcome,
  OUTCOME_WHY as WHY,
  outcomesOf,
  REINFORCE,
  step,
  STEPS,
  type Steps,
  WAIT_MINUTES,
} from "./core/learn.ts";

export { type CardVote, CO_USE, coPairs, coUsed, faded, type Outcome, outcomesOf, step, STEPS, type Steps };

async function setConfidence(db: Sql, id: string, next: (c: number) => number, reason: string, rid: string) {
  const [e] = await db`select confidence from memory.entry where id = ${id}`;
  if (!e) return;
  const after = Math.min(1, Math.max(0, next(e.confidence)));
  if (Math.abs(after - e.confidence) < 1e-6) return;
  await db`update memory.entry set confidence = ${after} where id = ${id}`;
  await db`insert into memory.confidence_log (target, before, after, reason, retrieval_id)
    values (${"entry:" + id}, ${e.confidence}, ${after}, ${reason}, ${rid})`;
}

async function moveLinks(db: Sql, among: string[], touching: string | null, up: boolean, rid: string) {
  if (among.length < 2) return;
  const links = await db`select src, dst, type, weight from memory.link
    where src = any(${among}::text[]) and dst = any(${among}::text[]) and type not in ('part_of', 'co_used')
      and (${touching}::text is null or src = ${touching} or dst = ${touching})`;
  for (const l of links) {
    const w = l.weight ?? 1;
    const after = up ? Math.min(LINK_CAP, w + LINK_UP) : Math.max(LINK_FLOOR, w * LINK_DOWN);
    if (Math.abs(after - w) < 1e-6) continue;
    await db`update memory.link set weight = ${after} where src = ${l.src} and dst = ${l.dst} and type = ${l.type}`;
    await db`insert into memory.confidence_log (target, before, after, reason, retrieval_id)
      values (${`link:${l.src}|${l.type}|${l.dst}`}, ${w}, ${after}, ${up ? "walked in a helpful recall" : "behind pushback"}, ${rid})`;
  }
}

/** What the judge sees of a delivered item. Private and confidential entries go by title alone. */
function itemText(r: Row) {
  return r.sensitivity === "normal" ? `${r.title}. ${r.body ?? ""}` : r.title;
}

/** The step sizes of the set that served a recall and its dormant line, or the defaults when it names none or is gone. */
async function stepsOf(setId: string | null): Promise<Steps & { dormant: number }> {
  if (!setId) return { ...STEPS, dormant: DORMANT };
  try {
    const p = (await paramSet(sql, setId)).params;
    return { trialStep: p.trialStep ?? STEPS.trialStep, settledStep: p.settledStep ?? STEPS.settledStep, dormant: p.dormant ?? DORMANT };
  } catch {
    return { ...STEPS, dormant: DORMANT };
  }
}

/** Add one co-use to the co_used link between src and dst (src < dst), made at 0.1 if it isn't there, from this session. */
async function strengthen(db: Sql, src: string, dst: string, session: string, rid: string, why: string) {
  const [l] = await db`select weight from memory.link where src = ${src} and dst = ${dst} and type = 'co_used'`;
  const before = l ? Number(l.weight ?? 0) : 0, after = coUsed(before);
  await db`insert into memory.link (src, dst, type, weight) values (${src}, ${dst}, 'co_used', ${after})
    on conflict (owner_id, src, dst, type) do update set weight = excluded.weight`;
  await db`insert into memory.co_use (src, dst, sessions, uses, misses) values (${src}, ${dst}, array[${session}::text], 1, 0)
    on conflict (owner_id, src, dst) do update set uses = memory.co_use.uses + 1, misses = 0, updated_at = now(),
      sessions = case when ${session}::text = any(memory.co_use.sessions) or cardinality(memory.co_use.sessions) >= ${CO_USE.sessions}
        then memory.co_use.sessions else memory.co_use.sessions || ${session}::text end`;
  if (Math.abs(after - before) >= 1e-6) {
    await db`insert into memory.confidence_log (target, before, after, reason, retrieval_id)
      values (${`link:${src}|co_used|${dst}`}, ${l ? before : null}, ${after}, ${why}, ${rid})`;
  }
}

/** R43 for one recall: link the pairs among its used entries and their projects, and count a miss on every other co_used link
 * with an end it showed, when the recall is on the clock. Says whether any co_used link changed. */
async function coUse(db: Sql, r: Row, shown: string[], used: string[]): Promise<boolean> {
  const pairs = coPairs(used);
  const session = String(r.mcp_session ?? r.id);
  for (const [a, b] of pairs) await strengthen(db, a, b, session, r.id, "used together");
  if (pairs.length) {
    const ends = [...new Set(pairs.flat())];
    const projects = new Map((await db`select e.id, e.project from memory.entry e join memory.entry p on p.id = e.project
      where e.id = any(${ends}::text[])`).map((e) => [e.id as string, e.project as string]));
    const across = new Set<string>();
    for (const [a, b] of pairs) {
      const pa = projects.get(a), pb = projects.get(b);
      if (pa && pb && pa !== pb) across.add(pa < pb ? `${pa}\n${pb}` : `${pb}\n${pa}`);
    }
    for (const key of across) {
      const [pa, pb] = key.split("\n");
      await strengthen(db, pa, pb, session, r.id, "their entries were used together");
    }
  }
  if (r.seq === null || r.seq === undefined || !shown.length) return pairs.length > 0;
  // A miss is a recall on the clock that showed one end and didn't co-use the pair. Every fadeEvery of them take one fade off.
  const keep = pairs.map(([a, b]) => `${a}\n${b}`);
  const due = await db`update memory.co_use c set updated_at = now(),
      misses = case when c.misses + 1 >= ${CO_USE.fadeEvery} then 0 else c.misses + 1 end
    where (c.src = any(${shown}::text[]) or c.dst = any(${shown}::text[])) and not (c.src || E'\n' || c.dst = any(${keep}::text[]))
    returning c.src, c.dst, c.misses`;
  let changed = pairs.length > 0;
  for (const d of due.filter((x) => x.misses === 0)) {
    const [l] = await db`select weight from memory.link where src = ${d.src} and dst = ${d.dst} and type = 'co_used'`;
    if (!l) continue;
    const before = Number(l.weight ?? 0), after = faded(before);
    if (after <= 1e-6) await db`delete from memory.link where src = ${d.src} and dst = ${d.dst} and type = 'co_used'`;
    else await db`update memory.link set weight = ${after} where src = ${d.src} and dst = ${d.dst} and type = 'co_used'`;
    await db`insert into memory.confidence_log (target, before, after, reason, retrieval_id)
      values (${`link:${d.src}|co_used|${d.dst}`}, ${before}, ${after}, ${`shown ${CO_USE.fadeEvery} times without being used together`}, ${r.id})`;
    changed = true;
  }
  return changed;
}

const SAYS: Record<string, Outcome> = { helpful: "used", used: "used", irrelevant: "irrelevant", wrong: "wrong" };

type Done = { learned: number; pushback: number; helpful: number; no_reaction: number; waiting: number; failed: number };

/** Learn from up to `limit` recalls of each owner. Cron calls it as postgres, and each owner's recalls are learned inside
 * that owner's tenant (R49), so nothing it reads or writes crosses owners. Returns what it did, for the cron log and the
 * console. */
export async function learn(limit = 40): Promise<Done> {
  if (currentOwner()) return await learnOwner(limit);
  const owners = await root`select distinct owner_id from memory.retrieval where learned_at is null`;
  const done: Done = { learned: 0, pushback: 0, helpful: 0, no_reaction: 0, waiting: 0, failed: 0 };
  for (const { owner_id } of owners) {
    const one = await asTenant(owner_id, () => learnOwner(limit));
    for (const k of Object.keys(done) as (keyof Done)[]) done[k] += one[k];
  }
  return done;
}

async function learnOwner(limit: number): Promise<Done> {
  const pending = await sql`select r.id, r.delivered, r.rejected, r.on_trial, r.param_set, r.created_at, r.mcp_session, r.seq, s.claude_session_id
    from memory.retrieval r left join memory.mcp_session s on s.owner_id = r.owner_id and s.id = r.mcp_session
    where r.learned_at is null order by r.created_at limit ${limit}`;
  const done: Done = { learned: 0, pushback: 0, helpful: 0, no_reaction: 0, waiting: 0, failed: 0 };
  let linked = false;
  for (const r of pending) {
    const delivered: string[] = r.delivered ?? [], rejected: string[] = r.rejected ?? [], onTrial: string[] = r.on_trial ?? [];
    const shown = [...delivered, ...onTrial];
    const [next] = r.claude_session_id ? await sql`select id, payload->>'prompt' as prompt from memory.event
      where session_id = ${r.claude_session_id} and event = 'UserPromptSubmit' and received_at > ${r.created_at}
        and received_at < ${r.created_at}::timestamptz + make_interval(mins => ${WAIT_MINUTES})
      order by received_at limit 1` : [];
    const fresh = Date.now() - new Date(r.created_at).getTime() < WAIT_MINUTES * 60_000;
    if (!next?.prompt && fresh) {
      done.waiting++;
      continue;
    }
    let read: { pushback: boolean; p: number; cause: string | null } | null = null;
    if (next?.prompt) {
      const found = shown.length ? await sql`select id, title, body, sensitivity from memory.entry where id = any(${shown}::text[])` : [];
      const rows = shown.flatMap((id) => found.filter((e) => e.id === id));
      try {
        read = await reaction(next.prompt, rows.map((e) => ({ id: e.id, text: itemText(e) })));
      } catch (e) {
        console.warn("learner: no reaction read for", r.id, e);
        done.failed++;
        continue;
      }
    }
    // What the agent said about this recall's entries, any whole-recall card vote, and which entries were opened soon after.
    const named = new Map<string, Outcome>();
    for (const f of await sql`select entry_id, verdict from memory.feedback
        where retrieval_id = ${r.id} and source = 'agent' and entry_id is not null order by id`) {
      if (shown.includes(f.entry_id) && SAYS[f.verdict]) named.set(f.entry_id, SAYS[f.verdict]);
    }
    const [cardRow] = await sql`select verdict from memory.feedback
        where retrieval_id = ${r.id} and source = 'card' order by id desc limit 1`;
    const cardVote: CardVote = cardRow?.verdict === "helpful" || cardRow?.verdict === "nothing_useful" ? cardRow.verdict : null;
    const opened = new Set<string>(r.mcp_session && shown.length
      ? (await sql`select distinct payload->>'entry_id' as id from memory.event
          where session_id = ${r.mcp_session} and event = 'get_entry' and received_at > ${r.created_at}
            and received_at < ${r.created_at}::timestamptz + make_interval(mins => ${WAIT_MINUTES})`)
        .map((e) => e.id as string).filter((id) => shown.includes(id))
      : []);
    const blamed = read?.pushback && read.cause && shown.includes(read.cause) ? read.cause : null;
    const outcomes = outcomesOf({ shown, named, opened, blamed, cardVote });
    const sizes = await stepsOf(r.param_set);
    // R43: what was used, by the agent's outcome or Wen's confirmation from the console, in the order the recall showed it.
    const confirmed = new Set<string>((await sql`select entry_id from memory.feedback where retrieval_id = ${r.id} and source = 'wen'
        and entry_id is not null and verdict in ('used', 'helpful')`).map((f) => f.entry_id as string));
    const used = shown.filter((id) => outcomes.get(id) === "used" || confirmed.has(id));
    await sql.begin(async (tx) => {
      // Fade by recalls only: a miss is this entry turning up as a candidate and being judged irrelevant.
      for (const id of rejected) {
        const [m] = await tx`update memory.entry set miss_streak = miss_streak + 1 where id = ${id} returning miss_streak`;
        if (m && m.miss_streak > MISS_FREE) await setConfidence(tx, id, (c) => c * MISS_EASE, "judged irrelevant again", r.id);
      }
      if (delivered.length) await tx`update memory.entry set miss_streak = 0 where id = any(${delivered}::text[])`;
      if (read?.pushback) {
        if (blamed && delivered.includes(blamed)) await moveLinks(tx, delivered, blamed, false, r.id);
      } else if (read) {
        // A dormant entry recall_more showed is not revived for being shown, only by an outcome below.
        for (const id of delivered) {
          await setConfidence(tx, id, (c) => c < sizes.dormant ? c : Math.min(CAP, c + REINFORCE), "served, no pushback", r.id);
        }
        await moveLinks(tx, delivered, null, true, r.id);
      }
      for (const [id, outcome] of outcomes) {
        const trial = onTrial.includes(id);
        const fromCard = !named.has(id) && !opened.has(id) && id !== blamed && cardVote !== null;
        const why = id === blamed && outcome === "wrong"
          ? "Wen pushed back on it"
          : fromCard
          ? (cardVote === "helpful" ? "the recall card was rated helpful" : "the recall card was rated not useful")
          : WHY[outcome];
        await setConfidence(tx, id, (c) => step({ confidence: c, trial }, outcome, sizes), `${trial ? "on trial: " : ""}${why}`, r.id);
      }
      if (await coUse(tx, r, shown, used)) linked = true;
      await tx`update memory.retrieval set learned_at = now(),
        reaction = ${tx.json(read ? { pushback: read.pushback, p: read.p, cause: read.cause, event_id: next.id } : { none: true })}
        where id = ${r.id}`;
    });
    done.learned++;
    if (!read) done.no_reaction++;
    else if (read.pushback) done.pushback++;
    else done.helpful++;
  }
  // This isolate ranks with the new co_used links at once. Others pick them up when their minute's cache runs out.
  if (linked) forgetGraph(currentOwner());
  return done;
}
