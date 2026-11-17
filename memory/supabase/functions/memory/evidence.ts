// The one quote check. A quote is verified when it appears word for word in the text of a hook event memory holds: the
// tool output of a PostToolUse, or the prompt of a UserPromptSubmit. remember() uses it to tell a fact from an
// observation, and the groom API uses it so the groomer can't put words in Wen's mouth.
import type { Row, Sql } from "./db.ts";

/** A quote shorter than this, once squashed, proves nothing. */
export const MIN_QUOTE = 8;
// A match must start and end on a token boundary: the character next to a match, when the match starts or ends with a
// letter or digit, can't continue a word, an address or a path.
const JOINS = /[\p{L}\p{N}.\-_:/]/u;
const EDGE = /[\p{L}\p{N}]/u;

export const squash = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

/** True when `quote` is in `text` once both are lowercased with whitespace runs squashed, at a token boundary. */
export function quoteIn(text: string, quote: string): boolean {
  const q = squash(quote), t = squash(text);
  if (q.length < MIN_QUOTE) return false;
  for (let at = t.indexOf(q); at >= 0; at = t.indexOf(q, at + 1)) {
    const before = t[at - 1], after = t[at + q.length];
    const startsBad = EDGE.test(q[0]) && before !== undefined && JOINS.test(before);
    const endsBad = EDGE.test(q.at(-1)!) && after !== undefined && JOINS.test(after);
    if (!startsBad && !endsBad) return true;
  }
  return false;
}

function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const v of value) yield* strings(v);
  // A content block's "type" names the block. It isn't output.
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) if (k !== "type") yield* strings(v);
}

/** The text an event can back a quote with: every string inside a PostToolUse's tool_response, or a UserPromptSubmit's
 * prompt. Never tool_input, which is what the agent sent, and no other event. */
export function eventTexts(event: string, payload: unknown): string[] {
  const p = (payload && typeof payload === "object" ? payload : {}) as Row;
  if (event === "PostToolUse") return [...strings(p.tool_response)];
  if (event === "UserPromptSubmit") return typeof p.prompt === "string" ? [p.prompt] : [];
  return [];
}

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
