// The pages the Worker serves at memory.heyclyde.me (R46): the sign-in states the function reports as JSON, and the
// "connect your apps" page at /. They wear Clyde's design system (R68): memory/design/tokens.css and components.css,
// inlined from memory/design/css.js because the CSP allows only this response's nonce'd styles. System fonts, no script
// or style from anywhere else.
import { COMPONENTS_CSS, TOKENS_CSS } from "../design/css.js";

export const MCP_URL = "https://memory.heyclyde.me/mcp";
export const INSTALL = "curl -fsSL https://memory.heyclyde.me/install | sh";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

// Clyde's mark, per memory/design/BRAND.md: a #262825 rounded square (29% corners) with a lowercase c at 62%.
const WORDMARK = `<a class="cl-wordmark" href="/"><span class="cl-mark" aria-hidden="true">c</span>clyde</a>`;
const FAVICON = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9.3" fill="#262825"/>` +
  `<text x="16" y="22.5" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="19.8" font-weight="600" fill="#fff">c</text></svg>`);

// Page frame shared by every page: a bar, the main column and a footer, on paper-0.
const PAGE_CSS = `
body{margin:0;min-height:100vh;display:flex;flex-direction:column}
a{color:var(--cl-carbon)}
:focus-visible{outline:2px solid var(--cl-carbon);outline-offset:2px}
.wrap{width:100%;max-width:var(--cl-page-max);margin:0 auto;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-block:20px}
.bar.center{justify-content:center}
.cl-status .v{text-transform:none;letter-spacing:0}
.foot{margin-top:auto;padding-block:28px}
.foot .wrap{display:flex;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;border-top:1px dashed var(--cl-rule-strong);padding-top:16px;font:var(--cl-text-mono);font-size:11.5px;color:var(--cl-ink-3)}
.foot a{color:var(--cl-ink-3)}
code{font-family:var(--cl-font-mono);font-size:.9em}
`;

// The sign-in ticket: a sheet with a printed head, then the state's stamp or badge, the headline and what to do.
const SIGN_CSS = `
main.sign{flex:1;display:flex;align-items:center;justify-content:center;padding:8px max(16px,env(safe-area-inset-left,0px)) 40px}
.ticket{width:100%;max-width:460px;overflow:hidden}
.ticket-head{display:flex;justify-content:space-between;gap:12px;padding:12px 20px;border-bottom:1.5px dashed var(--cl-rule-strong);background:var(--cl-paper-1)}
.ticket-body{display:grid;gap:14px;padding:28px 28px 30px}
@media (max-width:480px){.ticket-body{padding:24px 20px 26px}}
.ticket h1{margin:4px 0 0}
.ticket .cl-lead strong{color:var(--cl-ink);font-weight:600;overflow-wrap:anywhere}
.badge{width:46px;height:46px;display:grid;place-items:center;border:1px solid var(--cl-rule-strong);border-radius:var(--cl-radius-md);background:var(--cl-paper-1);color:var(--cl-ink-2);box-shadow:var(--cl-copy-1)}
.badge svg{width:22px;height:22px}
.ticket .cl-stamp{justify-self:start;font-size:14px;padding:7px 12px 6px;margin:4px 0 4px 2px}
.ticket .cl-well{overflow-wrap:anywhere}
.ticket .cl-well code{color:var(--cl-ink)}
.live{display:flex;align-items:center;gap:10px;font:var(--cl-text-small);color:var(--cl-ink-3)}
.dots{display:inline-flex;gap:4px}.dots i{width:6px;height:6px;border-radius:1px;background:var(--cl-carbon);animation:cl-dot 1.2s infinite ease-in-out}
.dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}
@keyframes cl-dot{0%,80%,100%{opacity:.25}40%{opacity:1}}
@media (prefers-reduced-motion:reduce){.dots i{animation:none;opacity:.7}}
form.ask{display:grid;gap:14px;margin-top:4px}
`;

// Connect your apps: the hero with Clyde's own picture (one memory and the copies every app gets), then a card per app.
const HOME_CSS = `
.hero{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:48px;align-items:center;padding-block:36px 56px}
@media (max-width:860px){.hero{grid-template-columns:minmax(0,1fr);gap:40px;padding-block:16px 40px}}
.hero-text{display:grid;gap:18px;min-width:0}
.hero .cl-display{margin:2px 0 0}
.hero .cl-copy{box-shadow:var(--cl-copy-2);border-color:var(--cl-ink-3);padding:8px 8px 8px 14px}
.hero .cl-copy code{font-size:14.5px}
@media (max-width:480px){.hero .cl-copy code{font-size:12.5px}.pile{margin:0 40px 40px 0}}
.stack{margin:0;min-width:0}
.pile{position:relative;margin:0 48px 48px 0}
.stack .cl-memory{position:relative;z-index:4;box-shadow:var(--cl-shadow-2);border-color:var(--cl-rule-strong)}
.c1{--i:1}.c2{--i:2}.c3{--i:3}
.sheet-copy{position:absolute;inset:0;border:1px dashed var(--cl-carbon);border-radius:var(--cl-radius-lg);background:var(--cl-carbon-wash);
transform:translate(calc(var(--i) * 16px),calc(var(--i) * 16px));z-index:calc(4 - var(--i))}
.sheet-copy span{position:absolute;right:12px;bottom:0;height:16px;font:var(--cl-text-label);line-height:16px;letter-spacing:.06em;text-transform:uppercase;color:var(--cl-carbon-ink);white-space:nowrap}
@media (prefers-reduced-motion:no-preference){.sheet-copy{animation:fan var(--cl-dur-4) var(--cl-ease-out) calc(var(--i) * 90ms) both}}
@keyframes fan{from{transform:translate(calc(var(--i) * 6px),calc(var(--i) * 6px))}}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font:var(--cl-text-mono);font-size:11.5px;color:var(--cl-ink-3)}
.legend b{color:var(--cl-carbon-ink);font-weight:600}
.section{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 0 14px;padding-top:18px;border-top:1px solid var(--cl-rule)}
.section h2{margin:0}
.apps{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-bottom:56px}
@media (max-width:760px){.apps{grid-template-columns:minmax(0,1fr)}}
.app{display:flex;flex-direction:column;gap:14px;padding:20px}
.app-head{display:flex;align-items:center;gap:12px;min-width:0}
.glyph{width:36px;height:36px;flex:none;display:grid;place-items:center;border:1.5px solid var(--cl-ink);border-radius:var(--cl-radius-sm);font:700 13px/1 var(--cl-font-mono);color:var(--cl-ink);background:var(--cl-paper-1)}
.app-head > div{min-width:0}
.app h3{margin:0}
.app .sub{margin:2px 0 0;font:var(--cl-text-small);color:var(--cl-ink-3)}
.app-head .cl-chip{margin-left:auto}
.app .fine{margin:0;font:var(--cl-text-small);color:var(--cl-ink-2)}
.app .fine code{color:var(--cl-ink);overflow-wrap:anywhere}
ol.steps{margin:0;padding:0;list-style:none;counter-reset:s;display:grid;gap:9px;font:var(--cl-text-body);color:var(--cl-ink-2)}
ol.steps li{counter-increment:s;display:grid;grid-template-columns:22px minmax(0,1fr);gap:8px;align-items:baseline}
ol.steps li::before{content:counter(s);font:700 11px/1 var(--cl-font-mono);color:var(--cl-ink-3)}
.k{font-weight:600;color:var(--cl-ink)}
.how{list-style:none;margin:0 0 24px;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--cl-rule-strong);border-radius:var(--cl-radius-lg);background:var(--cl-paper-1);overflow:hidden}
@media (max-width:760px){.how{grid-template-columns:minmax(0,1fr)}}
.how li{display:grid;gap:6px;align-content:start;padding:18px 20px;border-left:1.5px dashed var(--cl-rule-strong)}
.how li:first-child{border-left:0}
@media (max-width:760px){.how li{border-left:0;border-top:1.5px dashed var(--cl-rule-strong)}.how li:first-child{border-top:0}}
.how b{font:var(--cl-text-title-3)}
.how p{margin:0;font:var(--cl-text-small);color:var(--cl-ink-2)}
`;

const COPY_JS = `document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){
var t=b.getAttribute('data-copy');function ok(){b.textContent='Copied';b.classList.add('is-done');setTimeout(function(){b.textContent='Copy';b.classList.remove('is-done')},1600)}
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,function(){})}else{var a=document.createElement('textarea');
a.value=t;document.body.appendChild(a);a.select();try{document.execCommand('copy');ok()}catch(e){}a.remove()}})});`;

const STATUS_JS = `(function(){var p=document.getElementById('status');if(!p)return;
fetch('/healthz',{cache:'no-store'}).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(d){
p.className='cl-status is-ok';p.textContent='Online';if(d&&d.version){var v=document.createElement('span');v.className='v';
v.textContent='v'+d.version;p.appendChild(document.createTextNode(' \\u00b7 '));p.appendChild(v)}}).catch(function(){p.className='cl-status is-bad';p.textContent='Offline'})})();`;

function shell({ nonce, title, css, body, script = "" }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex">
<link rel="icon" href="${FAVICON}"><style nonce="${nonce}">${TOKENS_CSS}${COMPONENTS_CSS}${PAGE_CSS}${css}</style></head><body class="cl-root">${body}${
    script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
}

const copyBox = (value, label = "Copy") =>
  `<div class="cl-copy"><code>${esc(value)}</code><button class="cl-btn cl-btn--sm" type="button" data-copy="${esc(value)}" aria-label="${esc(label)}">Copy</button></div>`;
const copyPre = (name, value) =>
  `<div class="cl-file"><div class="cl-file__head"><span>${esc(name)}</span><button class="cl-btn cl-btn--sm" type="button" data-copy="${esc(value)}">Copy</button></div>` +
  `<pre><code>${esc(value)}</code></pre></div>`;
const footer = `<footer class="foot"><div class="wrap"><span>clyde · one memory for every agent</span><a href="/healthz">Status JSON</a></div></footer>`;

// ---- Sign-in states ----

// Lucide-style line icons: 24 grid, 1.5 stroke, round caps (BRAND.md, Iconography).
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  mail: svg(`<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>`),
  wait: svg(`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`),
};

const live = (text) => `<div class="live" role="status"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>${text}</div>`;
const stamp = (tone, word, when) => `<span class="cl-stamp cl-stamp--${tone} is-new">${word} <small>${when}</small></span>`;
const note = (html) => `<p class="cl-well">${html}</p>`;

/** "memory: that sign-in link didn't work." → "That sign-in link didn't work." */
function sentence(message) {
  const s = String(message ?? "").replace(/^memory:\s*/, "").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "Start connecting again from the app.";
}

/** "15 Nov 2026", the date a clerk stamps. */
const today = () => new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** The page for one state the function reported. id is the request's authorization_id, already checked against the
 * function's pattern: the email form posts back to it, never to a URL from the JSON. */
export function statePage(data, nonce, id = "") {
  const state = data?.state;
  const app = (fallback = "the app") => data?.client ? `<strong>${esc(data.client)}</strong>` : fallback;
  const date = today();
  // mark: a pending state shows a badge; an outcome is stamped with the day it happened.
  let mark, h1, lead, extra = "", title, kind = "Sign-in";
  switch (state) {
    case "check_email":
      mark = `<div class="badge">${ICON.mail}</div>`; h1 = "Check your email"; title = "Check your email";
      lead = `We sent a sign-in link to ${data.email ? `<strong>${esc(data.email)}</strong>` : "the owner's inbox"}. Open it on any device, phone included.`;
      extra = live("This window moves on once you click it");
      break;
    case "waiting":
      mark = `<div class="badge">${ICON.wait}</div>`; h1 = "Waiting for you"; title = "Waiting for you";
      lead = "Click the sign-in link in your email, on this device or any other.";
      extra = live("Checking every few seconds");
      break;
    case "connected":
      mark = stamp("ok", "Approved", date); h1 = "Connected"; title = "Connected";
      lead = `${app()} can now recall and remember with Clyde.`;
      extra = note("Go back to the window that asked. It finishes by itself, and you can close this tab.");
      break;
    case "refused":
      mark = stamp("bad", "Refused", date); h1 = "Refused"; title = "Refused";
      lead = `${app("This app")} wasn't connected. Nothing was shared.`;
      extra = note(`Its callback${data?.callback ? `, <code>${esc(data.callback)}</code>,` : ""} isn't one of the agent apps Clyde knows, or this computer. The attempt is logged.`);
      break;
    case "ask_email":
      mark = `<div class="badge">${ICON.mail}</div>`; h1 = "Sign in to Clyde"; title = "Sign in";
      lead = "Enter your email and we'll send you a sign-in link. No password needed.";
      extra = `<form class="ask" method="post" action="/oauth/consent?authorization_id=${esc(encodeURIComponent(id))}">
<div class="cl-field"><label for="email">Email</label><input class="cl-input" id="email" type="email" name="email" autocomplete="email" required autofocus placeholder="you@example.com"></div>
<button class="cl-btn cl-btn--primary cl-btn--lg cl-btn--block" type="submit">Email me a link</button></form>`;
      break;
    case "blocked":
      mark = stamp("bad", "Not available", date); h1 = "Not available in your country"; title = "Not available";
      lead = esc(sentence(data?.message));
      extra = note("Nothing was saved and no email was sent.");
      break;
    case "subscribed":
      kind = "Subscription";
      mark = stamp("ok", "Paid", date); h1 = "You're subscribed"; title = "Subscribed";
      lead = "Your Clyde subscription starts within a minute.";
      extra = note("Go back to your app and carry on. You can close this tab.");
      break;
    case "expired":
      mark = stamp("warn", "Expired", date); h1 = "Link expired"; title = "Link expired";
      lead = "Sign-in links last 15 minutes and work once. Start connecting again from the app.";
      break;
    default:
      mark = stamp("bad", "Stopped", date); h1 = "Something went wrong"; title = "Something went wrong";
      lead = esc(sentence(data?.message));
  }
  const body = `<header class="bar center wrap">${WORDMARK}</header>
<main class="sign"><section class="cl-sheet ticket"><div class="ticket-head"><span class="cl-label">${kind}</span><span class="cl-label">memory.heyclyde.me</span></div>
<div class="ticket-body">${mark}<h1 class="cl-title-1">${h1}</h1><p class="cl-lead">${lead}</p>${extra}</div></section></main>${footer}`;
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
    id: "antigravity", name: "Antigravity", sub: "Desktop IDE and CLI", tag: "Config file", glyph: "Ag",
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
    id: "antigravity-cloud", name: "Antigravity cloud", sub: "Agents that can't open a browser", tag: "HTTPS token", glyph: "Ag",
    body: `<p class="fine">Cloud agents can't do the email sign-in, so they send a device token over HTTPS. Copy it from <code>~/.config/memory/token</code> on any computer the installer set up, and keep it in the agent's secrets, never in a repo.</p>
${copyPre("mcp_config.json", JSON.stringify({ mcpServers: { memory: { serverUrl: MCP_URL, headers: { Authorization: "Bearer <your device token>" } } } }, null, 2))}`,
  },
];

// The hero's picture: one memory atlas filed, and the carbon copy each app's agent gets.
const STACK = `<figure class="stack" aria-label="One memory, copied to every app"><div class="pile">
<div class="sheet-copy c3"><span>gemini</span></div><div class="sheet-copy c2"><span>codex</span></div>
<div class="sheet-copy c1"><span>claude.ai</span></div>
<article class="cl-card cl-memory"><div class="cl-memory__top"><span class="cl-chip">Decision</span><span class="cl-state cl-state--settled">Settled</span><span class="cl-memory__conf">93%</span></div>
<h3 class="cl-memory__title">Deploys go through deploy.sh, never the dashboard</h3>
<p class="cl-memory__body">A dashboard deploy skips the migration check and once left the function on old code.</p>
<div class="cl-prov"><span class="cl-prov__who">atlas</span><span>Claude Code</span><span class="cl-prov__sep">/</span><span>mbp-work</span><span class="cl-prov__sep">/</span><span>3 weeks ago</span></div>
<div class="cl-memory__foot"><span>recalled 41×</span><span>by codex today</span></div></article></div>
<figcaption class="legend"><span><b>atlas</b> filed it in Claude Code.</span><span>Codex recalled it today.</span></figcaption></figure>`;

export function homePage(nonce) {
  const cards = APPS.map((a) => `<article class="cl-card app" data-app="${a.id}"><div class="app-head"><span class="glyph" aria-hidden="true">${a.glyph}</span>
<div><h3 class="cl-title-3">${esc(a.name)}</h3><p class="sub">${esc(a.sub)}</p></div><span class="cl-chip">${esc(a.tag)}</span></div>${a.body}</article>`).join("\n");
  const body = `<header class="bar wrap">${WORDMARK}<span class="cl-status" id="status" role="status">Checking</span></header>
<main class="wrap">
<section class="hero"><div class="hero-text"><span class="cl-label">One memory for every agent</span><h1 class="cl-display">Connect your apps</h1>
<p class="cl-lead">Point each app at one URL and approve the sign-in email. What one agent learns, every other agent can recall, whichever app it runs in.</p>
<div class="cl-field"><span class="cl-field__label">Server URL</span>${copyBox(MCP_URL)}</div></div>${STACK}</section>
<div class="section"><h2 class="cl-label">Pick your app</h2><span class="cl-label">6 ways in</span></div>
<section class="apps">${cards}</section>
<div class="section"><h2 class="cl-label">How sign-in works</h2></div>
<ol class="how">
<li><span class="cl-label">Step 1</span><b>Add the URL</b><p>Each app registers itself through OAuth. There's no password and no key to paste.</p></li>
<li><span class="cl-label">Step 2</span><b>Click the email link</b><p>Clyde emails you a sign-in link. Open it on any device, and the app's window moves on by itself.</p></li>
<li><span class="cl-label">Step 3</span><b>Clyde checks the app</b><p>Only Claude, Antigravity, Gemini, Grok and your own computer get in. Anything else is refused and logged.</p></li>
</ol></main>${footer}`;
  return shell({ nonce, title: "Connect your apps · Clyde", css: HOME_CSS, body, script: COPY_JS + STATUS_JS });
}
