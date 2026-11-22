// Signing an MCP client like claude.ai in to memory. Supabase Auth's OAuth 2.1 server runs the protocol: discovery,
// client registration, the authorize and token endpoints. It hands the owner to a consent page at
// site_url + /oauth/consent, which would normally be HTML. Supabase serves no HTML from its own domain, so the function
// stands in with plain text there, and with JSON for the Worker at memory.heyclyde.me, which renders the pages (R46). It
// emails the allowlisted owner a sign-in link, and the waiting window reloads itself
// until that link is clicked, on this device or any other. The click signs the owner in on the server, approves the
// request, and the window moves on to the client with its code.
import { allowed, clientKey, DOMAIN, ensureAccount, entitlementOf, openSignup, viaProxy } from "./auth.ts";
import { checkoutLink, geoBlocked, geoOf } from "./billing/entitlement.ts";
import { REFUSAL } from "./billing/regions.ts";
import { root, secret, setting, sql } from "./db.ts";

const AUTH = () => `${Deno.env.get("SUPABASE_URL")}/auth/v1`;
const ID = /^[A-Za-z0-9_-]{8,100}$/;
const FRESH = "15 minutes";
// Where an approved code may go, over https: Claude's callbacks, Antigravity's (https://antigravity.google/oauth-callback),
// Grok's and the Gemini app's (R45). Grok and the Gemini app don't document their callbacks, so both of xAI's hosts and
// gemini.google.com are allowed, each exactly, never a subdomain. Google's redirect service is below.
// A program on this computer (Claude Code, Gemini CLI and other local clients) may use http too. Anything else is refused
// and its redirect_uri logged to admin_audit as oauth_deny, so a client someone registered for themselves can't collect a
// code, and an app whose real callback differs shows it on its first try.
// chatgpt.com: ChatGPT's connector callbacks (R67), https://chatgpt.com/connector_platform_oauth_redirect and /connector/oauth/<id>.
// chat.openai.com / platform.openai.com / openai.com: OpenAI portal and legacy ChatGPT connector callbacks.
const CLIENT_HOSTS = new Set(["claude.ai", "claude.com", "chatgpt.com", "chat.openai.com", "platform.openai.com", "openai.com", "antigravity.google", "grok.com", "x.ai", "gemini.google.com"]);
const PROVIDERS = new Set(["google", "github"]);
// Google's OAuth redirect service, which the Gemini app's Connected Apps sign in through (R58): /r/<project> and
// /a/<project> on these three hosts only, since other googleusercontent.com hosts serve anyone's content.
const GOOGLE_HOSTS = new Set([
  "oauth-redirect.googleusercontent.com",
  "oauth-redirect-sandbox.googleusercontent.com",
  "oauth-redirect-test.googleusercontent.com",
]);
const GOOGLE_PATH = /^\/[ra]\/[^/]+/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
// At most this many sign-in emails in 15 minutes, so the open consent page can't flood the owner's inbox.
const MAX_EMAILS = 3;
// With sign-in open (R38): at most 3 sign-in emails to one address an hour, from anywhere, and at most 5 sign-ins started
// from one client address an hour.
const MAX_PER_EMAIL = 3, MAX_PER_CLIENT = 5;
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}\.[^\s@<>"]{2,63}$/;
// A Google or GitHub sign-in is bound to the browser that started it: /oauth/provider sets this cookie to
// <authorization_id>.<bind> and puts bind in the callback's address, and /oauth/approve?direct=1 trades the code only when
// both match. A callback opened in another browser, or one an attacker started and sent on, is refused before any code is
// spent. __Host- keeps it on memory.heyclyde.me alone, and SameSite=Lax still sends it on the provider's redirect back.
const BIND_COOKIE = "__Host-clyde_oauth";
const ALLOW_COOKIE = "__Host-clyde_allow";
const BIND = /^[A-Za-z0-9_-]{16,64}$/;
const bindCookie = (value: string, maxAge: number) => `${BIND_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
const allowCookie = (value: string, maxAge: number) => `${ALLOW_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
export const CLEAR_BIND = bindCookie("", 0);
export const CLEAR_ALLOW = allowCookie("", 0);

const text = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });

const esc = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function callbackHost(uri: string) {
  try { return new URL(uri).host || uri; } catch { return uri; }
}

/** One of the sign-in pages (R46): check_email, waiting, confirm_allow, connected, refused, expired or error. A caller straight to
 * Supabase gets the line as text. The Worker at memory.heyclyde.me asks for JSON and renders the page itself, since
 * Supabase won't serve HTML from its own domain. */
type Page = { json: boolean };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page(p: Page, state: string, line: string, status = 200, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  if (!p.json) return text(`memory: ${line}`, status, headers);
  return Response.json({ state, message: `memory: ${line}`, ...extra }, { status, headers: { ...headers, "cache-control": "no-store" } });
}

/** The resource metadata (RFC 9728) an MCP client reads from the 401's WWW-Authenticate. It names Supabase Auth as the
 * authorization server; the client finds the rest at /.well-known/oauth-authorization-server/auth/v1. */
export function resourceMetadata(base: string) {
  return Response.json({
    resource: `${base}/mcp`,
    authorization_servers: [AUTH()],
    bearer_methods_supported: ["header"],
    resource_name: "Clyde",
  });
}

export const resourceMetadataUrl = (base: string) => `${base}/.well-known/oauth-protected-resource`;

function same(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookieOf(req: Request, name: string) {
  const jar = (req.headers.get("cookie") ?? "").split(/;\s*/);
  return jar.find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
}

/** Whether this browser started the provider sign-in for this request (BIND_COOKIE). */
function boundHere(req: Request, id: string, bind: string | null) {
  if (!bind || !BIND.test(bind)) return false;
  return same(cookieOf(req, BIND_COOKIE), `${id}.${bind}`);
}

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
  if (!emails.length) return page(p, "error", "connecting a client needs an allowed email.", 500);
  // Several allowlisted addresses (Wen and the reviewer account, R55): the page asks which, and only those get a link.
  if (emails.length > 1) return await emailForm(p, id);
  const [{ n }] = await sql`select count(*)::int as n from memory.oauth_consent where created_at > now() - ${FRESH}::interval`;
  if (n >= MAX_EMAILS) return page(p, "error", "too many sign-ins in the last 15 minutes. Try again later.", 429);

  return sendLink(p, base, id, emails[0].email, false);
}

/** Store a PKCE verifier for this request and email the sign-in link that lands on /oauth/approve. */
async function sendLink(p: Page, base: string, id: string, email: string, create: boolean) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  await sql`insert into memory.oauth_consent (authorization_id, code_verifier) values (${id}, ${verifier})
    on conflict (authorization_id) do update set
      code_verifier = excluded.code_verifier,
      client_name = null,
      redirect_url = null,
      pending_jwt = null,
      pending_user = null,
      decision_token = null,
      callback_uri = null,
      direct = false,
      created_at = now()`;
  const redirect = encodeURIComponent(`${base}/oauth/approve?authorization_id=${encodeURIComponent(id)}`);
  const sent = await auth(`/otp?redirect_to=${redirect}`, {
    method: "POST",
    body: JSON.stringify({ email, create_user: create, code_challenge: challenge, code_challenge_method: "s256" }),
  });
  if (!sent.ok) {
    await sql`delete from memory.oauth_consent where authorization_id = ${id}`;
    return page(p, "error", `couldn't send the sign-in email (${sent.body.msg ?? sent.body.error_description ?? sent.status}).`, 502);
  }
  const to = masked(email);
  return waiting(p, base, id, "check_email", `sent a sign-in link to ${to}. Open it on any device to connect.`, { email: to });
}

let providerCache: { at: number; list: string[] } | null = null;

/** Social OAuth providers enabled in Supabase Auth (cached 60s), or overridden via MEMORY_OAUTH_PROVIDERS in tests. */
async function enabledProviders(): Promise<string[]> {
  const override = Deno.env.get("MEMORY_OAUTH_PROVIDERS");
  if (override !== undefined) {
    return override.split(",").map((s) => s.trim().toLowerCase()).filter((s) => PROVIDERS.has(s));
  }
  if (providerCache && Date.now() - providerCache.at < 60_000) return providerCache.list;
  try {
    const r = await fetch(`${AUTH()}/settings`, {
      headers: { apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
      signal: AbortSignal.timeout(3_000),
    });
    const body = r.ok ? await r.json().catch(() => null) : null;
    const list = ["google", "github"].filter((k) => Boolean(body?.external?.[k]));
    providerCache = { at: Date.now(), list };
    return list;
  } catch {
    return providerCache?.list ?? [];
  }
}

/** With sign-in open (R38), the consent page asks for an email first: state ask_email for the Worker's page, a plain
 * form for a caller straight to the function. The form posts back to the same URL. */
async function emailForm(p: Page, id: string) {
  const [key, providers] = await Promise.all([setting("turnstile_site_key"), enabledProviders()]);
  if (p.json) return page(p, "ask_email", "enter your email and we'll send a sign-in link.", 200, await askData(id));
  const links = providers.length
    ? `<p>${providers.map((pr) => `<a href="/oauth/provider?authorization_id=${encodeURIComponent(id)}&provider=${pr}">Continue with ${pr === "google" ? "Google" : "GitHub"}</a>`).join(" | ")}</p>`
    : "";
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to Clyde</title></head><body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem">
<h1>Sign in to Clyde</h1>${links}<p>We'll email you a sign-in link.</p>
<form method="post" action="?authorization_id=${encodeURIComponent(id)}"><label>Your email <input type="email" name="email" required autofocus></label>
<label>Password, only if your account has one <input type="password" name="password" autocomplete="current-password"></label>
<button type="submit">Send the link</button></form></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** What the Worker needs to draw the email form: where it posts, Turnstile's site key and the social sign-ins on offer. */
async function askData(id: string) {
  const [key, providers] = await Promise.all([setting("turnstile_site_key"), enabledProviders()]);
  return {
    post: `/oauth/consent?authorization_id=${encodeURIComponent(id)}`,
    ...(key ? { turnstile_site_key: key } : {}),
    ...(providers.length ? { providers } : {}),
  };
}

/** R80: a sign-up the person can fix by trying again (a bad address, a Turnstile check that didn't pass) puts the form
 * back with what they typed and the reason, rather than a dead end. Nothing is written or sent. */
async function askAgain(p: Page, id: string, email: string, error: string) {
  return page(p, "ask_email", error, 400, { ...(await askData(id)), email: email.slice(0, 254), error });
}

/** POST /oauth/consent with sign-in open: email a sign-in link to whoever asked, creating their account. Refused from a
 * blocked country (451), straight to the function rather than through memory.heyclyde.me unless the email is allowlisted
 * (403), and past the hourly caps (429). Nothing is written or sent for a refusal. */
type Form = { email: string; human: string; password: string; decision: string; decisionToken: string };

/** A consent POST's fields, from a form or JSON, read once: email, Turnstile, password, or Allow/Deny fields. */
async function readForm(req: Request): Promise<Form> {
  const type = req.headers.get("content-type") ?? "";
  const raw = (await req.text()).slice(0, 4096);
  if (type.includes("application/json")) {
    try {
      const body = JSON.parse(raw);
      return {
        email: String(body?.email ?? ""),
        human: String(body?.turnstile ?? body?.["cf-turnstile-response"] ?? ""),
        password: String(body?.password ?? ""),
        decision: String(body?.decision ?? ""),
        decisionToken: String(body?.decision_token ?? ""),
      };
    } catch {
      return { email: "", human: "", password: "", decision: "", decisionToken: "" };
    }
  }
  const form = new URLSearchParams(raw);
  return {
    email: form.get("email") ?? "",
    human: form.get("cf-turnstile-response") ?? "",
    password: form.get("password") ?? "",
    decision: form.get("decision") ?? "",
    decisionToken: form.get("decision_token") ?? "",
  };
}

async function signUp(p: Page, req: Request, base: string, id: string, form: Form) {
  let { email } = form;
  const human = form.human;
  email = email.trim().toLowerCase();
  if (!EMAIL.test(email)) return askAgain(p, id, email, "That isn't an email address. Check it and send again.");
  const proxied = await viaProxy(req);
  if (!proxied && !(await allowed(email))) return page(p, "error", `sign in at ${DOMAIN}, not this address.`, 403);
  if (geoBlocked(geoOf(req, proxied))) return page(p, "blocked", REFUSAL, 451);
  const client = await clientKey(req);
  // R54: Turnstile says a person sent it. With no secret set, the door stays shut rather than open to bots.
  const check = await turnstile(human, client);
  if (check === null) return page(p, "error", "sign-up isn't ready yet. Try again later.", 503);
  if (!check) return askAgain(p, id, email, "Clyde couldn't tell a person sent that. Wait for the check to finish, then send again.");
  const [{ to, from }] = await sql`select
      count(*) filter (where email = ${email})::int as to,
      count(*) filter (where client = ${client})::int as from
    from memory.signup_attempt where at > now() - interval '1 hour'`;
  if (to >= MAX_PER_EMAIL) return page(p, "error", "too many sign-in emails to that address in the last hour. Try again later.", 429);
  if (from >= MAX_PER_CLIENT) return page(p, "error", "too many sign-ins from your address in the last hour. Try again later.", 429);
  await sql`delete from memory.signup_attempt where at < now() - interval '1 day'`;
  await sql`insert into memory.signup_attempt (client, email) values (${client}, ${email})`;
  return sendLink(p, base, id, email, true);
}

const TURNSTILE_URL = () => Deno.env.get("MEMORY_TURNSTILE_URL") || "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Whether Cloudflare Turnstile vouches for this token (R54): true or false, or null when no secret is set (Vault
 * turnstile_secret), so sign-up can't open without a CAPTCHA. A siteverify that doesn't answer counts as no. */
async function turnstile(token: string, client: string): Promise<boolean | null> {
  const key = await secret("turnstile_secret");
  if (!key) return null;
  if (!token || token.length > 2048) return false;
  try {
    const r = await fetch(TURNSTILE_URL(), {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: key, response: token, ...(client ? { remoteip: client.replace(/::\/64$/, "::") } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok && (await r.json())?.success === true;
  } catch {
    return false;
  }
}

function clientAllowed(uri: string) {
  try {
    const u = new URL(uri);
    if (LOOPBACK.has(u.hostname)) return u.protocol === "http:" || u.protocol === "https:";
    if (u.protocol !== "https:") return false;
    return CLIENT_HOSTS.has(u.hostname) || (GOOGLE_HOSTS.has(u.hostname) && GOOGLE_PATH.test(u.pathname));
  } catch {
    return false;
  }
}

/** The email link or OAuth callback lands here. Sign the user in with the stored verifier and approve the client request.
 * direct is a Google or GitHub callback (/oauth/provider's redirect_to): it must come back to the browser that started it,
 * and a cancelled or failed one offers this request's sign-in page again. */
async function approve(p: Page, req: Request, id: string, code: string | null, error: { code: string | null; text: string | null },
  direct = false, bind: string | null = null) {
  const [row] = await sql`select code_verifier, redirect_url, pending_jwt, client_name from memory.oauth_consent
    where authorization_id = ${id} and created_at > now() - ${FRESH}::interval`;
  if (!row) return page(p, "expired", "that sign-in expired. Start connecting again from the app.", 410);
  if (direct && !code) {
    const line = error.code === "access_denied"
      ? "sign-in was cancelled at the provider. Nothing was shared. Go back to sign-in to try again or use your email."
      : `the provider couldn't sign you in${error.text ? ` (${error.text.slice(0, 200)})` : ""}. Go back to sign-in to try again or use your email.`;
    return page(p, error.code === "access_denied" ? "denied" : "error", line, 400, { retry: true });
  }
  if (direct && !boundHere(req, id, bind)) {
    return page(p, "error", "that sign-in didn't start in this browser, so Clyde ignored it. Go back to sign-in and start again here.", 403, { retry: true });
  }
  // A link works once. Opened again after it already approved/denied this request, it's done, not failed.
  if (!code && row.redirect_url && !row.pending_jwt) {
    let denied = false;
    try { denied = Boolean(new URL(String(row.redirect_url)).searchParams.get("error")); } catch { /* ignore */ }
    if (denied) {
      return page(p, "denied", `denied${row.client_name ? ` ${row.client_name}` : ""}. Nothing was shared.`, 200,
        row.client_name ? { client: row.client_name } : {});
    }
    return page(p, "connected", `connected${row.client_name ? ` ${row.client_name}` : ""}. Go back to the window that asked. It finishes by itself.`, 200);
  }
  if (!code) return page(p, "error", `that sign-in link didn't work. ${error.text ?? ""}`.trim(), 400);

  const session = await auth("/token?grant_type=pkce", {
    method: "POST", body: JSON.stringify({ auth_code: code, code_verifier: row.code_verifier }),
  });
  // This session only approves. It lapses within the hour, and its refresh token is never kept.
  const jwt = session.body.access_token, user = session.body.user;
  if (!session.ok || !jwt) {
    return direct
      ? page(p, "error", "that sign-in code didn't work or was already used. Go back to sign-in and start again.", 400, { retry: true })
      : page(p, "error", "that sign-in link didn't work. Start connecting again from the app.", 400);
  }
  const proxied = await viaProxy(req);
  if (direct && user?.email && !(await allowed(user.email)) && geoBlocked(geoOf(req, proxied))) {
    return page(p, "blocked", REFUSAL, 451);
  }
  return await finish(p, id, jwt, user, direct);
}

/** Call Supabase Auth's /consent, write admin_audit, and record an approved app on the owner's account. */
async function applyConsent(
  p: Page,
  jwt: string,
  id: string,
  details: { body: Record<string, any> },
  action: "approve" | "deny",
  name: string,
  target: string,
  user: Record<string, any>,
  extraAudit: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<{ redirect?: string; error?: Response }> {
  const decided = await auth(`/oauth/authorizations/${encodeURIComponent(id)}/consent`, {
    method: "POST",
    jwt,
    body: JSON.stringify({ action }),
  });
  if (!decided.ok || !decided.body.redirect_url) {
    return { error: page(p, "error", `couldn't ${action} that request (${decided.status}).`, 502, {}, headers) };
  }
  await sql`insert into memory.admin_audit (action, target, after)
    values (${`oauth_${action}`}, ${`client:${details.body.client?.id ?? details.body.client?.client_id ?? "?"}`},
      ${sql.json({ name, redirect_uri: target, ...extraAudit })})`;
  const cid = String(details.body.client?.id ?? details.body.client?.client_id ?? "");
  const uid = UUID.test(String(user?.id ?? "")) ? String(user.id).toLowerCase() : null;
  if (action === "approve" && cid && uid) {
    const entry = { id: cid, name: String(name || cid), granted_at: new Date().toISOString(), revoked_at: null };
    await sql`update memory.account set oauth_apps = coalesce(oauth_apps, '{}'::jsonb) || ${sql.json({ [cid]: entry })}
      where owner_id = ${uid}::uuid`.catch(() => {});
  }
  return { redirect: String(decided.body.redirect_url) };
}

/** Deliver an approved redirect to the direct caller or the waiting window, respecting form-action 'self'. */
async function complete(
  p: Page,
  id: string,
  redirect: string,
  name: string,
  user: Record<string, any>,
  direct: boolean,
  headers: Record<string, string> = {},
): Promise<Response> {
  if (direct && p.json) {
    await sql`insert into memory.oauth_consent (authorization_id, code_verifier, redirect_url, client_name, direct)
      values (${id}, '', ${redirect}, ${name}, true)
      on conflict (authorization_id) do update
      set code_verifier = '', redirect_url = excluded.redirect_url, client_name = excluded.client_name,
        pending_jwt = null, pending_user = null, decision_token = null, callback_uri = null, direct = true, created_at = now()`;
    return new Response(null, {
      status: 303,
      headers: { ...headers, location: `/oauth/wait?authorization_id=${encodeURIComponent(id)}`, "cache-control": "no-store" },
    });
  }
  if (direct) {
    await sql`delete from memory.oauth_consent where authorization_id = ${id}`;
    return new Response(null, { status: 302, headers: { ...headers, location: redirect, "cache-control": "no-store" } });
  }
  await sql`update memory.oauth_consent set redirect_url = ${redirect}, client_name = ${name} where authorization_id = ${id}`;
  const full = await freeTierFull(user);
  return page(p, "connected", `connected ${name}. Go back to the window that asked. It finishes by itself.${full ? ` ${full.line}` : ""}`, 200,
    { client: name, ...(full ? { free_full: true, checkout_url: full.url } : {}) }, headers);
}

/** With a signed-in session: refuse disallowed callbacks immediately, or show an explicit Allow step naming the client
 * and callback host before calling Supabase Auth's /consent. Direct browser sign-ins bounce through /oauth/wait on decision. */
async function finish(p: Page, id: string, jwt: string, user: Record<string, any>, direct: boolean): Promise<Response> {
  // A Google or GitHub account counts only with an email the provider verified, the same bar an email link sets.
  if (!(user?.email && user.email_confirmed_at)) {
    return page(p, "error", "that account has no verified email, so Clyde can't tell whose it is. Verify the email with your provider, or sign in with your email.", 403);
  }
  if (!(await openSignup() || await allowed(user.email))) {
    return page(p, "error", "that account isn't on Clyde's allowlist.", 403);
  }
  const details = await auth(`/oauth/authorizations/${encodeURIComponent(id)}`, { jwt });
  if (!details.ok) return page(p, "error", `Supabase didn't recognize that request (${details.body.msg ?? details.status}).`, 400);
  const name = String(details.body.client?.name ?? details.body.client?.client_name ?? "an app");
  if (details.body.redirect_url) {
    return await complete(p, id, String(details.body.redirect_url), name, user, direct);
  }
  const target = String(details.body.redirect_uri ?? "");
  if (!clientAllowed(target)) {
    const out = await applyConsent(p, jwt, id, details, "deny", name, target, user);
    if (out.error) return out.error;
    console.warn(`memory: oauth_deny for ${name}: redirect_uri ${target}`);
    if (!direct) await sql`update memory.oauth_consent set redirect_url = ${out.redirect!} where authorization_id = ${id}`;
    return page(p, "refused", `refused ${name}. Its callback, ${target}, isn't one Clyde approves (Claude, ChatGPT, OpenAI, Antigravity, Grok, the Gemini app, or localhost).`, 403,
      { client: name, callback: target });
  }
  const formToken = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const cookieBind = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const token = `${formToken}.${cookieBind}`;
  const storedUser = { id: user.id ?? null, email: user.email, email_confirmed_at: user.email_confirmed_at };
  await sql`insert into memory.oauth_consent (
      authorization_id, code_verifier, client_name, redirect_url,
      pending_jwt, pending_user, decision_token, callback_uri, direct
    ) values (
      ${id}, '', ${name}, null,
      ${jwt}, ${sql.json(storedUser)}, ${token}, ${target}, ${direct}
    )
    on conflict (authorization_id) do update set
      code_verifier = '',
      client_name = excluded.client_name,
      redirect_url = null,
      pending_jwt = excluded.pending_jwt,
      pending_user = excluded.pending_user,
      decision_token = excluded.decision_token,
      callback_uri = excluded.callback_uri,
      direct = excluded.direct,
      created_at = now()`;
  const host = callbackHost(target);
  const cookie = allowCookie(`${id}.${cookieBind}`, 15 * 60);
  if (p.json) {
    return page(p, "confirm_allow", `Allow ${name} to use your Clyde? Callback: ${host}.`, 200, {
      client: name,
      callback: target,
      callback_host: host,
      email: String(user.email),
      decision_token: formToken,
    }, { "set-cookie": cookie });
  }
  const action = `approve?authorization_id=${encodeURIComponent(id)}`;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Allow ${esc(name)}? · Clyde</title></head><body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem">
<h1>Allow <strong>${esc(name)}</strong> to use your Clyde?</h1>
<p>Signed in as <strong>${esc(String(user.email))}</strong>.</p>
<p>Callback host: <code>${esc(host)}</code></p>
<p>Callback URL: <code>${esc(target)}</code></p>
<form method="post" action="${esc(action)}">
<input type="hidden" name="decision_token" value="${esc(formToken)}">
<button type="submit" name="decision" value="allow">Allow ${esc(name)}</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form></body></html>`,
    {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "set-cookie": cookie },
    },
  );
}

/** POST /oauth/approve (Quest #37): verify the single-use Allow/Deny form token + __Host-clyde_allow cookie, then ask
 * Supabase Auth to approve or deny the client request. */
async function decide(p: Page, req: Request, id: string): Promise<Response> {
  const form = await readForm(req);
  const decision = form.decision.trim().toLowerCase();
  if (decision !== "allow" && decision !== "deny") {
    return page(p, "error", "choose Allow or Deny to finish connecting.", 400);
  }
  const [row] = await sql`select pending_jwt, pending_user, decision_token, callback_uri, client_name, direct, redirect_url,
      created_at > now() - ${FRESH}::interval as fresh
    from memory.oauth_consent where authorization_id = ${id}`;
  if (!row || !row.fresh) {
    return page(p, "expired", "that sign-in expired. Start connecting again from the app.", 410, {}, { "set-cookie": CLEAR_ALLOW });
  }
  if (!row.pending_jwt || !row.decision_token || row.redirect_url) {
    return page(p, "error", "that approval request was already used. Start connecting again from the app.", 400, {}, { "set-cookie": CLEAR_ALLOW });
  }
  const rawCookie = cookieOf(req, ALLOW_COOKIE);
  const dot = rawCookie.indexOf(".");
  const cookieId = dot >= 0 ? rawCookie.slice(0, dot) : "";
  const cookieBind = dot >= 0 ? rawCookie.slice(dot + 1) : "";
  const expected = String(row.decision_token);
  if (cookieId !== id || !form.decisionToken || !cookieBind || !same(`${form.decisionToken}.${cookieBind}`, expected)) {
    return page(p, "error", "that approval check didn't match this browser session. Start connecting again from the app.", 403);
  }
  const [claimed] = await sql`update memory.oauth_consent
    set pending_jwt = null, pending_user = null, decision_token = null, code_verifier = ''
    where authorization_id = ${id} and decision_token = ${expected} and created_at > now() - ${FRESH}::interval
    returning authorization_id`;
  if (!claimed) {
    return page(p, "error", "that approval request was already used. Start connecting again from the app.", 409, {}, { "set-cookie": CLEAR_ALLOW });
  }
  const jwt = String(row.pending_jwt);
  let rawUser: unknown = row.pending_user ?? {};
  if (typeof rawUser === "string") {
    try { rawUser = JSON.parse(rawUser); } catch { rawUser = {}; }
  }
  const user = (rawUser && typeof rawUser === "object" ? rawUser : {}) as Record<string, any>;
  const direct = Boolean(row.direct);
  const clear = { "set-cookie": CLEAR_ALLOW };
  const details = await auth(`/oauth/authorizations/${encodeURIComponent(id)}`, { jwt });
  if (!details.ok) {
    return page(p, "error", `Supabase didn't recognize that request (${details.body.msg ?? details.status}).`, 400, {}, clear);
  }
  const name = String(details.body.client?.name ?? details.body.client?.client_name ?? row.client_name ?? "an app");
  if (details.body.redirect_url) {
    return await complete(p, id, String(details.body.redirect_url), name, user, direct, clear);
  }
  const target = String(details.body.redirect_uri ?? row.callback_uri ?? "");
  const allowedCallback = clientAllowed(target);
  const action: "approve" | "deny" = decision === "allow" && allowedCallback ? "approve" : "deny";
  const extraAudit = decision === "deny" ? { reason: "user_denied" } : {};
  const out = await applyConsent(p, jwt, id, details, action, name, target, user, extraAudit, clear);
  if (out.error) return out.error;
  const redirect = out.redirect!;
  if (decision === "allow" && !allowedCallback) {
    console.warn(`memory: oauth_deny for ${name}: redirect_uri ${target}`);
    if (!direct) await sql`update memory.oauth_consent set redirect_url = ${redirect} where authorization_id = ${id}`;
    return page(p, "refused", `refused ${name}. Its callback, ${target}, isn't one Clyde approves (Claude, ChatGPT, OpenAI, Antigravity, Grok, the Gemini app, or localhost).`, 403,
      { client: name, callback: target }, clear);
  }
  if (decision === "deny") {
    if (direct && p.json) {
      await sql`update memory.oauth_consent set redirect_url = ${redirect}, client_name = ${name} where authorization_id = ${id}`;
      return new Response(null, {
        status: 303,
        headers: { ...clear, location: `/oauth/wait?authorization_id=${encodeURIComponent(id)}`, "cache-control": "no-store" },
      });
    }
    if (direct) {
      await sql`delete from memory.oauth_consent where authorization_id = ${id}`;
      return new Response(null, { status: 302, headers: { ...clear, location: redirect, "cache-control": "no-store" } });
    }
    await sql`update memory.oauth_consent set redirect_url = ${redirect}, client_name = ${name} where authorization_id = ${id}`;
    return page(p, "denied", `denied ${name}. Nothing was shared.`, 200, { client: name }, clear);
  }
  return await complete(p, id, redirect, name, user, direct, clear);
}

/** With sign-up open (R74): a new account past the free tier's last seat, or while it is closed, connects but its tools need a
 * plan, so the page says so with the checkout link and the price. Null when the account holds a seat or a plan. */
async function freeTierFull(user: { id?: string; email?: string } | undefined) {
  const id = String(user?.id ?? "").toLowerCase();
  if (!user?.email || !UUID.test(id) || !(await openSignup())) return null;
  if (await ensureAccount(id, user.email, true)) return null;
  if ((await entitlementOf(id)).plan.open) return null;
  const [plan] = await root`select p.price_micro_usd_month as price from memory.plan p
    where p.id = coalesce((select value from memory.setting where name = 'checkout_plan'), 'clyde')`;
  const url = await checkoutLink(id);
  const price = plan ? `$${(Number(plan.price) / 1e6).toFixed(2)} a month` : "a month";
  return { url, line: `Clyde's free tier is full, so its tools need the Clyde plan at ${price}: ${url}` };
}

/** POST /oauth/consent with a password (R55): sign in with it and approve at once, for an account that has one, such as the
 * store reviewers' review@heyclyde.me. Counted with the sign-up attempts, so the hourly caps hold guessing down. Works with
 * sign-up closed, since the account is on the allowlist. */
async function passwordSignIn(p: Page, req: Request, id: string, form: Form) {
  if (geoBlocked(geoOf(req, await viaProxy(req)))) return page(p, "blocked", REFUSAL, 451);
  const email = form.email.trim().toLowerCase();
  if (!EMAIL.test(email) || form.password.length > 200) return page(p, "error", "that isn't an email and password.", 400);
  const client = await clientKey(req);
  const [{ from }] = await sql`select count(*) filter (where client = ${client})::int as from
    from memory.signup_attempt where at > now() - interval '1 hour'`;
  if (from >= MAX_PER_CLIENT) return page(p, "error", "too many sign-ins from your address in the last hour. Try again later.", 429);
  await sql`insert into memory.signup_attempt (client, email) values (${client}, ${email})`;
  const session = await auth("/token?grant_type=password", { method: "POST", body: JSON.stringify({ email, password: form.password }) });
  const jwt = session.body.access_token;
  if (!session.ok || !jwt) return page(p, "error", "that email and password don't match.", 401);
  return await finish(p, id, jwt, session.body.user, true);
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

/** GET /oauth/provider: start social OAuth (Google or GitHub) with PKCE back to /oauth/approve?direct=1. */
async function startProvider(p: Page, req: Request, base: string, id: string, rawProvider: string) {
  const provider = rawProvider.trim().toLowerCase();
  if (!PROVIDERS.has(provider)) return page(p, "error", "that sign-in provider isn't supported.", 400);
  if (!(await enabledProviders()).includes(provider)) return page(p, "error", "that sign-in provider isn't enabled yet.", 400);
  const proxied = await viaProxy(req);
  if (!proxied) return page(p, "error", `sign in at ${DOMAIN}, not this address.`, 403);
  if (geoBlocked(geoOf(req, proxied))) return page(p, "blocked", REFUSAL, 451);
  const client = await clientKey(req);
  const [{ from }] = await sql`select count(*) filter (where client = ${client})::int as from
    from memory.signup_attempt where at > now() - interval '1 hour'`;
  if (from >= MAX_PER_CLIENT) return page(p, "error", "too many sign-ins from your address in the last hour. Try again later.", 429);
  await sql`delete from memory.signup_attempt where at < now() - interval '1 day'`;
  await sql`insert into memory.signup_attempt (client, email) values (${client}, ${`oauth:${provider}`})`;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const bind = b64url(crypto.getRandomValues(new Uint8Array(16)));
  await sql`insert into memory.oauth_consent (authorization_id, code_verifier) values (${id}, ${verifier})
    on conflict (authorization_id) do update set
      code_verifier = excluded.code_verifier,
      client_name = null,
      redirect_url = null,
      pending_jwt = null,
      pending_user = null,
      decision_token = null,
      callback_uri = null,
      direct = false,
      created_at = now()`;
  const redirect = encodeURIComponent(`${base}/oauth/approve?authorization_id=${encodeURIComponent(id)}&direct=1&bind=${bind}`);
  const dest = `${AUTH()}/authorize?provider=${encodeURIComponent(provider)}&redirect_to=${redirect}&code_challenge=${challenge}&code_challenge_method=s256`;
  return new Response(null, {
    status: 302,
    headers: { location: dest, "cache-control": "no-store", "set-cookie": bindCookie(`${id}.${bind}`, 15 * 60) },
  });
}

/** json: the request came through the Worker (x-memory-proxy) and asked for application/json. */
export async function handle(req: Request, base: string, path: string, url: URL, json = false): Promise<Response> {
  const p: Page = { json };
  const id = url.searchParams.get("authorization_id") ?? "";
  if (!ID.test(id)) return page(p, "error", "that link is missing its authorization_id. Start connecting again from the app.", 400);
  await sql`delete from memory.oauth_consent where created_at < now() - interval '1 day'`;
  await sql`update memory.oauth_consent
    set pending_jwt = null, pending_user = null, decision_token = null
    where pending_jwt is not null and created_at <= now() - ${FRESH}::interval`;
  if (path === "/oauth/provider" && req.method === "GET") {
    return startProvider(p, req, base, id, url.searchParams.get("provider") ?? "");
  }
  if (path === "/oauth/approve" && req.method === "POST") {
    return decide(p, req, id);
  }
  const form = path === "/oauth/consent" && req.method === "POST" ? await readForm(req) : null;
  if (form?.password) return passwordSignIn(p, req, id, form);
  // With sign-in open (R38), anyone can ask for a link: an email form, then a capped, region-checked send.
  if (path === "/oauth/consent" && await openSignup()) {
    if (form) return signUp(p, req, base, id, form);
    const [row] = await sql`select created_at > now() - ${FRESH}::interval as fresh from memory.oauth_consent where authorization_id = ${id}`;
    return row?.fresh ? waiting(p, base, id, "check_email", "the sign-in link is in your email.") : emailForm(p, id);
  }
  // R54: while the door is shut, an allowlisted address still gets its sign-in link; anyone else is told sign-ups are
  // closed, and nobody is emailed.
  if (path === "/oauth/consent" && form) {
    const email = form.email.trim().toLowerCase();
    if (EMAIL.test(email) && await allowed(email)) {
      const [{ n }] = await sql`select count(*)::int as n from memory.oauth_consent where created_at > now() - ${FRESH}::interval`;
      if (n >= MAX_EMAILS) return page(p, "error", "too many sign-ins in the last 15 minutes. Try again later.", 429);
      return sendLink(p, base, id, email, false);
    }
    return page(p, "closed", "Sign-ups are closed. Clyde isn't taking new accounts right now.", 403);
  }
  if (path === "/oauth/consent") return consent(p, base, id);
  if (path === "/oauth/approve") {
    const direct = url.searchParams.get("direct") === "1";
    const error = { code: url.searchParams.get("error"), text: url.searchParams.get("error_description") };
    const res = await approve(p, req, id, url.searchParams.get("code"), error, direct, url.searchParams.get("bind"));
    // A provider callback spends its binding whatever happens, so the same address can't be replayed in this browser.
    if (direct) res.headers.append("set-cookie", CLEAR_BIND);
    return res;
  }
  if (path === "/oauth/wait") return wait(p, base, id);
  return json ? page(p, "error", "no such endpoint.", 404) : text("No such endpoint.", 404);
}

const INVITE_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

/** Look up a partner/special invite code for /invite?code=... */
export async function inviteInfo(url: URL): Promise<Response> {
  const j = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const code = (url.searchParams.get("code") ?? "").trim();
  if (!INVITE_CODE.test(code)) return j({ valid: false, error: "Invalid invite code." }, 404);
  const [inv] = await sql`select code, plan, label, invited_by, note, max_uses, uses, expires_at, revoked_at
    from memory.invite where code = ${code}`;
  if (!inv) return j({ valid: false, error: "That invite link doesn't exist." }, 404);
  if (inv.revoked_at) return j({ valid: false, error: "That invite link has been revoked." }, 410);
  if (inv.expires_at && new Date(inv.expires_at).getTime() <= Date.now()) {
    return j({ valid: false, error: "That invite link has expired." }, 410);
  }
  const maxUses = inv.max_uses === null || inv.max_uses === undefined ? null : Number(inv.max_uses);
  const uses = Number(inv.uses ?? 0);
  if (maxUses !== null && uses >= maxUses) {
    return j({ valid: false, error: "That invite link has reached its limit." }, 410);
  }
  return j({
    valid: true,
    code: String(inv.code),
    plan: String(inv.plan),
    unlimited: inv.plan === "partner" || inv.plan === "owner",
    label: String(inv.label || "Partner invite"),
    invited_by: String(inv.invited_by || "Wen"),
    note: inv.note ? String(inv.note) : null,
    remaining: maxUses === null ? null : Math.max(0, maxUses - uses),
  });
}

/** Public email sign-up from /invite: geo-checked, rate-limited, and gated on open_signup (or allowed_email or active invite code). */
export async function inviteSignup(req: Request): Promise<Response> {
  const j = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const raw = await req.text().catch(() => "");
  if (!raw || raw.length > 4096) return j({ error: "Invalid request body." }, 400);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return j({ error: "Invalid JSON body." }, 400);
  }
  const email = typeof parsed?.email === "string" ? parsed.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email)) return j({ error: "Enter a valid email address." }, 400);
  const proxied = await viaProxy(req);
  if (geoBlocked(geoOf(req, proxied))) return j({ error: REFUSAL }, 451);

  const rawCode = typeof parsed?.code === "string" ? parsed.code.trim() : "";
  let validCode = "";
  if (rawCode) {
    if (!INVITE_CODE.test(rawCode)) return j({ error: "That invite code isn't valid." }, 400);
    const [inv] = await sql`select code, max_uses, uses, expires_at, revoked_at from memory.invite where code = ${rawCode}`;
    if (!inv || inv.revoked_at || (inv.expires_at && new Date(inv.expires_at).getTime() <= Date.now()) ||
      (inv.max_uses !== null && Number(inv.uses) >= Number(inv.max_uses))) {
      return j({ error: "That invite link is no longer active." }, 410);
    }
    validCode = String(inv.code);
  }

  if (!validCode && !(await openSignup()) && !(await allowed(email))) {
    return j({ error: "Sign-ups are closed right now." }, 403);
  }
  const client = await clientKey(req);
  const [{ to, from }] = await sql`select
      count(*) filter (where email = ${email})::int as to,
      count(*) filter (where client = ${client})::int as from
    from memory.signup_attempt where at > now() - interval '1 hour'`;
  if (to >= MAX_PER_EMAIL) return j({ error: "Too many sign-in emails to that address in the last hour. Try again later." }, 429);
  if (from >= MAX_PER_CLIENT) return j({ error: "Too many sign-ins from your address in the last hour. Try again later." }, 429);
  await sql`delete from memory.signup_attempt where at < now() - interval '1 day'`;
  await sql`insert into memory.signup_attempt (client, email) values (${client}, ${email})`;
  const target = validCode
    ? `https://heyclyde.me/memories?onboarding=1&invite=${encodeURIComponent(validCode)}`
    : "https://heyclyde.me/memories?onboarding=1";
  const redirect = encodeURIComponent(target);
  const sent = await auth(`/otp?redirect_to=${redirect}`, {
    method: "POST",
    body: JSON.stringify({ email, create_user: true }),
  });
  if (!sent.ok) {
    return j({ error: `Couldn't send the sign-in email (${sent.body.msg ?? sent.body.error_description ?? sent.status}).` }, 502);
  }
  return j({ ok: true, email, invite: validCode || null });
}
