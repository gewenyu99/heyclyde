// Signing an MCP client like claude.ai in to memory. Supabase Auth's OAuth 2.1 server runs the protocol: discovery,
// client registration, the authorize and token endpoints. It hands the owner to a consent page at
// site_url + /oauth/consent, which would normally be HTML. Supabase serves no HTML from its own domain, so the function
// stands in with plain text: it emails the allowlisted owner a sign-in link, and the waiting window reloads itself
// until that link is clicked, on this device or any other. The click signs the owner in on the server, approves the
// request, and the window moves on to the client with its code.
import { allowed } from "./auth.ts";
import { sql } from "./db.ts";

const AUTH = () => `${Deno.env.get("SUPABASE_URL")}/auth/v1`;
const ID = /^[A-Za-z0-9_-]{8,100}$/;
const FRESH = "15 minutes";
// Where an approved code may go: Claude's own callbacks, and a program on this computer (Claude Code and other local
// clients). Anything else is refused, so a client someone registered for themselves can't collect a code.
const CLIENT_HOSTS = new Set(["claude.ai", "claude.com"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
// At most this many sign-in emails in 15 minutes, so the open consent page can't flood the owner's inbox.
const MAX_EMAILS = 3;

const text = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });

/** The resource metadata (RFC 9728) an MCP client reads from the 401's WWW-Authenticate. It names Supabase Auth as the
 * authorization server; the client finds the rest at /.well-known/oauth-authorization-server/auth/v1. */
export function resourceMetadata(base: string) {
  return Response.json({
    resource: `${base}/mcp`,
    authorization_servers: [AUTH()],
    bearer_methods_supported: ["header"],
    resource_name: "memory",
  });
}

export const resourceMetadataUrl = (base: string) => `${base}/.well-known/oauth-protected-resource`;

function b64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function auth(path: string, init: RequestInit & { jwt?: string } = {}) {
  const headers: Record<string, string> = { apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "", "content-type": "application/json" };
  if (init.jwt) headers.authorization = `Bearer ${init.jwt}`;
  const r = await fetch(`${AUTH()}${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
}

function waiting(base: string, id: string, line: string) {
  return text(`memory: ${line}\n\nThis page checks every few seconds and moves on by itself once you click the link.`, 200,
    { refresh: `3; url=${base}/oauth/wait?authorization_id=${encodeURIComponent(id)}`, "cache-control": "no-store" });
}

function masked(email: string) {
  const [name, host] = email.split("@");
  return `${name.slice(0, 1)}${"•".repeat(Math.max(1, name.length - 1))}@${host}`;
}

/** Where Supabase sends the owner: email the sign-in link once per request, then wait. */
async function consent(base: string, id: string) {
  const [row] = await sql`select created_at > now() - ${FRESH}::interval as fresh from memory.oauth_consent
    where authorization_id = ${id}`;
  if (row?.fresh) return waiting(base, id, "the sign-in link is in your email.");
  const emails = await sql`select email from memory.allowed_email order by email limit 2`;
  if (emails.length !== 1) return text("memory: connecting a client needs exactly one allowed email.", 500);
  const [{ n }] = await sql`select count(*)::int as n from memory.oauth_consent where created_at > now() - ${FRESH}::interval`;
  if (n >= MAX_EMAILS) return text("memory: too many sign-ins in the last 15 minutes. Try again later.", 429);

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  await sql`insert into memory.oauth_consent (authorization_id, code_verifier) values (${id}, ${verifier})
    on conflict (authorization_id) do update set code_verifier = excluded.code_verifier, redirect_url = null, created_at = now()`;
  const redirect = encodeURIComponent(`${base}/oauth/approve?authorization_id=${encodeURIComponent(id)}`);
  const sent = await auth(`/otp?redirect_to=${redirect}`, {
    method: "POST",
    body: JSON.stringify({ email: emails[0].email, create_user: false, code_challenge: challenge, code_challenge_method: "s256" }),
  });
  if (!sent.ok) {
    await sql`delete from memory.oauth_consent where authorization_id = ${id}`;
    return text(`memory: couldn't send the sign-in email (${sent.body.msg ?? sent.body.error_description ?? sent.status}).`, 502);
  }
  return waiting(base, id, `sent a sign-in link to ${masked(emails[0].email)}. Open it on any device to connect.`);
}

function clientAllowed(uri: string) {
  try {
    const u = new URL(uri);
    if (LOOPBACK.has(u.hostname)) return u.protocol === "http:" || u.protocol === "https:";
    return u.protocol === "https:" && CLIENT_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** The email link lands here. Sign the owner in with the stored verifier, approve the request, and leave the client's
 * redirect for the waiting window. */
async function approve(id: string, code: string | null, error: string | null) {
  const [row] = await sql`select code_verifier from memory.oauth_consent
    where authorization_id = ${id} and created_at > now() - ${FRESH}::interval`;
  if (!row) return text("memory: that sign-in expired. Start connecting again from the app.", 410);
  if (!code) return text(`memory: that sign-in link didn't work. ${error ?? ""}`.trim(), 400);

  const session = await auth("/token?grant_type=pkce", {
    method: "POST", body: JSON.stringify({ auth_code: code, code_verifier: row.code_verifier }),
  });
  // This session only approves. It lapses within the hour, and its refresh token is never kept.
  const jwt = session.body.access_token, user = session.body.user;
  if (!session.ok || !jwt) return text("memory: that sign-in link didn't work. Start connecting again from the app.", 400);
  if (!(user?.email && user.email_confirmed_at && await allowed(user.email))) {
    return text("memory: that account isn't on memory's allowlist.", 403);
  }
  const details = await auth(`/oauth/authorizations/${encodeURIComponent(id)}`, { jwt });
  if (!details.ok) return text(`memory: Supabase didn't recognize that request (${details.body.msg ?? details.status}).`, 400);
  let redirect: string | undefined = details.body.redirect_url;
  const name = details.body.client?.name ?? details.body.client?.client_name ?? "an app";
  if (!redirect) {
    const target = details.body.redirect_uri ?? "";
    const action = clientAllowed(target) ? "approve" : "deny";
    const decided = await auth(`/oauth/authorizations/${encodeURIComponent(id)}/consent`, {
      method: "POST", jwt, body: JSON.stringify({ action }),
    });
    if (!decided.ok || !decided.body.redirect_url) return text(`memory: couldn't ${action} that request (${decided.status}).`, 502);
    redirect = decided.body.redirect_url;
    await sql`insert into memory.admin_audit (action, target, after)
      values (${`oauth_${action}`}, ${`client:${details.body.client?.id ?? details.body.client?.client_id ?? "?"}`},
        ${sql.json({ name, redirect_uri: target })})`;
    if (action === "deny") {
      await sql`update memory.oauth_consent set redirect_url = ${redirect!} where authorization_id = ${id}`;
      return text(`memory: refused ${name}. Its callback, ${target}, isn't Claude's or this computer's.`, 403);
    }
  }
  await sql`update memory.oauth_consent set redirect_url = ${redirect!}, client_name = ${name} where authorization_id = ${id}`;
  return text(`memory: connected ${name}. Go back to the window that asked; it finishes by itself.`);
}

/** The waiting window reloads here until the link is clicked, then goes on to the client. */
async function wait(base: string, id: string) {
  const [row] = await sql`select redirect_url, created_at > now() - ${FRESH}::interval as fresh from memory.oauth_consent
    where authorization_id = ${id}`;
  if (!row || !row.fresh) return text("memory: that sign-in expired. Start connecting again from the app.", 410);
  if (!row.redirect_url) return waiting(base, id, "waiting for you to click the sign-in link in your email.");
  await sql`delete from memory.oauth_consent where authorization_id = ${id}`;
  return new Response(null, { status: 302, headers: { location: row.redirect_url, "cache-control": "no-store" } });
}

export async function handle(base: string, path: string, url: URL): Promise<Response> {
  const id = url.searchParams.get("authorization_id") ?? "";
  if (!ID.test(id)) return text("memory: that link is missing its authorization_id. Start connecting again from the app.", 400);
  await sql`delete from memory.oauth_consent where created_at < now() - interval '1 day'`;
  if (path === "/oauth/consent") return consent(base, id);
  if (path === "/oauth/approve") return approve(id, url.searchParams.get("code"), url.searchParams.get("error_description"));
  if (path === "/oauth/wait") return wait(base, id);
  return text("No such endpoint.", 404);
}
