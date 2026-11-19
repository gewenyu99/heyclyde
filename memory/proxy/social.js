// Google and GitHub sign-in for the heyclyde.me workspace (/memories and the other app pages). Supabase Auth runs the
// provider side. This is the browser's side of its PKCE flow:
//
//   begin   makes a code_verifier, its S256 challenge and a state, keeps them in this tab's sessionStorage for 10 minutes,
//           and sends the tab to /auth/v1/authorize, which the Worker passes to Supabase Auth. redirect_to is
//           https://heyclyde.me/auth/callback?state=<state>.
//   finish  runs on /auth/callback. It reads and deletes the pending sign-in once, refuses a callback with no pending
//           sign-in, a stale one or a state that doesn't match, and only then trades the code and the verifier at
//           /auth/v1/token?grant_type=pkce for a session. A code without this tab's verifier signs nobody in.
//
// Both functions go into the page's script by their source (app.js), so each is self-contained, and the tests call
// them directly with a stand-in window. Nothing here reads a token from the URL fragment.

/** The sign-in client over a window: { begin(provider, next), finish(search) }. win needs sessionStorage, crypto,
 * location (origin and assign) and fetch. */
export function socialClient(win) {
  var KEY = "clyde_social_v1";
  var TTL_MS = 10 * 60 * 1000;
  var PROVIDERS = ["google", "github"];
  // Where the tab goes after sign-in: a workspace path on this origin, else /memories. Never another origin.
  var NEXT = /^\/(memories|graph|quests|agents|apps|usage|settings|entries)(\/[A-Za-z0-9._~%-]+)?(\?[^#\\\s]*)?$/;

  function next(raw) {
    var s = String(raw == null ? "" : raw);
    return NEXT.test(s) && s.length <= 512 ? s : "/memories";
  }

  function b64url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function random(n) {
    return b64url(win.crypto.getRandomValues(new Uint8Array(n)));
  }

  async function challengeOf(verifier) {
    var digest = await win.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return b64url(new Uint8Array(digest));
  }

  function take() {
    var raw = null;
    try {
      raw = win.sessionStorage.getItem(KEY);
      win.sessionStorage.removeItem(KEY);
    } catch (e) {
      return null;
    }
    try {
      var p = raw ? JSON.parse(raw) : null;
      return p && typeof p.state === "string" && typeof p.verifier === "string" ? p : null;
    } catch (e) {
      return null;
    }
  }

  function fail(reason, message, pending) {
    return { ok: false, reason: reason, message: message, next: next(pending && pending.next) };
  }

  async function begin(provider, nextPath) {
    if (PROVIDERS.indexOf(provider) < 0) throw new Error("That sign-in provider isn't supported.");
    var verifier = random(32), state = random(16);
    var challenge = await challengeOf(verifier);
    win.sessionStorage.setItem(KEY, JSON.stringify({ state: state, verifier: verifier, provider: provider, next: next(nextPath), at: Date.now() }));
    var redirect = win.location.origin + "/auth/callback?state=" + encodeURIComponent(state);
    var url = "/auth/v1/authorize?provider=" + encodeURIComponent(provider) + "&redirect_to=" + encodeURIComponent(redirect) +
      "&code_challenge=" + encodeURIComponent(challenge) + "&code_challenge_method=s256";
    win.location.assign(url);
    return url;
  }

  async function finish(search) {
    var q = new URLSearchParams(search || "");
    var pending = take();
    var error = q.get("error"), code = q.get("code"), state = q.get("state");
    if (error) {
      var why = q.get("error_description") || error;
      var denied = error === "access_denied";
      return fail(denied ? "denied" : "provider", denied
        ? "Sign-in was cancelled at the provider. Nothing changed. Try again or use your email."
        : "The provider couldn't sign you in (" + String(why).slice(0, 200) + "). Try again or use your email.", pending);
    }
    if (!pending) return fail("missing", "This sign-in didn't start in this tab, so Clyde ignored it. Start again below.", null);
    if (!(Date.now() - Number(pending.at) < TTL_MS)) return fail("expired", "That sign-in took longer than 10 minutes and expired. Start again below.", pending);
    if (!state || state !== pending.state) return fail("state", "That sign-in didn't match the one this tab started, so Clyde ignored it. Start again below.", pending);
    if (!code) return fail("code", "The provider sent no sign-in code. Start again below.", pending);
    var r, d = {};
    try {
      r = await win.fetch("/auth/v1/token?grant_type=pkce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ auth_code: code, code_verifier: pending.verifier }),
      });
      d = await r.json().catch(function () { return {}; });
    } catch (e) {
      return fail("network", "Clyde couldn't reach its sign-in server. Check your connection and start again.", pending);
    }
    if (!r.ok || !d.access_token) {
      return fail("exchange", "That sign-in code didn't work or was already used. Start again below.", pending);
    }
    return { ok: true, session: d, next: next(pending.next), provider: pending.provider };
  }

  return { begin: begin, finish: finish, next: next };
}
