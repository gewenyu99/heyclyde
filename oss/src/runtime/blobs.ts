// Pluggable blob storage for local filesystem (`fs`) and inline SQL (`sql`) backends.
import { Buffer } from "node:buffer";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "../core/redact.ts";
import { decodeUtf8, isTextMedia, MAX_BLOB_BYTES, SHA_RE, sha256Hex } from "../core/write-rules.ts";

export type CheckedUpload = {
  sha256: string;
  media_type: string;
  size: number;
  text: string | null;
};

export type UploadTokenPayload = {
  sha256: string;
  size: number;
  media_type: string;
  exp: number;
};

export interface BlobStore {
  readonly backend: "fs" | "sql";
  readonly inlineMaxBytes: number;
  readonly maxBlobBytes: number;
  readonly maxQuotaBytes: number;
  storageOn(): boolean;
  put(sha: string, mediaType: string, bytes: Uint8Array, where?: "final" | "incoming"): Promise<void>;
  get(sha: string, where?: "final" | "incoming"): Promise<Uint8Array | null>;
  size(sha: string, where?: "final" | "incoming"): Promise<number | null>;
  claimIncoming(sha: string): Promise<void>;
  remove(sha: string, ...which: ("final" | "incoming")[]): Promise<void>;
  createUploadToken(payload: Omit<UploadTokenPayload, "exp">, ttlSeconds?: number): string;
  verifyUploadToken(token: string): UploadTokenPayload | null;
  inspectIncoming(sha: string, declared: { size: number; media_type: string }): Promise<CheckedUpload | null>;
  sweepIncoming(maxAgeSeconds?: number): Promise<number>;
}

export class BlobValidationError extends Error {}

function assertSha(sha: string): string {
  const s = sha.toLowerCase();
  if (!SHA_RE.test(s)) throw new BlobValidationError(`Invalid sha256: ${sha}`);
  return s;
}

function loadOrCreateSecret(dir: string): Buffer {
  const secretPath = join(dir, ".hmac-secret");
  if (existsSync(secretPath)) {
    const raw = readFileSync(secretPath, "utf8").trim();
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  }
  const secret = randomBytes(32);
  writeFileSync(secretPath, secret.toString("hex") + "\n", { mode: 0o600 });
  return secret;
}

export class LocalFsBlobStore implements BlobStore {
  readonly backend = "fs" as const;
  readonly inlineMaxBytes: number;
  readonly maxBlobBytes: number;
  readonly maxQuotaBytes: number;
  private readonly finalDir: string;
  private readonly incomingDir: string;
  private readonly hmacKey: Buffer;

  constructor(opts: { dir: string; inlineMaxBytes?: number; maxBlobBytes?: number; maxQuotaBytes?: number }) {
    this.finalDir = join(opts.dir, "final");
    this.incomingDir = join(opts.dir, "incoming");
    mkdirSync(this.finalDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.incomingDir, { recursive: true, mode: 0o700 });
    this.inlineMaxBytes = opts.inlineMaxBytes ?? 256 * 1024;
    this.maxBlobBytes = opts.maxBlobBytes ?? 64 * 1024 * 1024;
    this.maxQuotaBytes = opts.maxQuotaBytes ?? 10 * 1024 * 1024 * 1024;
    this.hmacKey = loadOrCreateSecret(opts.dir);
  }

  storageOn(): boolean {
    return true;
  }

  private pathFor(sha: string, where: "final" | "incoming"): string {
    const clean = assertSha(sha);
    return join(where === "final" ? this.finalDir : this.incomingDir, clean);
  }

  async put(sha: string, _mediaType: string, bytes: Uint8Array, where: "final" | "incoming" = "final"): Promise<void> {
    writeFileSync(this.pathFor(sha, where), bytes, { mode: 0o600 });
  }

  async get(sha: string, where: "final" | "incoming" = "final"): Promise<Uint8Array | null> {
    const p = this.pathFor(sha, where);
    if (!existsSync(p)) return null;
    return new Uint8Array(readFileSync(p));
  }

  async size(sha: string, where: "final" | "incoming" = "final"): Promise<number | null> {
    const p = this.pathFor(sha, where);
    if (!existsSync(p)) return null;
    return statSync(p).size;
  }

  async claimIncoming(sha: string): Promise<void> {
    const inc = this.pathFor(sha, "incoming");
    const fin = this.pathFor(sha, "final");
    if (!existsSync(inc)) return;
    if (!existsSync(fin)) {
      writeFileSync(fin, readFileSync(inc), { mode: 0o600 });
    }
    try {
      unlinkSync(inc);
    } catch {
      // ignore
    }
  }

  async remove(sha: string, ...which: ("final" | "incoming")[]): Promise<void> {
    const targets = which.length ? which : (["final", "incoming"] as const);
    for (const w of targets) {
      const p = this.pathFor(sha, w);
      if (existsSync(p)) unlinkSync(p);
    }
  }

  createUploadToken(payload: Omit<UploadTokenPayload, "exp">, ttlSeconds = 7200): string {
    const full: UploadTokenPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
    const body = Buffer.from(JSON.stringify(full)).toString("base64url");
    const sig = createHmac("sha256", this.hmacKey).update(body).digest("base64url");
    return `${body}.${sig}`;
  }

  verifyUploadToken(token: string): UploadTokenPayload | null {
    const dot = token.indexOf(".");
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const want = createHmac("sha256", this.hmacKey).update(body).digest("base64url");
    if (sig.length !== want.length) return null;
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
    try {
      const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as UploadTokenPayload;
      if (typeof data.exp !== "number" || data.exp < Math.floor(Date.now() / 1000)) return null;
      if (!SHA_RE.test(data.sha256)) return null;
      return data;
    } catch {
      return null;
    }
  }

  async inspectIncoming(sha: string, declared: { size: number; media_type: string }): Promise<CheckedUpload | null> {
    const bytes = await this.get(sha, "incoming");
    if (!bytes) return null;
    if (bytes.byteLength > this.maxBlobBytes) {
      await this.remove(sha, "incoming");
      throw new BlobValidationError(`The upload for ${sha} is ${bytes.byteLength} bytes. The limit is ${this.maxBlobBytes}.`);
    }
    if (bytes.byteLength !== declared.size) {
      await this.remove(sha, "incoming");
      throw new BlobValidationError(
        `The upload for ${sha} is ${bytes.byteLength} bytes, but upload_blob was told ${declared.size}. Upload it again.`,
      );
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== sha.toLowerCase()) {
      await this.remove(sha, "incoming");
      throw new BlobValidationError(`The upload for ${sha} has sha256 ${hash}, which doesn't match.`);
    }
    const texty = isTextMedia(declared.media_type);
    const decoded = bytes.byteLength <= 16 * 1024 * 1024 ? decodeUtf8(bytes) : null;
    const text = decoded !== null && (texty || !decoded.includes("\0")) ? decoded : null;
    return { sha256: hash, media_type: declared.media_type, size: bytes.byteLength, text };
  }

  async sweepIncoming(maxAgeSeconds = 7200): Promise<number> {
    if (!existsSync(this.incomingDir)) return 0;
    const cutoff = Date.now() - maxAgeSeconds * 1000;
    let swept = 0;
    for (const file of readdirSync(this.incomingDir)) {
      const full = join(this.incomingDir, file);
      const st = statSync(full);
      if (st.mtimeMs < cutoff) {
        unlinkSync(full);
        swept++;
      }
    }
    return swept;
  }
}

export class InlineSqlBlobStore implements BlobStore {
  readonly backend = "sql" as const;
  readonly inlineMaxBytes: number;
  readonly maxBlobBytes: number;
  readonly maxQuotaBytes: number;

  constructor(opts: { inlineMaxBytes?: number; maxBlobBytes?: number; maxQuotaBytes?: number } = {}) {
    this.inlineMaxBytes = opts.inlineMaxBytes ?? 256 * 1024;
    this.maxBlobBytes = opts.maxBlobBytes ?? MAX_BLOB_BYTES;
    this.maxQuotaBytes = opts.maxQuotaBytes ?? 10 * 1024 * 1024 * 1024;
  }

  storageOn(): boolean {
    return false;
  }

  async put(): Promise<void> {}
  async get(): Promise<Uint8Array | null> {
    return null;
  }
  async size(): Promise<number | null> {
    return null;
  }
  async claimIncoming(): Promise<void> {}
  async remove(): Promise<void> {}
  createUploadToken(): string {
    throw new BlobValidationError("External upload URLs require filesystem blob storage (blobs.backend = 'fs').");
  }
  verifyUploadToken(): UploadTokenPayload | null {
    return null;
  }
  async inspectIncoming(): Promise<CheckedUpload | null> {
    return null;
  }
  async sweepIncoming(): Promise<number> {
    return 0;
  }
}

export async function scanTextBlobForSecrets(text: string): Promise<string[]> {
  return [...new Set(redactText(text)[1])];
}

export { sha256Hex };
