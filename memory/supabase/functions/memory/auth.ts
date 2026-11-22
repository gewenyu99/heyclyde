// Who a request is. Each computer holds its own device token, clyde-flow holds the runtime token, the console holds the
// admin token, the weekly researcher holds the research token, the nightly backup holds the backup token and pg_cron holds the
// cron secret. Only SHA-256 hashes are
// stored, so a database read never yields a token.
import { blockedOrigin, entitled, type Geo, geoOf, refusal, refusal451, type Verdict } from "./billing/entitlement.ts";
import { isWebhook } from "./billing/index.ts";
import { root as sql, secret, setting } from "./db.ts";
import { sha256 } from "./embed.ts";
import { resourceMetadataUrl } from "./oauth.ts";
import { reportable } from "./version.ts";

export type Kind = "open" | "agent" | "admin" | "backup" | "cron" | "owner" | "webhook";
export type Principal = {
  role: "anyone" | "device" | "runtime" | "admin" | "research" | "backup" | "cron" | "owner";
  device?: string;
  /** For a device: "full" keeps hook payloads, "metadata" keeps only the event, session, folder and tool name. */
  hooks?: string;
  /** For a device: the memory-hook version it last reported (R31), or null for a hook that predates versions. */
  clientVersion?: string | null;
  /** For a device: whether its hook said, on its last call, that its last self-update failed. */
  updateFailed?: boolean;
  /** For a device: whether a hook has ever called. A computer that only uses MCP never has. */
  hookSeen?: boolean;
  /** The Supabase Auth user id behind the credential: an OAuth client's or a sign-in's user, or the user who claimed a device.
   * Wen's runtime, admin, backup and cron credentials, and devices claimed before R38, have none. Tenancy (R25) scopes
   * data by it; billing keys entitlement by it. */
  owner?: string;
  /** For an owner: the plan and access the entitlement check found (R38). */
  entitlement?: Verdict;
  /** For an MCP client whose plan isn't open: the 402 or 451 its tools/call gets. initialize and tools/list still work, so
   * the client connects and can show the checkout link. */
  denied?: Response;
  /** The Server-Timing entry of the entitlement check. */
  timing?: string;
};

/** Which credential a path takes. /healthz and the console's files take none. Any path not named takes none of them
 * and gets 401. */
export function credentialFor(path: string): Kind | null {
  if (path === "/billing/usage/report" || path === "/billing/guard" || path === "/billing/lapse") return "cron";
  if (isWebhook(path)) return "webhook";
  if (path === "/billing/checkout" || path === "/billing/thanks") return "open";
  if (path === "/healthz" || path === "/install" || path.startsWith("/install/") || path === "/invite/signup") return "open";
  if (path.startsWith("/oauth/") || path.startsWith("/.well-known/")) return "open";
  if (path === "/devices/claim" || path === "/me" || path.startsWith("/me/")) return "owner";
  if (path === "/" || path === "/api/v1" || path.startsWith("/api/v1/")) return "admin";
  if (["/mcp", "/mcp/", "/entries", "/recall"].includes(path)) return "agent";
  if (path === "/blobs/sweep") return "cron";
  if (["/hooks/", "/messages/", "/entries/", "/blobs/"].some((p) => path.startsWith(p))) return "agent";
  if (path === "/export") return "backup";
  if (path === "/embeddings/sync" || path === "/learn") return "cron";
  return null;
}

// memory's own address. A Cloudflare Worker there passes requests through and proves it with a shared secret.
export const DOMAIN = "https://memory.heyclyde.me";
export const SITE = "https://heyclyde.me";
const DIRECT = () => `${Deno.env.get("SUPABASE_URL")}/functions/v1/memory`;

/** True when the request came through the Worker at memory.heyclyde.me. Only its SHA-256 is stored. */
export async function viaProxy(req: Request) {
  const s = req.headers.get("x-memory-proxy") ?? "";
  return Boolean(s) && same(await sha256(s), await setting("proxy_secret_sha256"));
}

/** The address the caller used, for the URLs memory hands back: the resource an MCP client checks, the sign-in links. */
export async function baseOf(req: Request) {
  if (!(await viaProxy(req))) return DIRECT();
  // R53: heyclyde.me serves /mcp and its discovery file too, and the Worker says when it was the host. A caller's own
  // x-memory-host never reaches here: the Worker drops it.
  return req.headers.get("x-memory-host") === "heyclyde.me" ? SITE : DOMAIN;
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

/** What a request tells the server about the computer's hook (R31). */
type Seen = { version: string | null; failed: boolean; hook: boolean };

/** Stamps a computer as seen, with what its hook reported, and returns its row. The migration that adds the R31 columns
 * (client_version, client_update_failed, hook_seen) may not have run yet; then Postgres says 42703, and the plain update
 * of before it stands in, so auth never depends on a new column. */
async function touchDevice(hash: string, seen: Seen) {
  try {
    const [d] = await sql`update memory.device set last_seen = now(),
        client_version = coalesce(${seen.version}, client_version),
        client_update_failed = case when ${seen.version}::text is null then client_update_failed else ${seen.failed} end,
        hook_seen = hook_seen or ${seen.hook}
      where token_sha256 = ${hash} and revoked_at is null and coalesce(last_seen, created_at) > now() - interval '90 days'
      returning name, hooks, client_version, client_update_failed, hook_seen, owner_id`;
    return d;
  } catch (e) {
    if ((e as { code?: string }).code !== "42703") throw e;
    const [d] = await sql`update memory.device set last_seen = now()
      where token_sha256 = ${hash} and revoked_at is null and coalesce(last_seen, created_at) > now() - interval '90 days'
      returning name, hooks`;
    return d;
  }
}

async function resolve(kind: Kind, token: string, seen: Seen, req?: Request): Promise<Principal | null> {
  const hash = await sha256(token);
  if (kind === "agent") {
    if (same(hash, await setting("runtime_token_sha256"))) return { role: "runtime" };
    // An OAuth client, like claude.ai, holds a Supabase Auth access token for the owner. No hooks run there.
    if (isJwt(token)) {
      const claims = await ownerOf(token, req);
      if (!claims?.client_id) return null;
      const cid = String(claims.client_id);
      const uid = UUID.test(String(claims.sub ?? "")) ? String(claims.sub).toLowerCase() : null;
      if (uid) {
        const [acc] = await sql`select to_jsonb(a)->'oauth_apps' as apps from memory.account a where a.owner_id = ${uid}::uuid`;
        const apps = acc?.apps as Record<string, { revoked_at?: string | null }> | null | undefined;
        if (apps?.[cid]?.revoked_at) return null;
        if (apps !== null && apps !== undefined && !apps[cid]) {
          const cname = typeof claims.client_name === "string" && claims.client_name.trim() ? claims.client_name.trim() : cid;
          const entry = { id: cid, name: cname, granted_at: new Date().toISOString(), revoked_at: null };
          await sql`update memory.account set oauth_apps = coalesce(oauth_apps, '{}'::jsonb) || ${sql.json({ [cid]: entry })}
            where owner_id = ${uid}::uuid`.catch(() => {});
        }
      }
      return { role: "device", device: `oauth:${cid}`, hooks: "metadata", ...(uid ? { owner: uid } : {}) };
    }
    // A computer's token lapses after 90 days unused. Rerunning the installer signs it in again.
    // What a hook reports rides on the same write, so every computer's version is on its row.
    const d = await touchDevice(hash, seen);
    return d
      ? { role: "device", device: d.name, hooks: d.hooks, clientVersion: d.client_version, updateFailed: d.client_update_failed, hookSeen: d.hook_seen,
        ...(d.owner_id ? { owner: d.owner_id } : {}) }
      : null;
  }
  if (kind === "admin") {
    if (same(hash, await setting("admin_token_sha256"))) return { role: "admin" };
    // The weekly researcher's token opens /api/v1 too, and admin.ts lets it through only its own routes (RESEARCH).
    return same(hash, await setting("research_token_sha256")) ? { role: "research" } : null;
  }
  if (kind === "backup") {
    if (same(hash, await setting("backup_token_sha256"))) return { role: "backup" };
    return same(hash, await setting("admin_token_sha256")) ? { role: "admin" } : null;
  }
  if (kind === "cron") return same(token, await secret("cron_secret")) ? { role: "cron" } : null;
  // Only a verified sign-in of the owner's own mints a device token or reads /me, never an unconfirmed or OAuth token.
  if (kind === "owner") {
    const claims = await ownerOf(token, req);
    return claims && !claims.client_id && claims._confirmed ? { role: "owner", ...(claims.sub ? { owner: String(claims.sub) } : {}) } : null;
  }
  return null;
}

/** Records a signed-in user's account, the owner billing keys on. A new confirmed account outside blocked regions takes
 * one of the free plan's seats while any are left and free is open. True when the account holds a free seat. */
export async function ensureAccount(id: string, email: string, confirmed: boolean, blocked: Geo = null): Promise<boolean> {
  const [prev] = await sql`select email_confirmed from memory.account where owner_id = ${id}`;
  const [row] = await sql`insert into memory.account as a (owner_id, email, email_confirmed, free_slot, country, region)
    values (${id}, ${email.toLowerCase()}, ${confirmed}, false, ${blocked?.country ?? null}, ${blocked?.region ?? null})
    on conflict (owner_id) do update set
      email = excluded.email,
      email_confirmed = excluded.email_confirmed,
      country = coalesce(a.country, excluded.country),
      region = coalesce(a.region, excluded.region)
    returning (xmax = 0) as created, free_slot`;
  if (!confirmed || blocked) return false;
  if (row?.free_slot) return true;
  if (!row?.created && prev?.email_confirmed) return false;
  const [{ seat }] = await sql`select memory.claim_free_seat(${id}::uuid) as seat`;
  return Boolean(seat);
}

/** The entitlement check (R38), the one place it runs: for each request's owner in authenticate, and for cron working an
 * owner's rows (R50: the embedding sync stays within the owner's token cap). */
export async function entitlementOf(owner: string): Promise<Verdict> {
  return await entitled(owner);
}

/** Whether an email is on memory's allowlist. Only those emails sign in to connect a computer. */
export async function allowed(email: string) {
  return (await sql`select 1 from memory.allowed_email where email = ${email.trim().toLowerCase()}`).length > 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Clears the in-process token claims cache (used after app revocation or account deletion). */
export function forgetOwners() {
  owners.clear();
}

/** Whether anyone may sign in (R38), not just allowlisted emails. Off until tenancy (R25) gives each owner their own
 * memory: with it off, sign-in is exactly as before, so billing stays dormant. */
export const openSignup = async () => (await setting("open_signup")) === "on";

/** The token's claims, else null. Supabase Auth checks the token, so a forged, expired or revoked one comes back 401. With
 * sign-in closed, only a confirmed, allowlisted email gets claims. With it open, any user does, and the entitlement check
 * decides what they may do. The user's id and email are kept in memory.account, the owner billing keys on. */
async function ownerOf(jwt: string, req?: Request) {
  const key = await sha256(jwt), hit = owners.get(key);
  if (hit && hit.until > Date.now()) return hit.claims;
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    headers: { apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "", Authorization: `Bearer ${jwt}` },
    signal: AbortSignal.timeout(10_000),
  });
  const user = r.ok ? await r.json() : null;
  const confirmed = Boolean(user?.email && user.email_confirmed_at);
  const ok = Boolean(user?.email) && (await openSignup() || (confirmed && await allowed(user.email)));
  // Supabase Auth's user ids are uuids. Anything else has no owner, and can't get in with sign-in open.
  const id = UUID.test(String(user?.id ?? "")) ? String(user.id).toLowerCase() : null;
  const claims: Record<string, unknown> | null = ok && (id || !(await openSignup())) ? { ...claimsOf(jwt), sub: id, _confirmed: confirmed } : null;
  const blocked = req ? blockedOrigin(req, await viaProxy(req)) : null;
  if (claims && id) await ensureAccount(id, String(user.email), confirmed, blocked);
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
  // A webhook proves itself with its provider's signature, which billing/webhooks.ts checks.
  if (kind === "open" || kind === "webhook") return { role: "anyone" };
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
  const reported = req.headers.get("x-memory-client-version");
  const seen: Seen = {
    version: reportable(reported) ? reported : null,
    // Only the literal 1 counts.
    failed: req.headers.get("x-memory-update-failed") === "1",
    // The routes a hook calls: its events and its inbox.
    hook: /^\/(hooks|messages)\//.test(path),
  };
  const who = token ? await resolve(kind, token, seen, req) : null;
  if (!who) {
    // A JWT can't be guessed, and an expired one is how an OAuth client learns to refresh, so it costs no miss.
    if (token && !isJwt(token)) await miss(kind, client);
    // The header that points an MCP client at how to sign in (RFC 9728).
    const challenge: Record<string, string> = path.startsWith("/mcp")
      ? { "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl(await baseOf(req))}"` } : {};
    return json({ error: "unauthorized" }, 401, challenge);
  }
  // R38: the one entitlement check, for every agent and owner request whose principal has an owner. It runs before the
  // burst limiter and the usage counters, so a refused call writes nothing. A lookup that fails refuses: 503.
  if (who.owner) {
    let v: Verdict;
    try {
      v = await entitlementOf(who.owner);
    } catch (e) {
      console.error(e);
      return json({ error: "memory couldn't check your plan just now. Try again in a minute." }, 503);
    }
    who.entitlement = v;
    who.timing = `entitlement;dur=${v.ms.toFixed(2)};desc="${v.source}"`;
    const blocked = blockedOrigin(req, await viaProxy(req));
    if (!v.plan.open || (blocked && !v.allowlisted)) {
      const refused = blocked ? refusal451() : await refusal(v, geoOf(req, await viaProxy(req)));
      const meAllowed = refused.status !== 451 && (path === "/me" || path.startsWith("/me/")) &&
        ["GET", "HEAD", "DELETE"].includes(req.method);
      if (!meAllowed) {
        refused.headers.set("server-timing", who.timing);
        if (!path.startsWith("/mcp")) return refused;
        who.denied = refused;
      }
    }
  }
  return who;
}
