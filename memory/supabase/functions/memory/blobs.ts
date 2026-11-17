// Where artifact bytes live. Small text stays in Postgres, in memory.blob.content, so recall and backups read it directly.
// Everything else (images, video, audio, PDFs, zipped skills, long text) goes to the private Storage bucket memory-blobs
// under its sha256. An agent with a shell sends a big file straight to Storage through upload_blob, and the write that
// cites it moves it into place once its size and hash check out. Without Storage (the CI tier), everything stays in
// Postgres under the old 4 MiB limit. This is the only file that talks to Storage.
import { createHash } from "node:crypto";
import { currentOwner, root, type Row, type Sql, sql, wen } from "./db.ts";
import { sha256 } from "./embed.ts";

const num = (name: string, fallback: number) => {
  const v = Number(Deno.env.get(name));
  return Deno.env.get(name) && Number.isFinite(v) && v > 0 ? v : fallback;
};

export const BUCKET = "memory-blobs";
/** Text up to this size stays in Postgres. */
export const INLINE_MAX = 256 * 1024;
/** The most one Storage object may hold, the bucket's file_size_limit. */
export const MAX_STORED_BYTES = 500 * 1024 * 1024;
/** The most new Storage bytes one entry may cite, checked on the sizes upload_blob was told. */
export const MAX_ENTRY_STORED_BYTES = 1024 * 1024 * 1024;
/** The cap on every blob together, unless the setting blob_quota_bytes says otherwise. */
export const DEFAULT_QUOTA = 10 * 1024 * 1024 * 1024;
/** Text this big is read to scan it for secrets. A bigger text file is refused: zip it. */
export const SCAN_MAX = 16 * 1024 * 1024;
/** An export carries a Storage blob only up to this size. */
export const EXPORT_BLOB_MAX = 4 * 1024 * 1024;
/** How long a download link works. */
export const LINK_SECONDS = 600;
/** An upload that nothing cites is swept after this long. */
export const UPLOAD_TTL_SECONDS = 7200;
/** One device's uploads waiting to be cited. */
export const MAX_WAITING = 10;
/** One export carries at most this many bytes of Storage blobs. */
export const EXPORT_STORED_TOTAL = num("MEMORY_EXPORT_STORED_TOTAL", 2 * 1024 * 1024 * 1024);
/** A Storage request that takes longer fails the write. */
export const STORAGE_TIMEOUT_MS = num("MEMORY_STORAGE_TIMEOUT_MS", 120_000);
export const KIND_LIST = "image, video, audio, document, skill, artifact, data, other";
export const KINDS = new Set(KIND_LIST.split(", "));
export const SHA_RE = /^[0-9a-f]{64}$/;

const KEY = () => Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BASE = () => `${Deno.env.get("SUPABASE_URL")}/storage/v1`;

export function storageOn() {
  return Boolean(Deno.env.get("SUPABASE_URL") && KEY());
}

/** A blob problem the caller can fix. */
export class BlobError extends Error {}

/** A kind from the media type and name, for an artifact that didn't say. */
export function kindOf(mediaType: string, name: string) {
  const top = mediaType.split("/")[0];
  if (top === "image" || top === "video" || top === "audio") return top;
  if (/(^|\/)skill\.md$/i.test(name)) return "skill";
  if (mediaType === "text/html") return "artifact";
  if (mediaType === "application/pdf") return "document";
  if (mediaType === "application/json" || mediaType === "text/csv") return "data";
  if (top === "text") return "document";
  return "other";
}

/** True for a media type that holds text: it can be scanned for secrets and paged by get_blob. */
export function isText(mediaType: string) {
  return mediaType.startsWith("text/") || /\/(json|xml|yaml|x-yaml|csv|javascript|toml|x-sh|markdown)$|\+(json|xml)$/.test(mediaType);
}

export function utf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function call(path: string, init: RequestInit = {}) {
  try {
    return await fetch(`${BASE()}${path}`, {
      ...init, headers: { authorization: `Bearer ${KEY()}`, apikey: KEY(), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Storage didn't answer ${init.method ?? "GET"} ${path.split("?")[0].split("/").slice(0, 3).join("/")}: ${(e as Error).name}.`);
  }
}

/** Where a blob lives in Storage (R49). Wen's objects keep the flat keys they had before tenancy, <sha256> and
 * incoming/<sha256>. Every other owner's live under its id, <owner>/<sha256> and incoming/<owner>/<sha256>, so one owner's
 * delete never touches another's file, and holding a file reveals nothing about who else does. owner is the running
 * request's unless named. */
export async function keyOf(sha: string, where: "final" | "incoming" = "final", owner: string | null = currentOwner()) {
  const prefix = owner && owner !== await wen() ? `${owner}/` : "";
  return where === "final" ? `${prefix}${sha}` : `incoming/${prefix}${sha}`;
}

/** Put a blob's bytes at its key. */
export async function put(sha: string, mediaType: string, bytes: Uint8Array, owner = currentOwner()) {
  const r = await call(`/object/${BUCKET}/${await keyOf(sha, "final", owner)}`, {
    method: "POST", body: bytes as BodyInit, headers: { "content-type": mediaType, "x-upsert": "true" },
  });
  if (!r.ok) throw new Error(`Storage refused blob ${sha}: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

/** The bytes at <sha256>. null when the object isn't there (a restore leaves some out). */
export async function get(sha: string, owner = currentOwner()): Promise<Uint8Array | null> {
  const r = await call(`/object/${BUCKET}/${await keyOf(sha, "final", owner)}`);
  if (r.status === 400 || r.status === 404) {
    await r.body?.cancel();
    return null;
  }
  if (!r.ok) throw new Error(`Storage couldn't read blob ${sha} (${r.status}).`);
  return new Uint8Array(await r.arrayBuffer());
}

/** An object's size from its info, without reading it. null when there is no such object. */
async function size(name: string): Promise<number | null> {
  const r = await call(`/object/info/${BUCKET}/${name}`);
  if (r.status === 400 || r.status === 404) {
    await r.body?.cancel();
    return null;
  }
  if (!r.ok) throw new Error(`Storage couldn't read info for ${name} (${r.status}).`);
  const info = await r.json();
  const n = Number(info.size ?? info.metadata?.size);
  if (!Number.isFinite(n)) throw new Error(`Storage gave no size for ${name}.`);
  return n;
}

/** A link that downloads the blob for the next `seconds`. Throws NotStored when the object isn't in Storage. */
export class NotStored extends Error {}
export async function signDownload(sha: string, seconds = LINK_SECONDS) {
  const r = await call(`/object/sign/${BUCKET}/${await keyOf(sha)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expiresIn: seconds }),
  });
  if (r.status === 400 || r.status === 404) {
    await r.body?.cancel();
    throw new NotStored(sha);
  }
  if (!r.ok) throw new Error(`Storage couldn't sign blob ${sha} (${r.status}).`);
  return `${BASE()}${(await r.json()).signedURL}`;
}

/** A URL that takes one PUT of the file, for two hours, at incoming/<sha256>. */
export async function signUpload(sha: string) {
  const r = await call(`/object/upload/sign/${BUCKET}/${await keyOf(sha, "incoming")}`, { method: "POST", headers: { "x-upsert": "true" } });
  if (!r.ok) throw new Error(`Storage couldn't make an upload URL (${r.status}).`);
  const url: string = (await r.json()).url;
  return url.startsWith("http") ? url : `${BASE()}${url}`;
}

/** Delete the objects at <sha256> and incoming/<sha256>. */
export async function remove(sha: string, ...which: ("final" | "incoming")[]) {
  const prefixes = await Promise.all((which.length ? which : ["final", "incoming"] as const).map((w) => keyOf(sha, w)));
  await call(`/object/${BUCKET}`, {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ prefixes }),
  });
}

export type Checked = { sha256: string; media_type: string; size: number; text: string | null };

/** What an upload at incoming/<sha256> is, once its size and hash check out against what upload_blob was told. null when
 * nothing was uploaded there. A file-level problem (too big, the wrong size, the wrong hash, a secret in its text, text too
 * long to scan) deletes the upload and throws BlobError. The size comes from the object's info, so a wrong size is refused
 * before a byte is read. */
export async function inspectUpload(sha: string, declared: { size: number; media_type: string }): Promise<Checked | null> {
  const incoming = await keyOf(sha, "incoming");
  const found = await size(incoming);
  if (found === null) return null;
  const refuse = async (message: string): Promise<never> => {
    await remove(sha, "incoming");
    throw new BlobError(message);
  };
  if (found > MAX_STORED_BYTES) await refuse(`The upload for ${sha} is ${found} bytes. The limit is ${MAX_STORED_BYTES}.`);
  if (found !== declared.size) {
    await refuse(`The upload for ${sha} is ${found} bytes, but upload_blob was told ${declared.size}. Upload it again.`);
  }
  const texty = isText(declared.media_type);
  if (texty && found > SCAN_MAX) {
    await refuse(`The upload for ${sha} is ${found} bytes of text, which is too much text to scan for secrets. Zip it first.`);
  }
  const r = await call(`/object/${BUCKET}/${incoming}`);
  if (r.status === 400 || r.status === 404) {
    await r.body?.cancel();
    return null;
  }
  if (!r.ok) throw new Error(`Storage couldn't read the upload for ${sha} (${r.status}).`);
  let hash: string, text: string | null = null;
  if (texty) {
    const bytes = new Uint8Array(await r.arrayBuffer());
    hash = await sha256(bytes);
    if (hash === sha) text = utf8(bytes);
  } else {
    // Streamed through node:crypto, so a 500 MB file is never held whole.
    const h = createHash("sha256");
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) h.update(chunk);
    hash = h.digest("hex");
  }
  if (hash !== sha) await refuse(`The file uploaded for ${sha} has a different sha256, so memory deleted it. Upload the file again.`);
  return { sha256: sha, media_type: declared.media_type, size: found, text };
}

/** Move a checked upload to <sha256>. Another write may have moved the same file first, which is fine. */
export async function claim(sha: string) {
  const r = await call(`/object/move`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ bucketId: BUCKET, sourceKey: await keyOf(sha, "incoming"), destinationKey: await keyOf(sha) }),
  });
  if (!r.ok) {
    const body = await r.text();
    if (r.status !== 400 && r.status !== 404 && r.status !== 409) throw new Error(`Storage couldn't move the upload for ${sha} (${r.status}).`);
    if (r.status !== 409 && !(await size(await keyOf(sha)))) throw new Error(`Storage lost the upload for ${sha}: ${body.slice(0, 100)}`);
  }
}

/** Delete every upload under incoming/ older than UPLOAD_TTL_SECONDS, Wen's and every owner's folder under it. Returns how
 * many. */
export async function sweepIncoming(prefix = "incoming"): Promise<number> {
  let deleted = 0;
  for (let offset = 0;; offset += 100) {
    const r = await call(`/object/list/${BUCKET}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefix, limit: 100, offset }),
    });
    if (!r.ok) throw new Error(`Storage couldn't list ${prefix}/ (${r.status}).`);
    const items: Row[] = await r.json();
    // A folder (an owner's) has no id. Its uploads are swept on their own.
    if (prefix === "incoming") {
      for (const f of items.filter((o) => o.name && !o.id && !SHA_RE.test(o.name))) deleted += await sweepIncoming(`incoming/${f.name}`);
    }
    const old = items.filter((o) => o.name && Date.now() - Date.parse(o.created_at) > UPLOAD_TTL_SECONDS * 1000).map((o) => `${prefix}/${o.name}`);
    if (old.length) {
      await call(`/object/${BUCKET}`, {
        method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ prefixes: old }),
      });
      deleted += old.length;
    }
    if (items.length < 100) return deleted;
  }
}

/** The cap on every blob together. A setting that isn't a whole number of 0 or more is the default. Read fresh, since the
 * cap must follow the setting the moment it changes. */
export async function quotaCap(_db: Sql = sql): Promise<number> {
  // Settings are postgres's to read (R49), whatever connection the caller holds.
  const [row] = await root`select value from memory.setting where name = 'blob_quota_bytes'`;
  const v = String(row?.value ?? "").trim();
  return /^\d+$/.test(v) ? Number(v) : DEFAULT_QUOTA;
}

export async function quota(db: Sql = sql) {
  const [row] = await db`select coalesce(sum(size), 0)::bigint as used from memory.blob`;
  return { used: Number(row.used), cap: await quotaCap(db) };
}
