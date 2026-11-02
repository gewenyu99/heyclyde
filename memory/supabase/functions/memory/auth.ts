// Who a request is. Each computer holds its own device token, clyde-flow holds the runtime token, the console holds the
// admin token, the nightly backup holds the backup token and pg_cron holds the cron secret. Only SHA-256 hashes are
// stored, so a database read never yields a token.
import { secret, setting, sql } from "./db.ts";
import { sha256 } from "./embed.ts";
import { resourceMetadataUrl } from "./oauth.ts";

export type Kind = "open" | "agent" | "admin" | "backup" | "cron" | "owner";
export type Principal = {
  role: "anyone" | "device" | "runtime" | "admin" | "backup" | "cron" | "owner";
  device?: string;
  /** For a device: "full" keeps hook payloads, "metadata" keeps only the event, session, folder and tool name. */
  hooks?: string;
};

/** Which credential a path takes. /healthz and the console's files take none. Any path not named takes none of them
 * and gets 401. */
export function credentialFor(path: string): Kind | null {
  if (path === "/healthz" || path === "/install" || path.startsWith("/install/")) return "open";
  if (path.startsWith("/oauth/") || path.startsWith("/.well-known/")) return "open";
  if (path === "/devices/claim") return "owner";
  if (path === "/" || path === "/api/v1" || path.startsWith("/api/v1/")) return "admin";
  if (["/mcp", "/mcp/", "/entries", "/recall"].includes(path)) return "agent";
  if (["/hooks/", "/messages/", "/entries/", "/blobs/"].some((p) => path.startsWith(p))) return "agent";
  if (path === "/export") return "backup";
  if (path === "/embeddings/sync" || path === "/learn") return "cron";
  return null;
}

// memory's own address. A Cloudflare Worker there passes requests through and proves it with a shared secret.
export const DOMAIN = "https://memory.heyclyde.me";
const DIRECT = () => `${Deno.env.get("SUPABASE_URL")}/functions/v1/memory`;

/** True when the request came through the Worker at memory.heyclyde.me. Only its SHA-256 is stored. */
export async function viaProxy(req: Request) {
  const s = req.headers.get("x-memory-proxy") ?? "";
  return Boolean(s) && same(await sha256(s), await setting("proxy_secret_sha256"));
}

/** The address the caller used, for the URLs memory hands back: the resource an MCP client checks, the sign-in links. */
export async function baseOf(req: Request) {
  return (await viaProxy(req)) ? DOMAIN : DIRECT();
}

/** The client's address. Through the Worker, it's the one Cloudflare saw. Otherwise it's the platform's
 * X-Forwarded-For. IPv6 counts by /64, the block one host usually holds, so rotating through it buys no extra guesses. */
export async function clientKey(req: Request) {
  const ip = (await viaProxy(req) ? req.headers.get("x-memory-client") : null)
    || (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  return ip.includes(":") ? ip.split(":").slice(0, 4).join(":") + "::/64" : ip;
}

function same(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const FREE_MISSES = 10, CAP_SECONDS = 900, FORGET_SECONDS = 3600;

/** Seconds this address stays locked out for this credential, or 0. */
async function lockedFor(kind: Kind, client: string): Promise<number> {
  const [row] = await sql`select ceil(extract(epoch from locked_until - now()))::int as wait from memory.auth_miss
    where kind = ${kind} and client = ${client} and locked_until > now()`;
  return row?.wait ?? 0;
}

/** Count a wrong token. The first ten cost nothing. Each miss after that locks the address out twice as long as the
 * last, up to 15 minutes. Misses are forgotten after an hour without one. */
async function miss(kind: Kind, client: string) {
  await sql`insert into memory.auth_miss (kind, client, misses, last_miss) values (${kind}, ${client}, 1, now())
    on conflict (kind, client) do update set
      misses = case when memory.auth_miss.last_miss < now() - make_interval(secs => ${FORGET_SECONDS}) then 1
                    else memory.auth_miss.misses + 1 end,
      last_miss = now()`;
  await sql`update memory.auth_miss set locked_until = case when misses > ${FREE_MISSES}
      then now() + make_interval(secs => least(${CAP_SECONDS}, power(2, misses - ${FREE_MISSES} - 1))) end
    where kind = ${kind} and client = ${client}`;
}

async function resolve(kind: Kind, token: string): Promise<Principal | null> {
  const hash = await sha256(token);
  if (kind === "agent") {
    if (same(hash, await setting("runtime_token_sha256"))) return { role: "runtime" };
    // An OAuth client, like claude.ai, holds a Supabase Auth access token for the owner. No hooks run there.
    if (isJwt(token)) {
      const claims = await ownerOf(token);
      return claims?.client_id ? { role: "device", device: `oauth:${claims.client_id}`, hooks: "metadata" } : null;
    }
    // A computer's token lapses after 90 days unused. Rerunning the installer signs it in again.
    const [d] = await sql`update memory.device set last_seen = now()
      where token_sha256 = ${hash} and revoked_at is null and coalesce(last_seen, created_at) > now() - interval '90 days'
      returning name, hooks`;
    return d ? { role: "device", device: d.name, hooks: d.hooks } : null;
  }
  if (kind === "admin") return same(hash, await setting("admin_token_sha256")) ? { role: "admin" } : null;
  if (kind === "backup") {
    if (same(hash, await setting("backup_token_sha256"))) return { role: "backup" };
    return same(hash, await setting("admin_token_sha256")) ? { role: "admin" } : null;
  }
  if (kind === "cron") return same(token, await secret("cron_secret")) ? { role: "cron" } : null;
  // Only a sign-in of the owner's own mints a device token, never a token an OAuth client was given.
  if (kind === "owner") {
    const claims = await ownerOf(token);
    return claims && !claims.client_id ? { role: "owner" } : null;
  }
  return null;
}

/** Whether an email is on memory's allowlist. Only those emails sign in to connect a computer. */
export async function allowed(email: string) {
  return (await sql`select 1 from memory.allowed_email where email = ${email.trim().toLowerCase()}`).length > 0;
}

const isJwt = (token: string) => /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(token);

function claimsOf(jwt: string): Record<string, unknown> {
  try {
    return JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return {};
  }
}

// Answers for a minute, so an MCP client's burst of calls asks Supabase Auth once.
const owners = new Map<string, { until: number; claims: Record<string, unknown> | null }>();

/** The token's claims when a Supabase Auth access token belongs to an allowlisted email, confirmed, else null.
 * Supabase Auth checks the token, so a forged, expired or revoked one comes back 401. */
async function ownerOf(jwt: string) {
  const key = await sha256(jwt), hit = owners.get(key);
  if (hit && hit.until > Date.now()) return hit.claims;
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    headers: { apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "", Authorization: `Bearer ${jwt}` },
    signal: AbortSignal.timeout(10_000),
  });
  const user = r.ok ? await r.json() : null;
  const ok = Boolean(user?.email && user.email_confirmed_at) && await allowed(user.email);
  const claims = ok ? claimsOf(jwt) : null;
  if (owners.size > 100) owners.clear();
  owners.set(key, { until: Date.now() + 60_000, claims });
  return claims;
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });

/** The principal, or the response that refuses it: 401 for a wrong or missing token, 429 while the address is locked
 * out, 503 while the console has no admin token. */
export async function authenticate(req: Request, path: string): Promise<Principal | Response> {
  const kind = credentialFor(path);
  if (kind === "open") return { role: "anyone" };
  if (kind === null) return json({ error: "unauthorized" }, 401);
  if (kind === "admin" && !(await setting("admin_token_sha256"))) {
    return json({ error: "The console is off. No admin token is set." }, 503);
  }
  const client = await clientKey(req);
  const wait = await lockedFor(kind, client);
  if (wait) {
    return json({ error: `Too many wrong tokens from your address. Try again in ${wait} second${wait === 1 ? "" : "s"}.` },
      429, { "retry-after": String(wait) });
  }
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const who = token ? await resolve(kind, token) : null;
  if (!who) {
    // A JWT can't be guessed, and an expired one is how an OAuth client learns to refresh, so it costs no miss.
    if (token && !isJwt(token)) await miss(kind, client);
    // The header that points an MCP client at how to sign in (RFC 9728).
    const challenge: Record<string, string> = path.startsWith("/mcp")
      ? { "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl(await baseOf(req))}"` } : {};
    return json({ error: "unauthorized" }, 401, challenge);
  }
  return who;
}
