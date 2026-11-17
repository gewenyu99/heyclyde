// The feedback call (R33): what the agent may send, checked before anything is written, and the two lines that ask for it.
// A call is all or nothing. checkFeedback reads no database, so tests and the tool share it.

/** What an agent says about one entry a recall showed. */
export const ENTRY_VERDICTS = ["used", "irrelevant", "wrong"];
/** What the one-verdict form and Wen's console take. helpful is the older word for used. */
export const VERDICTS = ["helpful", "used", "irrelevant", "wrong", "nothing_useful"];
export const BAD_VERDICT = "Not logged: verdict must be helpful, used, irrelevant, wrong or nothing_useful.";
export const NOTE_MAX = 4000;
/** How many unanswered recalls a reminder names. */
export const REMIND_MAX = 3;

export type FeedbackRow = { entry_id: string | null; verdict: string };

/** The rows to log for a call, or why none are. `shown` is every entry id the recall delivered or put on trial. */
export function checkFeedback(args: Record<string, unknown>, shown: string[]): { rows: FeedbackRow[] } | { error: string } {
  const no = (why: string) => ({ error: `Not logged: ${why}` });
  if (typeof args.note === "string" && args.note.length > NOTE_MAX) return no(`note must be 4,000 characters or fewer.`);
  const entries = args.entries ?? args.items;
  const nothing = args.nothing_useful === true;
  const verdict = typeof args.verdict === "string" ? args.verdict : null;
  const entryId = typeof args.entry_id === "string" && args.entry_id ? args.entry_id : null;
  if (entries !== undefined && entries !== null && !Array.isArray(entries)) return no("entries must be a list of {entry_id, verdict}.");
  const list = (entries ?? []) as unknown[];
  if (nothing && list.length) return no("nothing_useful can't come with entries. Name the entries, or say nothing_useful.");
  const rows: FeedbackRow[] = [];
  if (list.length) {
    // The cap comes first, so a flood is refused before it is read.
    if (list.length > shown.length) return no(`entries holds ${list.length}, but the recall showed only ${shown.length}.`);
    const seen = new Set<string>();
    for (const item of list) {
      const e = item as Record<string, unknown> | null;
      if (!e || typeof e !== "object" || typeof e.entry_id !== "string" || typeof e.verdict !== "string") {
        return no("each entry needs an entry_id and a verdict.");
      }
      if (!ENTRY_VERDICTS.includes(e.verdict)) return no(`verdict for ${e.entry_id} must be used, irrelevant or wrong, not ${JSON.stringify(e.verdict)}.`);
      if (!shown.includes(e.entry_id)) return no(`${e.entry_id} was not in this recall.`);
      if (seen.has(e.entry_id)) return no(`${e.entry_id} appears twice.`);
      seen.add(e.entry_id);
      rows.push({ entry_id: e.entry_id, verdict: e.verdict });
    }
    if (verdict !== null) {
      if (!VERDICTS.includes(verdict)) return { error: BAD_VERDICT };
      rows.push({ entry_id: null, verdict });
    }
    return { rows };
  }
  if (nothing) return { rows: [{ entry_id: null, verdict: "nothing_useful" }] };
  if (verdict === null) return no("give entries or nothing_useful.");
  if (!VERDICTS.includes(verdict)) return { error: BAD_VERDICT };
  if (entryId && !shown.includes(entryId)) return no(`${entryId} was not in this recall.`);
  return { rows: [{ entry_id: entryId, verdict }] };
}

/** The last line of every MCP packet. */
export const feedbackFooter = (rid: string) =>
  `After using these, call feedback(retrieval_id="${rid}", entries=[{entry_id, verdict: used|irrelevant|wrong}]), or nothing_useful=true.`;

/** The last line of a tool reply while recalls in the session still wait for feedback. */
export const reminderLine = (rids: string[]) =>
  `Reminder: no feedback yet for retrieval ${rids.join(", ")}. Call feedback(retrieval_id, entries=[{entry_id, verdict}]) or nothing_useful=true.`;
