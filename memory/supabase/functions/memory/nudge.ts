// R75 (#80): task-shift gating for UserPromptSubmit hooks. Pure string logic with zero external imports so Deno and Node
// unit tests run it with --node-modules-dir=none, while service.ts supplies the session's prior cwd, idle gap, and last
// retrieval from Postgres.

export type PromptShiftInput = {
  prompt?: unknown;
  cwd?: unknown;
  hooksMode?: "full" | "metadata";
  prevCwd?: string | null;
  idleMs?: number | null;
  sinceRetrievalMs?: number | null;
  lastRetrievalText?: string | null;
};

const FRESH_RETRIEVAL_MS = 15 * 60_000;
const IDLE_GAP_MS = 20 * 60_000;
const MAX_NUDGE_LEN = 200;

// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;
const WORD = /[a-z0-9][a-z0-9_./-]{1,39}/g;

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "onto", "over", "under", "after", "before", "about",
  "what", "when", "where", "which", "while", "have", "has", "had", "will", "would", "could", "should", "can", "cant",
  "dont", "doesnt", "isnt", "arent", "was", "were", "been", "being", "make", "made", "just", "also", "only", "some",
  "more", "most", "other", "such", "than", "then", "them", "they", "their", "there", "here", "your", "ours", "please",
  "again", "still", "very", "much", "many", "each", "every", "both", "check", "update", "keep",
]);

const QUICK_FOLLOWUP =
  /^(?:yes|yep|yeah|no|nope|ok|okay|sure|thanks|thank you|cool|nice|good|great|lgtm|push|commit|merge|ship|deploy|rerun|retry|continue|proceed|go ahead|do it|fix (?:it|that|this|line|the typo|typo)|run (?:it|the|tests)|show (?:me )?(?:a )?screenshot|take (?:a )?screenshot|looks good)\b/i;

const stem = (w: string) => w.length >= 5 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;

function tokensOf(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(WORD)) {
    const w = m[0].replace(/^[./_-]+|[./_-]+$/g, "");
    if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) out.push(w);
  }
  return out;
}

function formatNudge(tokens: string[], metadataOnly: boolean): string {
  const prefix = "clyde: new goal or scope shift. ";
  if (metadataOnly || !tokens.length) {
    return `${prefix}Call recall before guessing past decisions or preferences.\n`;
  }
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const t of tokens) {
    const clean = t.replace(/[^a-z0-9._/-]/g, "").slice(0, 24);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    picked.push(clean);
    if (picked.length === 5) break;
  }
  if (!picked.length) return `${prefix}Call recall before guessing past decisions or preferences.\n`;
  let hint = picked.join(" ");
  const build = (h: string) => `${prefix}Call recall("${h}") if past decisions or preferences apply.\n`;
  while (hint.length > 8 && build(hint).length > MAX_NUDGE_LEN) {
    hint = hint.slice(0, hint.lastIndexOf(" ") > 0 ? hint.lastIndexOf(" ") : hint.length - 4).trim();
  }
  const line = build(hint);
  return line.length <= MAX_NUDGE_LEN ? line : `${prefix}Call recall before guessing past decisions or preferences.\n`;
}

/** Returns a single-line <= 200-char recall hint ending in \n when the prompt starts a new goal, switches folders, or
 * resumes after an idle gap, and "" on promptless payloads or quick follow-ups to the active task. */
export function classifyPromptShift(input: PromptShiftInput): string {
  const metadataOnly = input.hooksMode === "metadata";
  const raw = metadataOnly || typeof input.prompt !== "string" ? "" : input.prompt.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  const curCwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : null;
  const prevCwd = typeof input.prevCwd === "string" && input.prevCwd.trim() ? input.prevCwd.trim() : null;
  const cwdChanged = Boolean(curCwd && prevCwd && curCwd !== prevCwd);

  if (!raw && !cwdChanged) return "";
  if (cwdChanged) return formatNudge(raw ? tokensOf(raw) : [], metadataOnly);

  if (raw.startsWith("/") || /^comments on artifact uri:/i.test(raw)) return "";
  const wordCount = raw.split(" ").length;
  if (wordCount <= 10 && QUICK_FOLLOWUP.test(raw)) return "";

  const tokens = tokensOf(raw);
  if (tokens.length < 2) return "";

  const idleGap = typeof input.idleMs === "number" && input.idleMs > IDLE_GAP_MS;
  if (idleGap) return formatNudge(tokens, false);

  const freshRetrieval = typeof input.sinceRetrievalMs === "number" && input.sinceRetrievalMs >= 0 && input.sinceRetrievalMs <= FRESH_RETRIEVAL_MS;
  if (!freshRetrieval) return formatNudge(tokens, false);

  // An active session already ran recall recently in this folder: short follow-ups and overlapping turns stay silent.
  if (wordCount < 8) return "";
  const activeSet = new Set(tokensOf(input.lastRetrievalText ?? "").map(stem));
  let shared = 0;
  for (const t of tokens) if (activeSet.has(stem(t))) shared++;
  if (shared >= 1 && (wordCount <= 25 || shared >= 2)) return "";

  return formatNudge(tokens, false);
}
