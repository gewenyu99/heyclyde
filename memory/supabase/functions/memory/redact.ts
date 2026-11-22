// Secrets and dangerous personal identifiers never reach the store. Every write path runs text through redact() before it
// is saved: hook payloads, entries, messages and recall queries. A match becomes [redacted:<kind>], so the rest of the
// text keeps its meaning.
export { redact, redactText } from "./core/redact.ts";
