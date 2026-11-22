// The trial lane (R28): a recall's "On trial" list. An entry that has chances left is shown there, apart from the settled main
// list, so it can earn its place. Showing it spends one chance (service.recall does that, inside the recall's transaction).
import type { Row } from "./db.ts";
import { renderTrialItem as renderCoreTrialItem, TRIAL_CHANCES, TRIAL_ITEM_CHARS } from "./core/trial.ts";

export { TRIAL_CHANCES, TRIAL_ITEM_CHARS };

/** The n-th item of the On trial list, in at most TRIAL_ITEM_CHARS characters. `chancesLeft` is what the entry has after this
 * showing spent one, so the chance it is on is TRIAL_CHANCES less that. */
export function renderTrialItem(n: number, row: Row, chancesLeft: number) {
  return renderCoreTrialItem(n, row, chancesLeft, "Wen");
}
