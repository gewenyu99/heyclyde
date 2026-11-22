// Shared entry/blob constants, canonical payload hashing, ID generation, and validation helpers.
import type { Row } from "./ranking.ts";

export const AUTHORITY = new Set(["approved", "observed", "draft"]);
export const LINK_TYPES = new Set(["supersedes", "supports", "contradicts", "derived_from", "relates", "part_of", "corrects"]);
export const PATTERNS = new Set(["projects", "decisions", "observations", "preferences", "recommendations", "references", "reactions"]);
export const EVIDENCE_KINDS = new Set(["quote", "assistant", "summary", "memory"]);
export const SCOPE_RE = /^(global|domain:[a-z0-9-]+|repo:[A-Za-z0-9._/-]+|run:[A-Za-z0-9._-]+)$/;
export const SENSITIVITY = new Set(["normal", "private", "confidential"]);

export const RANK: Record<string, number> = { draft: 0, observed: 1, approved: 2 };
export const FREE_LINKS = new Set([...LINK_TYPES].filter((t) => t !== "part_of" && t !== "supersedes"));
export const FIELDS = new Set([
  "id", "pattern", "title", "body", "authority", "scope", "sensitivity", "lang", "valid_from",
  "source", "evidence_kind", "evidence", "evidence_event", "kind", "project", "links", "supersedes", "blobs", "artifacts", "long",
  "category", "context", "transferability", "project_slug", "computer",
]);
export const DEFAULT_CATEGORY: Record<string, string> = {
  decisions: "architecture",
  preferences: "preferences",
  projects: "product",
  reactions: "workflow",
};

export const CORE_KINDS = ["fact", "user", "observation", "plan"] as const;
export const START_CONFIDENCE: Record<string, { confidence: number; chances: number }> = {
  fact: { confidence: 0.9, chances: 0 },
  user: { confidence: 0.7, chances: 3 },
  observation: { confidence: 0.5, chances: 3 },
  plan: { confidence: 0.5, chances: 3 },
};

export const AGENT_NAME = /^[a-z0-9_-]{1,40}$/;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
export const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
const SURROGATE = /[\ud800-\udfff]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export const MAX_CHARS: Record<string, number> = { title: 300, body: 4000, evidence: 20000 };
export const BODY_SHORT = 500;
export const MAX_BLOBS = 16;
export const MAX_BLOB_BYTES = 4 * 1024 * 1024;
export const MAX_BLOBS_BYTES = 8 * 1024 * 1024;

export const KIND_LIST = "image, video, audio, document, skill, artifact, data, other";
export const BLOB_KINDS = new Set(KIND_LIST.split(", "));
export const SHA_RE = /^[0-9a-f]{64}$/;

export function blobKindOf(mediaType: string, name: string): string {
  const top = mediaType.split("/")[0];
  if (top === "image" || top === "video" || top === "audio") return top;
  if (/(^|\/)skill\.md$/i.test(name)) return "skill";
  if (mediaType === "text/html") return "artifact";
  if (mediaType === "application/pdf") return "document";
  if (mediaType === "application/json" || mediaType === "text/csv") return "data";
  if (top === "text") return "document";
  return "other";
}

export function isTextMedia(mediaType: string): boolean {
  return mediaType.startsWith("text/") || /\/(json|xml|yaml|x-yaml|csv|javascript|toml|x-sh|markdown)$|\+(json|xml)$/.test(mediaType);
}

export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export class Refused extends Error {}

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
}

function pyString(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** Deterministic canonical JSON string matching sorted-key Python json.dumps output. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(", ") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => `${pyString(k)}: ${canonical((v as Row)[k])}`).join(", ") + "}";
  }
  if (typeof v === "string") return pyString(v);
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" && Number.isInteger(v)) return String(v);
  if (typeof v === "number") return Number.isInteger(v) ? `${v}.0` : String(v);
  return v ? "true" : "false";
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function digestPayload(payload: Row): Promise<string> {
  const { id: _, ...rest } = payload;
  return sha256Hex(canonical(rest));
}

export function makeId(payload: Row, d: string): string {
  const head = slug(`${payload.scope ?? ""} ${payload.title ?? ""}`);
  return head ? `${head}-${d.slice(0, 8)}` : d.slice(0, 8);
}

export function* unstorable(value: unknown, path = ""): Generator<string> {
  if (typeof value === "string") {
    if (SURROGATE.test(value) && LONE_SURROGATE.test(value)) {
      yield `${path} has a lone surrogate, half of a character. Send valid UTF-8.`;
    } else if (value.includes("\0") && !/^(blobs|artifacts)\[\d+\]\.text$/.test(path)) {
      yield `${path} has a NUL character, which memory can't store.`;
    }
  } else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* unstorable(v, `${path}[${i}]`);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) yield* unstorable(v, path ? `${path}.${k}` : k);
  }
}
