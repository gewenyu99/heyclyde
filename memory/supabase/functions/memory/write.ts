// remember(): the runtime write path. One entry with its source, links and blobs, held to the invariants seed/build.py
// enforces on the vault, written in one transaction. The constants copy build.py's, plus run:<id> scopes.
import { type Row, type Sql, sql } from "./db.ts";
import { sha256 } from "./embed.ts";
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
  "source", "evidence_kind", "evidence", "project", "links", "supersedes", "blobs"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
const SURROGATE = /[\ud800-\udfff]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

// One entry can't flood a recall packet. Long material goes in blobs.
const MAX_CHARS: Record<string, number> = { title: 300, body: 4000, evidence: 20000 };
export const MAX_BLOBS = 16, MAX_BLOB_BYTES = 4 * 1024 * 1024, MAX_BLOBS_BYTES = 8 * 1024 * 1024;

// The most each caller may write. Every agent session holds a device token, so an agent writes drafts in a run scope, under
// AGENT_SOURCE, with an id memory generates. Only clyde-flow holds the runtime token.
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
    else if (value.includes("\0") && !/^blobs\[\d+\]\.text$/.test(path)) yield `${path} has a NUL character, which memory can't store.`;
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
export async function validate(payload: unknown, caller: string): Promise<Row> {
  if (!(caller in CALLERS)) throw new Error(`caller ${caller} must be agent or runtime`);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Refused("An entry is a JSON object.");
  const raw = payload as Row;
  const errs = Object.keys(raw).filter((k) => !FIELDS.has(k)).sort().map((k) => `Unknown field ${k}.`);
  const bad = [...unstorable(raw)];
  if (bad.length) throw new Refused([...errs, ...bad].join("\n"));
  const maxAuthority = CALLERS[caller], agent = caller === "agent";
  const p: Row = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null && v !== undefined));
  const e: Row = {
    pattern: p.pattern, title: text(p.title), body: text(p.body), authority: p.authority, scope: p.scope,
    sensitivity: p.sensitivity ?? "normal", lang: text(p.lang ?? "en"), evidence_kind: p.evidence_kind,
    evidence: text(p.evidence), project: p.project || null,
  };

  if (!oneOf(e.pattern, PATTERNS)) errs.push(`pattern must be one of ${[...PATTERNS].sort().join(", ")}.`);
  if (!e.title) errs.push("title is required.");
  if (!e.body) errs.push("body is required. It's the summary recall ranks on.");
  for (const [field, cap] of Object.entries(MAX_CHARS)) {
    if (e[field] && e[field].length > cap) {
      errs.push(`${field} is ${e[field].length} characters. The limit is ${cap}, so put long material in a blob.`);
    }
  }
  if (!oneOf(e.authority, AUTHORITY)) errs.push("authority must be draft, observed or approved.");
  else if (RANK[e.authority] > RANK[maxAuthority]) {
    errs.push(`authority ${e.authority} is above ${maxAuthority}, the most this caller may write.`);
  }
  if (!(typeof e.scope === "string" && SCOPE_RE.test(e.scope))) {
    errs.push(`scope ${JSON.stringify(e.scope ?? null)} must be global, domain:<x>, repo:<x> or run:<id>.`);
  } else if (agent && !e.scope.startsWith("run:")) {
    errs.push(`An agent writes only in a run scope, run:<id>, not ${e.scope}. Wen or clyde-flow promotes notes wider.`);
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
    errs.push("project is required unless pattern is projects. It's the id of the projects entry this belongs to." +
      (String(e.scope).startsWith("run:") ? ` For a run, create its projects entry in scope ${e.scope} first.` : ""));
  }

  const explicitId = (p.id ?? "") !== "";
  if (agent && "source" in p) errs.push("An agent can't name a source. memory records the write as an agent session.");
  if (agent && explicitId) errs.push("An agent can't choose an id. memory generates one from the payload.");
  e.source = await source(agent ? AGENT_SOURCE : p.source, errs);
  e.links = links(p.links ?? [], errs);
  e.supersedes = ids(p.supersedes ?? [], "supersedes", errs);
  e.blobs = await blobs(p.blobs ?? [], errs);

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

/** Each blob carries `text`, or `base64` for binary content. Returns the decoded bytes and their sha256. */
async function blobs(value: unknown, errs: string[]): Promise<Row[]> {
  if (!(Array.isArray(value) && value.every((b) => b && typeof b === "object" && !Array.isArray(b)))) {
    errs.push("blobs must be a list of {name, media_type, text}.");
    return [];
  }
  if (value.length > MAX_BLOBS) {
    errs.push(`An entry has ${value.length} blobs. The limit is ${MAX_BLOBS}.`);
    return [];
  }
  const out: Row[] = [], names = new Set<string>();
  for (const b of value as Row[]) {
    const name = text(b.name);
    if (!name) errs.push("Every blob needs a name.");
    else if (names.has(name)) errs.push(`Two blobs are named ${name}.`);
    if (name) names.add(name);
    const label = name || "without a name";
    if (("text" in b) === ("base64" in b)) {
      errs.push(`Blob ${label} needs text or base64, not both or neither.`);
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
    // The first writer's media type is the one GET /blobs sends, so it has to be a valid header value.
    let mediaType = b.media_type ?? defaultType;
    if (!(typeof mediaType === "string" && MEDIA_TYPE_RE.test(mediaType.toLowerCase()))) {
      errs.push(`Blob ${label} needs a media_type like text/markdown, not ${JSON.stringify(mediaType)}.`);
    } else mediaType = mediaType.toLowerCase();
    out.push({ name, media_type: mediaType, content: data, sha256: await sha256(data) });
  }
  const total = out.reduce((n, b) => n + b.content.length, 0);
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

/** Insert every row. False when another write took the id first. */
async function insert(db: Sql, e: Row) {
  const s = e.source;
  await db`insert into memory.source (id, kind, title, uri, date) values (${s.id}, ${s.kind}, ${s.title}, ${s.uri}, current_date)
    on conflict (id) do nothing`;
  // Two writers inserting the same new blobs in opposite orders would each wait on the other. One order can't deadlock.
  for (const b of [...e.blobs].sort((a, b) => a.sha256 < b.sha256 ? -1 : 1)) {
    await db`insert into memory.blob (sha256, media_type, size, content)
      values (${b.sha256}, ${b.media_type}, ${b.content.length}, ${b.content}) on conflict (sha256) do nothing`;
  }
  const inserted = await db`insert into memory.entry (id, pattern, title, body, authority, scope, sensitivity, lang, valid_from,
      source_id, evidence_kind, evidence, evidence_sha256, project, origin, payload_sha256)
    values (${e.id}, ${e.pattern}, ${e.title}, ${e.body}, ${e.authority}, ${e.scope}, ${e.sensitivity}, ${e.lang},
      ${e.valid_from}, ${s.id}, ${e.evidence_kind}, ${e.evidence}, ${await sha256(e.evidence)}, ${e.project ?? e.id},
      'runtime', ${e.digest})
    on conflict (id) do nothing returning id`;
  if (!inserted.length) return false;
  const all: [string, string][] = [
    ...(e.project ? [["part_of", e.project] as [string, string]] : []),
    ...e.supersedes.map((old: string): [string, string] => ["supersedes", old]),
    ...e.links,
  ];
  for (const [t, to] of all) await db`insert into memory.link (src, dst, type) values (${e.id}, ${to}, ${t})`;
  for (const b of e.blobs) {
    await db`insert into memory.entry_blob (entry_id, name, sha256) values (${e.id}, ${b.name}, ${b.sha256})`;
  }
  return true;
}

class Retry extends Error {}

/** Write one entry as `caller`, agent or runtime. Returns {id, blobs, embedded}. Throws Refused, having written
 * nothing, when the payload breaks an invariant. Sending the same payload again returns its entry. The embedding
 * sync picks the entry up after the response. */
export async function remember(payload: unknown, caller: string) {
  const e = await validate(payload, caller);
  // Secrets and identifiers come out first. Then the judge reads what would be stored and can refuse it. A judge that
  // can't answer refuses too: memory fails closed.
  for (const f of ["title", "body", "evidence"]) e[f] = redactText(e[f])[0];
  let why: string | null;
  try {
    why = await screen([e.title, e.body, e.evidence, ...e.blobs.map((b: Row) => new TextDecoder().decode(b.content).slice(0, 4000))].join("\n\n"));
  } catch (err) {
    throw new Refused(`memory couldn't screen this note right now (${(err as Error).message.slice(0, 80)}), so it wrote nothing. Try again later.`);
  }
  if (why) throw new Refused(why[0].toUpperCase() + why.slice(1));
  try {
    await sql.begin(async (tx) => {
      if (await landed(tx, e)) return;
      await check(tx, e);
      if (!(await insert(tx, e))) throw new Retry();
    });
  } catch (err) {
    if (!(err instanceof Retry)) throw err;
    // A send of the same payload committed between the lookup and the insert. Answer with its entry.
    await landed(sql, e);
  }
  return { id: e.id, blobs: e.blobs.map((b: Row) => ({ name: b.name, sha256: b.sha256 })), embedded: false };
}
