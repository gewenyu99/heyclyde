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

const text = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });

/** One of the sign-in pages (R46): check_email, waiting, connected, refused, expired or error. A caller straight to
 * Supabase gets the line as text. The Worker at memory.heyclyde.me asks for JSON and renders the page itself, since
 * Supabase won't serve HTML from its own domain. */
type Page = { json: boolean };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    resource_name: "Clyde",
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
    on conflict (authorization_id) do update set code_verifier = excluded.code_verifier, redirect_url = null, created_at = now()`;
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
  if (p.json) {
    return page(p, "ask_email", "enter your email and we'll send a sign-in link.", 200, {
      post: `/oauth/consent?authorization_id=${encodeURIComponent(id)}`,
      ...(key ? { turnstile_site_key: key } : {}),
      ...(providers.length ? { providers } : {}),
    });
  }
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

/** POST /oauth/consent with sign-in open: email a sign-in link to whoever asked, creating their account. Refused from a
 * blocked country (451), straight to the function rather than through memory.heyclyde.me unless the email is allowlisted
 * (403), and past the hourly caps (429). Nothing is written or sent for a refusal. */
type Form = { email: string; human: string; password: string };

/** A consent POST's fields, from a form or JSON, read once: the email, the Turnstile token and a password if one came. */
async function readForm(req: Request): Promise<Form> {
  const type = req.headers.get("content-type") ?? "";
  const raw = (await req.text()).slice(0, 4096);
  if (type.includes("application/json")) {
    try {
      const body = JSON.parse(raw);
      return { email: String(body?.email ?? ""), human: String(body?.turnstile ?? body?.["cf-turnstile-response"] ?? ""), password: String(body?.password ?? "") };
    } catch {
      return { email: "", human: "", password: "" };
    }
  }
  const form = new URLSearchParams(raw);
  return { email: form.get("email") ?? "", human: form.get("cf-turnstile-response") ?? "", password: form.get("password") ?? "" };
}

async function signUp(p: Page, req: Request, base: string, id: string, form: Form) {
  let { email } = form;
  const human = form.human;
  email = email.trim().toLowerCase();
  if (!EMAIL.test(email)) return page(p, "error", "that isn't an email address.", 400);
  const proxied = await viaProxy(req);
  if (!proxied && !(await allowed(email))) return page(p, "error", `sign in at ${DOMAIN}, not this address.`, 403);
  if (geoBlocked(geoOf(req, proxied))) return page(p, "blocked", REFUSAL, 451);
  const client = await clientKey(req);
  // R54: Turnstile says a person sent it. With no secret set, the door stays shut rather than open to bots.
  const check = await turnstile(human, client);
  if (check === null) return page(p, "error", "sign-up isn't ready yet. Try again later.", 503);
  if (!check) return page(p, "error", "Clyde couldn't tell a person sent that. Reload the page and try again.", 400);
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

/** The email link or OAuth callback lands here. Sign the user in with the stored verifier and approve the client request. */
async function approve(p: Page, req: Request, id: string, code: string | null, error: string | null, direct = false) {
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
  const proxied = await viaProxy(req);
  if (direct && user?.email && !(await allowed(user.email)) && geoBlocked(geoOf(req, proxied))) {
    return page(p, "blocked", REFUSAL, 451);
  }
  return await finish(p, id, jwt, user, direct);
}

/** With a signed-in session: approve the app's request if its callback is one Clyde approves, else deny and log it.
 * Direct browser sign-ins (password or social OAuth) bounce through same-origin /oauth/wait (303) to respect form-action 'self'. */
async function finish(p: Page, id: string, jwt: string, user: Record<string, any>, direct: boolean): Promise<Response> {
  if (!(user?.email && user.email_confirmed_at && (await openSignup() || await allowed(user.email)))) {
    return page(p, "error", "that account isn't on Clyde's allowlist.", 403);
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
      if (!direct) await sql`update memory.oauth_consent set redirect_url = ${redirect!} where authorization_id = ${id}`;
      return page(p, "refused", `refused ${name}. Its callback, ${target}, isn't one Clyde approves (Claude, ChatGPT, OpenAI, Antigravity, Grok, the Gemini app, or localhost).`, 403,
        { client: name, callback: target });
    }
  }
  if (direct && p.json) {
    await sql`insert into memory.oauth_consent (authorization_id, code_verifier, redirect_url, client_name)
      values (${id}, '', ${redirect!}, ${name})
      on conflict (authorization_id) do update
      set redirect_url = excluded.redirect_url, client_name = excluded.client_name, created_at = now()`;
    return new Response(null, {
      status: 303,
      headers: { location: `/oauth/wait?authorization_id=${encodeURIComponent(id)}`, "cache-control": "no-store" },
    });
  }
  if (direct) {
    await sql`delete from memory.oauth_consent where authorization_id = ${id}`;
    return new Response(null, { status: 302, headers: { location: redirect!, "cache-control": "no-store" } });
  }
  await sql`update memory.oauth_consent set redirect_url = ${redirect!}, client_name = ${name} where authorization_id = ${id}`;
  const full = await freeTierFull(user);
  return page(p, "connected", `connected ${name}. Go back to the window that asked. It finishes by itself.${full ? ` ${full.line}` : ""}`, 200,
    { client: name, ...(full ? { free_full: true, checkout_url: full.url } : {}) });
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
  await sql`insert into memory.oauth_consent (authorization_id, code_verifier) values (${id}, ${verifier})
    on conflict (authorization_id) do update set code_verifier = excluded.code_verifier, redirect_url = null, created_at = now()`;
  const redirect = encodeURIComponent(`${base}/oauth/approve?authorization_id=${encodeURIComponent(id)}&direct=1`);
  const dest = `${AUTH()}/authorize?provider=${encodeURIComponent(provider)}&redirect_to=${redirect}&code_challenge=${challenge}&code_challenge_method=s256`;
  return new Response(null, { status: 302, headers: { location: dest, "cache-control": "no-store" } });
}

/** json: the request came through the Worker (x-memory-proxy) and asked for application/json. */
export async function handle(req: Request, base: string, path: string, url: URL, json = false): Promise<Response> {
  const p: Page = { json };
  const id = url.searchParams.get("authorization_id") ?? "";
  if (!ID.test(id)) return page(p, "error", "that link is missing its authorization_id. Start connecting again from the app.", 400);
  await sql`delete from memory.oauth_consent where created_at < now() - interval '1 day'`;
  if (path === "/oauth/provider" && req.method === "GET") {
    return startProvider(p, req, base, id, url.searchParams.get("provider") ?? "");
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
  if (path === "/oauth/approve") return approve(p, req, id, url.searchParams.get("code"), url.searchParams.get("error_description"), url.searchParams.get("direct") === "1");
  if (path === "/oauth/wait") return wait(p, base, id);
  return json ? page(p, "error", "no such endpoint.", 404) : text("No such endpoint.", 404);
}
