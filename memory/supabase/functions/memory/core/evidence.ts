// Verbatim quote verification helpers against recorded hook event text.
import type { Row } from "./ranking.ts";

export const MIN_QUOTE = 8;
const JOINS = /[\p{L}\p{N}.\-_:/]/u;
const EDGE = /[\p{L}\p{N}]/u;

export const squash = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

/** True when `quote` appears verbatim in `text` (case/whitespace normalized) at token boundaries. */
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
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) if (k !== "type") yield* strings(v);
  }
}

/** Extract quote-verifiable text strings from PostToolUse tool_response or UserPromptSubmit prompt. */
export function eventTexts(event: string, payload: unknown): string[] {
  const p = (payload && typeof payload === "object" ? payload : {}) as Row;
  if (event === "PostToolUse") return [...strings(p.tool_response)];
  if (event === "UserPromptSubmit") return typeof p.prompt === "string" ? [p.prompt] : [];
  return [];
}
