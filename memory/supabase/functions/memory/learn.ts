// The learner. Every few minutes it reads recalls it hasn't learned from yet and moves confidence and link weights by
// what Wen did next, never by calendar time:
//   - his next prompt pushes back and blames a delivered item: that item ×0.8, links touching it among the delivered ×0.9
//   - his next prompt doesn't push back: every delivered item +0.03, links between delivered items +0.2
//   - the filter judged a candidate irrelevant: its miss streak grows, and past 5 in a row it eases ×0.98 per miss
// An entry under 0.15 goes dormant: recall skips it, nothing deletes it. Every change lands in memory.confidence_log.
import { type Row, type Sql, sql } from "./db.ts";
import { reaction } from "./judge.ts";

const WAIT_MINUTES = 30;           // how long a recall waits for Wen's next prompt before it counts as no reaction
const REINFORCE = 0.03, CAP = 0.99, WEAKEN = 0.8;
const MISS_FREE = 5, MISS_EASE = 0.98;
const LINK_UP = 0.2, LINK_CAP = 5, LINK_DOWN = 0.9, LINK_FLOOR = 0.2;

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

/** Learn from up to `limit` recalls. Returns what it did, for the cron log and the console. */
export async function learn(limit = 40) {
  const pending = await sql`select r.id, r.delivered, r.rejected, r.created_at, s.claude_session_id
    from memory.retrieval r left join memory.mcp_session s on s.id = r.mcp_session
    where r.learned_at is null order by r.created_at limit ${limit}`;
  const done = { learned: 0, pushback: 0, helpful: 0, no_reaction: 0, waiting: 0, failed: 0 };
  for (const r of pending) {
    const delivered: string[] = r.delivered ?? [], rejected: string[] = r.rejected ?? [];
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
      const rows = await sql`select id, title, body, sensitivity from memory.entry where id = any(${delivered}::text[])`;
      try {
        read = await reaction(next.prompt, rows.map((e) => ({ id: e.id, text: itemText(e) })));
      } catch (e) {
        console.warn("learner: no reaction read for", r.id, e);
        done.failed++;
        continue;
      }
    }
    await sql.begin(async (tx) => {
      // Fade by recalls only: a miss is this entry turning up as a candidate and being judged irrelevant.
      for (const id of rejected) {
        const [m] = await tx`update memory.entry set miss_streak = miss_streak + 1 where id = ${id} returning miss_streak`;
        if (m && m.miss_streak > MISS_FREE) await setConfidence(tx, id, (c) => c * MISS_EASE, "judged irrelevant again", r.id);
      }
      if (delivered.length) await tx`update memory.entry set miss_streak = 0 where id = any(${delivered}::text[])`;
      if (read?.pushback) {
        if (read.cause && delivered.includes(read.cause)) {
          await setConfidence(tx, read.cause, (c) => c * WEAKEN, "Wen pushed back on it", r.id);
          await moveLinks(tx, delivered, read.cause, false, r.id);
        }
      } else if (read) {
        for (const id of delivered) await setConfidence(tx, id, (c) => Math.min(CAP, c + REINFORCE), "served, no pushback", r.id);
        await moveLinks(tx, delivered, null, true, r.id);
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
