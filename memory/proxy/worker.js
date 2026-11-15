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
      "content-security-policy": `default-src 'none'; script-src 'nonce-${n}'; style-src 'nonce-${n}'; img-src data:; ` +
        "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
  return html((n) => statePage(data, n), res.status, headers);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const read = req.method === "GET" || req.method === "HEAD";
    if (read && url.pathname === "/" && !req.headers.has("authorization") && (req.headers.get("accept") ?? "").includes("text/html")) {
      return html(homePage, 200, { "cache-control": "public, max-age=300" });
    }
    if (read && SIGN_IN.has(url.pathname)) return signIn(req, url, env);
    return pass(req, url, env);
  },
};
