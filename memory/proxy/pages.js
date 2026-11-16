// The pages the Worker serves at memory.heyclyde.me (R46): the sign-in states the function reports as JSON, and the
// "connect your apps" page at /. They wear Clyde's sticky-note & doodle design system (R68): tokens.css, components.css
// and fonts.css, inlined from memory/design/css.js because the CSP allows only this response's nonce'd styles.
import { COMPONENTS_CSS, FONTS_CSS, TOKENS_CSS } from "../design/css.js";

// The one connector URL every app and store listing uses (R53). memory.heyclyde.me/mcp stays as an alias.
export const MCP_URL = "https://heyclyde.me/mcp";
export const INSTALL = "curl -fsSL https://memory.heyclyde.me/install | sh";
export const DESIGN_URL = "https://claude.ai/artifact/2EHGVrGQfefmStu1TqikCb";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/** An image with a dark-mode twin: <picture> switches on the system theme (these pages have no theme toggle). */
export const themed = (light, dark, alt, w, h, cls = "") => `<picture${cls ? ` class="${cls}"` : ""}><source media="(prefers-color-scheme: dark)" srcset="${dark}">` +
  `<img src="${light}" alt="${alt}" width="${w}" height="${h}"></picture>`;
// Sticky-Note Forehead Clyde lockup (332 x 92), mark (128 x 128), full mascot (156 x 310), and scene illustrations.
export const LOGO = (h = 30) => themed("/_clyde/brand/clyde-lockup-light.svg", "/_clyde/brand/clyde-lockup-dark.svg", "clyde", Math.round(h * 332 / 92), h);
export const MARK = (h = 20) => themed("/_clyde/brand/clyde-mark-light.svg", "/_clyde/brand/clyde-mark-dark.svg", "", h, h);
export const MASCOT = (h = 180) => themed("/_clyde/brand/clyde-mascot-light.svg", "/_clyde/brand/clyde-mascot-dark.svg", "Sticky-Note Forehead Clyde", Math.round(h * 156 / 310), h, "cl-mascot");
export const SCENE_IMG = (slug, alt, w, h) => themed(`/_clyde/scenes/${slug}-light.svg`, `/_clyde/scenes/${slug}-dark.svg`, alt, w, h, "cl-mascot");
const WORDMARK = `<a class="logo" href="https://heyclyde.me/" aria-label="clyde home">${LOGO()}</a>`;

export const PAGE_CSS = `
.soon{color:var(--cl-pen-red);font-weight:700;margin-left:2px}.soon-note{margin:6px 0 0;font:var(--cl-text-small);color:var(--cl-ink-3)}
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
.foot .brand img{height:22px;width:22px}
.foot nav{display:flex;gap:18px;flex-wrap:wrap}
.foot a{color:var(--cl-ink-2)}
.foot .legal{flex-basis:100%;line-height:1.5}
code{font-family:var(--cl-font-mono);font-size:.9em}
`;

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

// The hero, section, works and how styles heyclyde.me shares with the connect page (R72 keeps the site home under 50 KB).
export const HERO_CSS = `
.hero{position:relative;display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:48px;align-items:center;padding-block:36px 68px}
@media (max-width:960px){.hero{grid-template-columns:minmax(0,1fr);gap:40px;padding-block:20px 52px}}
.hero::before{content:"";position:absolute;inset:0 0 0 46%;z-index:-1;background:repeating-linear-gradient(to bottom,transparent 0 31px,var(--cl-rule) 31px 32px);-webkit-mask-image:radial-gradient(70% 70% at 60% 50%,#000,transparent);mask-image:radial-gradient(70% 70% at 60% 50%,#000,transparent)}
@media (max-width:960px){.hero::before{inset:auto 0 0;height:60%}}
.hero-text{display:grid;gap:20px;min-width:0}
.hero h1{margin:0;max-width:12ch}
.hero h1 em{font-style:normal;color:var(--cl-carbon)}
.hero .cl-lead{max-width:48ch}
.cta{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
.works{display:grid;gap:10px;margin-top:4px}
.works ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}
.works li{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 13px;border:1px solid var(--cl-rule);border-radius:var(--cl-radius-pill);background:var(--cl-paper-1);font:500 13px/1 var(--cl-font-sans);color:var(--cl-ink-2)}
.section{display:grid;gap:12px;margin:0 0 26px;max-width:720px}
.section h2{margin:0}
@media (max-width:860px){.apps-head{grid-template-columns:minmax(0,1fr)}}
.how{list-style:none;margin:0 0 24px;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
@media (max-width:860px){.how{grid-template-columns:minmax(0,1fr)}}
.how{counter-reset:how}
.how li{counter-increment:how;font:var(--cl-text-title-3);overflow-wrap:anywhere;padding:22px;border:1px solid var(--cl-rule);border-radius:var(--cl-radius-lg);background:var(--cl-paper-1)}
.how li::before{content:counter(how);display:block;margin-bottom:10px;font:780 44px/1 var(--cl-font-display);letter-spacing:-.04em;color:var(--cl-carbon)}
`;

/** App steps and card bodies: the connect page, /docs and the home page's app picker all use these. */
export const APP_STEPS_CSS = `
.works li img,.app-logo img{display:block;width:20px;height:20px;object-fit:contain}
.app{display:flex;flex-direction:column;gap:14px;padding:20px}
.app .fine{margin:0;font:var(--cl-text-small);color:var(--cl-ink-2)}
.app .fine code{color:var(--cl-ink);overflow-wrap:anywhere}
@media (max-width:480px){.app .cl-copy code{font-size:12px}}
ol.steps{margin:0;padding:0;list-style:none;counter-reset:s;display:grid;gap:8px;font:var(--cl-text-body);color:var(--cl-ink-2)}
ol.steps li{counter-increment:s;display:grid;grid-template-columns:22px minmax(0,1fr);gap:8px;align-items:baseline}
ol.steps li::before{content:counter(s);font:600 11px/1 var(--cl-font-mono);color:var(--cl-ink-3)}
.k{font-weight:600;color:var(--cl-ink)}
`;
/** The rest of the connect page and /docs: the hero, the card grid and the logo tiles. */
export const CONNECT_CSS = APP_STEPS_CSS + `
.hero-note{max-width:44ch;padding:12px 16px;font:var(--cl-text-small)}
.hero-art{min-width:0}.hero-art img{display:block;width:100%;max-width:484px;height:auto}
.apps-head{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,420px);gap:24px;align-items:end;margin-bottom:24px}
.apps-head .section{margin:0}
.apps-head .cl-copy{box-shadow:var(--cl-copy-2);border-color:var(--cl-ink-3);padding:8px 8px 8px 14px}
.apps{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-bottom:68px}
@media (max-width:760px){.apps{grid-template-columns:minmax(0,1fr)}}
.app-head{display:flex;align-items:center;gap:12px;min-width:0}
.app-logo{width:40px;height:40px;flex:none;display:grid;place-items:center;border:1px solid var(--cl-rule);border-radius:var(--cl-radius-md);background:var(--cl-paper-1)}
.app-logo img{width:24px;height:24px}
.mono-tile{font:700 13px/1 var(--cl-font-mono);color:var(--cl-ink-2)}
.app-head > div{min-width:0}
.app h3{margin:0}
.app .sub{margin:2px 0 0;font:var(--cl-text-small);color:var(--cl-ink-3)}
.app-head .cl-chip{margin-left:auto}
`;

export const HOME_CSS = HERO_CSS + CONNECT_CSS;

// The mock Claude and Codex windows on heyclyde.me. The connect page shows the relay drawing instead, to stay under 40 KB.
export const SCENE_CSS = `
.scene{position:relative;min-width:0;padding:0 0 96px}
.win{border:1px solid var(--cl-rule-strong);border-radius:var(--cl-radius-xl);background:var(--cl-paper-1);box-shadow:var(--cl-shadow-2);overflow:hidden}
.win-top{display:flex;align-items:center;gap:8px;height:38px;padding:0 14px;border-bottom:1px solid var(--cl-rule);font:500 13px/1 var(--cl-font-sans);color:var(--cl-ink)}
.win-top img{width:18px;height:18px}
.win-top span{margin-left:auto;font:var(--cl-text-label);letter-spacing:.06em;text-transform:uppercase;color:var(--cl-ink-3)}
.w1 .body{display:grid;gap:12px;padding:16px;background:var(--cl-paper-0)}
.ask{justify-self:end;max-width:82%;padding:9px 13px;border-radius:14px 14px 4px 14px;background:var(--cl-ink);color:var(--cl-on-ink);font:var(--cl-text-small)}
.say{font:var(--cl-text-small);color:var(--cl-ink-2);margin:0}
.w1 .cl-memory{box-shadow:var(--cl-copy-2);border-color:var(--cl-carbon)}
.via{display:flex;align-items:center;gap:6px;font:var(--cl-text-label);letter-spacing:.06em;text-transform:uppercase;color:var(--cl-ink-3)}
.via img{width:16px;height:16px}
.w2{position:absolute;right:-8px;bottom:0;width:min(76%,350px);transform:rotate(1.2deg)}
.w2 pre{margin:0;padding:12px 14px;font:400 12px/1.6 var(--cl-font-mono);color:var(--cl-ink-2);background:var(--cl-paper-1);white-space:pre-wrap}
.w2 b{color:var(--cl-ink);font-weight:600}.w2 i{font-style:normal;color:var(--cl-carbon)}
.pin{position:absolute;left:-10px;bottom:-4px;transform:rotate(-4deg);background:var(--cl-paper-1)}
@media (max-width:960px){.scene{padding:0}.w2{position:relative;right:auto;width:auto;margin:-18px 0 0 24px}.pin{position:relative;left:0;bottom:0;margin-top:14px}}
.win-top .dots{display:inline-flex;gap:5px;margin-right:4px}.win-top .dots::before,.win-top .dots::after{content:"";width:9px;height:9px;border-radius:50%;border:1px solid var(--cl-rule-strong);background:var(--cl-paper-2)}
`;

export const COPY_JS = `document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){
var t=b.getAttribute('data-copy');function ok(){b.textContent='Copied';b.classList.add('is-done');setTimeout(function(){b.textContent='Copy';b.classList.remove('is-done')},1600)}
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,function(){})}else{var a=document.createElement('textarea');
a.value=t;document.body.appendChild(a);a.select();try{document.execCommand('copy');ok()}catch(e){}a.remove()}})});`;

const STATUS_JS = `(function(){var p=document.getElementById('status');if(!p)return;
fetch('/healthz',{cache:'no-store'}).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(d){
p.className='cl-status is-ok';p.textContent='Online';if(d&&d.version){var v=document.createElement('span');v.className='v';
v.textContent='v'+d.version;p.appendChild(document.createTextNode(' \\u00b7 '));p.appendChild(v)}}).catch(function(){p.className='cl-status is-bad';p.textContent='Offline'})})();`;

export const SITE = "https://heyclyde.me";
export const OG_IMAGE = `${SITE}/brand/og-banner.png`;

/** R72: a public page's search tags. seo is {description, path, jsonld}: a canonical URL on heyclyde.me, the OG and
 * Twitter cards with the OG banner, and each JSON-LD object in its own data block. */
function seoTags(nonce, title, seo) {
  if (!seo) return "";
  const url = SITE + seo.path, d = esc(seo.description), t = esc(title);
  return `<meta name="description" content="${d}"><link rel="canonical" href="${url}">` +
    `<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1"><meta property="og:locale" content="en_US">` +
    `<link rel="apple-touch-icon" href="/brand/clyde-512.png"><meta name="theme-color" content="#f3f1ea">` +
    `<meta property="og:type" content="website"><meta property="og:site_name" content="Clyde"><meta property="og:title" content="${t}">` +
    `<meta property="og:description" content="${d}"><meta property="og:url" content="${url}"><meta property="og:image" content="${OG_IMAGE}">` +
    `<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="Clyde, a doodle with a sticky note on his forehead">` +
    `<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${t}"><meta name="twitter:description" content="${d}">` +
    `<meta name="twitter:image" content="${OG_IMAGE}">` +
    (seo.jsonld ?? []).map((j) => `<script type="application/ld+json" nonce="${nonce}">${JSON.stringify(j).replace(/</g, "\\u003c")}</script>`).join("");
}

/** The same minifier memory/design/build.mjs runs on the design system: comments out, whitespace collapsed. */
const minCss = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").replace(/\s*([{}:;,>])\s*/g, "$1").trim();

export function shell({ nonce, title, css, body, script = "", noindex = true, seo = null }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><meta name="color-scheme" content="light dark">${noindex ? '<meta name="robots" content="noindex">' : ""}${seoTags(nonce, title, seo)}
<link rel="icon" href="/_clyde/brand/favicon.svg" type="image/svg+xml"><style nonce="${nonce}">${FONTS_CSS}${TOKENS_CSS}${COMPONENTS_CSS}${minCss(PAGE_CSS + css)}</style></head><body class="cl-root">${body}${
    script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
}

export const copyBox = (value, label = "Copy") =>
  `<div class="cl-copy"><code>${esc(value)}</code><button class="cl-btn cl-btn--sm" type="button" data-copy="${esc(value)}" aria-label="${esc(label)}">Copy</button></div>`;
const copyPre = (name, value) =>
  `<div class="cl-file"><div class="cl-file__head"><span>${esc(name)}</span><button class="cl-btn cl-btn--sm" type="button" data-copy="${esc(value)}">Copy</button></div>` +
  `<pre><code>${esc(value)}</code></pre></div>`;
export const LEGAL = "Claude, ChatGPT, Codex, Gemini, Antigravity, and Grok are trademarks of their respective owners. None of them endorse Clyde. Not available in the EU, EEA, UK, Switzerland, or Quebec.";
const footer = `<footer class="foot"><div class="wrap"><span class="brand">${MARK(22)}clyde · a boring memory system</span>
<nav><a href="https://heyclyde.me/privacy">Privacy</a><a href="https://heyclyde.me/terms">Terms</a><a href="${DESIGN_URL}">Design system</a><a href="/healthz">Status</a></nav>
<span class="legal">${LEGAL}</span></div></footer>`;

// ---- Sign-in states ----

const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  mail: svg(`<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>`),
  wait: svg(`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`),
};

const live = (text) => `<div class="live" role="status"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>${text}</div>`;
const stamp = (tone, word, when) => `<span class="cl-stamp cl-stamp--${tone} is-new">${word} <small>${when}</small></span>`;
const note = (html) => `<p class="cl-well">${html}</p>`;

function sentence(message, fallback = "Restart the connection from your app.") {
  const s = String(message ?? "").replace(/^memory:\s*/, "").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : fallback;
}

const today = () => new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function statePage(data, nonce, id = "") {
  const state = data?.state;
  const app = (fallback = "your app") => data?.client ? `<strong>${esc(data.client)}</strong>` : fallback;
  const date = today();
  let mark, h1, lead, extra = "", title, kind = "Sign-in";
  switch (state) {
    case "check_email":
      mark = `<div class="badge">${ICON.mail}</div>`; h1 = "Check your email"; title = "Check your email";
      lead = `We sent a sign-in link to ${data.email ? `<strong>${esc(data.email)}</strong>` : "your inbox"}. Open it on any device.`;
      extra = live("This page moves on when you click it.");
      break;
    case "waiting":
      mark = `<div class="badge">${ICON.wait}</div>`; h1 = "Waiting for confirmation"; title = "Waiting for confirmation";
      lead = "Nobody has clicked the link yet. If the email isn't there, check spam.";
      extra = live("Watching for the click.");
      break;
    case "connected":
      mark = stamp("ok", "Approved", date); h1 = "Connected"; title = "Connected";
      lead = `${app("Your app")} is connected to Clyde.`;
      extra = note("Close this tab and return to your app.");
      break;
    case "refused":
      mark = stamp("bad", "Refused", date); h1 = "Connection refused"; title = "Connection refused";
      lead = `${app("This client")} wasn't connected. Nothing was shared.`;
      extra = note(`The callback URL${data?.callback ? ` <code>${esc(data.callback)}</code>` : ""} didn't match a supported app or localhost. Clyde refused it and logged the attempt.`);
      break;
    case "ask_email":
      mark = `<div class="badge">${ICON.mail}</div>`; h1 = "Sign in to Clyde"; title = "Sign in";
      lead = "Enter your email and Clyde sends you a one-time sign-in link.";
      extra = `<form class="ask" method="post" action="/oauth/consent?authorization_id=${esc(encodeURIComponent(id))}">
<div class="cl-field"><label for="email">Email</label><input class="cl-input" id="email" type="email" name="email" autocomplete="email" required autofocus placeholder="you@example.com"></div>
<button class="cl-btn cl-btn--primary cl-btn--lg cl-btn--block" type="submit">Send sign-in link</button></form>`;
      break;
    case "blocked":
      mark = stamp("bad", "Not available", date); h1 = "Not available in your region"; title = "Not available";
      lead = esc(sentence(data?.message, "Connection canceled."));
      extra = note("Clyde isn't available in GDPR jurisdictions or Quebec yet. No account was made and no email went out.");
      break;
    case "subscribed":
      kind = "Subscription";
      mark = stamp("ok", "Paid", date); h1 = "Subscription active"; title = "Subscribed";
      lead = "Your Clyde plan is on. New limits apply within a minute.";
      extra = note("Close this tab and return to your app.");
      break;
    case "expired":
      mark = stamp("warn", "Expired", date); h1 = "Link expired"; title = "Link expired";
      lead = "Sign-in links work once and expire after 15 minutes. Start again from your app.";
      break;
    default:
      mark = stamp("bad", "Error", date); h1 = "Sign-in failed"; title = "Sign-in failed";
      lead = esc(sentence(data?.message));
  }
  const body = `<header class="bar center wrap">${WORDMARK}</header>
<main class="sign"><section class="cl-sheet ticket"><div class="ticket-head"><span class="cl-label">${kind}</span><span class="cl-label">memory.heyclyde.me</span></div>
<div class="ticket-body">${mark}<h1 class="cl-title-1">${h1}</h1><p class="cl-lead">${lead}</p>${extra}</div></section></main>${footer}`;
  return shell({ nonce, title: `${title} · Clyde`, css: SIGN_CSS, body });
}

// ---- Connect your apps ----

// Official marks from each company's own press kit or site (memory/design/APP-LOGOS.md). Wen chose to show them all on
// 2026-11-16. The OpenAI marks switch light and dark inside the SVG. Grok's comes as two files.
export const APP_LOGO = {
  claude: ["/_clyde/apps/claude.svg"], "claude-code": ["/_clyde/apps/claude-code.svg"], codex: ["/_clyde/apps/codex.svg"],
  chatgpt: ["/_clyde/apps/chatgpt.svg"], gemini: ["/_clyde/apps/gemini.svg"], antigravity: ["/_clyde/apps/antigravity.svg"],
  grok: ["/_clyde/apps/grok.svg", "/_clyde/apps/grok-dark.svg"],
};
const MONO = { claude: "C", "claude-code": "&gt;_", codex: "&gt;_", gemini: "G", antigravity: "Ag", chatgpt: "G" };
export const appLogo = (slug, size = 24) => {
  const files = APP_LOGO[slug];
  if (!files) return `<span class="mono-tile" aria-hidden="true">${MONO[slug]}</span>`;
  const [light, dark] = files;
  return dark ? themed(light, dark, "", size, size) : `<img src="${light}" alt="" width="${size}" height="${size}">`;
};

const APPS = [
  {
    id: "claude-ai", logo: "claude", name: "Claude", sub: "claude.ai, Cowork, and mobile", tag: "Connector",
    body: `<ol class="steps"><li><span>Open <span class="k">Settings → Connectors → Add custom connector</span>.</span></li>
<li><span>Paste the URL, click <span class="k">Add</span>, then <span class="k">Connect</span>.</span></li>
<li><span>Click the email sign-in link. Clyde then works on web, Cowork and mobile.</span></li></ol>${copyBox(MCP_URL)}`,
  },
  {
    id: "claude-code", logo: "claude-code", name: "Claude Code and Codex", sub: "Terminal agents", tag: "One-liner",
    body: `<p class="fine">Run this in your terminal. It signs you in by email and adds the MCP server and hooks to both.</p>${copyBox(INSTALL)}`,
  },
  {
    id: "antigravity", logo: "antigravity", name: "Antigravity", sub: "Desktop IDE and CLI", tag: "Config",
    body: `<p class="fine">The Claude Code and Codex one-liner sets it up too. Or add this to ~/.gemini/config/mcp_config.json and sign in when your browser opens.</p>
${copyPre("mcp_config.json", JSON.stringify({ mcpServers: { clyde: { serverUrl: MCP_URL } } }, null, 2))}`,
  },
  {
    id: "gemini", logo: "gemini", name: "Gemini app", sub: "gemini.google.com", tag: "Custom app",
    body: `<ol class="steps"><li><span>Open <span class="k">Settings → Connected Apps</span>.</span></li>
<li><span>Add a custom app with Clyde's URL.</span></li>
<li><span>Click the email sign-in link. Needs Google AI Ultra or a US account where applicable.</span></li></ol>${copyBox(MCP_URL)}`,
  },
  {
    id: "grok", logo: "grok", name: "Grok", sub: "grok.com", tag: "Connector",
    body: `<ol class="steps"><li><span>Open <a href="https://grok.com/connectors" rel="noopener noreferrer" target="_blank">grok.com/connectors</a> and select <span class="k">Custom</span>.</span></li>
<li><span>Paste the URL and connect.</span></li>
<li><span>Click the email sign-in link.</span></li></ol>${copyBox(MCP_URL)}`,
  },
  {
    id: "chatgpt", logo: "chatgpt", name: "ChatGPT", sub: "chatgpt.com", tag: "Custom connector",
    body: `${copyBox(MCP_URL)}<p class="fine">Add it as a custom connector in ChatGPT's developer mode.</p>`,
  },
  {
    id: "antigravity-cloud", logo: "antigravity", name: "Antigravity cloud", sub: "Headless cloud environments", tag: "Token",
    body: `<p class="fine">Headless boxes can't open email links. Copy ~/.config/memory/token from a signed-in machine into your cloud environment's secrets. Never commit it to git.</p>
${copyPre("mcp_config.json", JSON.stringify({ mcpServers: { clyde: { serverUrl: MCP_URL, headers: { Authorization: "Bearer <your device token>" } } } }, null, 2))}`,
  },
];

/** Apps nobody has connected to Clyde yet (no sessions from them as of 16 Nov 2026). They show a red asterisk. */
export const SOON = new Set(["gemini", "grok", "chatgpt"]);
const soon = (slug) => SOON.has(slug) ? '<span class="soon" aria-label="work in progress">*</span>' : "";
export const SOON_NOTE = `<p class="soon-note"><span class="soon">*</span> WIP, Clyde's still workin' on it</p>`;
export const WORKS = [["claude", "Claude"], ["claude-code", "Claude Code"], ["codex", "Codex"], ["gemini", "Gemini"], ["antigravity", "Antigravity"], ["grok", "Grok"], ["chatgpt", "ChatGPT"]];

export const SCENE = `<div class="scene" aria-label="The same Clyde note showing up in Claude and in Codex">
<div class="win w1"><div class="win-top"><i class="dots"></i>Claude<span>chat</span></div><div class="body">
<div class="ask">Checkout's slow again. Any idea why?</div><p class="say">From Codex, last week:</p>
<article class="cl-card cl-memory"><div class="cl-memory__top"><span class="cl-chip">Decision</span><span class="cl-state cl-state--settled">Settled</span><span class="cl-memory__conf">94% sure</span></div>
<h3 class="cl-memory__title">The tax API retries 5 times. Raising the timeout made it worse. Don't.</h3>
<div class="cl-prov"><span class="cl-prov__who">atlas</span><span>Codex</span><span class="cl-prov__sep">/</span><span>mbp-work</span><span class="cl-prov__sep">/</span><span>6 d ago</span></div></article>
<span class="via">${MARK(16)}from clyde</span></div></div>
<div class="win w2"><div class="win-top"><i class="dots"></i>Codex<span>terminal</span></div><pre><b>›</b> fix checkout latency
<i>clyde</i> recall "checkout slow" <b>→</b> 1 note
  Tax API retries 5x. Don't raise the timeout.
<b>›</b> capping retries at 2 instead</pre></div></div>`;

/** One app from APPS by id: its logo slug, its name with the red asterisk when it's in SOON, and its install steps.
 * The picker on heyclyde.me's home page shows these, so the steps are written once. */
export const appSteps = (id) => { const a = APPS.find((x) => x.id === id); return { id, logo: a.logo, name: esc(a.name) + soon(a.logo), body: a.body }; };

/** One card per app with its install steps. The connect page and heyclyde.me/docs both show them. */
export const appCards = () => APPS.map((a) => `<article class="cl-card app" data-app="${a.id}" id="${a.id}"><div class="app-head"><span class="app-logo">${appLogo(a.logo)}</span>
<div><h3 class="cl-title-3">${esc(a.name)}${soon(a.logo)}</h3><p class="sub">${esc(a.sub)}</p></div><span class="cl-chip">${esc(a.tag)}</span></div>${a.body}</article>`).join("\n");

export function homePage(nonce) {
  const cards = appCards();
  const works = WORKS.map(([slug, name]) => `<li>${APP_LOGO[slug] ? appLogo(slug, 20) : ""}${name}${soon(slug)}</li>`).join("");
  const body = `<header class="bar wrap">${WORDMARK}<nav class="topnav"><a href="https://heyclyde.me/">Home</a><a href="#apps">Apps</a><a href="#how">How it works</a></nav>
<span class="cl-status" id="status" role="status">Checking</span></header>
<main>
<section class="hero wrap"><div class="hero-text"><span class="cl-label">Get Clyde</span>
<h1 class="cl-display">Connect your <em class="cl-scribble">apps</em></h1>
<p class="cl-lead">Add one MCP URL to each app and click the email sign-in link.</p>
<div class="cl-sticky cl-sticky--tilt hero-note"><b>Use with caution.</b> Put normal context and preferences in it.</div>
<div class="cta"><a class="cl-btn cl-btn--primary cl-btn--lg" href="#apps">Pick your app</a><a class="cl-btn cl-btn--ghost cl-btn--lg" href="https://heyclyde.me/">What is Clyde?</a></div>
<div class="works"><span class="cl-label">Connects to</span><ul>${works}</ul>${SOON_NOTE}</div></div><div class="hero-art">${SCENE_IMG("relay", "Clyde passing a sticky note from a chat window to a terminal", 484, 280)}</div></section>
<section class="wrap" id="apps"><div class="apps-head"><div class="section"><span class="cl-label">Connect</span><h2 class="cl-title-1">Pick your app</h2>
<p class="cl-lead">ChatGPT's custom MCP connectors take the same URL.</p></div>
<div class="cl-field"><span class="cl-field__label">Server URL</span>${copyBox(MCP_URL)}</div></div>
<div class="apps">${cards}</div></section>
<section class="wrap" id="how"><div class="section"><span class="cl-label">Authentication</span><h2 class="cl-title-1">OAuth + magic link</h2></div>
<ol class="how">
<li>Paste the URL. Your app registers itself over OAuth, with no API key.</li>
<li>Click the sign-in link Clyde emails you, on your phone or computer.</li>
<li>Clyde refuses and logs callbacks from anything but Claude, ChatGPT, Antigravity, Gemini, Grok or localhost.</li>
</ol></section></main>${footer}`;
  return shell({ nonce, title: "Connect · Clyde", css: HOME_CSS, body, script: COPY_JS + STATUS_JS });
}
