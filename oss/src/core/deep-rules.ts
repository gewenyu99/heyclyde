// Pure formatting and pagination label helpers for deep recall and recall_more.
import type { Params } from "./params.ts";
import { artifactsLine, MORE, redactEntry, type Row } from "./ranking.ts";

export const DEPTHS = ["packet", "deep"];
export const NOTHING_MORE = "Nothing more in memory matches.";
export const capLine = (n: number) => `Memory ranks only the top ${n} matches. Narrow the query to see more.`;
export const moreLine = (rid: string) => `More past these: recall_more(retrieval_id="${rid}").`;
export const PAGE_HEAD = "Deeper in memory, past what the recall showed. Each item says its kind, strength and state.";

export function deepLabel(row: Row, dormant: number): string {
  const c = Number(row.confidence ?? 0);
  const state = row.superseded_by
    ? `superseded by ${row.superseded_by}`
    : c < dormant
    ? "dormant"
    : Number(row.chances_left ?? 0) > 0
    ? `on trial, ${row.chances_left} left`
    : "settled";
  return `    kind ${row.kind ?? "observation"} · strength ${c.toFixed(2)} · ${state}`;
}

export function renderDeepItem(n: number, row: Row, p: Params, ownerLabel = "the owner"): string {
  row = redactEntry(row, ownerLabel);
  const body = p.itemChars && String(row.body).length > p.itemChars ? `${String(row.body).slice(0, p.itemChars)}${MORE}` : row.body;
  const parts = [`[${n}] ${row.id}: ${row.title}`, deepLabel(row, p.dormant), ...(row.provenance ? [`    ${row.provenance}`] : []), `    ${body}`];
  const artifacts = artifactsLine(row);
  if (artifacts) parts.push(`    ${artifacts}`);
  return parts.join("\n");
}

export type Page = { delivered: string[]; chunks: string[]; left: number; capped: boolean };

export const closingLine = (page: Page, rid: string, p: Params) =>
  page.left ? moreLine(rid) : page.capped ? capLine(p.candidates) : NOTHING_MORE;
