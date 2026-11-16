// remember(): the runtime write path. One entry with its source, links and blobs, held to the invariants seed/build.py
// enforces on the vault, written in one transaction. The constants copy build.py's, plus run:<id> scopes.
import { OverBudget } from "./budget.ts";
import * as store from "./blobs.ts";
import { type Row, type Sql, sql } from "./db.ts";
import { sha256 } from "./embed.ts";
import { MIN_QUOTE, squash, verifyEvidence } from "./evidence.ts";
import { redactText } from "./redact.ts";
import { screen } from "./judge.ts";

const AUTHORITY = new Set(["approved", "observed", "draft"]);
const LINK_TYPES = new Set(["supersedes", "supports", "contradicts", "derived_from", "relates", "part_of", "corrects"]);
const PATTERNS = new Set(["projects", "decisions", "observations", "preferences", "recommendations", "references", "reactions"]);
const EVIDENCE_KINDS = new Set(["quote", "assistant", "summary", "memory"]);
export const SCOPE_RE = /^(global|domain:[a-z0-9-]+|repo:[A-Za-z0-9._/-]+|run:[A-Za-z0-9._-]+)$/;
// private: agents and third-party models see the title only. confidential: agents see it all, third-party models the
// title only, for work material.
const SENSITIVITY = new Set(["normal", "private", "confidential"]);

const RANK: Record<string, number> = { draft: 0, observed: 1, approved: 2 };
// part_of comes from `project` and supersedes from `supersedes`, so `links` takes the other types.
const FREE_LINKS = new Set([...LINK_TYPES].filter((t) => t !== "part_of" && t !== "supersedes"));
const FIELDS = new Set(["id", "pattern", "title", "body", "authority", "scope", "sensitivity", "lang", "valid_from",
  "source", "evidence_kind", "evidence", "evidence_event", "kind", "project", "links", "supersedes", "blobs", "artifacts", "long"]);
// What a note claims. A fact is checkable against an event memory holds, wen is Wen's own words, an observation is an
// agent's inference or summary, and a plan says what someone means to do.
const KINDS = ["fact", "wen", "observation", "plan"];
/** Where a kind of note starts: its confidence, and how many showings it has to prove itself. A fact whose quote checked
 * out against its event starts settled and high. Everything else is on trial for its first 3 showings. */
export const START: Record<string, { confidence: number; chances: number }> = {
  fact: { confidence: 0.9, chances: 0 }, wen: { confidence: 0.7, chances: 3 },
  observation: { confidence: 0.5, chances: 3 }, plan: { confidence: 0.5, chances: 3 },
};
const AGENT_NAME = /^[a-z0-9_-]{1,40}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
export const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
const SURROGATE = /[\ud800-\udfff]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

// One entry can't flood a recall packet. Long material goes in artifacts. An agent's body is held to BODY_SHORT unless it
// passes long: true.
const MAX_CHARS: Record<string, number> = { title: 300, body: 4000, evidence: 20000 };
export const BODY_SHORT = 500;
export const MAX_BLOBS = 16, MAX_BLOB_BYTES = 4 * 1024 * 1024, MAX_BLOBS_BYTES = 8 * 1024 * 1024;

// The most each caller may write. Every agent session holds a device token, so an agent writes drafts under AGENT_SOURCE,
// with an id memory generates. A draft hides from no one: authority is a label, and visibility never waits on review. Only
// clyde-flow holds the runtime token.
const CALLERS: Record<string, string> = { agent: "draft", runtime: "approved" };
const AGENT_SOURCE = { kind: "session", title: "An agent session, through remember" };

/** The payload breaks an invariant. Nothing was written. The message has one line per problem. */
export class Refused extends Error {}

export function slug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
}

/** Python's json.dumps(sort_keys=True), so a digest made by the old server still matches. */
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

function pyString(s: string) {
  // json.dumps escapes every non-ASCII character as \uXXXX.
  return JSON.stringify(s).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** sha256 of the payload without its id. Stored on the entry, so a resend can tell its own entry from another. */
export function digest(payload: Row) {
  const { id: _, ...rest } = payload;
  return sha256(canonical(rest));
}

/** A slug of the scope and title plus the payload's digest. The same write always gets the same id. */
export function makeId(payload: Row, d: string) {
  const head = slug(`${payload.scope ?? ""} ${payload.title ?? ""}`);
  return head ? `${head}-${d.slice(0, 8)}` : d.slice(0, 8);
}

const text = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : null;
const oneOf = (v: unknown, allowed: Set<string>) => typeof v === "string" && allowed.has(v);

/** A refusal for each string memory can't store: NUL outside blob text, or a lone surrogate. */
function* unstorable(value: unknown, path = ""): Generator<string> {
  if (typeof value === "string") {
    if (SURROGATE.test(value) && LONE_SURROGATE.test(value)) yield `${path} has a lone surrogate, half of a character. Send valid UTF-8.`;
    else if (value.includes("\0") && !/^(blobs|artifacts)\[\d+\]\.text$/.test(path)) yield `${path} has a NUL character, which memory can't store.`;
  } else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* unstorable(v, `${path}[${i}]`);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) yield* unstorable(v, path ? `${path}.${k}` : k);
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const isDate = (v: unknown) =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) && new Date(v).toISOString().startsWith(v);

// ---------------------------------------------------------------- checks that need no database
/** Every check that needs no database. Returns the entry with its defaults filled in, or throws Refused. */
export async function validate(payload: unknown, caller: string, agentName = "agent", profile: string | null = null): Promise<Row> {
  if (!(caller in CALLERS)) throw new Error(`caller ${caller} must be agent or runtime`);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Refused("An entry is a JSON object.");
  const raw = payload as Row;
  const errs = Object.keys(raw).filter((k) => !FIELDS.has(k)).sort().map((k) => `Unknown field ${k}.`);
  const bad = [...unstorable(raw)];
  if (bad.length) throw new Refused([...errs, ...bad].join("\n"));
  const maxAuthority = CALLERS[caller], agent = caller === "agent";
  const p: Row = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null && v !== undefined));
  const e: Row = {
    pattern: p.pattern, title: text(p.title), body: text(p.body), authority: p.authority ?? (agent ? "draft" : undefined),
    scope: p.scope ?? "global", kind: p.kind,
    sensitivity: p.sensitivity ?? "normal", lang: text(p.lang ?? "en"), evidence_kind: p.evidence_kind,
    evidence: text(p.evidence), project: p.project || null,
  };

  if (!oneOf(e.pattern, PATTERNS)) errs.push(`pattern must be one of ${[...PATTERNS].sort().join(", ")}.`);
  if (!e.title) errs.push("title is required.");
  if (!e.body) errs.push("body is required. It's the summary recall ranks on.");
  for (const [field, cap] of Object.entries(MAX_CHARS)) {
    if (e[field] && e[field].length > cap) {
      errs.push(`${field} is ${e[field].length} characters. The limit is ${cap}, so put long material in an artifact.`);
    }
  }
  if (agent && e.body && e.body.length > BODY_SHORT && e.body.length <= MAX_CHARS.body && p.long !== true) {
    errs.push(`body is ${e.body.length} characters. Keep a memory under ${BODY_SHORT} characters and put the detail in an artifact ` +
      `(artifacts: [{name, kind, text}]), or pass long: true.`);
  }
  if (!oneOf(e.authority, AUTHORITY)) errs.push("authority must be draft, observed or approved.");
  else if (RANK[e.authority] > RANK[maxAuthority]) {
    errs.push(`authority ${e.authority} is above ${maxAuthority}, the most this caller may write.`);
  }
  if (!(typeof e.scope === "string" && SCOPE_RE.test(e.scope))) {
    errs.push(`scope ${JSON.stringify(e.scope ?? null)} must be global, domain:<x>, repo:<x> or run:<id>.`);
  }
  if (e.kind !== undefined && !oneOf(e.kind, new Set(KINDS))) {
    errs.push(`kind ${JSON.stringify(e.kind)} must be one of ${KINDS.join(", ")}.`);
  }
  e.evidence_event = null;
  if ("evidence_event" in p) {
    if (/^\d{1,18}$/.test(String(p.evidence_event)) && Number(p.evidence_event) > 0) e.evidence_event = String(p.evidence_event);
    else errs.push("evidence_event must be an event id.");
  }
  if (!oneOf(e.sensitivity, SENSITIVITY)) errs.push("sensitivity must be normal, private or confidential.");
  if (!e.lang) errs.push("lang must be a language code like en.");
  if (!oneOf(e.evidence_kind, EVIDENCE_KINDS)) {
    errs.push(`evidence_kind must be one of ${[...EVIDENCE_KINDS].sort().join(", ")}.`);
  }
  if (!e.evidence) errs.push("evidence is required and can't be empty.");
  if (e.evidence_kind === "quote" && e.authority === "draft") errs.push("A quote of Wen can't back a draft.");

  if ("valid_from" in p && !isDate(p.valid_from)) errs.push(`valid_from ${JSON.stringify(p.valid_from)} must be a YYYY-MM-DD date.`);
  e.valid_from = "valid_from" in p ? p.valid_from : today();

  if (e.project !== null && typeof e.project !== "string") errs.push("project must be an entry id.");
  else if (e.project === null && e.pattern !== "projects") {
    if (agent) {
      // An agent that names no project gets its own notes project, made the first time it's needed.
      e.project = `notes-${AGENT_NAME.test(agentName) ? agentName : "agent"}`;
      e.notesProject = true;
    } else {
      errs.push("project is required unless pattern is projects. It's the id of the projects entry this belongs to." +
        (String(e.scope).startsWith("run:") ? ` For a run, create its projects entry in scope ${e.scope} first.` : ""));
    }
  }

  const explicitId = (p.id ?? "") !== "";
  if (agent && "source" in p) errs.push("An agent can't name a source. memory records the write as an agent session.");
  if (agent && explicitId) errs.push("An agent can't choose an id. memory generates one from the payload.");
  // A registered agent's notes name it (R19): "r19-a, a work agent on claude-code, through remember".
  e.source = await source(agent ? (profile ? { ...AGENT_SOURCE, title: `${profile}, through remember` } : AGENT_SOURCE) : p.source, errs);
  e.links = links(p.links ?? [], errs);
  e.supersedes = ids(p.supersedes ?? [], "supersedes", errs);
  e.blobs = await artifacts([...(Array.isArray(p.artifacts) ? p.artifacts : p.artifacts === undefined ? [] : [p.artifacts]),
    ...(Array.isArray(p.blobs) ? p.blobs : p.blobs === undefined ? [] : [p.blobs])], errs);

  e.digest = await digest(raw);
  e.id = explicitId && !agent ? p.id : makeId(raw, e.digest);
  if (!(typeof e.id === "string" && ID_RE.test(e.id))) {
    errs.push("id must be letters, digits, '.', '_' and '-', starting with a letter or digit.");
  }
  if (e.project !== null && e.project === e.id) errs.push("An entry can't be part of itself.");
  if (e.links.some(([, to]: string[]) => to === e.id)) errs.push("An entry can't link to itself.");
  if (e.supersedes.includes(e.id)) errs.push("An entry can't supersede itself.");
  if (errs.length) throw new Refused(errs.join("\n"));
  return e;
}

async function source(src: unknown, errs: string[]) {
  if (!src || typeof src !== "object" || Array.isArray(src)) {
    errs.push("source is required: {kind, title, uri} for a new one, or {id} for one memory already has.");
    return null;
  }
  const r = src as Row;
  const s: Row = { id: r.id || null, kind: text(r.kind), title: text(r.title), uri: text(r.uri) };
  if (s.id === null) {
    if (!(s.kind && s.title)) errs.push("A new source needs a kind and a title.");
    s.id = `${slug(s.kind || "source")}-${(await sha256(canonicalList([s.kind, s.title, s.uri]))).slice(0, 10)}`;
  } else if (!(typeof s.id === "string" && ID_RE.test(s.id))) {
    errs.push("source.id must be letters, digits, '.', '_' and '-'.");
  }
  return s;
}

/** json.dumps of a list, without sort_keys, the way the old server named new sources. */
const canonicalList = (v: unknown[]) => canonical(v);

function ids(value: unknown, field: string, errs: string[]): string[] {
  if (!(Array.isArray(value) && value.every((v) => typeof v === "string" && v))) {
    errs.push(`${field} must be a list of entry ids.`);
    return [];
  }
  return [...new Set(value as string[])];
}

function links(value: unknown, errs: string[]): [string, string][] {
  if (!(Array.isArray(value) && value.every((l) => l && typeof l === "object" && !Array.isArray(l)))) {
    errs.push("links must be a list of {type, to}.");
    return [];
  }
  const out = new Map<string, [string, string]>();
  for (const l of value as Row[]) {
    const t = l.type, to = l.to;
    if (t === "part_of") errs.push("Set part_of with project, not links.");
    else if (t === "supersedes") errs.push("Set supersedes with supersedes, not links.");
    else if (!oneOf(t, FREE_LINKS)) errs.push(`link type ${JSON.stringify(t ?? null)} must be one of ${[...FREE_LINKS].sort().join(", ")}.`);
    if (!(typeof to === "string" && to)) errs.push("Every link needs a `to` entry id.");
    else if (oneOf(t, FREE_LINKS)) out.set(`${t}\0${to}`, [t, to]);
  }
  return [...out.values()];
}

function b64decode(s: string): Uint8Array | null {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4) return null;
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Each artifact carries `text`, `base64` for binary content, or the `sha256` of a file sent with upload_blob. Returns the
 * inline ones decoded and hashed, and the cited ones by sha256 alone (resolve() fills in the rest). `kind` is one of KINDS, or
 * memory derives it. Inline text with a secret in it has the secret redacted. */
async function artifacts(value: unknown, errs: string[]): Promise<Row[]> {
  if (!(Array.isArray(value) && value.every((b) => b && typeof b === "object" && !Array.isArray(b)))) {
    errs.push("artifacts must be a list of {name, kind, text | base64 | sha256}.");
    return [];
  }
  if (value.length > MAX_BLOBS) {
    errs.push(`An entry has ${value.length} artifacts. The limit is ${MAX_BLOBS}.`);
    return [];
  }
  const out: Row[] = [], names = new Set<string>();
  for (const b of value as Row[]) {
    const name = text(b.name);
    if (!name) errs.push("Every blob needs a name.");
    else if (names.has(name)) errs.push(`Two blobs are named ${name}.`);
    if (name) names.add(name);
    const label = name || "without a name";
    let kind: string | null = null;
    if (b.kind !== undefined && b.kind !== null) {
      if (typeof b.kind === "string" && store.KINDS.has(b.kind)) kind = b.kind;
      else errs.push(`Blob ${label} has kind ${JSON.stringify(b.kind)}. Use one of ${store.KIND_LIST}.`);
    }
    const given = ["text", "base64", "sha256"].filter((k) => k in b);
    if (given.length !== 1) {
      errs.push(`Blob ${label} needs text, base64 or sha256, not several or none.`);
      continue;
    }
    let mediaType = b.media_type;
    const typeOk = () => {
      // The first writer's media type is the one GET /blobs sends, so it has to be a valid header value.
      if (mediaType === undefined || mediaType === null) return true;
      if (typeof mediaType === "string" && MEDIA_TYPE_RE.test(mediaType.toLowerCase())) {
        mediaType = mediaType.toLowerCase();
        return true;
      }
      errs.push(`Blob ${label} needs a media_type like text/markdown, not ${JSON.stringify(mediaType)}.`);
      return false;
    };
    if (given[0] === "sha256") {
      if (typeof b.sha256 !== "string" || !store.SHA_RE.test(b.sha256)) {
        errs.push(`Blob ${label} has a sha256 that isn't 64 hex digits.`);
        continue;
      }
      typeOk();
      out.push({ name, kind, media_type: mediaType ?? null, sha256: b.sha256, cited: true });
      continue;
    }
    let data: Uint8Array, defaultType: string;
    if ("text" in b) {
      if (typeof b.text !== "string") {
        errs.push(`Blob ${label} has text that isn't a string.`);
        continue;
      }
      data = new TextEncoder().encode(redactText(b.text)[0]);
      defaultType = "text/plain";
    } else {
      const decoded = b64decode(b.base64);
      if (!decoded) {
        errs.push(`Blob ${label} has base64 that doesn't decode.`);
        continue;
      }
      data = decoded;
      defaultType = "application/octet-stream";
    }
    if (data.length > MAX_BLOB_BYTES) errs.push(`Blob ${label} is ${data.length} bytes. The limit is ${MAX_BLOB_BYTES}.`);
    if (!typeOk()) continue;
    mediaType = mediaType ?? defaultType;
    // Text sent as base64 gets the same redaction as text sent as text.
    const asText = "base64" in b && store.isText(mediaType) ? store.utf8(data) : null;
    if (asText !== null) data = new TextEncoder().encode(redactText(asText)[0]);
    out.push({ name, kind: kind ?? store.kindOf(mediaType, name ?? ""), media_type: mediaType, content: data, sha256: await sha256(data) });
  }
  const total = out.reduce((n, b) => n + (b.content?.length ?? 0), 0);
  if (total > MAX_BLOBS_BYTES) errs.push(`The blobs add up to ${total} bytes. The limit for one entry is ${MAX_BLOBS_BYTES}.`);
  return out;
}

// ---------------------------------------------------------------- checks against the graph, then the write
/** The invariants that need the graph: targets exist, the project is a project, and supersession never hides an
 * entry from anyone who could see it before. */
async function check(db: Sql, e: Row) {
  const targets = [...new Set([e.project, ...e.links.map(([, to]: string[]) => to), ...e.supersedes].filter(Boolean))];
  const known: Record<string, Row> = Object.fromEntries(
    (await db`select id, pattern, authority, scope from memory.entry where id = any(${targets}::text[])`).map((r) => [r.id, r]),
  );
  const errs: string[] = [];
  const p = e.project;
  if (p !== null && !(p in known)) {
    errs.push(e.scope.startsWith("run:")
      ? `Project ${p} doesn't exist. Create the run's project entry first, with pattern projects and scope ${e.scope}.`
      : `Project ${p} doesn't exist.`);
  } else if (p !== null && known[p].pattern !== "projects") {
    errs.push(`${p} is a ${known[p].pattern} entry, not a project.`);
  }
  for (const [t, to] of e.links) if (!(to in known)) errs.push(`Dangling link: ${t} ${to}, which doesn't exist.`);
  for (const old of e.supersedes) {
    const o = known[old];
    if (!o) {
      errs.push(`Can't supersede ${old}: it doesn't exist.`);
      continue;
    }
    if (RANK[o.authority] > RANK[e.authority]) {
      errs.push(`${e.authority === "observed" ? "An" : "A"} ${e.authority} entry can't supersede ${o.authority} ${old}.`);
    }
    if (e.scope.startsWith("run:") && o.scope !== e.scope) {
      errs.push(`A ${e.scope} entry can only supersede entries in ${e.scope}, and ${old} is in ${o.scope}.`);
    }
  }
  const s = e.source;
  if (!(s.kind && s.title) && !(await db`select 1 from memory.source where id = ${s.id}`).length) {
    errs.push(`Source ${s.id} is new, so it needs a kind and a title.`);
  }
  if (errs.length) throw new Refused(errs.join("\n"));
}

/** True when this payload already landed. Refused when its id holds an entry with different content. */
async function landed(db: Sql, e: Row) {
  const [row] = await db`select payload_sha256 from memory.entry where id = ${e.id}`;
  if (!row) return false;
  if (row.payload_sha256 !== e.digest) throw new Refused(`Entry ${e.id} already exists. Write a new entry that supersedes it.`);
  return true;
}

/** The kind a note is stored as, with its starting strength. A claimed fact is stored as one only when its evidence quote
 * is in the event it cites, and an agent's claim to quote Wen only when the event is one of his prompts. A claim that fails
 * the check becomes an observation, and `verified` says it failed. With no claim, the writer's evidence decides: a quote of
 * Wen is wen, and anything else an observation. */
export async function classify(db: Sql, e: Row, caller: string) {
  const claimed: string = e.kind ?? (caller === "runtime" && e.evidence_kind === "quote" ? "wen" : "observation");
  let kind = claimed, verified: boolean | null = null;
  // The runtime token (the groomer, clyde-flow) may name Wen's words without an event. An agent has to cite one.
  if (claimed === "fact" || (claimed === "wen" && (caller === "agent" || e.evidence_event !== null))) {
    // Redaction markers prove nothing, so a quote that is mostly markers can't verify.
    const bare = squash(e.evidence.replace(/\[redacted:[^\]]*\]/g, ""));
    const verdict = bare.length < MIN_QUOTE ? null : await verifyEvidence(db, e.evidence_event, e.evidence);
    verified = Boolean(verdict?.ok && (claimed !== "wen" || verdict.event.event === "UserPromptSubmit"));
    if (!verified) kind = "observation";
  }
  return { kind, verified, ...START[kind] };
}

/** The projects entry an agent's notes hang off when it names none. Made once, and settled: it isn't a claim. */
async function ensureNotesProject(db: Sql, e: Row) {
  if (!e.notesProject) return;
  const s = e.source, who = e.project.slice("notes-".length);
  const evidence = `memory made this the first time ${who} remembered a note with no project of its own.`;
  await db`insert into memory.source (id, kind, title, uri, date) values (${s.id}, ${s.kind}, ${s.title}, ${s.uri}, current_date)
    on conflict (owner_id, id) do nothing`;
  await db`insert into memory.entry (id, pattern, title, body, authority, scope, sensitivity, lang, valid_from, source_id,
      evidence_kind, evidence, evidence_sha256, project, origin, kind, confidence, chances_left)
    values (${e.project}, 'projects', ${`Notes by ${who}`}, ${`Notes ${who} wrote through remember with no project of their own.`},
      'draft', 'global', 'normal', 'en', ${today()}, ${s.id}, 'summary', ${evidence}, ${await sha256(evidence)}, ${e.project},
      'runtime', 'observation', ${START.observation.confidence}, 0)
    on conflict (owner_id, id) do nothing`;
}

/** Insert every row. False when another write took the id first. A new blob's file in Storage moves from incoming/ to its
 * sha256 only after the entry is in, so a refusal of the note leaves the upload where a retry can find it. */
async function insert(db: Sql, e: Row) {
  const s = e.source;
  await db`insert into memory.source (id, kind, title, uri, date) values (${s.id}, ${s.kind}, ${s.title}, ${s.uri}, current_date)
    on conflict (owner_id, id) do nothing`;
  // Two writers inserting the same new blobs in opposite orders would each wait on the other. One order can't deadlock.
  for (const b of [...e.blobs].sort((a, b) => a.sha256 < b.sha256 ? -1 : 1)) {
    if (b.existing) continue;
    await db`insert into memory.blob (sha256, media_type, size, content, stored)
      values (${b.sha256}, ${b.media_type}, ${b.size}, ${b.stored === "db" ? b.content : null}, ${b.stored}) on conflict (owner_id, sha256) do nothing`;
  }
  const inserted = await db`insert into memory.entry (id, pattern, title, body, authority, scope, sensitivity, lang, valid_from,
      source_id, evidence_kind, evidence, evidence_sha256, project, origin, payload_sha256, kind, confidence, chances_left,
      evidence_event, verified)
    values (${e.id}, ${e.pattern}, ${e.title}, ${e.body}, ${e.authority}, ${e.scope}, ${e.sensitivity}, ${e.lang},
      ${e.valid_from}, ${s.id}, ${e.evidence_kind}, ${e.evidence}, ${await sha256(e.evidence)}, ${e.project ?? e.id},
      'runtime', ${e.digest}, ${e.kind}, ${e.confidence}, ${e.chances}, ${e.evidence_event}, ${e.verified})
    on conflict (owner_id, id) do nothing returning id`;
  if (!inserted.length) return false;
  const all: [string, string][] = [
    ...(e.project ? [["part_of", e.project] as [string, string]] : []),
    ...e.supersedes.map((old: string): [string, string] => ["supersedes", old]),
    ...e.links,
  ];
  for (const [t, to] of all) await db`insert into memory.link (src, dst, type) values (${e.id}, ${to}, ${t})`;
  for (const b of e.blobs) {
    await db`insert into memory.entry_blob (entry_id, name, sha256, kind) values (${e.id}, ${b.name}, ${b.sha256}, ${b.kind})`;
  }
  // R41: where it came from. The folder and repo are the ones the session's hook reported, if it has.
  if (e.prov) {
    await db`insert into memory.entry_provenance (entry_id, device, agent, agent_context, repo, cwd, session, run_scope)
      select ${e.id}::text, ${e.prov.device}::text, ${e.prov.agent}::text, ${e.prov.context}::text, s.repo, s.cwd, ${e.prov.session}::text,
        ${String(e.scope).startsWith("run:") ? e.scope : null}::text
      from (select 1) one left join memory.mcp_session s on s.id = ${e.prov.session}::text
      on conflict (owner_id, entry_id) do nothing`;
  }
  for (const b of e.blobs) if (b.uploaded && !b.existing) await store.claim(b.sha256);
  return true;
}

class Retry extends Error {}

const SHAPE = (b: Row) => ({ name: b.name, sha256: b.sha256, kind: b.kind, size: b.size });

/** The line of the refusal when new blobs would push memory over its cap. */
const overQuota = (need: number, used: number, cap: number) =>
  new Refused(`These blobs need ${need} bytes, and memory holds ${used} of its ${cap}. Free some space or raise blob_quota_bytes.`);

/** Settle each artifact cited by sha256. A file sent with upload_blob is checked against what upload_blob was told (size, then
 * hash, then secrets in its text), and a file that fails is deleted. A sha256 with no file waiting is a blob memory already
 * holds, but only one some non-private entry attaches: a private blob can't be cited by hash, since that would tell anyone who
 * guessed the file that memory has it. */
async function resolveCited(e: Row, principal: string) {
  const cited: Row[] = e.blobs.filter((b: Row) => b.cited);
  if (!cited.length) return;
  const shas = cited.map((b) => b.sha256);
  const waiting = new Map((await sql`select sha256, size, media_type from memory.upload
    where principal = ${principal} and sha256 = any(${shas}::text[])`).map((r) => [r.sha256 as string, r]));
  const held = new Map((await sql`select b.sha256, b.size, b.media_type, b.stored, coalesce(bool_or(n.sensitivity <> 'private'), false) as public
    from memory.blob b left join memory.entry_blob x on x.sha256 = b.sha256 left join memory.entry n on n.id = x.entry_id
    where b.sha256 = any(${shas}::text[]) group by b.owner_id, b.sha256`).map((r) => [r.sha256 as string, r]));
  // The cap on new bytes counts what upload_blob was told, before any file is read.
  const declared = cited.reduce((n, b) => n + (held.has(b.sha256) ? 0 : waiting.get(b.sha256)?.size ?? 0), 0);
  if (declared > store.MAX_ENTRY_STORED_BYTES) {
    throw new Refused(`These blobs add up to ${declared} bytes. The limit for one entry is ${store.MAX_ENTRY_STORED_BYTES}.`);
  }
  const drop = (sha: string) => sql`delete from memory.upload where principal = ${principal} and sha256 = ${sha}`;
  for (const b of cited) {
    const up = waiting.get(b.sha256), row = held.get(b.sha256);
    let checked: store.Checked | null = null;
    if (up && store.storageOn()) {
      try {
        checked = await store.inspectUpload(b.sha256, up as { size: number; media_type: string });
      } catch (err) {
        if (!(err instanceof store.BlobError)) throw err;
        await drop(b.sha256);
        throw new Refused(err.message);
      }
    }
    if (checked) {
      const found = checked.text === null ? [] : redactText(checked.text)[1];
      if (found.length) {
        await store.remove(b.sha256, "incoming");
        await drop(b.sha256);
        throw new Refused(`Blob ${b.name} has secrets or identifiers in it (${[...new Set(found)].join(", ")}), so memory deleted the ` +
          `upload. Take them out and upload it again.`);
      }
      Object.assign(b, { media_type: checked.media_type, size: checked.size, text: checked.text, uploaded: true, existing: Boolean(row), stored: "storage" });
    } else if (row?.public) {
      Object.assign(b, { media_type: row.media_type, size: row.size, existing: true, stored: row.stored });
    } else {
      throw new Refused(`memory has no blob ${b.sha256}. Send the file with upload_blob and PUT it before citing its sha256.`);
    }
    b.kind ??= store.kindOf(b.media_type, b.name ?? "");
  }
}

/** The blobs a landed entry already holds, in the shape remember answers with. */
async function blobsOf(id: string) {
  return (await sql`select x.name, x.sha256, x.kind, b.size from memory.entry_blob x join memory.blob b on b.sha256 = x.sha256
    where x.entry_id = ${id} order by x.name`).map(SHAPE);
}

/** Write one entry as `caller`, agent or runtime. Returns {id, blobs, embedded}. Throws Refused, having written
 * nothing, when the payload breaks an invariant. Sending the same payload again returns its entry. The embedding
 * sync picks the entry up after the response. `principal` is the device that cites an upload_blob file. */
/** What memory knows about a write besides the payload (R41): the agent that made it, that agent's work context, the MCP session,
 * and `profile`, the registered agent's one-line description for the note's source. The device is the principal. None of it
 * comes from the caller's payload. */
export type Origin = { agent: string; context: string | null; session: string | null; profile?: string | null };

export async function remember(payload: unknown, caller: string, agentName = "agent", principal = "anyone", origin: Origin | null = null) {
  const e = await validate(payload, caller, agentName, origin?.profile ?? null);
  e.prov = { device: principal, agent: origin?.agent ?? agentName, context: origin?.context ?? null, session: origin?.session ?? null };
  if (await landed(sql, e)) return { id: e.id, blobs: await blobsOf(e.id), embedded: false };
  // Secrets and identifiers come out first. Then the judge reads what would be stored and can refuse it. A judge that
  // can't answer refuses too: memory fails closed. A private or confidential entry reaches a third-party model by its
  // title alone, so the judge reads only that, and its body rests on redaction.
  for (const f of ["title", "body", "evidence"]) e[f] = redactText(e[f])[0];
  // The quote check reads the redacted evidence, since the event it cites was stored redacted.
  const { chances, ...start } = await classify(sql, e, caller);
  Object.assign(e, start, { chances });
  await resolveCited(e, principal);
  const uploads: Row[] = e.blobs.filter((b: Row) => b.uploaded);
  for (const b of e.blobs) {
    if (b.cited) continue;
    const text = store.isText(b.media_type) ? store.utf8(b.content) : null;
    b.size = b.content.length;
    b.text = text;
    b.stored = store.storageOn() && (text === null || b.size > store.INLINE_MAX) ? "storage" : "db";
  }
  const titleOnly = e.sensitivity === "private" || e.sensitivity === "confidential";
  let why: string | null;
  try {
    why = await screen(titleOnly ? e.title
      : [e.title, e.body, e.evidence, ...e.blobs.map((b: Row) => (b.text ?? "").slice(0, 4000))].join("\n\n"));
  } catch (err) {
    if (err instanceof OverBudget) throw new Refused(`memory won't take new notes this month: ${err.message}.`);
    throw new Refused(`memory couldn't screen this note right now (${(err as Error).message.slice(0, 80)}), so it wrote nothing. Try again later.`);
  }
  if (why) {
    // A refused note takes its uploads with it.
    for (const b of uploads) {
      await store.remove(b.sha256, "incoming");
      await sql`delete from memory.upload where principal = ${principal} and sha256 = ${b.sha256}`;
    }
    throw new Refused(why[0].toUpperCase() + why.slice(1));
  }
  // Which blobs are new, before anything goes to Storage or takes a lock, so an obvious refusal writes nothing.
  const present = async (db: Sql) => new Set((await db`select sha256 from memory.blob where sha256 = any(${e.blobs.map((b: Row) => b.sha256)}::text[])`)
    .map((r) => r.sha256 as string));
  const settle = async (db: Sql) => {
    if (!e.blobs.length) return;
    const have = await present(db);
    for (const b of e.blobs) b.existing = Boolean(b.existing) || have.has(b.sha256);
    const need = e.blobs.filter((b: Row) => !b.existing).reduce((n: number, b: Row) => n + b.size, 0);
    if (need) {
      const { used, cap } = await store.quota(db);
      if (used + need > cap) throw overQuota(need, used, cap);
    }
  };
  await settle(sql);
  // Inline bytes bound for Storage go up first. The note commits only if they did.
  const put: Row[] = e.blobs.filter((b: Row) => !b.cited && !b.existing && b.stored === "storage");
  const sent: Row[] = [];
  try {
    for (const b of put) {
      await store.put(b.sha256, b.media_type, b.content);
      sent.push(b);
    }
    try {
      await sql.begin(async (tx) => {
        if (await landed(tx, e)) return;
        await ensureNotesProject(tx, e);
        await check(tx, e);
        // One cap for the whole memory: the check and the insert take turns.
        if (e.blobs.some((b: Row) => !b.existing)) await tx`select pg_advisory_xact_lock(hashtext('memory-blob-quota'))`;
        await settle(tx);
        if (!(await insert(tx, e))) throw new Retry();
      });
    } catch (err) {
      if (!(err instanceof Retry)) throw err;
      // A send of the same payload committed between the lookup and the insert. Answer with its entry.
      await landed(sql, e);
    }
  } catch (err) {
    // Bytes this write put in Storage that no row holds go again. The uploads it cited stay in incoming/ for a retry.
    for (const b of sent) {
      if (!(await sql`select 1 from memory.blob where sha256 = ${b.sha256}`).length) await store.remove(b.sha256, "final").catch(() => {});
    }
    throw err;
  }
  for (const b of uploads) {
    await sql`delete from memory.upload where principal = ${principal} and sha256 = ${b.sha256}`;
    // A file memory already held: the copy in incoming/ is not needed.
    if (b.existing) await store.remove(b.sha256, "incoming").catch(() => {});
  }
  return { id: e.id, blobs: e.blobs.map(SHAPE), embedded: false };
}
