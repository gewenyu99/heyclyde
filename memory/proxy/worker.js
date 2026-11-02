// memory.heyclyde.me: memory's own address. It passes every request through to the Supabase function, so connectors and
// installs keep one URL however memory is hosted later. The shared secret tells the function the request came through
// here, so it trusts the caller's address for lockouts and answers with this domain in its URLs.
const ORIGIN = "https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.set("x-memory-proxy", env.PROXY_SECRET);
    headers.delete("x-memory-client");
    const ip = req.headers.get("cf-connecting-ip");
    if (ip) headers.set("x-memory-client", ip);
    const hasBody = !["GET", "HEAD"].includes(req.method);
    return fetch(ORIGIN + (url.pathname === "/" ? "" : url.pathname) + url.search, {
      method: req.method, headers, body: hasBody ? req.body : undefined, redirect: "manual",
    });
  },
};
