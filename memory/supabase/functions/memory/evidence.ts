// The one quote check. A quote is verified when it appears word for word in the text of a hook event memory holds: the
// tool output of a PostToolUse, or the prompt of a UserPromptSubmit. remember() uses it to tell a fact from an
// observation, and the groom API uses it so the groomer can't put words in Wen's mouth.
import type { Row, Sql } from "./db.ts";
import { eventTexts, MIN_QUOTE, quoteIn, squash } from "./core/evidence.ts";

export { eventTexts, MIN_QUOTE, quoteIn, squash };

export type Verdict = { ok: true; event: Row } | { ok: false; why: string };

/** Whether `quote` is in the cited event. Never throws for a bad citation: `why` says what failed. */
export async function verifyEvidence(db: Sql, eventId: unknown, quote: unknown): Promise<Verdict> {
  if (typeof quote !== "string" || squash(quote).length < MIN_QUOTE) return { ok: false, why: `the quote is under ${MIN_QUOTE} characters.` };
  if (!/^\d{1,18}$/.test(String(eventId))) return { ok: false, why: "no event is cited." };
  const [ev] = await db`select id, session_id, event, payload from memory.event where id = ${String(eventId)}`;
  if (!ev) return { ok: false, why: `there is no event ${eventId}.` };
  if (!eventTexts(ev.event, ev.payload).some((t) => quoteIn(t, quote))) return { ok: false, why: `the quote isn't in event ${eventId} word for word.` };
  return { ok: true, event: ev };
}
