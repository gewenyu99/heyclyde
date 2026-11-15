// Signing an MCP client like claude.ai in to memory. Supabase Auth's OAuth 2.1 server runs the protocol: discovery,
// client registration, the authorize and token endpoints. It hands the owner to a consent page at
// site_url + /oauth/consent, which would normally be HTML. Supabase serves no HTML from its own domain, so the function
// stands in with plain text there, and with JSON for the Worker at memory.heyclyde.me, which renders the pages (R46). It
// emails the allowlisted owner a sign-in link, and the waiting window reloads itself
// until that link is clicked, on this device or any other. The click signs the owner in on the server, approves the
// request, and the window moves on to the client with its code.
import { allowed } from "./auth.ts";
import { sql } from "./db.ts";

const AUTH = () => `${Deno.env.get("SUPABASE_URL")}/auth/v1`;
const ID = /^[A-Za-z0-9_-]{8,100}$/;
const FRESH = "15 minutes";
// Where an approved code may go, over https: Claude's callbacks, Antigravity's (https://antigravity.google/oauth-callback),
// Grok's and the Gemini app's (R45). Grok and the Gemini app don't document their callbacks, so both of xAI's hosts and
// gemini.google.com are allowed, each exactly, never a subdomain. No other Google host is, without evidence it's used.
// A program on this computer (Claude Code, Gemini CLI and other local clients) may use http too. Anything else is refused
// and its redirect_uri logged to admin_audit as oauth_deny, so a client someone registered for themselves can't collect a
// code, and an app whose real callback differs shows it on its first try.
// chatgpt.com: ChatGPT's connector callbacks (R67), https://chatgpt.com/connector_platform_oauth_redirect and /connector/oauth/<id>.
const CLIENT_HOSTS = new Set(["claude.ai", "claude.com", "chatgpt.com", "antigravity.google", "grok.com", "x.ai", "gemini.google.com"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
// At most this many sign-in emails in 15 minutes, so the open consent page can't flood the owner's inbox.
const MAX_EMAILS = 3;

const text = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });

/** One of the sign-in pages (R46): check_email, waiting, connected, refused, expired or error. A caller straight to
 * Supabase gets the line as text. The Worker at memory.heyclyde.me asks for JSON and renders the page itself, since
 * Supabase won't serve HTML from its own domain. */
type Page = { json: boolean };
function page(p: Page, state: string, line: string, status = 200, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  if (!p.json) return text(`memory: ${line}`, status, headers);
  return Response.json({ state, message: `memory: ${line}`, ...extra }, { status, headers: { "cache-control": "no-store" } });
}

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

function waiting(p: Page, base: string, id: string, state: string, line: string, extra: Record<string, unknown> = {}) {
  if (p.json) return page(p, state, line, 200, extra);
  return text(`memory: ${line}\n\nThis page checks every few seconds and moves on by itself once you click the link.`, 200,
    { refresh: `3; url=${base}/oauth/wait?authorization_id=${encodeURIComponent(id)}`, "cache-control": "no-store" });
}

function masked(email: string) {
  const [name, host] = email.split("@");
  return `${name.slice(0, 1)}${"•".repeat(Math.max(1, name.length - 1))}@${host}`;
}

/** Where Supabase sends the owner: email the sign-in link once per request, then wait. */
async function consent(p: Page, base: string, id: string) {
  const [row] = await sql`select created_at > now() - ${FRESH}::interval as fresh from memory.oauth_consent
    where authorization_id = ${id}`;
  if (row?.fresh) return waiting(p, base, id, "check_email", "the sign-in link is in your email.");
  const emails = await sql`select email from memory.allowed_email order by email limit 2`;
  if (emails.length !== 1) return page(p, "error", "connecting a client needs exactly one allowed email.", 500);
  const [{ n }] = await sql`select count(*)::int as n from memory.oauth_consent where created_at > now() - ${FRESH}::interval`;
  if (n >= MAX_EMAILS) return page(p, "error", "too many sign-ins in the last 15 minutes. Try again later.", 429);

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
    return page(p, "error", `couldn't send the sign-in email (${sent.body.msg ?? sent.body.error_description ?? sent.status}).`, 502);
  }
  const to = masked(emails[0].email);
  return waiting(p, base, id, "check_email", `sent a sign-in link to ${to}. Open it on any device to connect.`, { email: to });
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
async function approve(p: Page, id: string, code: string | null, error: string | null) {
  const [row] = await sql`select code_verifier from memory.oauth_consent
    where authorization_id = ${id} and created_at > now() - ${FRESH}::interval`;
  if (!row) return page(p, "expired", "that sign-in expired. Start connecting again from the app.", 410);
  if (!code) return page(p, "error", `that sign-in link didn't work. ${error ?? ""}`.trim(), 400);

  const session = await auth("/token?grant_type=pkce", {
    method: "POST", body: JSON.stringify({ auth_code: code, code_verifier: row.code_verifier }),
  });
  // This session only approves. It lapses within the hour, and its refresh token is never kept.
  const jwt = session.body.access_token, user = session.body.user;
  if (!session.ok || !jwt) return page(p, "error", "that sign-in link didn't work. Start connecting again from the app.", 400);
  if (!(user?.email && user.email_confirmed_at && await allowed(user.email))) {
    return page(p, "error", "that account isn't on memory's allowlist.", 403);
  }
  const details = await auth(`/oauth/authorizations/${encodeURIComponent(id)}`, { jwt });
  if (!details.ok) return page(p, "error", `Supabase didn't recognize that request (${details.body.msg ?? details.status}).`, 400);
  let redirect: string | undefined = details.body.redirect_url;
  const name = details.body.client?.name ?? details.body.client?.client_name ?? "an app";
  if (!redirect) {
    const target = details.body.redirect_uri ?? "";
    const action = clientAllowed(target) ? "approve" : "deny";
    const decided = await auth(`/oauth/authorizations/${encodeURIComponent(id)}/consent`, {
      method: "POST", jwt, body: JSON.stringify({ action }),
    });
    if (!decided.ok || !decided.body.redirect_url) return page(p, "error", `couldn't ${action} that request (${decided.status}).`, 502);
    redirect = decided.body.redirect_url;
    await sql`insert into memory.admin_audit (action, target, after)
      values (${`oauth_${action}`}, ${`client:${details.body.client?.id ?? details.body.client?.client_id ?? "?"}`},
        ${sql.json({ name, redirect_uri: target })})`;
    if (action === "deny") {
      console.warn(`memory: oauth_deny for ${name}: redirect_uri ${target}`);
      await sql`update memory.oauth_consent set redirect_url = ${redirect!} where authorization_id = ${id}`;
      return page(p, "refused", `refused ${name}. Its callback, ${target}, isn't one memory approves (Claude, Antigravity, Grok, the Gemini app or this computer).`, 403,
        { client: name, callback: target });
    }
  }
  await sql`update memory.oauth_consent set redirect_url = ${redirect!}, client_name = ${name} where authorization_id = ${id}`;
  return page(p, "connected", `connected ${name}. Go back to the window that asked; it finishes by itself.`, 200, { client: name });
}

/** The waiting window reloads here until the link is clicked, then goes on to the client. */
async function wait(p: Page, base: string, id: string) {
  const [row] = await sql`select redirect_url, created_at > now() - ${FRESH}::interval as fresh from memory.oauth_consent
    where authorization_id = ${id}`;
  if (!row || !row.fresh) return page(p, "expired", "that sign-in expired. Start connecting again from the app.", 410);
  if (!row.redirect_url) return waiting(p, base, id, "waiting", "waiting for you to click the sign-in link in your email.");
  await sql`delete from memory.oauth_consent where authorization_id = ${id}`;
  return new Response(null, { status: 302, headers: { location: row.redirect_url, "cache-control": "no-store" } });
}

/** json: the request came through the Worker (x-memory-proxy) and asked for application/json. */
export async function handle(base: string, path: string, url: URL, json = false): Promise<Response> {
  const p: Page = { json };
  const id = url.searchParams.get("authorization_id") ?? "";
  if (!ID.test(id)) return page(p, "error", "that link is missing its authorization_id. Start connecting again from the app.", 400);
  await sql`delete from memory.oauth_consent where created_at < now() - interval '1 day'`;
  if (path === "/oauth/consent") return consent(p, base, id);
  if (path === "/oauth/approve") return approve(p, id, url.searchParams.get("code"), url.searchParams.get("error_description"));
  if (path === "/oauth/wait") return wait(p, base, id);
  return json ? page(p, "error", "no such endpoint.", 404) : text("No such endpoint.", 404);
}
