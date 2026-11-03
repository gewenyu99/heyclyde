// The learner. Every few minutes it reads recalls it hasn't learned from yet and moves confidence and link weights by
// what happened next, never by calendar time:
//   - each entry the recall showed, in the main list or On trial, gets at most one outcome, its strongest: Wen's pushback
//     blaming it (wrong), the agent's feedback naming it (used, irrelevant or wrong), or the agent opening it with get_entry
//   - an entry shown but named by no one, in a packet whose feedback named other entries, is ignored: a weak negative
//   - step() turns an outcome into a new confidence: a big step while the entry was on trial, a small one once settled
//   - his next prompt doesn't push back: every delivered item +0.03, links between delivered items +0.2
//   - the filter judged a candidate irrelevant: its miss streak grows, and past 5 in a row it eases ×0.98 per miss
// An entry under 0.15 goes dormant: recall skips it, nothing deletes it. Every change lands in memory.confidence_log.
import { type Row, type Sql, sql } from "./db.ts";
import { reaction } from "./judge.ts";
import { paramSet } from "./params.ts";

const WAIT_MINUTES = 30;           // how long a recall waits for Wen's next prompt before it counts as no reaction
const REINFORCE = 0.03, CAP = 0.99;
const MISS_FREE = 5, MISS_EASE = 0.98;
const LINK_UP = 0.2, LINK_CAP = 5, LINK_DOWN = 0.9, LINK_FLOOR = 0.2;

export type Outcome = "used" | "irrelevant" | "wrong" | "opened" | "ignored";
export type Steps = { trialStep: number; settledStep: number };
/** The step sizes a set that doesn't name its own gets. */
export const STEPS: Steps = { trialStep: 0.12, settledStep: 0.02 };
/** How many steps an outcome is worth. Wen's pushback is wrong, the same −1. */
const WEIGHT: Record<Exclude<Outcome, "ignored">, number> = { used: 1, irrelevant: -0.3, wrong: -1, opened: 0.2 };
/** Shown but named by no one. Fixed, not scaled by the step, since it's a nudge and not a verdict. */
const IGNORED = { trial: -0.05, settled: -0.01 };
const FLOOR = 0.01, CEILING = 0.99;

/** Where an entry's confidence goes after one outcome. `trial` says the entry was on trial in the recall the outcome is
 * for, which stays true for the showing that spent its last chance. Clamped to [0.01, 0.99]. */
export function step(entry: { confidence: number; trial: boolean }, outcome: Outcome, sizes: Steps = STEPS): number {
  const delta = outcome === "ignored"
    ? (entry.trial ? IGNORED.trial : IGNORED.settled)
    : WEIGHT[outcome] * (entry.trial ? sizes.trialStep : sizes.settledStep);
  return Math.round(Math.min(CEILING, Math.max(FLOOR, entry.confidence + delta)) * 1e6) / 1e6;
}

/** The outcome each shown entry gets from one recall's signals, in the order shown. An entry with several signals takes the
 * strongest, and a tie goes to the negative one. Ignored needs feedback that named other entries, so a recall nobody gave
 * feedback on moves nothing. */
export function outcomesOf(
  { shown, named, opened, blamed }: { shown: string[]; named: Map<string, Outcome>; opened: Set<string>; blamed: string | null },
): Map<string, Outcome> {
  const out = new Map<string, Outcome>();
  for (const id of shown) {
    const signals: Exclude<Outcome, "ignored">[] = [];
    if (id === blamed) signals.push("wrong");
    const said = named.get(id);
    if (said && said !== "ignored" && said !== "opened") signals.push(said);
    if (opened.has(id)) signals.push("opened");
    if (signals.length) {
      signals.sort((a, b) => Math.abs(WEIGHT[b]) - Math.abs(WEIGHT[a]) || WEIGHT[a] - WEIGHT[b]);
      out.set(id, signals[0]);
    } else if (named.size) out.set(id, "ignored");
  }
  return out;
}

const WHY: Record<Outcome, string> = {
  used: "the agent used it", irrelevant: "the agent found it irrelevant", wrong: "named wrong", opened: "the agent opened it", ignored: "shown, not used",
};

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
    where src = any(${among}::text[]) and dst = any(${among}::text[]) and type <> 'part_of'
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

/** The step sizes of the set that served a recall, or the defaults when it names none or is gone. */
async function stepsOf(setId: string | null): Promise<Steps> {
  if (!setId) return STEPS;
  try {
    const p = (await paramSet(sql, setId)).params;
    return { trialStep: p.trialStep ?? STEPS.trialStep, settledStep: p.settledStep ?? STEPS.settledStep };
  } catch {
    return STEPS;
  }
}

const SAYS: Record<string, Outcome> = { helpful: "used", used: "used", irrelevant: "irrelevant", wrong: "wrong" };

/** Learn from up to `limit` recalls. Returns what it did, for the cron log and the console. */
export async function learn(limit = 40) {
  const pending = await sql`select r.id, r.delivered, r.rejected, r.on_trial, r.param_set, r.created_at, r.mcp_session, s.claude_session_id
    from memory.retrieval r left join memory.mcp_session s on s.id = r.mcp_session
    where r.learned_at is null order by r.created_at limit ${limit}`;
  const done = { learned: 0, pushback: 0, helpful: 0, no_reaction: 0, waiting: 0, failed: 0 };
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
    // What the agent said about this recall's entries, and which of them it opened in the same session soon after.
    const named = new Map<string, Outcome>();
    for (const f of await sql`select entry_id, verdict from memory.feedback
        where retrieval_id = ${r.id} and source = 'agent' and entry_id is not null order by id`) {
      if (shown.includes(f.entry_id) && SAYS[f.verdict]) named.set(f.entry_id, SAYS[f.verdict]);
    }
    const opened = new Set<string>(r.mcp_session && shown.length
      ? (await sql`select distinct payload->>'entry_id' as id from memory.event
          where session_id = ${r.mcp_session} and event = 'get_entry' and received_at > ${r.created_at}
            and received_at < ${r.created_at}::timestamptz + make_interval(mins => ${WAIT_MINUTES})`)
        .map((e) => e.id as string).filter((id) => shown.includes(id))
      : []);
    const blamed = read?.pushback && read.cause && shown.includes(read.cause) ? read.cause : null;
    const outcomes = outcomesOf({ shown, named, opened, blamed });
    const sizes = outcomes.size ? await stepsOf(r.param_set) : STEPS;
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
        for (const id of delivered) await setConfidence(tx, id, (c) => Math.min(CAP, c + REINFORCE), "served, no pushback", r.id);
        await moveLinks(tx, delivered, null, true, r.id);
      }
      for (const [id, outcome] of outcomes) {
        const trial = onTrial.includes(id);
        const why = id === blamed && outcome === "wrong" ? "Wen pushed back on it" : WHY[outcome];
        await setConfidence(tx, id, (c) => step({ confidence: c, trial }, outcome, sizes), `${trial ? "on trial: " : ""}${why}`, r.id);
      }
      await tx`update memory.retrieval set learned_at = now(),
        reaction = ${tx.json(read ? { pushback: read.pushback, p: read.p, cause: read.cause, event_id: next.id } : { none: true })}
        where id = ${r.id}`;
    });
    done.learned++;
    if (!read) done.no_reaction++;
    else if (read.pushback) done.pushback++;
    else done.helpful++;
  }
  return done;
}
