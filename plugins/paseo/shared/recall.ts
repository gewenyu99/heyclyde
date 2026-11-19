import { z } from "zod";

// Mirror the authorized display payload produced by memoryCard() for MCP Apps.
export const noteSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string().optional(),
  kind: z.string().nullish(),
  category: z.string().nullish(),
  context: z.string().nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  verified: z.boolean().optional(),
  unreviewed: z.boolean().optional(),
  trial: z.boolean().optional(),
  chance: z.number().nullish(),
  private: z.boolean().optional(),
  provenance: z.string().nullish(),
  valid_from: z.string().nullish(),
  quote: z.string().nullish(),
  superseded_by: z.string().nullish(),
  artifacts: z.array(z.object({ name: z.string(), kind: z.string(), size: z.number() })).optional(),
});
export const badgeSchema = z.object({
  name: z.string(),
  context: z.string().nullish(),
  surface: z.string().nullish(),
  registered: z.boolean(),
});
const packet = z.object({
  retrieval_id: z.string().min(1),
  query: z.string().optional(),
  card_receipt: z.string().optional(),
  badge: badgeSchema.nullish(),
  page: z.string().optional(),
  degraded: z.string().nullish(),
  items: z.array(noteSchema),
});

export function recallPacket(card: unknown, text: string) {
  const parsed = packet.safeParse(card);
  if (parsed.success) return parsed.data;
  // Some provider bridges carry the text content but omit the MCP Apps metadata.
  const id = /^retrieval ([0-9a-f-]{36})\b/im.exec(text)?.[1];
  if (!id) throw new Error("Clyde returned no retrieval ID");
  const items: z.infer<typeof noteSchema>[] = [];
  for (const match of text.matchAll(/^\[(T?)(?:\d+)\] ([^:\s]+): (.+)((?:\r?\n[ \t]+[^\n]*)*)/gm)) {
    const [, trial, id, title, detail] = match;
    const note: z.infer<typeof noteSchema> = { id, title };
    const lines = detail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const meta = lines.shift();
    if (meta) {
      const fields = meta.split(" · ");
      note.kind = fields[trial ? 1 : 0];
      note.verified = !fields.includes("unverified");
      const confidence = meta.match(/(?:confidence | · )(0(?:\.\d+)?|1(?:\.0+)?)(?= · |$)/);
      if (confidence) note.confidence = Number(confidence[1]);
      if (trial) {
        note.trial = true;
        const chance = meta.match(/chance (\d+) of/);
        if (chance) note.chance = Number(chance[1]);
      }
      if (fields.includes("unreviewed")) note.unreviewed = true;
      const day = meta.match(/valid from (\d{4}-\d{2}-\d{2})/);
      if (day) note.valid_from = day[1];
    }
    if (lines[0]?.startsWith("from ")) note.provenance = lines.shift();
    const body = lines.filter((line) => !line.startsWith("Artifacts:") && !line.startsWith("Wen: “"));
    if (body.length) note.body = body.join("\n");
    const quote = lines.find((line) => line.startsWith("Wen: “"));
    if (quote) note.quote = quote.slice(6).replace(/”$/, "");
    items.push(note);
  }
  return {
    retrieval_id: id,
    items,
    query: undefined,
    card_receipt: undefined,
    badge: undefined,
    page: undefined,
    degraded: undefined,
  };
}
export function needsRecall(prompt: string, hasContext: boolean) {
  const text = prompt.trim();
  if (!text || /^\/(clyde|clyde-recall)(?:\s|$)/i.test(text)) return false;
  // A reaction to the previous reply carries no searchable topic. A named constraint or question still falls through.
  if (
    /^(?:(?:oh|hey|like|yeah|yep|nope|no|not|still|it|its|it's|this|that|is|isnt|isn't|doesnt|doesn't|working|wokring|work|broken|btw|lol|haha|but|good|nice|great|job|thanks|thank|you|cool|ok|okay|though|tho)\b[\s,.!'’?-]*)+$/i
      .test(text)
  ) return false;
  return !(hasContext &&
    /^(?:yes|ok(?:ay)?|continue|keep going|rerun(?: it)?|run it again|push it|commit it|thanks)[.!]?$/i.test(text));
}

/** Existing provider sessions can call Clyde's native MCP server directly, outside the Paseo bridge. */
export function nativeRecall(name: string, output: unknown) {
  if (!/^(?:mcp[_:.]+)?(?:memory|clyde)[_:.]+recall(?:_more)?$/i.test(name)) return;
  try {
    let value = output;
    if (typeof value === "string" && /^[{[]/.test(value.trim())) {
      try {
        value = JSON.parse(value);
      } catch { /* plain tool text */ }
    }
    const reply = value as { _meta?: Record<string, unknown>; content?: { text?: string }[]; text?: string } | null;
    const content = Array.isArray(value) ? value : reply?.content;
    const text = typeof value === "string"
      ? value
      : Array.isArray(content)
      ? content.map((b) => b?.text ?? "").join("\n")
      : reply?.text ?? "";
    return recallPacket(reply?._meta?.["clyde/card"], text);
  } catch {
    return;
  }
}

export function usedNotes(args: Record<string, unknown>, reply: string): string[] | undefined {
  if (args.card_vote === true || !/^Logged\.(?:\s|$)/.test(reply)) return;
  const entries = args.entries ?? args.items;
  if (Array.isArray(entries)) {
    return [
      ...new Set(
        entries.filter((e) => typeof e?.entry_id === "string" && ["used", "helpful"].includes(e.verdict)).map((e) =>
          e.entry_id as string
        ),
      ),
    ];
  }
  if (typeof args.entry_id === "string") {
    return ["helpful", "used"].includes(String(args.verdict)) ? [args.entry_id] : [];
  }
  if (args.nothing_useful === true || ["nothing_useful", "irrelevant", "wrong"].includes(String(args.verdict))) {
    return [];
  }
  return;
}
export function nativeFeedback(name: string, detail: { type: string; input?: unknown; output?: unknown }) {
  if (!/^(?:mcp[_:.]+)?(?:memory|clyde)[_:.]+feedback$/i.test(name) || detail.type !== "unknown") return;
  const raw = detail.input as Record<string, unknown> | null;
  if (!raw) return;
  const args = (raw.arguments ?? raw) as Record<string, unknown>;
  const value = detail.output as { content?: { text?: string }[]; text?: string; isError?: boolean } | string | null;
  if (!value || typeof value === "object" && value.isError) return;
  const text = typeof value === "string"
    ? value
    : Array.isArray(value)
    ? value.map((x) => x?.text ?? "").join("\n")
    : value.content?.map((x) => x.text ?? "").join("\n") ?? value.text ?? "";
  if (typeof args.retrieval_id === "string" && usedNotes(args, text) !== undefined) return { args, text };
}
export function usedFirst<T extends { id: string }>(items: readonly T[], used: ReadonlySet<string>): T[] {
  return [...items.filter((n) => used.has(n.id)), ...items.filter((n) => !used.has(n.id))];
}
