// The pages the Worker serves at memory.heyclyde.me (R46): the sign-in states the function reports as JSON, and the
// "connect your apps" page at /. They wear Clyde's sticky-note & doodle design system (R68): tokens.css, components.css
// and fonts.css, inlined from memory/design/css.js because the CSP allows only this response's nonce'd styles.
import { COMPONENTS_CSS, FONTS_CSS, TOKENS_CSS } from "../design/css.js";
import { AGENT_SETUP_PROMPT, ANTIGRAVITY_HOOKS_JSON, CLAUDE_HOOKS_JSON, CLYDE_VERIFY_SH, CODEX_HOOKS_JSON, GEMINI_HOOKS_JSON, HOOK_INSTALL, HOOK_PATH } from "./hook.js";

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
.social{display:grid;gap:10px;margin-top:4px}
.social-btn{justify-content:center;gap:10px;text-decoration:none}
.social-btn svg{width:18px;height:18px;flex:none}
.or-rule{display:flex;align-items:center;gap:12px;color:var(--cl-ink-3);font:var(--cl-text-label);text-transform:uppercase;letter-spacing:.06em;margin:2px 0}
.or-rule::before,.or-rule::after{content:"";flex:1;height:1px;background:var(--cl-rule)}
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
.app.cl-sticky{padding:24px 20px 20px}
.app .fine{margin:0;font:var(--cl-text-small);color:var(--cl-ink-2)}
.app .fine code{color:var(--cl-ink);overflow-wrap:anywhere}
.app .cl-file pre{max-height:220px;overflow:auto}
.app-fold{border-top:1px dashed var(--cl-rule-strong);padding-top:10px}
.app-fold summary{cursor:pointer;font:var(--cl-text-mono);font-size:12px;color:var(--cl-ink-2)}
.app-fold[open] summary{margin-bottom:10px}
@media (max-width:480px){.app .cl-copy code{font-size:12px}}
ol.steps{margin:0;padding:0;list-style:none;counter-reset:s;display:grid;gap:8px;font:var(--cl-text-body);color:var(--cl-ink-2)}
ol.steps li{counter-increment:s;display:grid;grid-template-columns:22px minmax(0,1fr);gap:8px;align-items:baseline}
ol.steps li::before{content:counter(s);font:600 11px/1 var(--cl-font-mono);color:var(--cl-ink-3)}
.k{font-weight:600;color:var(--cl-ink)}
`;
/** The rest of the connect page and /docs: the hero, the mosaic card stack and the logo tiles. */
export const CONNECT_CSS = APP_STEPS_CSS + `
.hero-note{max-width:44ch;padding:12px 16px;font:var(--cl-text-small)}
.hero-art{min-width:0}.hero-art img{display:block;width:100%;max-width:484px;height:auto}
.apps-head{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,420px);gap:24px;align-items:end;margin-bottom:24px}
.apps-head .section{margin:0}
.apps-head .cl-copy{box-shadow:var(--cl-copy-2);border-color:var(--cl-ink-3);padding:8px 8px 8px 14px}
.apps{columns:2 380px;column-gap:16px;margin-bottom:68px}
@media (max-width:820px){.apps{columns:1}}
.apps>.app{display:inline-flex;width:100%;vertical-align:top;break-inside:avoid;margin:0 0 16px}
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
export const copyPre = (name, value) =>
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

const PROVIDER_ICON = {
  google: `<svg viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62Z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.33A9 9 0 0 0 9 18Z"/><path fill="#FBBC05" d="M3.97 10.71A5.4 5.4 0 0 1 3.69 9c0-.6.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.04l3.01-2.33Z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"/></svg>`,
  github: `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`,
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
      extra = live("This page updates after you click the link.");
      break;
    case "waiting":
      mark = `<div class="badge">${ICON.wait}</div>`; h1 = "Waiting for confirmation"; title = "Waiting for confirmation";
      lead = "Click the email link to finish connecting. If it isn't in your inbox, check spam.";
      extra = live("Checking automatically.");
      break;
    case "connected":
      mark = stamp("ok", "Approved", date); h1 = "Connected"; title = "Connected";
      lead = `${app("Your app")} is connected to Clyde.`;
      // R74: past the free tier's last seat, the app connects but its tools need the plan. Only an https link is a link.
      extra = data?.free_full && /^https:\/\//.test(String(data.checkout_url ?? ""))
        ? note(`No free seats are available right now. <a href="${esc(data.checkout_url)}">Subscribe to Clyde for $12.99 USD/month</a> to start using tools, then return to your app.`)
        : note("Close this tab and return to your app.");
      break;
    case "refused":
      mark = stamp("bad", "Refused", date); h1 = "Connection refused"; title = "Connection refused";
      lead = `${app("This client")} wasn't connected. Nothing was shared.`;
      extra = note(`The callback URL${data?.callback ? ` <code>${esc(data.callback)}</code>` : ""} didn't match a supported app or localhost. Clyde refused it and logged the attempt.`);
      break;
    case "ask_email": {
      mark = `<div class="badge">${ICON.mail}</div>`; h1 = "Sign in to Clyde"; title = "Sign in";
      const providers = Array.isArray(data?.providers) ? data.providers.filter((x) => x === "google" || x === "github") : [];
      const names = providers.map((pr) => pr === "google" ? "Google" : "GitHub");
      lead = names.length
        ? `Sign in with ${names.join(" or ")}, or enter your email for a one-time link.`
        : "Enter your email and Clyde sends you a one-time sign-in link.";
      const social = providers.length
        ? `<div class="social">${providers.map((pr) => `<a class="cl-btn cl-btn--lg cl-btn--block social-btn" href="/oauth/provider?authorization_id=${esc(encodeURIComponent(id))}&provider=${pr}">${PROVIDER_ICON[pr]}<span>Continue with ${pr === "google" ? "Google" : "GitHub"}</span></a>`).join("")}</div><div class="or-rule"><span>or with email</span></div>`
        : "";
      extra = `${social}<form class="ask" method="post" action="/oauth/consent?authorization_id=${esc(encodeURIComponent(id))}">
<div class="cl-field"><label for="email">Email</label><input class="cl-input" id="email" type="email" name="email" autocomplete="email" required autofocus placeholder="you@example.com"></div>
<details class="cl-field"><summary>Have a password?</summary><label for="password">Password</label><input class="cl-input" id="password" type="password" name="password" autocomplete="current-password"></details>
${data?.turnstile_site_key ? `<div class="cf-turnstile" data-sitekey="${esc(data.turnstile_site_key)}"></div>` : ""}
<button class="cl-btn cl-btn--primary cl-btn--lg cl-btn--block" type="submit">Send sign-in link</button></form>${data?.turnstile_site_key
        ? `<script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ""}`;
      break;
    }
    case "closed":
      mark = stamp("warn", "Closed", date); h1 = "Sign-ups are closed"; title = "Sign-ups closed";
      lead = "Clyde isn't taking new accounts right now. No account was made and no email went out.";
      break;
    case "blocked":
      mark = stamp("bad", "Not available", date); h1 = "Not available in your region"; title = "Not available";
      lead = esc(sentence(data?.message, "Connection canceled."));
      extra = note("Clyde isn't available in the EU, EEA, UK, Switzerland, or Quebec yet. No account was created and no email went out.");
      break;
    case "subscribed":
      kind = "Subscription";
      mark = stamp("ok", "Paid", date); h1 = "Subscription active"; title = "Subscribed";
      lead = "Your Clyde plan is active. Paid limits apply within a minute.";
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
  "agent-setup": ["/_clyde/brand/clyde-mark-light.svg", "/_clyde/brand/clyde-mark-dark.svg"],
  claude: ["/_clyde/apps/claude.svg"], "claude-code": ["/_clyde/apps/claude-code.svg"], codex: ["/_clyde/apps/codex.svg"],
  chatgpt: ["/_clyde/apps/chatgpt.svg"], gemini: ["/_clyde/apps/gemini.svg"], antigravity: ["/_clyde/apps/antigravity.svg"],
  grok: ["/_clyde/apps/grok.svg", "/_clyde/apps/grok-dark.svg"],
  other: ["/_clyde/brand/clyde-mark-light.svg", "/_clyde/brand/clyde-mark-dark.svg"],
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
    id: "agent-setup", logo: "agent-setup", name: "Let your agent set it up", sub: "Claude Code, Codex, Antigravity, and Gemini CLI", tag: "Full setup", sticky: true,
    body: `<ol class="steps"><li><span><span class="k">Wire MCP:</span> Merge <code>${MCP_URL}</code> into every installed client without clobbering existing entries (<code>~/.gemini/config/mcp_config.json</code>, <code>~/.claude.json</code>, <code>~/.codex/config.toml</code>, or <code>~/.gemini/settings.json</code>).</span></li>
<li><span><span class="k">Guide sign-in:</span> Reuse <code>~/.config/memory/token</code> via <code>${INSTALL}</code> if valid, or ask for the user's email, run <code>MEMORY_EMAIL=&lt;email&gt; sh -c '${INSTALL}'</code> (or refresh <span class="k">MCP Servers</span> in Antigravity), and wait for the email link click.</span></li>
<li><span><span class="k">Confirm:</span> Call <code>register_agent</code>, <code>check_messages</code>, and <code>remember</code> (&lt;500 chars) to save a first setup note and show the returned note ID.</span></li>
<li><span><span class="k">Install task-shift hooks:</span> Install <code>${HOOK_PATH}</code>, merge the hook JSON configs on this page into <code>~/.gemini/config/hooks.json</code>, <code>~/.claude/settings.json</code>, <code>~/.codex/hooks.json</code>, and <code>~/.gemini/settings.json</code>, drop old hard per-step hooks, and save <code>.agents/rules/clyde.md</code> (or <code>.agent/rules/clyde.md</code>) with <code>trigger: model_decision</code>.</span></li>
<li><span><span class="k">Tell the user to restart:</span> List every app to restart (Antigravity, Claude Code, Codex CLI plus <code>/hooks</code> once to trust, and Gemini CLI).</span></li></ol>
${copyPre("Paste into your coding agent", AGENT_SETUP_PROMPT)}
<details class="app-fold"><summary>Pre-restart check via ~/.config/memory/token</summary>${copyPre("Confirm register_agent + first memory", CLYDE_VERIFY_SH)}</details>`,
  },
  {
    id: "claude-ai", logo: "claude", name: "Claude", sub: "claude.ai, Cowork, and mobile", tag: "Connector",
    body: `<ol class="steps"><li><span><span class="k">MCP:</span> Open <span class="k">Settings → Connectors → Add custom connector</span> and paste the URL below.</span></li>
<li><span><span class="k">Login:</span> Click <span class="k">Add</span>, click <span class="k">Connect</span>, and open the sign-in link in your email.</span></li>
<li><span><span class="k">Confirm:</span> Ask Claude to call <code>register_agent</code> and save a first note with <code>remember</code> so a note ID returns.</span></li>
<li><span><span class="k">Rules:</span> Paste the <a href="https://heyclyde.me/docs#instructions">Clyde rule</a> into <span class="k">Settings → Profile → Personal preferences</span>.</span></li>
<li><span><span class="k">Restart:</span> Open a new chat so Personal preferences and Clyde load together.</span></li></ol>${copyBox(MCP_URL)}`,
  },
  {
    id: "antigravity", logo: "antigravity", name: "Antigravity", sub: "Desktop App, IDE, and CLI", tag: "MCP + hooks",
    body: `<ol class="steps"><li><span><span class="k">MCP:</span> Merge <code>mcp_config.json</code> below into <code>~/.gemini/config/mcp_config.json</code> (or run the terminal installer).</span></li>
<li><span><span class="k">Login:</span> Refresh <span class="k">MCP Servers</span> in Antigravity and click the sign-in link in your email.</span></li>
<li><span><span class="k">Confirm:</span> Ask Antigravity to call <code>register_agent</code> and save a first note with <code>remember</code> so a note ID returns.</span></li>
<li><span><span class="k">Hooks &amp; rules:</span> Install <code>clyde-hook.sh</code>, merge <code>hooks.json</code> below into <code>~/.gemini/config/hooks.json</code> (removing any hard per-step hook), and save <code>.agents/rules/clyde.md</code> set to <span class="k">Model Decision</span>.</span></li>
<li><span><span class="k">Restart:</span> Restart Antigravity (or check <span class="k">Customizations → Hooks</span> and <span class="k">Rules</span>) so task-shift hooks take over.</span></li></ol>
${copyPre("~/.gemini/config/mcp_config.json", JSON.stringify({ mcpServers: { memory: { serverUrl: MCP_URL } } }, null, 2))}
${copyBox(HOOK_INSTALL)}
${copyPre("~/.gemini/config/hooks.json (or .agents/hooks.json)", ANTIGRAVITY_HOOKS_JSON)}`,
  },
  {
    id: "grok", logo: "grok", name: "Grok", sub: "grok.com", tag: "Connector",
    body: `<ol class="steps"><li><span><span class="k">MCP:</span> Open <a href="https://grok.com/connectors" rel="noopener noreferrer" target="_blank">grok.com/connectors</a>, choose <span class="k">Custom</span>, and paste the URL.</span></li>
<li><span><span class="k">Login:</span> Click <span class="k">Connect</span> and open the sign-in link in your email.</span></li>
<li><span><span class="k">Confirm:</span> Ask Grok to call <code>register_agent</code> and save a first note with <code>remember</code>.</span></li>
<li><span><span class="k">Rules:</span> Paste the <a href="https://heyclyde.me/docs#instructions">Clyde rule</a> into <span class="k">Customize Grok</span>.</span></li>
<li><span><span class="k">Restart:</span> Open a new Grok chat so Customize Grok applies.</span></li></ol>${copyBox(MCP_URL)}`,
  },
  {
    id: "other", logo: "other", name: "Other agents", sub: "Anything that speaks MCP", tag: "Remote MCP",
    body: `<ol class="steps"><li><span><span class="k">MCP:</span> Add a remote MCP server with this URL.</span></li>
<li><span><span class="k">Login:</span> Click the email sign-in link, or send <span class="k">Authorization: Bearer</span> plus <code>~/.config/memory/token</code> on headless hosts.</span></li>
<li><span><span class="k">Confirm:</span> Call <code>register_agent</code> and save a first note with <code>remember</code> to confirm a note ID returns.</span></li>
<li><span><span class="k">Hooks &amp; rules:</span> Wire <code>clyde-hook.sh</code> if your client supports shell hooks and paste the <a href="https://heyclyde.me/docs#instructions">Clyde rule</a> into its system prompt.</span></li>
<li><span><span class="k">Restart:</span> Restart your client so MCP, hooks, and rules load.</span></li></ol>
${copyPre("mcp.json", JSON.stringify({ mcpServers: { clyde: { url: MCP_URL } } }, null, 2))}`,
  },
  {
    id: "claude-code", logo: "claude-code", name: "Claude Code and Codex", sub: "Terminal agents + hooks", tag: "CLI + hooks",
    body: `<ol class="steps"><li><span><span class="k">MCP &amp; login:</span> Run the installer below and click the email sign-in link to wire MCP and mint <code>~/.config/memory/token</code>.</span></li>
<li><span><span class="k">Confirm:</span> Have the agent call <code>register_agent</code> and save a first note with <code>remember</code> to confirm a note ID returns.</span></li>
<li><span><span class="k">Hooks:</span> Install <code>clyde-hook.sh</code> and merge the configs below into <code>~/.claude/settings.json</code> and <code>~/.codex/hooks.json</code> (<code>MEMORY_HOOKS=metadata</code> on work machines).</span></li>
<li><span><span class="k">Rules:</span> Add the <a href="https://heyclyde.me/docs#instructions">Clyde rule</a> to <code>~/.claude/CLAUDE.md</code> and <code>~/.codex/AGENTS.md</code>.</span></li>
<li><span><span class="k">Restart:</span> Restart Claude Code, and restart Codex CLI then run <code>/hooks</code> once to trust the new hooks.</span></li></ol>
${copyBox(INSTALL)}${copyBox(HOOK_INSTALL)}
${copyPre("~/.claude/settings.json", CLAUDE_HOOKS_JSON)}
${copyPre("~/.codex/hooks.json", CODEX_HOOKS_JSON)}`,
  },
  {
    id: "gemini", logo: "gemini", name: "Gemini app and CLI", sub: "gemini.google.com and Gemini CLI", tag: "App + hooks",
    body: `<ol class="steps"><li><span><span class="k">MCP:</span> On web, open <span class="k">Settings → Connected Apps</span> and add the URL (Google AI Ultra or US account). In Gemini CLI, run the terminal installer.</span></li>
<li><span><span class="k">Login:</span> Click the one-time sign-in link in your email.</span></li>
<li><span><span class="k">Confirm:</span> Ask Gemini to call <code>register_agent</code> and save a first note with <code>remember</code> to confirm a note ID returns.</span></li>
<li><span><span class="k">Hooks &amp; rules:</span> Save the <a href="https://heyclyde.me/docs#instructions">Clyde rule</a> in <span class="k">Settings → Saved info</span> on web. In Gemini CLI, install <code>clyde-hook.sh</code>, add <code>settings.json</code> below (or extension <code>hooks.json</code>, never both), and put the rule in <code>~/.gemini/GEMINI.md</code>.</span></li>
<li><span><span class="k">Restart:</span> Restart Gemini CLI (or open a new web chat) so hooks and rules load.</span></li></ol>
${copyBox(MCP_URL)}${copyBox(HOOK_INSTALL)}
${copyPre("~/.gemini/settings.json (Gemini CLI)", GEMINI_HOOKS_JSON)}`,
  },
  {
    id: "chatgpt", logo: "chatgpt", name: "ChatGPT", sub: "chatgpt.com", tag: "Custom connector",
    body: `<ol class="steps"><li><span><span class="k">MCP:</span> Turn on developer mode in <span class="k">Settings → Connectors</span> and add the URL.</span></li>
<li><span><span class="k">Login:</span> Connect and click the sign-in link in your email.</span></li>
<li><span><span class="k">Confirm:</span> Ask ChatGPT to call <code>register_agent</code> and save a first note with <code>remember</code>.</span></li>
<li><span><span class="k">Rules:</span> Paste the <a href="https://heyclyde.me/docs#instructions">Clyde rule</a> into <span class="k">Settings → Personalization → Custom instructions</span> (or Memory).</span></li>
<li><span><span class="k">Restart:</span> Start a new chat so Custom instructions and Clyde load together.</span></li></ol>${copyBox(MCP_URL)}`,
  },
  {
    id: "antigravity-cloud", logo: "antigravity", name: "Antigravity cloud", sub: "Headless cloud environments", tag: "Token + hooks",
    body: `<ol class="steps"><li><span><span class="k">MCP &amp; login:</span> Run the installer on a local machine first, copy <code>~/.config/memory/token</code> to cloud secrets (never git), and add <code>mcp_config.json</code>.</span></li>
<li><span><span class="k">Confirm:</span> Have the cloud agent call <code>register_agent</code> and save a first note with <code>remember</code> to confirm the token works.</span></li>
<li><span><span class="k">Hooks &amp; rules:</span> Install <code>clyde-hook.sh</code>, add <code>.agents/hooks.json</code> below, and save <code>.agents/rules/clyde.md</code> (<code>trigger: model_decision</code>).</span></li>
<li><span><span class="k">Restart:</span> Start a fresh cloud session so MCP, workspace hooks, and rules load together.</span></li></ol>
${copyPre("mcp_config.json", JSON.stringify({ mcpServers: { memory: { serverUrl: MCP_URL, headers: { Authorization: "Bearer <your device token>" } } } }, null, 2))}
${copyBox(HOOK_INSTALL)}
${copyPre(".agents/hooks.json", ANTIGRAVITY_HOOKS_JSON)}`,
  },
];

/** Apps nobody has connected to Clyde yet (no sessions from them as of 16 Nov 2026). They show a red asterisk. */
export const SOON = new Set(["gemini", "grok", "chatgpt"]);
const soon = (slug) => SOON.has(slug) ? '<span class="soon" aria-label="work in progress">*</span>' : "";
export const SOON_NOTE = `<p class="soon-note"><span class="soon">*</span> WIP, Clyde's still workin' on it</p>`;
export const WORKS = [["claude", "Claude"], ["claude-code", "Claude Code"], ["codex", "Codex"], ["gemini", "Gemini"], ["antigravity", "Antigravity"], ["grok", "Grok"], ["chatgpt", "ChatGPT"]];

export const SCENE = `<div class="scene" aria-label="The same Clyde note showing up in Claude and in Gemini">
<div class="win w1"><div class="win-top"><i class="dots"></i>Claude<span>chat</span></div><div class="body">
<div class="ask">Plan dinners for this week.</div><p class="say">You, to ChatGPT, 3 weeks ago: "I'm vegetarian. I've said this four times."</p>
<article class="cl-card cl-memory"><div class="cl-memory__top"><span class="cl-chip">Preference</span><span class="cl-state cl-state--settled">Settled</span><span class="cl-memory__conf">97% sure</span></div>
<h3 class="cl-memory__title">You're vegetarian. You called the last chicken recipe "a personal attack."</h3>
<div class="cl-prov"><span class="cl-prov__who">juniper</span><span>ChatGPT</span><span class="cl-prov__sep">/</span><span>phone</span><span class="cl-prov__sep">/</span><span>3 w ago</span></div></article>
<span class="via">${MARK(16)}from clyde</span></div></div>
<div class="win w2"><div class="win-top"><i class="dots"></i>Gemini<span>phone</span></div><pre><b>›</b> make the grocery list
<i>clyde</i> recall "diet" <b>→</b> 1 note
  Vegetarian. Chicken is "a personal attack."
<b>›</b> tofu, chickpeas, halloumi. no chicken.</pre></div></div>`;

/** One app from APPS by id: its logo slug, its name with the red asterisk when it's in SOON, and its install steps.
 * The picker on heyclyde.me's home page shows these, so the steps are written once. */
export const appSteps = (id) => { const a = APPS.find((x) => x.id === id); return { id, logo: a.logo, name: esc(a.name) + soon(a.logo), body: a.body }; };

/** One card per app with its install steps. The connect page and heyclyde.me/docs both show them in a mosaic. */
export const appCards = () => APPS.map((a) => `<article class="${a.sticky ? "cl-sticky" : "cl-card"} app" data-app="${a.id}" id="${a.id}"><div class="app-head"><span class="app-logo">${appLogo(a.logo)}</span>
<div><h3 class="cl-title-3">${esc(a.name)}${soon(a.logo)}</h3><p class="sub">${esc(a.sub)}</p></div><span class="cl-chip${a.sticky ? " cl-chip--carbon" : ""}">${esc(a.tag)}</span></div>${a.body}</article>`).join("\n");

export function homePage(nonce) {
  const cards = appCards();
  const works = WORKS.map(([slug, name]) => `<li>${APP_LOGO[slug] ? appLogo(slug, 20) : ""}${name}${soon(slug)}</li>`).join("");
  const body = `<header class="bar wrap">${WORDMARK}<nav class="topnav"><a href="https://heyclyde.me/">Home</a><a href="#apps">Apps</a><a href="https://heyclyde.me/docs#hooks">Hooks &amp; rules</a><a href="#how">How it works</a></nav>
<span class="cl-status" id="status" role="status">Checking</span></header>
<main>
<section class="hero wrap"><div class="hero-text"><span class="cl-label">Get Clyde</span>
<h1 class="cl-display">Connect your <em class="cl-scribble">apps</em></h1>
<p class="cl-lead">Add one MCP URL to each app, then sign in with the link Clyde emails you.</p>
<div class="cl-sticky cl-sticky--tilt hero-note"><b>Use with caution.</b> Put normal context and preferences in it.</div>
<div class="cta"><a class="cl-btn cl-btn--primary cl-btn--lg" href="#apps">Pick your app</a><a class="cl-btn cl-btn--ghost cl-btn--lg" href="https://heyclyde.me/docs#hooks">Set up hooks &amp; rules</a></div>
<div class="works"><span class="cl-label">Connects to</span><ul>${works}</ul>${SOON_NOTE}</div></div><div class="hero-art">${SCENE_IMG("relay", "Clyde passing a sticky note from a chat window to a terminal", 484, 280)}</div></section>
<section class="wrap" id="apps"><div class="apps-head"><div class="section"><span class="cl-label">Connect</span><h2 class="cl-title-1">Pick your app</h2>
<p class="cl-lead">Every supported app takes the same URL or one terminal installer.</p></div>
<div class="cl-field"><span class="cl-field__label">Server URL</span>${copyBox(MCP_URL)}</div></div>
<div class="apps">${cards}</div></section>
<section class="wrap" id="how"><div class="section"><span class="cl-label">Authentication</span><h2 class="cl-title-1">OAuth + magic link</h2></div>
<ol class="how">
<li>Paste the URL or run the installer. Apps register via OAuth, or the installer saves a device token. No manual API key needed.</li>
<li>Enter your email and click the sign-in link Clyde sends you, on your phone or computer.</li>
<li>Clyde refuses callbacks from anything except Claude, ChatGPT, Antigravity, Gemini, Grok, or localhost.</li>
</ol></section></main>${footer}`;
  return shell({ nonce, title: "Connect · Clyde", css: HOME_CSS, body, script: COPY_JS + STATUS_JS });
}
