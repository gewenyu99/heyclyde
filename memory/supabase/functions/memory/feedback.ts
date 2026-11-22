// The feedback call (R33): what the agent may send, checked before anything is written, and the two lines that ask for it.
// A call is all or nothing. checkFeedback reads no database, so tests and the tool share it.
export {
  BAD_VERDICT,
  checkFeedback,
  ENTRY_VERDICTS,
  feedbackFooter,
  type FeedbackRow,
  NOTE_MAX,
  REMIND_MAX,
  reminderLine,
  VERDICTS,
} from "./core/feedback.ts";

const CARD_RECEIPT_HEX = /^[0-9a-f]{64}$/;

async function cardReceiptKey(usages: KeyUsage[]): Promise<CryptoKey> {
  const secret = (typeof Deno !== "undefined" ? Deno.env.get("MEMORY_CARD_RECEIPT_SECRET") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") : "") || "clyde-card-vote-v1";
  return await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

const cardReceiptInput = (session: string, retrieval: string) =>
  new TextEncoder().encode(JSON.stringify(["clyde-card-vote-v1", session, retrieval]));

/** A receipt only authorizes a card vote on this retrieval. A host can render the card outside the original MCP session. */
export async function cardVoteReceipt(session: string, retrieval: string): Promise<string> {
  const key = await cardReceiptKey(["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, cardReceiptInput(session, retrieval));
  return Array.from(new Uint8Array(sig), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant-time HMAC verification for cross-session recall card vote receipts. */
export async function verifyCardVoteReceipt(session: string, retrieval: string, receipt: unknown): Promise<boolean> {
  if (typeof receipt !== "string" || !CARD_RECEIPT_HEX.test(receipt)) return false;
  const sig = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sig[i] = Number.parseInt(receipt.slice(i * 2, i * 2 + 2), 16);
  const key = await cardReceiptKey(["verify"]);
  return await crypto.subtle.verify("HMAC", key, sig, cardReceiptInput(session, retrieval));
}
