// The pages the Worker serves at memory.heyclyde.me (R46): the sign-in states the function reports as JSON, and the
// "connect your apps" page at /. Everything is inline: system fonts, no script or style from anywhere else, and each
// script and style tag carries the response's CSP nonce.
export const MCP_URL = "https://memory.heyclyde.me/mcp";
export const INSTALL = "curl -fsSL https://memory.heyclyde.me/install | sh";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

// Clyde's mark, per memory/CLYDE-DESIGN.md's icon brief: a #262825 rounded square (29% corners) with a lowercase c at 62%.
const MARK = `<span class="mark" aria-hidden="true">c</span>`;
const FAVICON = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9.3" fill="#262825"/>` +
  `<text x="16" y="22.5" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="19.8" font-weight="600" fill="#fff">c</text></svg>`);

const CSS = `
:root{color-scheme:light dark;--bg:#f4f4f1;--bg-2:#eef0ec;--surface:#fff;--border:#e4e5e0;--text:#20211f;--muted:#777a75;
--accent:#2f5fd0;--accent-soft:#eaf1ff;--on-accent:#fff;--ok:#1f8a45;--ok-soft:#e8f6ec;--bad:#b91c1c;--bad-soft:#fde8e8;
--warn:#c86a12;--warn-soft:#fff1e2;--code:#f8f9f6;--brand:#262825;--on-brand:#fff;--shadow:0 1px 2px #1c1c1a08,0 8px 24px -14px #1c1c1a24}
@media (prefers-color-scheme:dark){:root{--bg:#171816;--bg-2:#2a2c28;--surface:#1f201e;--border:#30322e;--text:#ecece6;
--muted:#9a9d96;--accent:#7ea0f0;--accent-soft:#1f2b47;--on-accent:#11141c;--ok:#5cc486;--ok-soft:#173222;--bad:#f08a8a;
--bad-soft:#3d1c1c;--warn:#e39a52;--warn-soft:#3a2714;--code:#191a18;--brand:#ecece6;--on-brand:#1f201e;--shadow:0 1px 2px #0000004d,0 12px 32px -16px #00000099}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Roboto,
"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;min-height:100vh;display:flex;flex-direction:column}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:.86em}
.wrap{width:100%;max-width:1040px;margin:0 auto;padding:0 16px}
header.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:20px;padding-bottom:20px}
.brand{display:flex;align-items:center;gap:10px;font-weight:680;font-size:17px;letter-spacing:-.3px;color:var(--text)}
.brand:hover{text-decoration:none}.mark{width:26px;height:26px;border-radius:7px;background:var(--brand);color:var(--on-brand);
display:grid;place-items:center;font-size:16px;font-weight:600;line-height:1;padding-bottom:2px}
.pill{display:inline-flex;align-items:center;gap:8px;padding:5px 12px 5px 10px;border:1px solid var(--border);
border-radius:999px;background:var(--surface);font-size:13px;color:var(--muted);white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
.pill.ok .dot{background:var(--ok);box-shadow:0 0 0 3px var(--ok-soft)}.pill.bad .dot{background:var(--bad);box-shadow:0 0 0 3px var(--bad-soft)}
.pill.ok b{color:var(--text);font-weight:600}
footer{margin-top:auto;padding:32px 0;color:var(--muted);font-size:13px}
footer .wrap{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;border-top:1px solid var(--border);padding-top:20px}
.btn{appearance:none;border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit;font-size:13px;
font-weight:550;padding:6px 12px;border-radius:8px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s}
.btn:hover{border-color:var(--accent)}.btn.done{color:var(--ok);border-color:var(--ok)}
.btn:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.copy{display:flex;align-items:center;gap:8px;background:var(--code);border:1px solid var(--border);border-radius:10px;padding:8px 8px 8px 14px}
.copy code{flex:1;min-width:0;overflow-wrap:anywhere;padding:4px 0}
.file{border:1px solid var(--border);border-radius:10px;background:var(--code);overflow:hidden}
.file-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px 6px 14px;border-bottom:1px solid var(--border);font-size:12px;color:var(--muted)}
.file pre{margin:0;padding:12px 14px;overflow-x:auto;line-height:1.55}
`;

const SIGN_CSS = `
main.sign{flex:1;display:flex;align-items:center;justify-content:center;padding:24px 16px 48px}
.card{width:100%;max-width:460px;background:var(--surface);border:1px solid var(--border);border-radius:18px;
box-shadow:var(--shadow);padding:36px 32px 30px;text-align:center}
@media (max-width:480px){.card{padding:30px 20px 24px;border-radius:16px}}
.badge{width:60px;height:60px;border-radius:50%;margin:0 auto 20px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent)}
.badge svg{width:28px;height:28px}
.ok .badge{background:var(--ok-soft);color:var(--ok)}.bad .badge{background:var(--bad-soft);color:var(--bad)}
.warn .badge{background:var(--warn-soft);color:var(--warn)}
h1{font-size:26px;line-height:1.2;letter-spacing:-.02em;margin:0 0 10px;font-weight:680}
.lead{margin:0 auto;color:var(--muted);max-width:36ch}.lead strong{color:var(--text);font-weight:600;overflow-wrap:anywhere}
.note{margin:22px 0 0;padding:12px 14px;border-radius:10px;background:var(--bg-2);color:var(--muted);font-size:14px;text-align:left;overflow-wrap:anywhere}
.note code{color:var(--text)}
.live{display:inline-flex;align-items:center;gap:10px;margin-top:24px;font-size:14px;color:var(--muted)}
.dots{display:inline-flex;gap:4px}.dots i{width:6px;height:6px;border-radius:50%;background:var(--accent);animation:b 1.2s infinite ease-in-out}
.dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}
@keyframes b{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
@media (prefers-reduced-motion:reduce){.dots i{animation:none;opacity:.7}}
.sign-top{justify-content:center}
`;

const HOME_CSS = `
.hero{padding:40px 0 36px;max-width:720px}
.eyebrow{display:inline-block;font-size:13px;font-weight:600;color:var(--accent);background:var(--accent-soft);padding:4px 10px;border-radius:999px;margin-bottom:18px}
.hero h1{font-size:clamp(34px,6vw,52px);line-height:1.05;letter-spacing:-.035em;margin:0 0 16px;font-weight:720}
.hero p{font-size:18px;color:var(--muted);margin:0 0 26px;max-width:58ch}
.hero .copy{max-width:560px;padding:10px 10px 10px 16px;background:var(--surface);box-shadow:var(--shadow)}
.hero .copy code{font-size:15px}
.hero .label{font-size:12px;margin:0 0 8px}
.label{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 8px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
@media (max-width:760px){.grid{grid-template-columns:minmax(0,1fr)}.hero{padding:20px 0 28px}.hero p{font-size:16px}}
.app{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:22px 22px 20px;display:flex;flex-direction:column;gap:14px;min-width:0}
.app header{display:flex;align-items:center;gap:12px}
.icon{width:38px;height:38px;border-radius:9px;display:grid;place-items:center;flex:none;font-weight:650;font-size:14px;background:var(--bg-2);color:var(--text);border:1px solid var(--border)}
.app h2{margin:0;font-size:17px;letter-spacing:-.01em;font-weight:650;line-height:1.25}
.app .sub{margin:2px 0 0;font-size:13px;color:var(--muted)}
.tag{margin-left:auto;font-size:12px;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:2px 9px;white-space:nowrap}
ol.steps{margin:0;padding:0;list-style:none;counter-reset:s;display:grid;gap:8px;font-size:15px}
ol.steps li{counter-increment:s;display:flex;gap:10px;align-items:baseline}
ol.steps li::before{content:counter(s);flex:none;width:20px;height:20px;border-radius:50%;background:var(--bg-2);color:var(--muted);
font-size:12px;font-weight:650;display:inline-grid;place-items:center;transform:translateY(-1px)}
.app .fine{font-size:13px;color:var(--muted);margin:0}
.k{font-weight:600;color:var(--text)}
.how{margin:56px 0 8px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
@media (max-width:760px){.how{grid-template-columns:minmax(0,1fr);margin-top:40px}h3.section{margin-top:28px}}
.how div{padding:4px 0}.how b{display:block;font-size:15px;margin-bottom:4px}.how p{margin:0;color:var(--muted);font-size:14px}
.how .n{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:8px;background:var(--accent-soft);color:var(--accent);font-weight:700;font-size:13px;margin-bottom:10px}
h3.section{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:48px 0 14px}
`;

const COPY_JS = `document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){
var t=b.getAttribute('data-copy');function ok(){b.textContent='Copied';b.classList.add('done');setTimeout(function(){b.textContent='Copy';b.classList.remove('done')},1600)}
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,function(){})}else{var a=document.createElement('textarea');
a.value=t;document.body.appendChild(a);a.select();try{document.execCommand('copy');ok()}catch(e){}a.remove()}})});`;

const STATUS_JS = `(function(){var p=document.getElementById('status');if(!p)return;var l=p.querySelector('span');
fetch('/healthz',{cache:'no-store'}).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(d){
p.className='pill ok';l.innerHTML='';var b=document.createElement('b');b.textContent='Online';l.appendChild(b);
if(d&&d.version)l.appendChild(document.createTextNode(' \\u00b7 v'+d.version))}).catch(function(){p.className='pill bad';l.textContent='Offline'})})();`;

function shell({ nonce, title, css, body, script = "" }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex">
<link rel="icon" href="${FAVICON}"><style nonce="${nonce}">${CSS}${css}</style></head><body>${body}${
    script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
}

const copyBox = (value, label = "Copy") =>
  `<div class="copy"><code>${esc(value)}</code><button class="btn" type="button" data-copy="${esc(value)}" aria-label="${esc(label)}">Copy</button></div>`;
const copyPre = (name, value) =>
  `<div class="file"><div class="file-head"><span class="mono">${esc(name)}</span><button class="btn" type="button" data-copy="${esc(value)}">Copy</button></div>` +
  `<pre><code>${esc(value)}</code></pre></div>`;

// ---- Sign-in states ----

const ICON = {
  mail: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/></svg>`,
  wait: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  ok: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`,
  no: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3Z"/><path d="m9.5 9.5 5 5m0-5-5 5"/></svg>`,
  late: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12M6 21h12M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9"/></svg>`,
  err: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 2.5 20h19L12 3.5Z"/><path d="M12 10v4.5M12 17.5v.01"/></svg>`,
};

const live = (text) => `<div class="live" role="status"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>${text}</div>`;

/** "memory: that sign-in link didn't work." → "That sign-in link didn't work." */
function sentence(message) {
  const s = String(message ?? "").replace(/^memory:\s*/, "").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "Start connecting again from the app.";
}

/** The page for one state the function reported. */
export function statePage(data, nonce) {
  const state = data?.state;
  const app = (fallback = "the app") => data?.client ? `<strong>${esc(data.client)}</strong>` : fallback;
  let tone = "", icon, h1, lead, extra = "", title;
  switch (state) {
    case "check_email":
      icon = ICON.mail; h1 = "Check your email"; title = "Check your email";
      lead = `We sent a sign-in link to ${data.email ? `<strong>${esc(data.email)}</strong>` : "the owner's inbox"}. Open it on any device, phone included.`;
      extra = live("This window moves on by itself once you click it");
      break;
    case "waiting":
      icon = ICON.wait; h1 = "Waiting for you"; title = "Waiting for you";
      lead = "Click the sign-in link in your email, on this device or any other.";
      extra = live("Checking every few seconds");
      break;
    case "connected":
      tone = "ok"; icon = ICON.ok; h1 = "Connected"; title = "Connected";
      lead = `${app()} can now recall and remember with Clyde.`;
      extra = `<p class="note">Go back to the window that asked. It finishes by itself, and you can close this tab.</p>`;
      break;
    case "refused":
      tone = "bad"; icon = ICON.no; h1 = "Refused"; title = "Refused";
      lead = `${app("This app")} wasn't connected. Nothing was shared.`;
      extra = `<p class="note">Its callback${data?.callback ? `, <code>${esc(data.callback)}</code>,` : ""} isn't one of the agent apps Clyde knows, or this computer. The attempt is logged.</p>`;
      break;
    case "expired":
      tone = "warn"; icon = ICON.late; h1 = "Link expired"; title = "Link expired";
      lead = "Sign-in links last 15 minutes and work once. Start connecting again from the app.";
      break;
    default:
      tone = "bad"; icon = ICON.err; h1 = "Something went wrong"; title = "Something went wrong";
      lead = esc(sentence(data?.message));
  }
  const body = `<header class="top sign-top wrap"><a class="brand" href="/">${MARK}clyde</a></header>
<main class="sign"><section class="card ${tone}"><div class="badge">${icon}</div><h1>${h1}</h1><p class="lead">${lead}</p>${extra}</section></main>`;
  return shell({ nonce, title: `${title} · Clyde`, css: SIGN_CSS, body });
}

// ---- Connect your apps ----

const APPS = [
  {
    id: "claude-ai", name: "Claude", sub: "claude.ai, Cowork and mobile", tag: "Connector", glyph: "C",
    body: `<ol class="steps"><li><span>Open <span class="k">Settings → Connectors</span> and choose <span class="k">Add custom connector</span>.</span></li>
<li><span>Paste the URL and click <span class="k">Add</span>, then <span class="k">Connect</span>.</span></li>
<li><span>Open the sign-in link Clyde emails you. The connector syncs to Cowork and the mobile apps.</span></li></ol>${copyBox(MCP_URL)}`,
  },
  {
    id: "claude-code", name: "Claude Code and Codex", sub: "Terminal agents on your computer", tag: "Installer", glyph: "&gt;_",
    body: `<p class="fine">Run this in a terminal. It signs in by email, adds the MCP server and hooks to both, and keeps them up to date.</p>${copyBox(INSTALL)}`,
  },
  {
    id: "antigravity", name: "Antigravity", sub: "Desktop IDE and CLI", tag: "Config file", glyph: "A",
    body: `<p class="fine">The installer adds this for you. To do it by hand, merge it into <code>~/.gemini/config/mcp_config.json</code>, then sign in when Antigravity opens the browser.</p>
${copyPre("mcp_config.json", JSON.stringify({ mcpServers: { memory: { serverUrl: MCP_URL } } }, null, 2))}`,
  },
  {
    id: "gemini", name: "Gemini app", sub: "gemini.google.com", tag: "Custom app", glyph: "G",
    body: `<ol class="steps"><li><span>Open <span class="k">Settings → Connected Apps</span>.</span></li>
<li><span>Add a <span class="k">custom app</span> with the URL.</span></li>
<li><span>Approve with the sign-in link Clyde emails you.</span></li></ol>${copyBox(MCP_URL)}
<p class="fine">Custom apps may need Google AI Ultra or a US account.</p>`,
  },
  {
    id: "grok", name: "Grok", sub: "grok.com", tag: "Connector", glyph: "X",
    body: `<ol class="steps"><li><span>Open <a href="https://grok.com/connectors" rel="noopener noreferrer" target="_blank">grok.com/connectors</a> and choose <span class="k">Custom</span>.</span></li>
<li><span>Paste the URL and connect.</span></li>
<li><span>Open the sign-in link Clyde emails you.</span></li></ol>${copyBox(MCP_URL)}`,
  },
  {
    id: "antigravity-cloud", name: "Antigravity cloud", sub: "Agents that can't open a browser", tag: "HTTPS token", glyph: "A",
    body: `<p class="fine">Cloud agents can't do the email sign-in, so they send a device token over HTTPS. Copy it from <code>~/.config/memory/token</code> on any computer the installer set up, and keep it in the agent's secrets, never in a repo.</p>
${copyPre("mcp_config.json", JSON.stringify({ mcpServers: { memory: { serverUrl: MCP_URL, headers: { Authorization: "Bearer <your device token>" } } } }, null, 2))}`,
  },
];

export function homePage(nonce) {
  const cards = APPS.map((a) => `<article class="app" data-app="${a.id}"><header><span class="icon" aria-hidden="true">${a.glyph}</span>
<div><h2>${esc(a.name)}</h2><p class="sub">${esc(a.sub)}</p></div><span class="tag">${esc(a.tag)}</span></header>${a.body}</article>`).join("\n");
  const body = `<header class="top wrap"><a class="brand" href="/">${MARK}clyde</a>
<span class="pill" id="status" role="status"><i class="dot"></i><span>Checking…</span></span></header>
<main class="wrap">
<section class="hero"><span class="eyebrow">Clyde</span><h1>Connect your apps</h1>
<p>One shared memory for every agent you use. Point an app at one URL, approve the sign-in email, and what one agent learns, the others can recall.</p>
<p class="label">Server URL</p>${copyBox(MCP_URL)}</section>
<h3 class="section">Pick your app</h3>
<section class="grid">${cards}</section>
<section class="how" aria-label="How sign-in works">
<div><span class="n">1</span><b>Add the URL</b><p>Each app registers itself through OAuth. There's no password and no key to paste.</p></div>
<div><span class="n">2</span><b>Click the email link</b><p>Clyde emails you a sign-in link. Open it on any device, and the app's window moves on by itself.</p></div>
<div><span class="n">3</span><b>Only known apps get in</b><p>Clyde approves Claude, Antigravity, Gemini, Grok and your own computer. Anything else is refused and logged.</p></div>
</section></main>
<footer><div class="wrap"><span>Clyde · heyclyde.me</span><a href="/healthz">Status JSON</a></div></footer>`;
  return shell({ nonce, title: "Connect your apps · Clyde", css: HOME_CSS, body, script: COPY_JS + STATUS_JS });
}
