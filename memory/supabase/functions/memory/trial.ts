// The trial lane (R28): a recall's "On trial" list. An entry that has chances left is shown there, apart from the settled main
// list, so it can earn its place. Showing it spends one chance (service.recall does that, inside the recall's transaction).
import type { Row } from "./db.ts";
import { kindLabel, redact } from "./search.ts";

/** How many showings a new note gets. write.ts starts them at this many chances_left. */
export const TRIAL_CHANCES = 3;
/** A trial item is a glance, so it stays short however long the note is. */
export const TRIAL_ITEM_CHARS = 400;
const TITLE_CHARS = 100;
const clip = (text: string, n: number) => text.length > n ? text.slice(0, n - 1) + "…" : text;

/** The n-th item of the On trial list, in at most TRIAL_ITEM_CHARS characters. `chancesLeft` is what the entry has after this
 * showing spent one, so the chance it is on is TRIAL_CHANCES less that. */
export function renderTrialItem(n: number, row: Row, chancesLeft: number) {
  row = redact(row);
  const head = `[T${n}] ${row.id}: ${clip(String(row.title), TITLE_CHARS)}`;
  const label = `    new · ${kindLabel(row, " · ")} · chance ${TRIAL_CHANCES - chancesLeft} of ${TRIAL_CHANCES}`;
  // R41: the line provenance.ts worded, when memory recorded where the note came from.
  const origin = row.provenance ? `    ${row.provenance}` : "";
  const room = TRIAL_ITEM_CHARS - head.length - label.length - origin.length - (origin ? 1 : 0) - 6;
  return [head, label, ...(origin ? [origin] : []), `    ${clip(String(row.body ?? "").replace(/\s+/g, " ").trim(), Math.max(room, 1))}`].join("\n");
}
