// Dialect-safe SQL builder, table naming, and value normalization helpers.
import type { SqlDialect } from "./types.ts";

export type SqlTarget = {
  readonly dialect: SqlDialect;
  readonly schema?: string;
  readonly tablePrefix?: string;
};

const IDENT_RE = /^[a-z][a-z0-9_]*$/;

export function validIdent(name: string, label: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`Invalid SQL ${label}: ${name}`);
  return name;
}

/** Resolves a logical table name with optional table prefix and schema namespace. */
export function tbl(name: string, target: SqlTarget): string {
  const base = validIdent(name, "table");
  const prefix = target.tablePrefix ? validIdent(target.tablePrefix, "tablePrefix") : "";
  const table = prefix ? `${prefix}${base}` : base;
  if (target.schema) {
    const schema = validIdent(target.schema, "schema");
    return `${schema}.${table}`;
  }
  return table;
}

/** Builds a dialect-appropriate parameter placeholder (`$1` on Postgres, `?` elsewhere). */
export function ph(dialect: SqlDialect, index1: number): string {
  return dialect === "postgres" ? `$${index1}` : "?";
}

/** Incremental SQL query builder that stays portable across `?` and `$N` dialects. */
export class SqlQuery {
  readonly dialect: SqlDialect;
  private parts: string[] = [];
  private values: unknown[] = [];

  constructor(dialect: SqlDialect) {
    this.dialect = dialect;
  }

  raw(fragment: string): this {
    this.parts.push(fragment);
    return this;
  }

  val(value: unknown): this {
    this.values.push(value);
    this.parts.push(ph(this.dialect, this.values.length));
    return this;
  }

  inList(values: readonly unknown[]): this {
    if (!values.length) throw new Error("SqlQuery.inList requires at least one value");
    const placeholders: string[] = [];
    for (const v of values) {
      this.values.push(v);
      placeholders.push(ph(this.dialect, this.values.length));
    }
    this.parts.push(`(${placeholders.join(", ")})`);
    return this;
  }

  build(): { sql: string; params: unknown[] } {
    return { sql: this.parts.join(""), params: this.values };
  }
}

export function queryBuilder(dialect: SqlDialect): SqlQuery {
  return new SqlQuery(dialect);
}

export const toJson = (v: unknown): string => JSON.stringify(v ?? null);

export function fromJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined || v === "") return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

export const toBool = (v: boolean | null | undefined): number | null =>
  v === null || v === undefined ? null : v ? 1 : 0;

export const fromBool = (v: unknown): boolean =>
  v === true || v === 1 || v === "1" || v === "true";

export function toNullableBool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  return fromBool(v);
}

export const nowIso = (): string => new Date().toISOString();
export const todayDate = (): string => new Date().toISOString().slice(0, 10);

export function toFloat32Bytes(vec: ArrayLike<number>): Uint8Array {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return new Uint8Array(f32.buffer.slice(f32.byteOffset, f32.byteOffset + f32.byteLength));
}

export function fromFloat32Bytes(raw: unknown): Float32Array | null {
  if (!raw) return null;
  let bytes: Uint8Array;
  if (raw instanceof Uint8Array) {
    bytes = raw;
  } else if (raw instanceof ArrayBuffer) {
    bytes = new Uint8Array(raw);
  } else if (Array.isArray(raw)) {
    bytes = Uint8Array.from(raw as number[]);
  } else if (typeof raw === "string") {
    if (raw.startsWith("\\x")) {
      const hex = raw.slice(2);
      bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    } else {
      const bin = atob(raw);
      bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    }
  } else {
    return null;
  }
  if (bytes.byteLength % 4 !== 0) return null;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}
