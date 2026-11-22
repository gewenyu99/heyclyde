// Secrets and sensitive personal identifiers never reach storage. Every write path runs text through
// redact() before saving: hook payloads, entries, messages, and recall queries. A match becomes
// [redacted:<kind>], preserving the surrounding text.

type Rule = [kind: string, pattern: RegExp, keep?: (m: string) => boolean];

/** Luhn check so digit runs only count as payment cards or national IDs when valid. */
function luhn(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
}

const RULES: Rule[] = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ["api-key", /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}/g],
  ["api-key", /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}/g],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["aws-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["google-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["stripe-key", /\b(?:rk|pk|sk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["bearer-token", /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g],
  ["url-credentials", /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]{3,}(?=@)/gi],
  ["secret", /\b((?:password|passwd|pwd|passphrase|secret|client_secret|api[_-]?key|access[_-]?key|auth[_-]?token|token)\b["']?\s*[:=]\s*["']?)[^\s"'`,;)}\]]{6,}/gi],
  ["card", /\b(?:\d[ -]?){13,19}\b/g, luhn],
  ["ssn", /\b\d{3}-\d{2}-\d{4}\b/g],
  ["sin", /\b\d{3}[- ]\d{3}[- ]\d{3}\b/g, luhn],
];

/** Returns text with secrets and dangerous identifiers replaced, plus matched kinds. */
export function redactText(text: string): [string, string[]] {
  const found: string[] = [];
  let out = text;
  for (const [kind, pattern, keep] of RULES) {
    out = out.replace(pattern, (match: string, prefix?: unknown) => {
      if (keep && !keep(match)) return match;
      found.push(kind);
      // Rules capturing a prefix such as "password=" or "Bearer " preserve the prefix so text stays readable.
      return (typeof prefix === "string" && match.startsWith(prefix) ? prefix : "") + `[redacted:${kind}]`;
    });
  }
  return [out, found];
}

/** Returns a deep copy of any JSON-compatible value with every string redacted. */
export function redact<T>(value: T, found: string[] = []): T {
  if (typeof value === "string") {
    const [out, kinds] = redactText(value);
    found.push(...kinds);
    return out as T;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, found)) as T;
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, found)])) as T;
  }
  return value;
}
