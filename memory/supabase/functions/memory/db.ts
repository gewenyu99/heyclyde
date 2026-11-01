// One postgres.js client per isolate, on Supabase's transaction pooler, so no prepared statements. Counts come back as
// numbers and dates as YYYY-MM-DD strings, the way the console and the packets print them.
import postgres from "npm:postgres@3.4.7";
import { config } from "./config.ts";

export type Sql = postgres.Sql | postgres.TransactionSql;
export type Row = Record<string, any>;

export const sql = postgres(config.databaseUrl, {
  prepare: false,
  max: 3,
  idle_timeout: 20,
  connection: { search_path: "memory,extensions,public", application_name: "memory" },
  types: {
    int8: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    numeric: { to: 1700, from: [1700], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
  },
});

// The settings table and Vault, cached per isolate for a minute, so a rotated key or token takes hold within one. A
// missing name is "".
const cache = new Map<string, { value: string; at: number }>();
const TTL_MS = 60_000;

async function cached(key: string, read: () => Promise<string>) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await read();
  cache.set(key, { value, at: Date.now() });
  return value;
}

export const setting = (name: string) =>
  cached(name, async () => (await sql`select value from memory.setting where name = ${name}`)[0]?.value ?? "");

export const secret = (name: string) =>
  cached(`vault:${name}`, async () =>
    (await sql`select decrypted_secret as value from vault.decrypted_secrets where name = ${name}`)[0]?.value ?? "");
