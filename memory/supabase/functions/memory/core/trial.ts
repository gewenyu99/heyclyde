// Trial lane formatting helpers for newly stored entries still proving themselves.
import { kindLabel, redactEntry, type Row } from "./ranking.ts";

export const TRIAL_CHANCES = 3;
export const TRIAL_ITEM_CHARS = 400;
const TITLE_CHARS = 100;
const clipText = (text: string, n: number) => text.length > n ? text.slice(0, n - 1) + "…" : text;

export function renderTrialItem(n: number, row: Row, chancesLeft: number, ownerLabel = "the owner"): string {
  row = redactEntry(row, ownerLabel);
  const head = `[T${n}] ${row.id}: ${clipText(String(row.title), TITLE_CHARS)}`;
  const label = `    new · ${kindLabel(row, " · ")} · chance ${TRIAL_CHANCES - chancesLeft} of ${TRIAL_CHANCES}`;
  const origin = row.provenance ? `    ${row.provenance}` : "";
  const room = TRIAL_ITEM_CHARS - head.length - label.length - origin.length - (origin ? 1 : 0) - 6;
  return [
    head,
    label,
    ...(origin ? [origin] : []),
    `    ${clipText(String(row.body ?? "").replace(/\s+/g, " ").trim(), Math.max(room, 1))}`,
  ].join("\n");
}
