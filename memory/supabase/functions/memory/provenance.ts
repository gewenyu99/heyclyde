// R41: where a note came from, in one short line. provenanceLine is the only place that words it, and every arm's packet
// (the index lines, the main list, the On trial list) and get_entry use it. Nothing here filters: a note from another
// machine, agent or repo is shown, labelled, and the reading agent weighs it.
import type { Row, Sql } from "./db.ts";

/** The longest a provenance line gets, so it adds little to a packet item. */
export const PROVENANCE_MAX = 60;
export const YOU_WROTE_THIS = "(you wrote this)";

/** What memory recorded about a write. */
export type Provenance = { device: string; agent: string; agent_context?: string | null; repo?: string | null };
/** The reader: its machine and its agent. A note is the reader's own when both match. */
export type Viewer = { device: string; agent: string } | null;

const clip = (text: string, n: number) => text.length > n ? text.slice(0, Math.max(n - 1, 1)) + "…" : text;

/** `from codex on mac-mini in repo:posthog (work)`, with `(you wrote this)` after it on the reader's own notes. When the
 * parts don't fit in 60 characters, the repo goes first, then the context, then the agent and machine names are cut. */
export function provenanceLine(p: Provenance, viewer: Viewer): string {
  const mine = viewer !== null && viewer.device === p.device && viewer.agent === p.agent;
  const tail = mine ? ` ${YOU_WROTE_THIS}` : "";
  const repo = p.repo ? ` in repo:${p.repo}` : "";
  const context = p.agent_context ? ` (${p.agent_context})` : "";
  let agent = p.agent, device = p.device;
  const build = (r: string, c: string) => `from ${agent} on ${device}${r}${c}${tail}`;
  for (const [r, c] of [[repo, context], ["", context], ["", ""]]) {
    const line = build(r, c);
    if (line.length <= PROVENANCE_MAX) return line;
  }
  // Names alone are too long: cut the longer one a character at a time.
  while (build("", "").length > PROVENANCE_MAX) {
    if (device.length >= agent.length) device = clip(device, device.length - 1);
    else agent = clip(agent, agent.length - 1);
  }
  return build("", "");
}

/** The provenance line of each of these entries that has one, by entry id. One query by primary key. */
export async function provenanceLines(db: Sql, ids: string[], viewer: Viewer): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db`select entry_id, device, agent, agent_context, repo from memory.entry_provenance where entry_id = any(${ids}::text[])`;
  return new Map(rows.map((r: Row) => [r.entry_id as string, provenanceLine(r as Provenance, viewer)]));
}
