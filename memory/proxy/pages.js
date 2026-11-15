// The pages the Worker serves at memory.heyclyde.me (R46): the sign-in states the function reports as JSON, and the
// "connect your apps" page at /. They wear Clyde's design system (R68): tokens.css, components.css and fonts.css,
// inlined from memory/design/css.js because the CSP allows only this response's nonce'd styles. Fonts, the logo and
// the apps' logos are static files the Worker serves from memory/proxy/public/_clyde.
import { COMPONENTS_CSS, FONTS_CSS, TOKENS_CSS } from "../design/css.js";

export const MCP_URL = "https://memory.heyclyde.me/mcp";
export const INSTALL = "curl -fsSL https://memory.heyclyde.me/install | sh";
export const DESIGN_URL = "https://claude.ai/artifact/2EHGVrGQfefmStu1TqikCb";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/** An image with a dark-mode twin: <picture> switches on the system theme (these pages have no theme toggle). */
export const themed = (light, dark, alt, w, h, cls = "") => `<picture${cls ? ` class="${cls}"` : ""}><source media="(prefers-color-scheme: dark)" srcset="${dark}">` +
  `<img src="${light}" alt="${alt}" width="${w}" height="${h}"></picture>`;
// Clyde's logo (memory/design/BRAND.md, Logo): the lockup is 324 x 86 units, the mark 64 x 64.
export const LOGO = (h = 30) => themed("/_clyde/brand/clyde-lockup-light.svg", "/_clyde/brand/clyde-lockup-dark.svg", "clyde", Math.round(h * 324 / 86), h);
export const MARK = (h = 20) => themed("/_clyde/brand/clyde-mark-light.svg", "/_clyde/brand/clyde-mark-dark.svg", "", h, h);
const WORDMARK = `<a class="logo" href="https://heyclyde.me/" aria-label="clyde home">${LOGO()}</a>`;

// Page frame shared by every page: a bar, the main column and a footer, on desk paper with a faint grain.
export const PAGE_CSS = `
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background-image:url(/_clyde/brand/grain.svg)}
a{color:var(--cl-carbon)}
:focus-visible{outline:2px solid var(--cl-carbon);outline-offset:2px}
img{max-width:100%}
.wrap{width:100%;max-width:var(--cl-page-max);margin:0 auto;padding-left:max(20px,env(safe-area-inset-left,0px));padding-right:max(20px,env(safe-area-inset-right,0px))}
.bar{display:flex;align-items:center;gap:24px;padding-block:22px}
.bar.center{justify-content:center}
.logo{display:inline-flex;line-height:0}
.logo img{height:30px;width:auto}
.topnav{display:flex;gap:22px;margin-left:auto;font:500 14px/1 var(--cl-font-sans)}
.topnav a{color:var(--cl-ink-2);text-decoration:none}
.topnav a:hover{color:var(--cl-ink)}
@media (max-width:640px){.topnav{display:none}.bar .cl-status{margin-left:auto}}
.cl-status .v{text-transform:none;letter-spacing:0}
.foot{margin-top:auto;padding-block:40px 32px}
.foot .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px 24px;flex-wrap:wrap;border-top:1px dashed var(--cl-rule-strong);padding-top:22px;font:var(--cl-text-mono);font-size:12px;color:var(--cl-ink-3)}
.foot .brand{display:flex;align-items:center;gap:10px}
.foot .brand img{height:20px;width:20px}
.foot nav{display:flex;gap:18px;flex-wrap:wrap}
.foot a{color:var(--cl-ink-2)}
.foot .legal{flex-basis:100%}
code{font-family:var(--cl-font-mono);font-size:.9em}
`;

// The sign-in ticket: a sheet with a printed head, then the state's stamp or badge, the headline and what to do.
const SIGN_CSS = `
main.sign{flex:1;display:flex;align-items:center;justify-content:center;padding:8px max(16px,env(safe-area-inset-left,0px)) 40px}
.ticket{width:100%;max-width:460px;overflow:hidden}
.ticket-head{display:flex;justify-content:space-between;gap:12px;padding:12px 20px;border-bottom:1.5px dashed var(--cl-rule-strong);background:var(--cl-paper-1)}
.ticket-body{display:grid;gap:14px;padding:28px 28px 30px;grid-template-columns:minmax(0,1fr)}
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

// Connect your apps: a hero that shows Clyde working inside two chat apps, a row of the apps it works with, a card
// per app, and three steps. Ruled paper behind the hero; the cards in the scene lift like the rest of the system.
export const HOME_CSS = `
.hero{position:relative;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.02fr);gap:56px;align-items:center;padding-block:40px 72px}
@media (max-width:960px){.hero{grid-template-columns:minmax(0,1fr);gap:44px;padding-block:20px 56px}}
.hero::before{content:"";position:absolute;inset:0 0 0 46%;z-index:-1;background:repeating-linear-gradient(to bottom,transparent 0 31px,var(--cl-rule) 31px 32px);-webkit-mask-image:radial-gradient(70% 70% at 60% 50%,#000,transparent);mask-image:radial-gradient(70% 70% at 60% 50%,#000,transparent)}
@media (max-width:960px){.hero::before{inset:auto 0 0;height:60%}}
.hero-text{display:grid;gap:22px;min-width:0}
.hero h1{margin:0;max-width:11ch}
.hero h1 em{font-style:normal;color:var(--cl-carbon)}
.hero .cl-lead{max-width:46ch}
.cta{display:flex;flex-wrap:wrap;gap:12px}
.works{display:grid;gap:10px;margin-top:8px}
.works ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}
.works li{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 13px;border:1px solid var(--cl-rule);border-radius:var(--cl-radius-pill);background:var(--cl-paper-1);font:500 13px/1 var(--cl-font-sans);color:var(--cl-ink-2)}
.works li img,.app-logo img{display:block;width:20px;height:20px;object-fit:contain}
.works li small{font:var(--cl-text-label);letter-spacing:.06em;text-transform:uppercase;color:var(--cl-ink-3)}
.scene{position:relative;min-width:0;padding:0 0 104px}
.win{border:1px solid var(--cl-rule-strong);border-radius:var(--cl-radius-xl);background:var(--cl-paper-1);box-shadow:var(--cl-shadow-2);overflow:hidden}
.win-top{display:flex;align-items:center;gap:8px;height:40px;padding:0 14px;border-bottom:1px solid var(--cl-rule);font:500 13px/1 var(--cl-font-sans);color:var(--cl-ink)}
.win-top img{width:18px;height:18px}
.win-top span{margin-left:auto;font:var(--cl-text-label);letter-spacing:.06em;text-transform:uppercase;color:var(--cl-ink-3)}
.w1 .body{display:grid;gap:12px;padding:16px;background:var(--cl-paper-0)}
.ask{justify-self:end;max-width:78%;padding:9px 13px;border-radius:14px 14px 4px 14px;background:var(--cl-ink);color:var(--cl-on-ink);font:var(--cl-text-small)}
.say{font:var(--cl-text-small);color:var(--cl-ink-2);margin:0}
.w1 .cl-memory{box-shadow:var(--cl-copy-2);border-color:var(--cl-carbon)}
.via{display:flex;align-items:center;gap:6px;font:var(--cl-text-label);letter-spacing:.06em;text-transform:uppercase;color:var(--cl-ink-3)}
.via img{width:14px;height:14px}
.w2{position:absolute;right:-12px;bottom:0;width:min(74%,360px);transform:rotate(1.2deg)}
.w2 pre{margin:0;padding:12px 14px;font:400 12px/1.65 var(--cl-font-mono);color:var(--cl-ink-2);background:var(--cl-paper-1);white-space:pre-wrap}
.w2 b{color:var(--cl-ink);font-weight:600}.w2 i{font-style:normal;color:var(--cl-carbon)}
.pin{position:absolute;left:-14px;bottom:-6px;transform:rotate(-4deg);background:var(--cl-paper-1)}
@media (max-width:960px){.scene{padding:0}.w2{position:relative;right:auto;width:auto;margin:-20px 0 0 28px}.pin{position:relative;left:0;bottom:0;margin-top:16px}}
.section{display:grid;gap:12px;margin:0 0 26px;max-width:720px}
.section h2{margin:0}
.apps-head{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,420px);gap:24px;align-items:end;margin-bottom:24px}
@media (max-width:860px){.apps-head{grid-template-columns:minmax(0,1fr)}}
.apps-head .section{margin:0}
.apps-head .cl-copy{box-shadow:var(--cl-copy-2);border-color:var(--cl-ink-3);padding:8px 8px 8px 14px}
.apps{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-bottom:72px}
@media (max-width:760px){.apps{grid-template-columns:minmax(0,1fr)}}
.app{display:flex;flex-direction:column;gap:14px;padding:20px}
.app-head{display:flex;align-items:center;gap:12px;min-width:0}
.app-logo{width:40px;height:40px;flex:none;display:grid;place-items:center;border:1px solid var(--cl-rule);border-radius:var(--cl-radius-md);background:var(--cl-paper-1)}
.app-logo img{width:24px;height:24px}
.mono-tile{font:700 13px/1 var(--cl-font-mono);color:var(--cl-ink-2)}
.win-top .dots{display:inline-flex;gap:5px;margin-right:4px}.win-top .dots::before,.win-top .dots::after{content:"";width:9px;height:9px;border-radius:50%;border:1px solid var(--cl-rule-strong);background:var(--cl-paper-2)}
.app-head > div{min-width:0}
.app h3{margin:0}
.app .sub{margin:2px 0 0;font:var(--cl-text-small);color:var(--cl-ink-3)}
.app-head .cl-chip{margin-left:auto}
.app .fine{margin:0;font:var(--cl-text-small);color:var(--cl-ink-2)}
.app .fine code{color:var(--cl-ink);overflow-wrap:anywhere}
@media (max-width:480px){.app .cl-copy code{font-size:12px}}
ol.steps{margin:0;padding:0;list-style:none;counter-reset:s;display:grid;gap:9px;font:var(--cl-text-body);color:var(--cl-ink-2)}
ol.steps li{counter-increment:s;display:grid;grid-template-columns:22px minmax(0,1fr);gap:8px;align-items:baseline}
ol.steps li::before{content:counter(s);font:600 11px/1 var(--cl-font-mono);color:var(--cl-ink-3)}
.k{font-weight:600;color:var(--cl-ink)}
.how{list-style:none;margin:0 0 24px;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
@media (max-width:860px){.how{grid-template-columns:minmax(0,1fr)}}
.how li{display:grid;gap:10px;align-content:start;padding:22px;border:1px solid var(--cl-rule);border-radius:var(--cl-radius-lg);background:var(--cl-paper-1)}
.how .n{font:780 44px/1 var(--cl-font-display);letter-spacing:-.04em;color:var(--cl-carbon)}
.how b{font:var(--cl-text-title-3)}
.how p{margin:0;font:var(--cl-text-small);color:var(--cl-ink-2)}
`;

export const COPY_JS = `document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){
var t=b.getAttribute('data-copy');function ok(){b.textContent='Copied';b.classList.add('is-done');setTimeout(function(){b.textContent='Copy';b.classList.remove('is-done')},1600)}
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,function(){})}else{var a=document.createElement('textarea');
a.value=t;document.body.appendChild(a);a.select();try{document.execCommand('copy');ok()}catch(e){}a.remove()}})});`;

const STATUS_JS = `(function(){var p=document.getElementById('status');if(!p)return;
fetch('/healthz',{cache:'no-store'}).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(d){
p.className='cl-status is-ok';p.textContent='Online';if(d&&d.version){var v=document.createElement('span');v.className='v';
v.textContent='v'+d.version;p.appendChild(document.createTextNode(' \\u00b7 '));p.appendChild(v)}}).catch(function(){p.className='cl-status is-bad';p.textContent='Offline'})})();`;

export function shell({ nonce, title, css, body, script = "", noindex = true }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><meta name="color-scheme" content="light dark">${noindex ? '<meta name="robots" content="noindex">' : ""}
<link rel="icon" href="/_clyde/brand/favicon.svg" type="image/svg+xml"><style nonce="${nonce}">${FONTS_CSS}${TOKENS_CSS}${COMPONENTS_CSS}${(PAGE_CSS + css).replace(/\n/g, "")}</style></head><body class="cl-root">${body}${
    script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
}

const copyBox = (value, label = "Copy") =>
  `<div class="cl-copy"><code>${esc(value)}</code><button class="cl-btn cl-btn--sm" type="button" data-copy="${esc(value)}" aria-label="${esc(label)}">Copy</button></div>`;
const copyPre = (name, value) =>
  `<div class="cl-file"><div class="cl-file__head"><span>${esc(name)}</span><button class="cl-btn cl-btn--sm" type="button" data-copy="${esc(value)}">Copy</button></div>` +
  `<pre><code>${esc(value)}</code></pre></div>`;
const footer = `<footer class="foot"><div class="wrap"><span class="brand">${MARK()}clyde · one memory for every agent</span>
<nav><a href="https://heyclyde.me/privacy">Privacy</a><a href="https://heyclyde.me/terms">Terms</a><a href="${DESIGN_URL}">Design system</a><a href="/healthz">Status</a></nav>
<span class="legal">App names and marks belong to their owners. Listing an app doesn't mean its maker endorses Clyde.</span></div></footer>`;

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

// The apps' logos (memory/design/APP-LOGOS.md). Only marks whose owners allow third-party use without approval ship;
// today that's Grok's, unaltered from x.ai. The rest show their name in a neutral Clyde tile until approval comes.
export const APP_LOGO = { grok: ["/_clyde/apps/grok.svg", "/_clyde/apps/grok-dark.svg"] };
const MONO = { claude: "C", "claude-code": "&gt;_", codex: "&gt;_", gemini: "G", antigravity: "Ag", chatgpt: "G" };
export const appLogo = (slug, size = 24) => {
  const files = APP_LOGO[slug];
  if (!files) return `<span class="mono-tile" aria-hidden="true">${MONO[slug]}</span>`;
  const [light, dark] = files;
  return dark ? themed(light, dark, "", size, size) : `<img src="${light}" alt="" width="${size}" height="${size}">`;
};

const APPS = [
  {
    id: "claude-ai", logo: "claude", name: "Claude", sub: "claude.ai, Cowork and mobile", tag: "Connector",
    body: `<ol class="steps"><li><span>Open <span class="k">Settings → Connectors</span> and choose <span class="k">Add custom connector</span>.</span></li>
<li><span>Paste the URL and click <span class="k">Add</span>, then <span class="k">Connect</span>.</span></li>
<li><span>Open the sign-in link Clyde emails you. The connector syncs to Cowork and the mobile apps.</span></li></ol>${copyBox(MCP_URL)}`,
  },
  {
    id: "claude-code", logo: "claude-code", name: "Claude Code and Codex", sub: "Terminal agents on your computer", tag: "Installer",
    body: `<p class="fine">Run this in a terminal. It signs in by email, adds the MCP server and hooks to both, and keeps them up to date.</p>${copyBox(INSTALL)}`,
  },
  {
    id: "antigravity", logo: "antigravity", name: "Antigravity", sub: "Desktop IDE and CLI", tag: "Config file",
    body: `<p class="fine">The installer adds this for you. To do it by hand, merge it into <code>~/.gemini/config/mcp_config.json</code>, then sign in when Antigravity opens the browser.</p>
${copyPre("mcp_config.json", JSON.stringify({ mcpServers: { memory: { serverUrl: MCP_URL } } }, null, 2))}`,
  },
  {
    id: "gemini", logo: "gemini", name: "Gemini app", sub: "gemini.google.com", tag: "Custom app",
    body: `<ol class="steps"><li><span>Open <span class="k">Settings → Connected Apps</span>.</span></li>
<li><span>Add a <span class="k">custom app</span> with the URL.</span></li>
<li><span>Approve with the sign-in link Clyde emails you.</span></li></ol>${copyBox(MCP_URL)}
<p class="fine">Custom apps may need Google AI Ultra or a US account.</p>`,
  },
  {
    id: "grok", logo: "grok", name: "Grok", sub: "grok.com", tag: "Connector",
    body: `<ol class="steps"><li><span>Open <a href="https://grok.com/connectors" rel="noopener noreferrer" target="_blank">grok.com/connectors</a> and choose <span class="k">Custom</span>.</span></li>
<li><span>Paste the URL and connect.</span></li>
<li><span>Open the sign-in link Clyde emails you.</span></li></ol>${copyBox(MCP_URL)}`,
  },
  {
    id: "antigravity-cloud", logo: "antigravity", name: "Antigravity cloud", sub: "Agents that can't open a browser", tag: "HTTPS token",
    body: `<p class="fine">Cloud agents can't do the email sign-in, so they send a device token over HTTPS. Copy it from <code>~/.config/memory/token</code> on any computer the installer set up, and keep it in the agent's secrets, never in a repo.</p>
${copyPre("mcp_config.json", JSON.stringify({ mcpServers: { memory: { serverUrl: MCP_URL, headers: { Authorization: "Bearer <your device token>" } } } }, null, 2))}`,
  },
];

export const WORKS = [["claude", "Claude"], ["claude-code", "Claude Code"], ["codex", "Codex"], ["gemini", "Gemini"], ["antigravity", "Antigravity"], ["grok", "Grok"], ["chatgpt", "ChatGPT", "soon"]];

// The hero's picture: a question asked in Claude, answered from a memory atlas filed in Claude Code; Codex recalling the
// same memory in a terminal; and a quest atlas claimed. Example data, drawn with the real components.
export const SCENE = `<div class="scene" aria-label="Clyde answering in Claude and in Codex from the same memory">
<div class="win w1"><div class="win-top"><i class="dots"></i>Claude<span>chat</span></div><div class="body">
<div class="ask">What did we decide about deploys?</div><p class="say">You decided three weeks ago. Clyde has it:</p>
<article class="cl-card cl-memory"><div class="cl-memory__top"><span class="cl-chip">Decision</span><span class="cl-state cl-state--settled">Settled</span><span class="cl-memory__conf">93%</span></div>
<h3 class="cl-memory__title">Deploys go through deploy.sh, never the dashboard</h3>
<div class="cl-prov"><span class="cl-prov__who">atlas</span><span>Claude Code</span><span class="cl-prov__sep">/</span><span>mbp-work</span><span class="cl-prov__sep">/</span><span>3 weeks ago</span></div></article>
<span class="via">${MARK(14)}from clyde · recalled 41×</span></div></div>
<div class="win w2"><div class="win-top"><i class="dots"></i>Codex<span>terminal</span></div><pre><b>›</b> ship the migration
<i>clyde</i> recall "deploy" <b>→</b> 1 memory, 93%
  Deploys go through deploy.sh (atlas, Claude Code)
<b>›</b> running ./deploy.sh</pre></div>
<span class="cl-stamp cl-stamp--carbon pin">Claimed <small>atlas · Nº 38</small></span></div>`;

export function homePage(nonce) {
  const cards = APPS.map((a) => `<article class="cl-card app" data-app="${a.id}"><div class="app-head"><span class="app-logo">${appLogo(a.logo)}</span>
<div><h3 class="cl-title-3">${esc(a.name)}</h3><p class="sub">${esc(a.sub)}</p></div><span class="cl-chip">${esc(a.tag)}</span></div>${a.body}</article>`).join("\n");
  const works = WORKS.map(([slug, name, soon]) => `<li>${APP_LOGO[slug] ? appLogo(slug, 20) : ""}${name}${soon ? ` <small>${soon}</small>` : ""}</li>`).join("");
  const body = `<header class="bar wrap">${WORDMARK}<nav class="topnav"><a href="https://heyclyde.me/">Home</a><a href="#apps">Apps</a><a href="#how">How it works</a></nav>
<span class="cl-status" id="status" role="status">Checking</span></header>
<main>
<section class="hero wrap"><div class="hero-text"><span class="cl-label">Get Clyde</span>
<h1 class="cl-display">Connect your <em>apps.</em></h1>
<p class="cl-lead">Point each app at one URL and approve one email. What one agent learns, every other agent can recall.</p>
<div class="cta"><a class="cl-btn cl-btn--primary cl-btn--lg" href="#apps">Pick your app</a><a class="cl-btn cl-btn--ghost cl-btn--lg" href="https://heyclyde.me/">What is Clyde?</a></div>
<div class="works"><span class="cl-label">Connects to</span><ul>${works}</ul></div></div>${SCENE}</section>
<section class="wrap" id="apps"><div class="apps-head"><div class="section"><span class="cl-label">Connect</span><h2 class="cl-title-1">Pick your app</h2>
<p class="cl-lead">Point each app at one URL and approve the sign-in email. Every app's agents then share the same memories.</p></div>
<div class="cl-field"><span class="cl-field__label">Server URL</span>${copyBox(MCP_URL)}</div></div>
<div class="apps">${cards}</div></section>
<section class="wrap" id="how"><div class="section"><span class="cl-label">How sign-in works</span><h2 class="cl-title-1">No passwords, no keys to paste.</h2></div>
<ol class="how">
<li><span class="n">1</span><b>Add the URL</b><p>Each app registers itself through OAuth. There's no password and no key to paste.</p></li>
<li><span class="n">2</span><b>Click the email link</b><p>Clyde emails you a sign-in link. Open it on any device, and the app's window moves on by itself.</p></li>
<li><span class="n">3</span><b>Clyde checks the app</b><p>Only Claude, Antigravity, Gemini, Grok and your own computer get in. Anything else is refused and logged.</p></li>
</ol></section></main>${footer}`;
  return shell({ nonce, title: "Clyde · one memory for every agent", css: HOME_CSS, body, script: COPY_JS + STATUS_JS });
}
