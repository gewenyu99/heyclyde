// One postgres.js client per isolate, on Supabase's transaction pooler, so no prepared statements. Counts come back as
// numbers and dates as YYYY-MM-DD strings, the way the console and the packets print them.
//
// Tenancy (R49): a request runs inside asTenant, one transaction as role memory_tenant with memory.owner set to its owner,
// so row-level security shows it only that owner's rows. `sql` is that transaction while one runs, and postgres outside
// one, so every module keeps importing `sql` and nothing else switches the role. Wen's console runs as memory_console,
// which RLS holds to Wen's rows too. `root` is always postgres: settings, Vault, entitlements, the backup and cron.
import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "npm:postgres@3.4.7";
import { config } from "./config.ts";

export type Sql = postgres.Sql | postgres.TransactionSql;
export type Row = Record<string, any>;

const client = (max: number) => postgres(config.databaseUrl, {
  prepare: false,
  max,
  idle_timeout: 20,
  connection: { search_path: "memory,extensions,public", application_name: "memory" },
  types: {
    int8: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    numeric: { to: 1700, from: [1700], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
  },
});

/** postgres itself, which bypasses row-level security. Only for what no tenant may touch. Its connections are its own, so a
 * read of a setting or an entitlement inside a request never waits behind the requests' open transactions. */
export const root = client(3);
/** The connections tenant transactions hold, one per request in flight. */
const tenants = client(4);

type Scope = {
  tx: postgres.TransactionSql;
  owner: string;
  /** Work the request leaves running after it answers, each started in a tenant transaction of its own. */
  later: (() => Promise<unknown>)[];
  /** Server-Timing entries the request's work recorded. */
  timings: string[];
};
const scope = new AsyncLocalStorage<Scope>();

/** The request's tenant transaction while one runs, else postgres. A begin inside a tenant transaction is a savepoint. */
export const sql = new Proxy(root, {
  apply(_target, thisArg, args) {
    return Reflect.apply(scope.getStore()?.tx ?? root, thisArg, args);
  },
  get(_target, prop) {
    const s = scope.getStore();
    if (s && prop === "begin") {
      return (...args: unknown[]) => (s.tx.savepoint as (...a: unknown[]) => unknown)(...args.filter((a) => typeof a === "function"));
    }
    const target = (s?.tx ?? root) as unknown as Record<string | symbol, unknown>;
    const value = target[prop];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  },
}) as postgres.Sql;

/** The owner the running request is for, or null outside a tenant transaction. */
export const currentOwner = () => scope.getStore()?.owner ?? null;

/** Runs fn as owner, in one transaction: as memory_tenant, or as memory_console for Wen's console. Work fn hands to later()
 * starts after the transaction commits, in a tenant transaction of its own, so a failure there never undoes the answer. */
export async function asTenant<T>(owner: string, fn: () => Promise<T>, opts: { console?: boolean; timings?: string[] } = {}): Promise<T> {
  const s = { owner, later: [], timings: opts.timings ?? [] } as unknown as Scope;
  const result = await tenants.begin(async (tx) => {
    await tx.unsafe(opts.console ? "set local role memory_console" : "set local role memory_tenant");
    await tx`select set_config('memory.owner', ${owner}, true)`;
    s.tx = tx;
    return await scope.run(s, fn);
  }) as T;
  for (const work of s.later) {
    runLater(asTenant(owner, work, { console: opts.console }).catch((e) => console.error("background:", e)));
  }
  return result;
}

// The Supabase runtime's global for work that outlives the response.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
function runLater(p: Promise<unknown>) {
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime) EdgeRuntime.waitUntil(p);
}

/** Run work after the response. Inside a request it starts once the request's transaction commits, as the same owner.
 * A failure is logged, never thrown at the caller. */
export function later(work: () => Promise<unknown>) {
  const s = scope.getStore();
  if (s) s.later.push(work);
  else runLater(work().catch((e) => console.error("background:", e)));
}

/** A statement that may fail without failing the request: inside a tenant transaction it runs in a savepoint, so its error
 * leaves the rest of the transaction usable. */
export async function attempt<T>(fn: (db: Sql) => Promise<T>): Promise<T> {
  const s = scope.getStore();
  return s ? await s.tx.savepoint((sp) => fn(sp)) as T : await fn(root);
}

/** Records a Server-Timing entry for the running request, like `vector;dur=3.10`. */
export function timing(entry: string) {
  scope.getStore()?.timings.push(entry);
}

// The settings table and Vault, cached per isolate for a minute, so a rotated key or token takes hold within one. A
// missing name is "". Both are read as postgres, since no tenant may read them.
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
  cached(name, async () => (await root`select value from memory.setting where name = ${name}`)[0]?.value ?? "");

export const secret = (name: string) =>
  cached(`vault:${name}`, async () =>
    (await root`select decrypted_secret as value from vault.decrypted_secrets where name = ${name}`)[0]?.value ?? "");

export const forgetSecret = (name: string) => {
  cache.delete(`vault:${name}`);
};

/** Wen's owner id (setting owner_id), whom the runtime token, the console and every pre-tenancy row belong to. */
export const wen = () => setting("owner_id");
