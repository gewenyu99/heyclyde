import { z } from "zod";

const packet = z.object({
  retrieval_id: z.string().min(1),
  query: z.string().optional(),
  card_receipt: z.string().optional(),
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      body: z.string().optional(),
      provenance: z.string().nullish(),
      kind: z.string().nullish(),
    }),
  ),
});
export function recallPacket(card: unknown, text: string) {
  const parsed = packet.safeParse(card);
  if (parsed.success) return parsed.data;
  // Some provider bridges carry the text content but omit the MCP Apps metadata.
  const id = /^retrieval ([0-9a-f-]{36})\b/im.exec(text)?.[1];
  if (!id) throw new Error("Clyde returned no retrieval ID");
  const items = [...text.matchAll(/^\[(?:T)?\d+\] ([^:\s]+): (.+)$/gm)].map(([, id, title]) => ({ id, title }));
  return { retrieval_id: id, items, query: undefined, card_receipt: undefined };
}
export function needsRecall(prompt: string, hasContext: boolean) {
  const text = prompt.trim();
  if (!text || /^\/(clyde|clyde-recall)(?:\s|$)/i.test(text)) return false;
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
