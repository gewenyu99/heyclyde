// memory.heyclyde.me: memory's own address. It passes every request through to the Supabase function, so connectors and
// installs keep one URL however memory is hosted later. The shared secret tells the function the request came through
// here, so it trusts the caller's address for lockouts and answers with this domain in its URLs.
//
// It also serves the web pages (R46). Supabase won't serve HTML from its own domain, so on the three sign-in routes the
// Worker asks the function for JSON and renders the page here. A browser asking for / gets the "connect your apps" page.
import { homePage, statePage } from "./pages.js";

const ORIGIN = "https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory";
const SIGN_IN = new Set(["/oauth/consent", "/oauth/wait", "/oauth/approve"]);
const ID = /^[A-Za-z0-9_-]{8,100}$/;

function pass(req, url, env, extra = {}) {
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.set("x-memory-proxy", env.PROXY_SECRET);
  headers.delete("x-memory-client");
  const ip = req.headers.get("cf-connecting-ip");
  if (ip) headers.set("x-memory-client", ip);
  // Where Cloudflare saw the caller, for the blocked-country checks (R38). A client's own cf-ipcountry or cf-region-code
  // never passes: both come from request.cf or not at all.
  headers.delete("cf-ipcountry");
  headers.delete("cf-region-code");
  if (req.cf?.country) headers.set("cf-ipcountry", req.cf.country);
  if (req.cf?.regionCode) headers.set("cf-region-code", req.cf.regionCode);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  const hasBody = !["GET", "HEAD"].includes(req.method);
  return fetch(ORIGIN + (url.pathname === "/" ? "" : url.pathname) + url.search, {
    method: req.method, headers, body: hasBody ? req.body : undefined, redirect: "manual",
  });
}

function nonce() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, "");
}

/** An HTML reply, locked down: scripts and styles only from this response, nothing framed, no referrer to leak a code. */
function html(render, status = 200, headers = {}) {
  const n = nonce();
  return new Response(render(n), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${n}'; style-src 'nonce-${n}'; img-src 'self' data:; font-src 'self'; ` +
        "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...headers,
    },
  });
}

async function signIn(req, url, env) {
  const res = await pass(req, url, env, { accept: "application/json" });
  if (!(res.headers.get("content-type") ?? "").startsWith("application/json")) return res;
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return new Response(raw, res);
  }
  const id = url.searchParams.get("authorization_id") ?? "";
  const advances = (data.state === "check_email" || data.state === "waiting") && ID.test(id);
  const headers = { "cache-control": "no-store" };
  if (advances) headers.refresh = `3; url=/oauth/wait?authorization_id=${encodeURIComponent(id)}`;
  return html((n) => statePage(data, n, ID.test(id) ? id : ""), res.status, headers);
}

/** A browser asking for a page: it accepts HTML and sends no token. */
const wantsPage = (req) => !req.headers.has("authorization") && (req.headers.get("accept") ?? "").includes("text/html");

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const read = req.method === "GET" || req.method === "HEAD";
    if (read && url.pathname === "/" && wantsPage(req)) {
      return html(homePage, 200, { "cache-control": "public, max-age=300" });
    }
    if (read && SIGN_IN.has(url.pathname)) return signIn(req, url, env);
    // With open sign-up (R38), the consent page's email form posts back here, and the reply is a page too.
    if (req.method === "POST" && url.pathname === "/oauth/consent") return signIn(req, url, env);
    // Polar sends the buyer here after checkout (R38). The page says only what the function's text does.
    if (read && url.pathname === "/billing/thanks" && wantsPage(req)) return html((n) => statePage({ state: "subscribed" }, n));
    return pass(req, url, env);
  },
};
