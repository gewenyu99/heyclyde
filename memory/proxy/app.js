// Authenticated heyclyde.me app pages (R51-R65): /memories, /entries/<id>, /graph, /quests, /agents, /apps, /usage, /settings, /invite.
// Read-only workspace by design: every write, edit, quest, and agent configuration happens through MCP tool calls.
// Self-contained ES module with nonce'd CSS and vanilla client script, zero external scripts, zero inline style attrs,
// zero slop, and zero matches of /\bmemory\b/i in visible copy.
import { AUTH_PROVIDERS, OR_RULE, providerButton } from "../design/auth.js";
import { AUTH_CSS } from "../design/css.js";
import { appLogo, DESIGN_URL, esc, INSTALL, LEGAL, LOGO, MARK, MCP_URL, SCENE_IMG, shell } from "./pages.js";
import { socialClient } from "./social.js";

const APP_ROUTES = [
  ["/memories", "Notes"],
  ["/graph", "Graph"],
  ["/quests", "Quests"],
  ["/agents", "Agents"],
  ["/apps", "Apps"],
  ["/usage", "Usage"],
  ["/settings", "Settings"],
];

const APP_CSS = `
.app-wrap{flex:1;padding-block:12px 64px;display:grid;gap:20px;align-content:start}
.app-nav{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.app-nav .cl-nav__item{width:auto;flex:none}
.app-bar-user{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font:var(--cl-text-small);color:var(--cl-ink-2)}
.app-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;padding-bottom:14px;border-bottom:1.5px dashed var(--cl-rule-strong)}
.app-head h1{margin:4px 0 0}
.app-head-acts{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.app-grid{display:grid;gap:16px}
.app-cols-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.app-cols-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:start}
@media (max-width:900px){.app-cols-3{grid-template-columns:minmax(0,1fr)}}
@media (max-width:720px){.app-cols-2{grid-template-columns:minmax(0,1fr)}}
.app-filters{display:grid;grid-template-columns:minmax(0,2fr) repeat(5,minmax(0,1fr)) auto;gap:10px;align-items:end;padding:16px}
@media (max-width:980px){.app-filters{grid-template-columns:repeat(2,minmax(0,1fr))}}
.app-form{display:grid;gap:14px;padding:20px}
.app-form-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.app-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.app-meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.app-body{margin:0;white-space:pre-wrap;font:var(--cl-text-body);color:var(--cl-ink)}
.app-table-wrap{overflow-x:auto;border:1px solid var(--cl-rule);border-radius:var(--cl-radius-lg);background:var(--cl-paper-1)}
.app-table{width:100%;border-collapse:collapse;font:var(--cl-text-small);color:var(--cl-ink-2)}
.app-table th,.app-table td{text-align:left;vertical-align:top;padding:10px 14px;border-top:1px dashed var(--cl-rule)}
.app-table thead th{border-top:0;font:var(--cl-text-label);text-transform:uppercase;letter-spacing:.06em;color:var(--cl-ink-3);background:var(--cl-paper-0)}
.meter-list{display:grid;gap:12px}
.meter-row{display:grid;gap:8px;padding:16px}
.meter-top{display:flex;justify-content:space-between;gap:12px;align-items:baseline;flex-wrap:wrap}
.meter-bar{width:100%;height:10px;border:1px solid var(--cl-rule-strong);border-radius:var(--cl-radius-pill);background:var(--cl-paper-2);overflow:hidden;appearance:none}
.meter-bar::-webkit-progress-bar{background:var(--cl-paper-2)}
.meter-bar::-webkit-progress-value{background:var(--cl-carbon);border-radius:var(--cl-radius-pill)}
.meter-bar::-moz-progress-bar{background:var(--cl-carbon);border-radius:var(--cl-radius-pill)}
.mcp-box{display:grid;gap:10px;padding:16px 18px;border:1px solid var(--cl-rule-strong);border-radius:var(--cl-radius-lg);background:var(--cl-paper-1)}
.mcp-box--sticky{background:var(--cl-sticky);border-color:var(--cl-sticky-edge)}
.mcp-box__head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.mcp-box__title{margin:0;font:var(--cl-text-title-3)}
.mcp-box__pre{margin:0;padding:11px 13px;border:1px dashed var(--cl-rule-strong);border-radius:var(--cl-radius-md);background:var(--cl-paper-0);font:var(--cl-text-mono);font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:var(--cl-ink)}
.mcp-list{display:grid;gap:12px}
.onb-card{display:grid;gap:16px;padding:20px;border:1.5px solid var(--cl-ink);border-radius:var(--cl-radius-xl);background:var(--cl-paper-1);box-shadow:var(--cl-copy-2)}
.onb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}
.onb-head h2{margin:4px 0 0}
.onb-track{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
@media (max-width:720px){.onb-track{grid-template-columns:minmax(0,1fr)}}
.onb-pill{display:grid;gap:6px;padding:12px 14px;border:1px solid var(--cl-rule-strong);border-radius:var(--cl-radius-lg);background:var(--cl-paper-0)}
.onb-pill.is-done{border-color:var(--cl-ok);background:var(--cl-ok-wash)}
.onb-pill__top{display:flex;align-items:center;justify-content:space-between;gap:8px;font:600 13px/1.2 var(--cl-font-sans);color:var(--cl-ink)}
.onb-pill__sub{font:var(--cl-text-small);color:var(--cl-ink-2)}
.onb-tabs{display:flex;gap:8px;flex-wrap:wrap}
.onb-tab{appearance:none;display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid var(--cl-rule-strong);border-radius:var(--cl-radius-pill);background:var(--cl-paper-1);color:var(--cl-ink-2);font:600 12.5px/1.2 var(--cl-font-sans);cursor:pointer}
.onb-tab img{width:16px;height:16px;display:block}
.onb-tab.is-active{border-color:var(--cl-ink);background:var(--cl-sticky);color:var(--cl-ink);box-shadow:var(--cl-copy-1)}
.onb-panel{display:grid;gap:12px}
.inv-stage{display:grid;gap:20px;align-content:start}
.inv-top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.inv-apps{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.inv-app-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid var(--cl-rule);border-radius:var(--cl-radius-pill);background:var(--cl-paper-1);font:600 12px/1 var(--cl-font-sans);color:var(--cl-ink-2)}
.inv-app-pill img{width:15px;height:15px;display:block}
.inv-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:0;padding:0;list-style:none}
@media (max-width:900px){.inv-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:460px){.inv-tiles{grid-template-columns:minmax(0,1fr)}}
.inv-tile{display:grid;grid-template-rows:1fr auto;gap:10px;padding:14px;border:1.5px solid var(--cl-rule-strong);border-radius:var(--cl-radius-xl);background:var(--cl-paper-1);aspect-ratio:1 / 1}
.inv-tile:nth-child(2){background:var(--cl-sticky);border-color:var(--cl-sticky-edge)}
.inv-tile__art{position:relative;display:flex;align-items:center;justify-content:center;padding:8px;border:1px dashed var(--cl-rule-strong);border-radius:var(--cl-radius-md);background:var(--cl-paper-0);min-height:116px;overflow:hidden}
.inv-tile__art picture{display:flex;align-items:center;justify-content:center;width:100%;height:108px}
.inv-tile__art img{display:block;height:104px;width:auto;max-width:100%;object-fit:contain}
@media (max-width:900px){.inv-tile{aspect-ratio:auto;padding:11px;gap:8px}.inv-tile__art{min-height:82px;padding:6px}.inv-tile__art picture{height:74px}.inv-tile__art img{height:72px}}
.inv-tile__num{position:absolute;top:6px;left:6px;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;border:1.5px solid var(--cl-ink);background:var(--cl-sticky);font:700 11px/1 var(--cl-font-mono);color:var(--cl-ink)}
.inv-tile__copy{display:grid;gap:3px}
.inv-tile__copy h3{margin:0;font:700 14px/1.2 var(--cl-font-display);color:var(--cl-ink)}
.inv-tile__copy p{margin:0;font:400 12px/1.35 var(--cl-font-sans);color:var(--cl-ink-2)}
.inv-cta-row{display:flex;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap;padding-top:4px}
.inv-cta{min-width:260px;justify-content:center;font-size:16px;padding:14px 28px;box-shadow:var(--cl-copy-2)}
.inv-signup-wrap{display:grid;gap:12px;max-width:460px;width:100%;margin:0 auto}
.gr-shell{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:start}
@media (max-width:1040px){.gr-shell{grid-template-columns:minmax(0,1fr)}}
.gr-toolbar{display:grid;gap:12px;padding:14px 16px}
.gr-toolbar-top{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.gr-search-wrap{position:relative;flex:1 1 240px;min-width:200px}
.gr-results{position:absolute;left:0;right:0;top:100%;margin-top:4px;z-index:20;display:grid;max-height:260px;overflow:auto;border:1px solid var(--cl-ink);border-radius:var(--cl-radius-md);background:var(--cl-paper-1);box-shadow:var(--cl-shadow-2)}
.gr-res-btn{appearance:none;border:0;border-top:1px dashed var(--cl-rule);background:transparent;text-align:left;padding:9px 12px;cursor:pointer;display:grid;gap:2px;font:var(--cl-text-small);color:var(--cl-ink)}
.gr-res-btn:first-child{border-top:0}
.gr-res-btn:hover,.gr-res-btn:focus-visible{background:var(--cl-sticky);outline:none}
.gr-res-meta{font:var(--cl-text-mono);font-size:11px;color:var(--cl-ink-3)}
.gr-filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.gr-chip-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid var(--cl-rule-strong);border-radius:var(--cl-radius-pill);background:var(--cl-paper-0);color:var(--cl-ink-2);font:600 11.5px/1.2 var(--cl-font-mono);cursor:pointer}
.gr-chip-btn.is-on{border-color:var(--cl-ink);background:var(--cl-paper-1);color:var(--cl-ink)}
.gr-chip-btn:not(.is-on){opacity:.48;text-decoration:line-through}
.gr-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.gr-dot--relates{background:var(--cl-pen-blue)}.gr-dot--supports{background:var(--cl-pen-green)}
.gr-dot--contradicts{background:var(--cl-pen-red)}.gr-dot--supersedes{background:var(--cl-pen-amber)}
.gr-dot--part_of{background:var(--cl-pen-violet)}.gr-dot--derived_from{background:var(--cl-pen-teal)}
.gr-dot--co_used{background:var(--cl-pen-graphite)}
.gr-wrap{position:relative;border:1px solid var(--cl-rule-strong);border-radius:var(--cl-radius-xl);background:var(--cl-paper-0);overflow:hidden}
.gr-zoom{position:absolute;right:12px;top:12px;z-index:5;display:flex;gap:6px}
.gr-svg{display:block;width:100%;height:580px;cursor:grab;user-select:none;touch-action:none}
.gr-svg.is-panning{cursor:grabbing}
.gr-edge{fill:none;stroke:var(--cl-rule-strong);stroke-width:1.5;opacity:.75;transition:opacity .12s}
.gr-edge--relates{stroke:var(--cl-pen-blue)}.gr-edge--supports{stroke:var(--cl-pen-green)}
.gr-edge--contradicts{stroke:var(--cl-pen-red);stroke-dasharray:5 3}.gr-edge--supersedes{stroke:var(--cl-pen-amber);stroke-dasharray:6 2}
.gr-edge--part_of{stroke:var(--cl-pen-violet)}.gr-edge--derived_from{stroke:var(--cl-pen-teal)}
.gr-edge--co_used{stroke:var(--cl-pen-graphite);stroke-dasharray:2 4;opacity:.45}
.gr-edge.is-dim{opacity:.08}.gr-edge.is-hi{opacity:1;stroke-width:2.5}
.gr-node{cursor:pointer}
.gr-node circle{stroke:var(--cl-paper-1);stroke-width:2;fill:var(--cl-pen-blue);transition:opacity .12s,stroke-width .12s}
.gr-node .gr-hit{fill:transparent;stroke:none}
.gr-node--decisions circle{fill:var(--cl-pen-blue)}.gr-node--projects circle{fill:var(--cl-pen-violet)}
.gr-node--preferences circle{fill:var(--cl-pen-amber)}.gr-node--observations circle{fill:var(--cl-pen-teal)}
.gr-node--references circle{fill:var(--cl-pen-green)}.gr-node--recommendations circle{fill:var(--cl-pen-green)}
.gr-node--reactions circle{fill:var(--cl-pen-red)}.gr-node--other circle{fill:var(--cl-pen-graphite)}
.gr-node.is-center circle{stroke:var(--cl-ink);stroke-width:3}
.gr-node.is-selected circle{stroke:var(--cl-ink);stroke-width:3.5}
.gr-node.is-dormant circle{opacity:.55;stroke-dasharray:3 2}
.gr-node text{font:600 11px/1.2 var(--cl-font-sans);fill:var(--cl-ink);paint-order:stroke;stroke:var(--cl-paper-0);stroke-width:3px;stroke-linejoin:round}
.gr-node.is-label-hide text{display:none}
.gr-node.is-dim{opacity:.16}
.gr-node.is-hi text{display:block}
.gr-inspector{display:grid;gap:14px;padding:18px;align-content:start}
.gr-inspector h3{margin:0;font:var(--cl-text-title-3)}
.gr-ins-body{margin:0;font:var(--cl-text-small);color:var(--cl-ink-2);white-space:pre-wrap;max-height:220px;overflow:auto}
.gr-ins-links{display:grid;gap:6px;max-height:200px;overflow:auto}
.gr-ins-link{appearance:none;border:1px solid var(--cl-rule);border-radius:var(--cl-radius-sm);background:var(--cl-paper-0);padding:6px 9px;text-align:left;cursor:pointer;font:var(--cl-text-small);color:var(--cl-ink);display:flex;justify-content:space-between;gap:8px;align-items:center}
.gr-ins-link:hover{border-color:var(--cl-ink);background:var(--cl-sticky)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media (max-width:640px){.bar{flex-wrap:wrap;gap:12px 16px}.app-nav{order:3;flex-basis:100%}}
.signin-box{max-width:460px;margin:12px auto;display:grid;gap:16px;padding:24px}
.app-banner{padding:12px 16px;border-radius:var(--cl-radius-md);font:var(--cl-text-small)}
.app-banner--ok{background:var(--cl-ok-wash);color:var(--cl-ok)}
.app-banner--bad{background:var(--cl-bad-wash);color:var(--cl-bad)}
.app-banner--warn{background:var(--cl-warn-wash);color:var(--cl-warn)}
.is-hidden{display:none}
.app-qcol{display:grid;gap:12px}
.app-qcol-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-bottom:6px;border-bottom:1px dashed var(--cl-rule-strong)}
.agent-card{display:grid;gap:12px;padding:18px}
`;

const PAGE_SPEC = {
  entries: { title: "Notes · Clyde", heading: "Notes", sub: "Read-only view of notes from your agents. Copy an MCP prompt to save, replace, or link a note." },
  entry: { title: "Note · Clyde", heading: "Note detail", sub: "Inspect provenance, artifacts, links, and confidence history. Manage this note through your connected agent." },
  graph: { title: "Graph · Clyde", heading: "Graph", sub: "See how your notes connect. Pan, zoom, drag nodes, and filter by link type." },
  quests: { title: "Quest board · Clyde", heading: "Quest board", sub: "Track open, claimed, and finished agent tasks. Post or claim quests through MCP." },
  agents: { title: "Agents and devices · Clyde", heading: "Agents and devices", sub: "Connect a new agent or inspect registered agents and devices. Updates happen through register_agent." },
  apps: { title: "Connected apps · Clyde", heading: "Connected apps", sub: "See which client apps hold OAuth access to your Clyde notebook." },
  usage: { title: "Usage and billing · Clyde", heading: "Usage and billing", sub: "Check your plan, monthly usage meters, and billing status." },
  settings: { title: "Settings · Clyde", heading: "Settings", sub: "Clyde is read-only on the web. Check your endpoint details and copy MCP prompts below." },
  callback: { title: "Signing in · Clyde", heading: "Signing in", sub: "Finishing your Google or GitHub sign-in." },
  invite: { title: "You're invited · Clyde", heading: "Shared notes for Claude, Antigravity, and ChatGPT", sub: "Connect Clyde once so your agents recall past chats and save new decisions automatically." },
};

const PROVIDER_BUTTONS = Object.fromEntries(AUTH_PROVIDERS.map((p) => [p, providerButton(p)]));
const INVITE_ART = {
  standing: SCENE_IMG("standing", "Clyde holding a sticky note ready to connect", 92, 112),
  relay: SCENE_IMG("relay", "Clyde passing a sticky note from a chat window to a terminal", 156, 90),
  goldfish: SCENE_IMG("goldfish", "Clyde staring at a goldfish in a bowl", 96, 112),
  questboard: SCENE_IMG("questboard", "Clyde pointing at a board of sticky notes", 98, 110),
};
const CLIENT_ICONS = {
  antigravity: appLogo("antigravity", 16),
  "claude-code": appLogo("claude-code", 16),
  claude: appLogo("claude", 16),
  chatgpt: appLogo("chatgpt", 16),
};

const APP_JS = `(function(){
var root = document.getElementById('app-root');
if (!root) return;
var view = root.getAttribute('data-view');
var entryId = root.getAttribute('data-id') || '';
var STORE = 'clyde_session_v1';
var MCP_ENDPOINT = ${JSON.stringify(MCP_URL)};
var INSTALL_CMD = ${JSON.stringify(INSTALL)};
var INVITE_ART = ${JSON.stringify(INVITE_ART).replace(/</g, "\\u003c")};
var CLIENT_ICONS = ${JSON.stringify(CLIENT_ICONS).replace(/</g, "\\u003c")};
var PROVIDER_BUTTONS = ${JSON.stringify(PROVIDER_BUTTONS).replace(/</g, "\\u003c")};
var OR_RULE = ${JSON.stringify(OR_RULE).replace(/</g, "\\u003c")};
function __name(f) { return f; }
var social = (${socialClient.toString()})(window);
var afterSignIn = view === 'callback' ? '/memories' : (view === 'invite' ? '/memories?onboarding=1' : location.pathname + location.search);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
  });
}

function copyText(text, btn) {
  var done = function() {
    if (!btn) return;
    var old = btn.getAttribute('data-label') || btn.textContent;
    btn.setAttribute('data-label', old);
    btn.textContent = 'Copied';
    setTimeout(function() { btn.textContent = old; }, 1600);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(function() {
      fallbackCopy(text);
      done();
    });
  } else {
    fallbackCopy(text);
    done();
  }
}

function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.className = 'sr-only';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  ta.remove();
}

if (document.addEventListener) document.addEventListener('click', function(ev) {
  var btn = ev.target && ev.target.closest ? ev.target.closest('[data-copy]') : null;
  if (!btn) return;
  copyText(btn.getAttribute('data-copy') || '', btn);
});

function mcpCard(title, hint, tool, prompt, sticky, btnLabel) {
  return '<section class="mcp-box' + (sticky ? ' mcp-box--sticky' : '') + '">' +
    '<div class="mcp-box__head">' +
      '<div class="app-meta"><h3 class="mcp-box__title">' + esc(title) + '</h3>' +
      (tool ? '<span class="cl-chip cl-chip--carbon">MCP: ' + esc(tool) + '</span>' : '') + '</div>' +
      '<button type="button" class="cl-btn cl-btn--sm" data-copy="' + esc(prompt) + '">' + esc(btnLabel || 'Copy prompt') + '</button>' +
    '</div>' +
    (hint ? '<p class="cl-hint">' + esc(hint) + '</p>' : '') +
    '<pre class="mcp-box__pre">' + esc(prompt) + '</pre>' +
  '</section>';
}

function readSession() {
  try {
    var raw = localStorage.getItem(STORE);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function writeSession(data) {
  if (!data || !data.access_token) {
    try { localStorage.removeItem(STORE); } catch (e) {}
    updateUserBar(null);
    return null;
  }
  var user = data.user || {};
  var s = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || '',
    email: user.email || data.email || '',
    user_id: user.id || data.user_id || '',
    expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : (data.expires_at || Date.now() + 3000000)
  };
  try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (e) {}
  updateUserBar(s);
  return s;
}

function updateUserBar(s) {
  var bar = document.getElementById('app-user-bar');
  if (!bar) return;
  var inviteUrl = location.origin + '/invite';
  if (!s) {
    bar.innerHTML = '<a class="cl-btn cl-btn--primary cl-btn--sm" href="/invite">Get started</a>' +
      '<a class="cl-btn cl-btn--sm" href="/memories">Sign in</a>';
    return;
  }
  bar.innerHTML =
    '<button type="button" class="cl-btn cl-btn--sm" data-copy="' + esc(inviteUrl) + '">Copy invite link</button>' +
    '<span>' + esc(s.email || 'Signed in') + '</span>' +
    '<button type="button" class="cl-btn cl-btn--sm cl-btn--ghost" id="btn-signout">Sign out</button>';
  var out = document.getElementById('btn-signout');
  if (out) out.addEventListener('click', function() {
    var tok = s.access_token;
    writeSession(null);
    if (tok) fetch('/auth/v1/logout?scope=local', { method: 'POST', headers: { authorization: 'Bearer ' + tok } }).catch(function(){});
    renderSignIn();
  });
}

function parseCallbackHash() {
  var h = (location.hash || '').replace(/^#/, '');
  if (!h) return false;
  var p = new URLSearchParams(h);
  var tok = p.get('access_token');
  if (!tok) return false;
  writeSession({
    access_token: tok,
    refresh_token: p.get('refresh_token') || '',
    expires_in: Number(p.get('expires_in') || 3600)
  });
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

async function refreshSession(s) {
  if (!s || !s.refresh_token) return null;
  var r = await fetch('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: s.refresh_token })
  });
  if (!r.ok) { writeSession(null); return null; }
  var d = await r.json();
  return writeSession(d);
}

async function api(path, opts) {
  opts = opts || {};
  var s = readSession();
  if (!s) { renderSignIn(); throw new Error('Sign in required.'); }
  if (s.expires_at && Date.now() > s.expires_at - 30000 && s.refresh_token) {
    s = (await refreshSession(s)) || s;
  }
  var headers = Object.assign({ authorization: 'Bearer ' + s.access_token }, opts.headers || {});
  if (opts.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
  var r = await fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body });
  if (r.status === 401 && s.refresh_token) {
    var fresh = await refreshSession(s);
    if (fresh) {
      headers.authorization = 'Bearer ' + fresh.access_token;
      r = await fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body });
    }
  }
  if (r.status === 401) {
    writeSession(null);
    renderSignIn('Your session expired. Sign in again.');
    throw new Error('Unauthorized');
  }
  if (opts.raw) return r;
  var text = await r.text();
  var data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { error: text }; }
  if (!r.ok) throw new Error(data.error || ('Request failed (HTTP ' + r.status + '). Try again.'));
  return data;
}

function notice(el, kind, msg) {
  if (!el) return;
  el.className = 'app-banner app-banner--' + kind;
  el.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
  el.setAttribute('aria-live', kind === 'bad' ? 'assertive' : 'polite');
  el.textContent = msg;
}

function clearNotice(el) {
  if (!el) return;
  el.className = 'is-hidden';
  el.textContent = '';
}

function renderSignIn(msg) {
  root.innerHTML =
    '<section class="cl-card signin-box">' +
      '<h2 class="cl-title-2">Sign in to Clyde</h2>' +
      '<p class="cl-hint">Enter your email for a sign-in link or code, or use a password if your account has one. New here? <a class="cl-link" href="/invite">Create an account</a>.</p>' +
      '<div id="sign-msg" class="' + (msg ? 'app-banner app-banner--bad' : 'is-hidden') + '">' + esc(msg || '') + '</div>' +
      '<div id="sign-providers" class="is-hidden"></div>' +
      '<form id="otp-req" class="app-grid">' +
        '<div class="cl-field"><label for="s-email">Email</label><input id="s-email" class="cl-input" type="email" required placeholder="you@example.com" autocomplete="email"></div>' +
        '<div class="app-actions"><button type="submit" class="cl-btn cl-btn--primary" id="btn-send-code">Send sign-in email</button>' +
        '<button type="button" class="cl-btn cl-btn--ghost" id="btn-toggle-pw">Use password instead</button></div>' +
      '</form>' +
      '<form id="otp-verify" class="app-grid is-hidden">' +
        '<div class="cl-field"><label for="s-code">One-time code</label><input id="s-code" class="cl-input" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="123456"></div>' +
        '<button type="submit" class="cl-btn cl-btn--primary">Verify code</button>' +
      '</form>' +
      '<form id="pw-form" class="app-grid is-hidden">' +
        '<div class="cl-field"><label for="s-pw">Password</label><input id="s-pw" class="cl-input" type="password" autocomplete="current-password"></div>' +
        '<button type="submit" class="cl-btn cl-btn--primary">Sign in with password</button>' +
      '</form>' +
    '</section>';
  var banner = document.getElementById('sign-msg');
  var emailEl = document.getElementById('s-email');
  showProviders(document.getElementById('sign-providers'), banner);
  var otpVerify = document.getElementById('otp-verify');
  var pwForm = document.getElementById('pw-form');

  document.getElementById('btn-toggle-pw').addEventListener('click', function() {
    pwForm.classList.toggle('is-hidden');
  });

  document.getElementById('otp-req').addEventListener('submit', async function(e) {
    e.preventDefault();
    clearNotice(banner);
    var email = emailEl.value.trim();
    try {
      var r = await fetch('/auth/v1/otp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email, email_redirect_to: location.origin + location.pathname })
      });
      var d = await r.json().catch(function() { return {}; });
      if (!r.ok) throw new Error(d.error_description || d.msg || d.error || "Couldn't send the sign-in email. Check your address and try again.");
      otpVerify.classList.remove('is-hidden');
      notice(banner, 'ok', 'Sign-in email sent. Click the link in your inbox, or paste the 6-digit code below if included.');
    } catch (err) {
      notice(banner, 'bad', err.message);
    }
  });

  otpVerify.addEventListener('submit', async function(e) {
    e.preventDefault();
    clearNotice(banner);
    var email = emailEl.value.trim();
    var token = document.getElementById('s-code').value.trim();
    try {
      var r = await fetch('/auth/v1/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'email', email: email, token: token })
      });
      var d = await r.json().catch(function() { return {}; });
      if (!r.ok || !d.access_token) throw new Error(d.error_description || d.msg || d.error || "That code didn't work or expired. Request a new sign-in email and try again.");
      writeSession(d);
      start();
    } catch (err) {
      notice(banner, 'bad', err.message);
    }
  });

  pwForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    clearNotice(banner);
    var email = emailEl.value.trim();
    var password = document.getElementById('s-pw').value;
    try {
      var r = await fetch('/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email, password: password })
      });
      var d = await r.json().catch(function() { return {}; });
      if (!r.ok || !d.access_token) throw new Error(d.error_description || d.msg || d.error || "Email or password didn't match. Check both and try again.");
      writeSession(d);
      start();
    } catch (err) {
      notice(banner, 'bad', err.message);
    }
  });
}

function renderInvite() {
  var s = readSession();
  var sp = new URLSearchParams(location.search);
  var from = (sp.get('from') || '').trim().slice(0, 40);
  var step = sp.get('step') === 'signup' ? 'signup' : 'intro';
  var alreadyBanner = s
    ? '<div class="app-banner app-banner--ok">You\\'re signed in as ' + esc(s.email || 'your account') + '. <a class="cl-link" href="/memories?onboarding=1">Open onboarding</a></div>'
    : '';

  if (step === 'intro') {
    root.innerHTML =
      alreadyBanner +
      '<div class="inv-stage">' +
        '<div class="inv-top">' +
          (from ? '<span class="cl-chip cl-chip--carbon">Invited by ' + esc(from) + '</span>' : '<span class="cl-chip cl-chip--carbon">Shared notebook for your AI agents</span>') +
          '<div class="inv-apps">' +
            '<span class="inv-app-pill">' + CLIENT_ICONS.antigravity + 'Antigravity</span>' +
            '<span class="inv-app-pill">' + CLIENT_ICONS.claude + 'Claude</span>' +
            '<span class="inv-app-pill">' + CLIENT_ICONS.chatgpt + 'ChatGPT / Codex</span>' +
          '</div>' +
        '</div>' +
        '<ol class="inv-tiles">' +
          '<li class="inv-tile">' +
            '<div class="inv-tile__art"><span class="inv-tile__num">1</span>' + INVITE_ART.standing + '</div>' +
            '<div class="inv-tile__copy"><h3>Connect once</h3><p>One command sets up MCP and hooks, or connect by OAuth URL.</p></div>' +
          '</li>' +
          '<li class="inv-tile">' +
            '<div class="inv-tile__art"><span class="inv-tile__num">2</span>' + INVITE_ART.relay + '</div>' +
            '<div class="inv-tile__copy"><h3>Recall and save</h3><p>Agents pull past notes into new chats and save new decisions.</p></div>' +
          '</li>' +
          '<li class="inv-tile">' +
            '<div class="inv-tile__art"><span class="inv-tile__num">3</span>' + INVITE_ART.goldfish + '</div>' +
            '<div class="inv-tile__copy"><h3>No blank slates</h3><p>Short notes load fast in new chats. Full specs open only when needed.</p></div>' +
          '</li>' +
          '<li class="inv-tile">' +
            '<div class="inv-tile__art"><span class="inv-tile__num">4</span>' + INVITE_ART.questboard + '</div>' +
            '<div class="inv-tile__copy"><h3>Read-only web UI</h3><p>No forms to fill out. Your agents handle every note edit and quest.</p></div>' +
          '</li>' +
        '</ol>' +
        '<div class="inv-cta-row">' +
          '<button type="button" class="cl-btn cl-btn--primary cl-btn--lg inv-cta" id="btn-inv-start">Create your account</button>' +
          '<a class="cl-link" href="/memories">Already have an account? Sign in</a>' +
        '</div>' +
      '</div>';

    var goBtn = document.getElementById('btn-inv-start');
    if (goBtn) goBtn.addEventListener('click', function() {
      var nextQs = new URLSearchParams(location.search);
      nextQs.set('step', 'signup');
      history.pushState(null, '', '/invite?' + nextQs.toString());
      renderInvite();
    });
    return;
  }

  root.innerHTML =
    alreadyBanner +
    '<div class="inv-signup-wrap">' +
      '<div><button type="button" class="cl-btn cl-btn--sm cl-btn--ghost" id="btn-inv-back">Back to overview</button></div>' +
      '<section class="cl-card app-form">' +
        '<h2 class="cl-title-2">Create your account</h2>' +
        '<p class="cl-hint">Sign up with Google, GitHub, or email. Next, you\\'ll connect your first agent and test it with one prompt.</p>' +
        '<div id="inv-msg" class="is-hidden"></div>' +
        '<div id="inv-providers" class="is-hidden"></div>' +
        '<form id="inv-email-form" class="app-grid">' +
          '<div class="cl-field"><label for="inv-email">Email</label><input id="inv-email" class="cl-input" type="email" required placeholder="you@example.com" autocomplete="email"></div>' +
          '<button type="submit" class="cl-btn cl-btn--primary" id="btn-inv-send">Send sign-up link</button>' +
        '</form>' +
        '<form id="inv-otp-form" class="app-grid is-hidden">' +
          '<div class="cl-field"><label for="inv-code">One-time code</label><input id="inv-code" class="cl-input" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="123456"></div>' +
          '<button type="submit" class="cl-btn cl-btn--primary">Verify code and continue</button>' +
        '</form>' +
      '</section>' +
    '</div>';

  var backBtn = document.getElementById('btn-inv-back');
  if (backBtn) backBtn.addEventListener('click', function() {
    var backQs = new URLSearchParams(location.search);
    backQs.delete('step');
    var q = backQs.toString();
    history.pushState(null, '', '/invite' + (q ? '?' + q : ''));
    renderInvite();
  });

  var banner = document.getElementById('inv-msg');
  var emailEl = document.getElementById('inv-email');
  var otpForm = document.getElementById('inv-otp-form');
  afterSignIn = '/memories?onboarding=1';
  showProviders(document.getElementById('inv-providers'), banner);

  document.getElementById('inv-email-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    clearNotice(banner);
    var email = emailEl.value.trim();
    var btn = document.getElementById('btn-inv-send');
    btn.disabled = true;
    try {
      var r = await fetch('/invite/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email })
      });
      var d = await r.json().catch(function() { return {}; });
      if (!r.ok) throw new Error(d.error || "Couldn't send the sign-up link. Check your email and try again.");
      otpForm.classList.remove('is-hidden');
      notice(banner, 'ok', 'Sign-up link sent to ' + email + '. Click the link in your inbox, or enter the 6-digit code below.');
    } catch (err) {
      notice(banner, 'bad', err.message);
    } finally {
      btn.disabled = false;
    }
  });

  otpForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    clearNotice(banner);
    var email = emailEl.value.trim();
    var token = document.getElementById('inv-code').value.trim();
    try {
      var r = await fetch('/auth/v1/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'email', email: email, token: token })
      });
      var d = await r.json().catch(function() { return {}; });
      if (!r.ok || !d.access_token) throw new Error(d.error_description || d.msg || d.error || "That code didn't match or expired. Send a new sign-up link and try again.");
      writeSession(d);
      location.replace('/memories?onboarding=1');
    } catch (err) {
      notice(banner, 'bad', err.message);
    }
  });
}

if (window.addEventListener) window.addEventListener('popstate', function() {
  if (view === 'invite') renderInvite();
});

async function showProviders(box, banner) {
  var on = [];
  try {
    var r = await fetch('/auth/v1/settings');
    var d = r.ok ? await r.json() : {};
    on = Object.keys(PROVIDER_BUTTONS).filter(function(p) { return d && d.external && d.external[p] === true; });
  } catch (e) { on = []; }
  if (!box || !on.length) return;
  box.className = 'app-grid';
  box.innerHTML = '<div class="cl-auth-providers">' + on.map(function(p) { return PROVIDER_BUTTONS[p]; }).join('') + '</div>' + OR_RULE;
  box.querySelectorAll('[data-provider]').forEach(function(b) {
    b.addEventListener('click', async function() {
      clearNotice(banner);
      b.setAttribute('aria-busy', 'true');
      try { await social.begin(b.getAttribute('data-provider'), afterSignIn); }
      catch (err) { b.removeAttribute('aria-busy'); notice(banner, 'bad', err.message || "Couldn't start that sign-in. Try again."); }
    });
  });
}

async function finishProviderSignIn() {
  var search = location.search;
  history.replaceState(null, '', '/auth/callback');
  root.innerHTML = '<p class="cl-hint" role="status">Finishing sign-in...</p>';
  var res = await social.finish(search);
  if (!res.ok) {
    afterSignIn = res.next;
    writeSession(null);
    renderSignIn(res.message);
    return;
  }
  writeSession(res.session);
  location.replace(res.next);
}

function confText(c) {
  return Math.round((Number(c == null ? 0.5 : c)) * 100) + '%';
}

function stateBadge(n) {
  if (n.superseded_by) return '<span class="cl-state cl-state--superseded">Superseded</span>';
  if (Number(n.confidence) < 0.15) return '<span class="cl-state cl-state--dormant">Pruned</span>';
  return '<span class="cl-state cl-state--settled">Active</span>';
}

function buildOnboardingHtml(ob, activeTab) {
  var s1 = ob.agents > 0;
  var s2 = ob.entries > 0;
  var s3 = ob.recalls > 0;
  var doneCount = (s1 ? 1 : 0) + (s2 ? 1 : 0) + (s3 ? 1 : 0);
  var allDone = doneCount === 3;
  var tab = activeTab || 'antigravity';

  var agentName = tab === 'antigravity' ? 'antigravity-main' : (tab === 'chatgpt' ? 'codex-main' : 'claude-main');
  var surfaceName = tab === 'antigravity' ? 'Antigravity' : (tab === 'claude-code' ? 'claude-code' : (tab === 'chatgpt' ? 'codex' : 'claude.ai'));
  var allInOnePrompt =
    'Run all three Clyde onboarding checks in order:\\n' +
    '1. Call Clyde register_agent with name "' + agentName + '", context "both", surface "' + surfaceName + '", and a short description of what you help me with.\\n' +
    '2. Call Clyde remember to save a test note: pattern "observations", title "Clyde setup check", body "Connected my first agent and verified saving a note over MCP.", evidence "Onboarding verification".\\n' +
    '3. Call Clyde recall with query "Clyde setup check", then call get_entry on the returned note id to verify full details load.\\n' +
    'Reply with the registered agent name, saved note id, and retrieved note title.';

  var connectBlock = '';
  if (tab === 'antigravity') {
    connectBlock =
      '<p class="cl-hint">Run this in your terminal, then restart Antigravity and sign in when asked. It adds Clyde MCP to <code>~/.gemini/config/mcp_config.json</code>, installs hooks in <code>~/.gemini/config/hooks.json</code>, and adds the Clyde rule to <code>~/.gemini/GEMINI.md</code>.</p>' +
      mcpCard('1. Install Antigravity MCP + hooks', 'Adds Clyde MCP, hooks, and the Clyde rule for Antigravity.', '', INSTALL_CMD, false, 'Copy command');
  } else if (tab === 'claude-code') {
    connectBlock =
      '<p class="cl-hint">Run this in your terminal, then restart Claude Code. It adds Clyde MCP to <code>~/.claude.json</code>, installs hooks in <code>~/.claude/settings.json</code>, and adds the Clyde rule to <code>~/.claude/CLAUDE.md</code>.</p>' +
      mcpCard('1. Install Claude Code MCP + hooks', 'Sets up MCP, hooks, and device sign-in in one command.', '', INSTALL_CMD, false, 'Copy command');
  } else if (tab === 'chatgpt') {
    connectBlock =
      '<p class="cl-hint">For <strong>Codex</strong> (desktop app or CLI), run the installer below, then run <code>/hooks</code> in Codex once to trust the hooks. Or connect without hooks using <code>codex mcp add clyde --url https://heyclyde.me/mcp &amp;&amp; codex mcp login clyde</code>. For <strong>chatgpt.com</strong>, turn on Developer mode in <strong>Settings / Connectors</strong> and add the URL below with OAuth.</p>' +
      mcpCard('1. Install Codex MCP + hooks', 'Adds Clyde to ~/.codex/config.toml, ~/.codex/hooks.json, and ~/.codex/AGENTS.md.', '', INSTALL_CMD, false, 'Copy command') +
      mcpCard('Or connect ChatGPT web over OAuth', 'Paste into ChatGPT Settings / Connectors with OAuth.', 'OAuth URL', MCP_ENDPOINT, false, 'Copy URL');
  } else {
    connectBlock =
      '<p class="cl-hint">In Claude (web, desktop, or mobile), open <strong>Settings / Connectors / Add custom connector</strong>, paste the URL below, click Add, then click Connect and sign in with the same account.</p>' +
      mcpCard('1. Add Claude custom connector', 'Paste into Claude Settings / Connectors.', 'OAuth URL', MCP_ENDPOINT, false, 'Copy URL');
  }

  var setupBody =
    '<div class="onb-tabs" role="tablist" aria-label="Choose your client">' +
      '<button type="button" class="onb-tab' + (tab === 'antigravity' ? ' is-active' : '') + '" data-onb-tab="antigravity">' + CLIENT_ICONS.antigravity + 'Antigravity</button>' +
      '<button type="button" class="onb-tab' + (tab === 'claude-code' ? ' is-active' : '') + '" data-onb-tab="claude-code">' + CLIENT_ICONS['claude-code'] + 'Claude Code</button>' +
      '<button type="button" class="onb-tab' + (tab === 'claude-web' ? ' is-active' : '') + '" data-onb-tab="claude-web">' + CLIENT_ICONS.claude + 'Claude (Web / Desktop)</button>' +
      '<button type="button" class="onb-tab' + (tab === 'chatgpt' ? ' is-active' : '') + '" data-onb-tab="chatgpt">' + CLIENT_ICONS.chatgpt + 'ChatGPT / Codex</button>' +
    '</div>' +
    '<div class="onb-panel">' +
      connectBlock +
      mcpCard(
        '2. Run all 3 checks in one prompt',
        'Paste this into your agent to run register_agent, remember, recall, and get_entry in one turn.',
        'register_agent + remember + recall',
        allInOnePrompt,
        !allDone,
        'Copy all 3 steps'
      ) +
    '</div>';

  var savedLabel = ob.latest_entry ? String(ob.latest_entry.title || '') : '';
  if (savedLabel.length > 26) savedLabel = savedLabel.slice(0, 25) + '…';

  return '<section class="onb-card" id="onb-box">' +
    '<div class="onb-head">' +
      '<div>' +
        '<span class="cl-chip cl-chip--carbon">' + (allDone ? 'Setup complete · 3 of 3' : 'First-run setup · ' + doneCount + ' of 3 complete') + '</span>' +
        '<h2 class="cl-title-2">' + (allDone ? 'Your first agent is connected' : 'Connect your first agent') + '</h2>' +
        '<p class="cl-hint">' + (allDone
          ? 'All three checks passed. Your agents share one notebook.'
          : 'This web UI is read-only. Connect your client, paste the prompt below, then click Check progress.') + '</p>' +
      '</div>' +
      '<div class="app-actions">' +
        '<button type="button" class="cl-btn cl-btn--sm" id="onb-refresh">Check progress</button>' +
        (allDone ? '<a class="cl-btn cl-btn--primary cl-btn--sm" href="/graph">Open graph</a>' : '') +
      '</div>' +
    '</div>' +
    '<div class="onb-track">' +
      '<div class="onb-pill' + (s1 ? ' is-done' : '') + '">' +
        '<div class="onb-pill__top"><span>1. Connect agent</span>' + (s1 ? '<span class="cl-stamp cl-stamp--ok">Done</span>' : '<span class="cl-chip">Waiting</span>') + '</div>' +
        '<span class="onb-pill__sub">' + (s1 ? esc(ob.latest_agent ? ob.latest_agent.name : (ob.agents + ' connected')) : 'Calls register_agent') + '</span>' +
      '</div>' +
      '<div class="onb-pill' + (s2 ? ' is-done' : '') + '">' +
        '<div class="onb-pill__top"><span>2. Save first note</span>' + (s2 ? '<span class="cl-stamp cl-stamp--ok">Done</span>' : '<span class="cl-chip">Waiting</span>') + '</div>' +
        '<span class="onb-pill__sub">' + (s2 && ob.latest_entry ? '<a class="cl-link" href="/entries/' + encodeURIComponent(ob.latest_entry.id) + '">' + esc(savedLabel) + '</a>' : 'Calls remember') + '</span>' +
      '</div>' +
      '<div class="onb-pill' + (s3 ? ' is-done' : '') + '">' +
        '<div class="onb-pill__top"><span>3. Retrieve note</span>' + (s3 ? '<span class="cl-stamp cl-stamp--ok">Done</span>' : '<span class="cl-chip">Waiting</span>') + '</div>' +
        '<span class="onb-pill__sub">' + (s3 ? (ob.recalls + (ob.recalls === 1 ? ' recall verified' : ' recalls verified')) : 'Calls recall + get_entry') + '</span>' +
      '</div>' +
    '</div>' +
    (allDone
      ? '<details><summary class="cl-hint">Show setup instructions and all-in-one prompt</summary>' + setupBody + '</details>'
      : setupBody) +
  '</section>';
}

async function mountOnboarding(container, forceShow, onRefresh) {
  var activeTab = 'antigravity';
  async function draw() {
    try {
      var ob = await api('/me/onboarding');
      var needs = ob.agents === 0 || ob.entries === 0 || ob.recalls === 0;
      if (!forceShow && !needs) {
        container.innerHTML = '';
        return;
      }
      container.innerHTML = buildOnboardingHtml(ob, activeTab);
      container.querySelectorAll('[data-onb-tab]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          activeTab = btn.getAttribute('data-onb-tab') || 'antigravity';
          draw();
        });
      });
      var ref = document.getElementById('onb-refresh');
      if (ref) ref.addEventListener('click', function() {
        draw();
        if (onRefresh) onRefresh();
      });
    } catch (e) {}
  }
  await draw();
}

async function renderEntries() {
  var sp = new URLSearchParams(location.search);
  var forceOnb = sp.get('onboarding') === '1';
  root.innerHTML =
    '<div id="onb-slot" class="app-grid"></div>' +
    mcpCard(
      'Save a note through your agent',
      'Clyde has no manual write forms. Copy this prompt into Claude or Antigravity to save a note over MCP.',
      'remember',
      'Save a note to Clyde using remember: pattern "decisions", title "<short title>", body "<under 500 chars>", evidence "<source or command output>".',
      false
    ) +
    '<form id="f-entries" class="cl-card app-filters">' +
      '<div class="cl-field"><label for="q-in">Search</label><input id="q-in" name="q" class="cl-input" value="' + esc(sp.get('q') || '') + '" placeholder="Title or text"></div>' +
      '<div class="cl-field"><label for="kind-in">Kind</label><select id="kind-in" name="kind" class="cl-select"><option value="">All</option><option value="decisions">decisions</option><option value="fact">fact</option><option value="preferences">preferences</option><option value="projects">projects</option><option value="observations">observations</option><option value="recommendations">recommendations</option><option value="references">references</option><option value="reactions">reactions</option><option value="wen">wen</option><option value="plan">plan</option></select></div>' +
      '<div class="cl-field"><label for="proj-in">Project</label><input id="proj-in" name="project" class="cl-input" value="' + esc(sp.get('project') || '') + '" placeholder="e.g. clyde"></div>' +
      '<div class="cl-field"><label for="ctx-in">Context</label><select id="ctx-in" name="context" class="cl-select"><option value="">All</option><option value="general">general</option><option value="work">work</option><option value="home">home</option><option value="hobby">hobby</option><option value="personal">personal</option></select></div>' +
      '<div class="cl-field"><label for="agent-in">Agent</label><input id="agent-in" name="agent" class="cl-input" value="' + esc(sp.get('agent') || '') + '" placeholder="Agent name"></div>' +
      '<div class="cl-field"><label for="state-in">State</label><select id="state-in" name="state" class="cl-select"><option value="active">active</option><option value="pruned">pruned</option><option value="superseded">superseded</option><option value="all">all</option></select></div>' +
      '<button type="submit" class="cl-btn cl-btn--primary">Filter notes</button>' +
    '</form>' +
    '<div id="entries-status" class="cl-hint">Loading notes...</div>' +
    '<div id="entries-list" class="app-grid"></div>';

  ['kind', 'context', 'state'].forEach(function(k) {
    var v = sp.get(k);
    if (v) { var sel = document.querySelector('[name="' + k + '"]'); if (sel) sel.value = v; }
  });

  async function load() {
    var qs = new URLSearchParams();
    ['q', 'kind', 'project', 'context', 'agent', 'state'].forEach(function(k) {
      var el = document.querySelector('[name="' + k + '"]');
      if (el && el.value.trim()) qs.set(k, el.value.trim());
    });
    var url = '/me/entries' + (qs.toString() ? '?' + qs.toString() : '');
    try {
      var d = await api(url);
      var status = document.getElementById('entries-status');
      var list = document.getElementById('entries-list');
      status.textContent = d.total.toLocaleString('en-US') + ' ' + (d.total === 1 ? 'note' : 'notes') + (d.total >= 1000 ? ' (showing newest 1,000)' : '');
      if (!d.entries.length) {
        list.innerHTML = '<div class="cl-empty"><p class="cl-empty__title">No matching notes</p><p class="cl-empty__text">Nothing matches those filters. Connect an agent above and save your first note over MCP, or switch State to all.</p></div>';
        return;
      }
      list.innerHTML = d.entries.map(function(n) {
        var cls = 'cl-card cl-card--lift cl-memory' + (n.superseded_by ? ' is-superseded' : '') + (Number(n.confidence) < 0.15 ? ' is-dormant' : '');
        return '<a class="' + cls + '" href="/entries/' + encodeURIComponent(n.id) + '">' +
          '<div class="cl-memory__top"><span class="cl-chip">' + esc(n.pattern || n.kind) + '</span>' +
          (n.project ? '<span class="cl-chip cl-chip--carbon">' + esc(n.project) + '</span>' : '') +
          stateBadge(n) + '<span class="cl-memory__conf">' + confText(n.confidence) + '</span></div>' +
          '<h3 class="cl-memory__title">' + esc(n.title) + '</h3>' +
          '<p class="cl-memory__body">' + esc(n.body) + '</p>' +
          '<div class="cl-memory__foot"><span>id: ' + esc(n.id) + '</span><span>' + esc(n.context || 'general') + '</span><span>' + esc(n.authority || 'draft') + '</span></div>' +
        '</a>';
      }).join('');
    } catch (err) {
      var st = document.getElementById('entries-status');
      if (st) notice(st, 'bad', err.message);
    }
  }

  document.getElementById('f-entries').addEventListener('submit', function(e) {
    e.preventDefault();
    load();
  });
  await Promise.all([mountOnboarding(document.getElementById('onb-slot'), forceOnb, load), load()]);
}

async function renderEntryDetail() {
  if (!entryId) { renderEntries(); return; }
  root.innerHTML = '<div id="detail-status" class="cl-hint">Loading note...</div>';
  try {
    var d = await api('/me/entries/' + encodeURIComponent(entryId));
    var e = d.entry || d;
    var artifactsHtml = (d.artifacts || []).length
      ? '<ul class="app-grid">' + d.artifacts.map(function(a) {
          return '<li><code>' + esc(a.name) + '</code> · ' + esc(a.kind) + ' · ' + esc(a.size) + ' bytes · <code>' + esc(String(a.sha256).slice(0, 12)) + '</code></li>';
        }).join('') + '</ul>'
      : '<p class="cl-hint">No artifacts attached.</p>';
    var linksHtml = (d.links || []).length
      ? '<ul class="app-grid">' + d.links.map(function(l) {
          var other = l.src === e.id ? l.dst : l.src;
          var dir = l.src === e.id ? '->' : '<-';
          return '<li><code>' + esc(l.type) + '</code> ' + dir + ' <a class="cl-link" href="/entries/' + encodeURIComponent(other) + '">' + esc(other) + '</a></li>';
        }).join('') + '</ul>'
      : '<p class="cl-hint">No linked notes.</p>';
    var prov = d.provenance;
    var provHtml = prov
      ? '<div class="cl-prov"><span class="cl-prov__who">' + esc(prov.agent) + '</span> on ' + esc(prov.device) +
        (prov.repo ? ' · repo ' + esc(prov.repo) : '') + (prov.cwd ? ' · ' + esc(prov.cwd) : '') + ' · ' + esc(String(prov.created_at || '').slice(0, 19)) + '</div>'
      : '<p class="cl-hint">No provenance recorded.</p>';
    var histHtml = (d.confidence_history || []).length
      ? '<div class="app-table-wrap"><table class="app-table"><thead><tr><th>When</th><th>Before</th><th>After</th><th>Reason</th></tr></thead><tbody>' +
        d.confidence_history.map(function(h) {
          return '<tr><td>' + esc(String(h.at || '').slice(0, 19)) + '</td><td>' + esc(h.before) + '</td><td>' + esc(h.after) + '</td><td>' + esc(h.reason || '') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : '<p class="cl-hint">No confidence changes yet.</p>';

    var replacePrompt = 'In Clyde, call get_entry with id "' + e.id + '", then call remember with supersedes: ["' + e.id + '"] to replace it with an updated note and evidence.';
    var linkPrompt = 'In Clyde, save a related note using remember with links: [{"type": "relates", "to": "' + e.id + '"}] and evidence.';
    var inspectPrompt = 'In Clyde, call get_entry with id "' + e.id + '" and read any attached artifacts using get_blob.';

    root.innerHTML =
      '<div class="app-actions"><a class="cl-btn cl-btn--sm" href="/memories">Back to notes</a>' +
      '<a class="cl-btn cl-btn--sm" href="/graph?center=' + encodeURIComponent(e.id) + '">Open in graph</a></div>' +
      '<article class="cl-card app-grid">' +
        '<div class="app-meta"><span class="cl-chip">' + esc(e.pattern || e.kind) + '</span>' + stateBadge(d) +
        (e.project ? '<span class="cl-chip cl-chip--carbon">' + esc(e.project) + '</span>' : '') +
        (d.superseded_by ? '<a class="cl-chip cl-chip--warn" href="/entries/' + encodeURIComponent(d.superseded_by) + '">Replaced by ' + esc(d.superseded_by) + '</a>' : '') +
        '<span class="cl-memory__conf">Confidence ' + confText(e.confidence) + '</span></div>' +
        '<h2 class="cl-title-2">' + esc(e.title) + '</h2>' +
        '<pre class="app-body">' + esc(e.body) + '</pre>' +
        (e.evidence ? '<div class="cl-well"><strong>Evidence:</strong> ' + esc(e.evidence) + '</div>' : '') +
        provHtml +
      '</article>' +
      '<section class="app-cols-2">' +
        '<div class="cl-card app-grid"><h3 class="cl-title-3">Artifacts</h3>' + artifactsHtml + '</div>' +
        '<div class="cl-card app-grid"><h3 class="cl-title-3">Links</h3>' + linksHtml + '</div>' +
      '</section>' +
      '<section class="cl-card app-grid"><h3 class="cl-title-3">Confidence history</h3>' + histHtml + '</section>' +
      '<section class="app-grid">' +
        '<h3 class="cl-title-3">Manage this note via MCP</h3>' +
        '<div class="app-cols-2">' +
          mcpCard('Replace or update this note', 'Write a replacement note with supersedes so history stays intact.', 'remember', replacePrompt, true) +
          mcpCard('Link another note to this one', 'Connect decisions, evidence, or follow-ups in the graph.', 'remember', linkPrompt, false) +
        '</div>' +
        mcpCard('Load full note and artifacts in chat', 'Pull this exact note and its attached files into Claude or Antigravity.', 'get_entry + get_blob', inspectPrompt, false) +
      '</section>';
  } catch (err) {
    root.innerHTML = '<div class="app-banner app-banner--bad">' + esc(err.message) + '</div>';
  }
}

async function renderGraph() {
  var sp = new URLSearchParams(location.search);
  var EDGE_TYPES = ['relates', 'supports', 'contradicts', 'supersedes', 'part_of', 'derived_from', 'co_used'];
  var activeEdges = {};
  EDGE_TYPES.forEach(function(t) { activeEdges[t] = true; });
  var state = {
    center: sp.get('center') || '',
    depth: sp.get('depth') || '2',
    pattern: '',
    showPruned: false,
    data: null,
    pos: {},
    deg: {},
    selected: null,
    hovered: null,
    viewBox: { x: 0, y: 0, w: 960, h: 580 }
  };

  root.innerHTML =
    '<section class="cl-card gr-toolbar">' +
      '<div class="gr-toolbar-top">' +
        '<div class="cl-field gr-search-wrap"><label for="g-search">Find or jump to note</label>' +
          '<input id="g-search" class="cl-input" autocomplete="off" placeholder="Search by title or id...">' +
          '<div id="g-results" class="gr-results is-hidden"></div>' +
        '</div>' +
        '<div class="cl-field"><label for="g-depth">Depth</label><select id="g-depth" class="cl-select"><option value="1">1 hop</option><option value="2">2 hops</option><option value="3">3 hops</option></select></div>' +
        '<div class="cl-field"><label for="g-pattern">Pattern</label><select id="g-pattern" class="cl-select"><option value="">All patterns</option><option value="decisions">decisions</option><option value="projects">projects</option><option value="preferences">preferences</option><option value="observations">observations</option><option value="references">references</option><option value="recommendations">recommendations</option><option value="reactions">reactions</option></select></div>' +
        '<label class="gr-chip-btn is-on" for="g-pruned"><input id="g-pruned" type="checkbox"> Show pruned</label>' +
      '</div>' +
      '<div class="gr-filters" id="g-edge-filters">' +
        '<span class="cl-label">Links</span>' +
        EDGE_TYPES.map(function(t) {
          return '<button type="button" class="gr-chip-btn is-on" data-edge-type="' + t + '"><span class="gr-dot gr-dot--' + t + '"></span>' + t + '</button>';
        }).join('') +
      '</div>' +
    '</section>' +
    '<div id="g-status" class="cl-hint" role="status" aria-live="polite">Loading graph...</div>' +
    '<div class="gr-shell">' +
      '<div class="gr-wrap" id="g-canvas-wrap">' +
        '<div class="gr-zoom">' +
          '<button type="button" class="cl-btn cl-btn--sm" id="g-zin" aria-label="Zoom in">+</button>' +
          '<button type="button" class="cl-btn cl-btn--sm" id="g-zout" aria-label="Zoom out">-</button>' +
          '<button type="button" class="cl-btn cl-btn--sm" id="g-fit">Fit</button>' +
        '</div>' +
        '<div id="g-canvas"></div>' +
      '</div>' +
      '<aside class="cl-card gr-inspector" id="g-inspector"><p class="cl-hint">Select a node to inspect its full text, links, and MCP prompt.</p></aside>' +
    '</div>';

  var depthEl = document.getElementById('g-depth');
  depthEl.value = state.depth;
  var patEl = document.getElementById('g-pattern');
  var prunedEl = document.getElementById('g-pruned');
  var searchEl = document.getElementById('g-search');
  var resultsEl = document.getElementById('g-results');

  function visibleGraph() {
    if (!state.data) return { nodes: [], edges: [], adj: {} };
    var nodes = state.data.nodes.filter(function(n) {
      if (!state.showPruned && Number(n.confidence) < 0.15 && n.id !== state.data.center) return false;
      if (state.pattern && (n.pattern || n.kind) !== state.pattern && n.id !== state.data.center) return false;
      return true;
    });
    var keep = {};
    nodes.forEach(function(n) { keep[n.id] = n; });
    var edges = state.data.edges.filter(function(e) {
      var t = EDGE_TYPES.indexOf(e.type) >= 0 ? e.type : 'relates';
      return keep[e.src] && keep[e.dst] && activeEdges[t];
    });
    var adj = {};
    nodes.forEach(function(n) { adj[n.id] = []; });
    edges.forEach(function(e) {
      adj[e.src].push({ id: e.dst, type: e.type, dir: '->' });
      adj[e.dst].push({ id: e.src, type: e.type, dir: '<-' });
    });
    return { nodes: nodes, edges: edges, adj: adj, byId: keep };
  }

  function runLayout(nodes, edges, centerId) {
    var pos = {};
    var vel = {};
    var W = 960, H = 580, cx = W / 2, cy = H / 2;
    nodes.forEach(function(n, i) {
      if (n.id === centerId) {
        pos[n.id] = { x: cx, y: cy };
      } else {
        var ang = i * 2.3999632;
        var rad = 65 + Math.sqrt(i + 1) * 42;
        pos[n.id] = { x: cx + Math.cos(ang) * rad * 1.25, y: cy + Math.sin(ang) * rad };
      }
      vel[n.id] = { x: 0, y: 0 };
    });
    var nCount = nodes.length;
    var ticks = nCount > 180 ? 55 : (nCount > 80 ? 85 : 120);
    var repulse = nCount > 120 ? 2200 : 3400;
    var springLen = nCount > 120 ? 95 : 125;
    for (var t = 0; t < ticks; t++) {
      var cool = 1 - (t / ticks) * 0.72;
      for (var i = 0; i < nCount; i++) {
        var a = nodes[i].id, pa = pos[a];
        for (var j = i + 1; j < nCount; j++) {
          var b = nodes[j].id, pb = pos[b];
          var dx = pa.x - pb.x, dy = pa.y - pb.y;
          var d2 = dx * dx + dy * dy + 25;
          var f = repulse / d2;
          var dist = Math.sqrt(d2);
          var fx = (dx / dist) * f, fy = (dy / dist) * f;
          vel[a].x += fx; vel[a].y += fy;
          vel[b].x -= fx; vel[b].y -= fy;
        }
      }
      for (var k = 0; k < edges.length; k++) {
        var ed = edges[k];
        var p1 = pos[ed.src], p2 = pos[ed.dst];
        if (!p1 || !p2) continue;
        var ex = p2.x - p1.x, ey = p2.y - p1.y;
        var d = Math.sqrt(ex * ex + ey * ey) || 1;
        var pull = (d - springLen) * 0.045;
        var ux = (ex / d) * pull, uy = (ey / d) * pull;
        vel[ed.src].x += ux; vel[ed.src].y += uy;
        vel[ed.dst].x -= ux; vel[ed.dst].y -= uy;
      }
      for (var m = 0; m < nCount; m++) {
        var id = nodes[m].id;
        vel[id].x += (cx - pos[id].x) * 0.012;
        vel[id].y += (cy - pos[id].y) * 0.012;
        vel[id].x *= 0.78;
        vel[id].y *= 0.78;
        var step = Math.sqrt(vel[id].x * vel[id].x + vel[id].y * vel[id].y);
        if (step > 28) {
          vel[id].x = (vel[id].x / step) * 28;
          vel[id].y = (vel[id].y / step) * 28;
        }
        if (id !== centerId) {
          pos[id].x += vel[id].x * cool;
          pos[id].y += vel[id].y * cool;
        }
      }
    }
    state.pos = pos;
    fitView(nodes);
  }

  function fitView(nodes) {
    if (!nodes || !nodes.length) {
      state.viewBox = { x: 0, y: 0, w: 960, h: 580 };
      return;
    }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(function(n) {
      var p = state.pos[n.id];
      if (!p) return;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    });
    var pad = 75;
    var w = Math.max(320, (maxX - minX) + pad * 2);
    var h = Math.max(210, (maxY - minY) + pad * 2);
    var aspect = 960 / 580;
    if (w / h > aspect) h = w / aspect;
    else w = h * aspect;
    state.viewBox = {
      x: ((minX + maxX) / 2) - w / 2,
      y: ((minY + maxY) / 2) - h / 2,
      w: w,
      h: h
    };
  }

  function renderInspector(vg) {
    var box = document.getElementById('g-inspector');
    var n = vg.byId[state.selected] || vg.byId[state.data && state.data.center] || vg.nodes[0];
    if (!n) {
      box.innerHTML = '<p class="cl-hint">No visible nodes match these filters.</p>';
      return;
    }
    state.selected = n.id;
    var links = vg.adj[n.id] || [];
    var linksHtml = links.length
      ? '<div class="gr-ins-links">' + links.map(function(l) {
          var target = vg.byId[l.id];
          var label = target ? (target.title || l.id) : l.id;
          return '<button type="button" class="gr-ins-link" data-pick="' + esc(l.id) + '"><span>' + esc(label.slice(0, 48)) + '</span><code>' + esc(l.type) + '</code></button>';
        }).join('') + '</div>'
      : '<p class="cl-hint">No visible links on this node.</p>';
    var mcpPrompt = 'In Clyde, call get_entry with id "' + n.id + '", or link a new note to it via remember with links: [{"type": "relates", "to": "' + n.id + '"}].';
    box.innerHTML =
      '<div class="app-meta">' +
        '<span class="cl-chip">' + esc(n.pattern || n.kind) + '</span>' +
        (n.project ? '<span class="cl-chip cl-chip--carbon">' + esc(n.project) + '</span>' : '') +
        '<span class="cl-memory__conf">' + confText(n.confidence) + '</span>' +
      '</div>' +
      '<h3>' + esc(n.title || n.id) + '</h3>' +
      (n.body ? '<p class="gr-ins-body">' + esc(n.body) + '</p>' : '') +
      '<div class="app-actions">' +
        (n.id !== state.data.center ? '<button type="button" class="cl-btn cl-btn--primary cl-btn--sm" id="g-recenter">Re-center here</button>' : '') +
        '<a class="cl-btn cl-btn--sm" href="/entries/' + encodeURIComponent(n.id) + '">Open full note</a>' +
        '<button type="button" class="cl-btn cl-btn--sm" data-copy="' + esc(mcpPrompt) + '">Copy MCP prompt</button>' +
      '</div>' +
      '<div><span class="cl-label">Connected notes (' + links.length + ')</span>' + linksHtml + '</div>';

    var rec = document.getElementById('g-recenter');
    if (rec) rec.addEventListener('click', function() {
      state.center = n.id;
      history.replaceState(null, '', '/graph?center=' + encodeURIComponent(n.id) + '&depth=' + encodeURIComponent(state.depth));
      load();
    });
    box.querySelectorAll('[data-pick]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        state.selected = btn.getAttribute('data-pick');
        draw();
      });
    });
  }

  function applySpotlight(svg, vg) {
    var focusId = state.hovered;
    var nb = {};
    if (focusId) {
      nb[focusId] = true;
      (vg.adj[focusId] || []).forEach(function(l) { nb[l.id] = true; });
    }
    svg.querySelectorAll('.gr-node').forEach(function(el) {
      var id = el.getAttribute('data-node');
      el.classList.toggle('is-dim', Boolean(focusId && !nb[id]));
      el.classList.toggle('is-hi', Boolean(focusId && nb[id]));
    });
    svg.querySelectorAll('.gr-edge').forEach(function(el) {
      var s = el.getAttribute('data-src'), d = el.getAttribute('data-dst');
      var hit = focusId && (s === focusId || d === focusId);
      el.classList.toggle('is-dim', Boolean(focusId && !hit));
      el.classList.toggle('is-hi', Boolean(hit));
    });
  }

  function draw() {
    var vg = visibleGraph();
    var canvas = document.getElementById('g-canvas');
    var st = document.getElementById('g-status');
    var total = state.data ? (state.data.total_notes || state.data.nodes.length) : 0;
    st.textContent = vg.nodes.length + ' of ' + total + (total === 1 ? ' note, ' : ' notes, ') + vg.edges.length + (vg.edges.length === 1 ? ' link' : ' links') +
      (state.data && state.data.nodes.length >= 300 ? ' (300-node cap)' : '') + ' · Drag background to pan, scroll to zoom, drag any node to rearrange.';

    if (!vg.nodes.length) {
      canvas.innerHTML = '<div class="cl-empty"><p class="cl-empty__title">No notes in the graph yet</p><p class="cl-empty__text">Once your agents save notes over MCP, they appear here.</p></div>';
      renderInspector(vg);
      return;
    }

    var zoomedIn = state.viewBox.w < 720;
    var edgesSvg = vg.edges.map(function(ed) {
      var a = state.pos[ed.src], b = state.pos[ed.dst];
      if (!a || !b) return '';
      var t = EDGE_TYPES.indexOf(ed.type) >= 0 ? ed.type : 'relates';
      return '<line class="gr-edge gr-edge--' + t + '" data-src="' + esc(ed.src) + '" data-dst="' + esc(ed.dst) + '" x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '"></line>';
    }).join('');

    var nodesSvg = vg.nodes.map(function(n) {
      var p = state.pos[n.id] || { x: 480, y: 290 };
      var isCenter = n.id === state.data.center;
      var isSel = n.id === state.selected;
      var deg = (vg.adj[n.id] || []).length;
      var r = isCenter ? 13 : Math.min(13, 6 + Math.sqrt(deg) * 2.1);
      var pat = ['decisions','projects','preferences','observations','references','recommendations','reactions'].indexOf(n.pattern) >= 0 ? n.pattern : 'other';
      var showLbl = isCenter || isSel || zoomedIn || vg.nodes.length <= 28 || deg >= 4;
      var cls = 'gr-node gr-node--' + pat + (isCenter ? ' is-center' : '') + (isSel ? ' is-selected' : '') +
        (Number(n.confidence) < 0.15 ? ' is-dormant' : '') + (showLbl ? '' : ' is-label-hide');
      var rawTitle = String(n.title || n.id);
      var label = rawTitle.length > 28 ? rawTitle.slice(0, 27) + '…' : rawTitle;
      return '<g class="' + cls + '" data-node="' + esc(n.id) + '" tabindex="0" role="button" aria-label="' + esc(rawTitle + ', ' + confText(n.confidence)) + '">' +
        '<circle class="gr-hit" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + (r + 7).toFixed(1) + '"></circle>' +
        '<circle class="gr-vis" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + r.toFixed(1) + '"></circle>' +
        '<text x="' + (p.x + r + 5).toFixed(1) + '" y="' + (p.y + 4).toFixed(1) + '">' + esc(label) + '</text>' +
      '</g>';
    }).join('');

    var vb = state.viewBox;
    canvas.innerHTML =
      '<svg class="gr-svg" id="g-svg" viewBox="' + vb.x.toFixed(1) + ' ' + vb.y.toFixed(1) + ' ' + vb.w.toFixed(1) + ' ' + vb.h.toFixed(1) +
      '" role="group" aria-label="Note neighborhood graph"><title>Note neighborhood graph</title>' + edgesSvg + nodesSvg + '</svg>';

    var svg = document.getElementById('g-svg');
    var dragNode = null, panning = false, startPt = null, startVb = null, moved = false;

    function toSvgPoint(ev) {
      var rect = svg.getBoundingClientRect();
      return {
        x: state.viewBox.x + ((ev.clientX - rect.left) / rect.width) * state.viewBox.w,
        y: state.viewBox.y + ((ev.clientY - rect.top) / rect.height) * state.viewBox.h
      };
    }

    function setVb() {
      svg.setAttribute('viewBox', state.viewBox.x.toFixed(1) + ' ' + state.viewBox.y.toFixed(1) + ' ' + state.viewBox.w.toFixed(1) + ' ' + state.viewBox.h.toFixed(1));
    }

    svg.addEventListener('pointerdown', function(ev) {
      var g = ev.target && ev.target.closest ? ev.target.closest('.gr-node') : null;
      moved = false;
      if (g) {
        dragNode = g.getAttribute('data-node');
        svg.setPointerCapture(ev.pointerId);
      } else {
        panning = true;
        startPt = { x: ev.clientX, y: ev.clientY };
        startVb = { x: state.viewBox.x, y: state.viewBox.y, w: state.viewBox.w, h: state.viewBox.h };
        svg.classList.add('is-panning');
        svg.setPointerCapture(ev.pointerId);
      }
    });

    svg.addEventListener('pointermove', function(ev) {
      if (dragNode) {
        moved = true;
        var pt = toSvgPoint(ev);
        state.pos[dragNode] = { x: pt.x, y: pt.y };
        var g = svg.querySelector('.gr-node[data-node="' + CSS.escape(dragNode) + '"]');
        if (g) {
          var hit = g.querySelector('.gr-hit'), c = g.querySelector('.gr-vis'), tx = g.querySelector('text');
          var r = Number((c && c.getAttribute('r')) || 7);
          if (hit) { hit.setAttribute('cx', pt.x.toFixed(1)); hit.setAttribute('cy', pt.y.toFixed(1)); }
          if (c) { c.setAttribute('cx', pt.x.toFixed(1)); c.setAttribute('cy', pt.y.toFixed(1)); }
          if (tx) { tx.setAttribute('x', (pt.x + r + 5).toFixed(1)); tx.setAttribute('y', (pt.y + 4).toFixed(1)); }
        }
        svg.querySelectorAll('.gr-edge').forEach(function(line) {
          if (line.getAttribute('data-src') === dragNode) {
            line.setAttribute('x1', pt.x.toFixed(1));
            line.setAttribute('y1', pt.y.toFixed(1));
          }
          if (line.getAttribute('data-dst') === dragNode) {
            line.setAttribute('x2', pt.x.toFixed(1));
            line.setAttribute('y2', pt.y.toFixed(1));
          }
        });
      } else if (panning && startPt && startVb) {
        var rect = svg.getBoundingClientRect();
        var dx = ((ev.clientX - startPt.x) / rect.width) * startVb.w;
        var dy = ((ev.clientY - startPt.y) / rect.height) * startVb.h;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
        state.viewBox.x = startVb.x - dx;
        state.viewBox.y = startVb.y - dy;
        setVb();
      }
    });

    svg.addEventListener('pointerup', function(ev) {
      if (dragNode && !moved) {
        state.selected = dragNode;
        draw();
      }
      dragNode = null;
      panning = false;
      svg.classList.remove('is-panning');
    });

    svg.addEventListener('wheel', function(ev) {
      ev.preventDefault();
      var factor = ev.deltaY > 0 ? 1.16 : 0.86;
      var pt = toSvgPoint(ev);
      var nw = Math.max(180, Math.min(4800, state.viewBox.w * factor));
      var nh = nw * (580 / 960);
      state.viewBox.x = pt.x - (pt.x - state.viewBox.x) * (nw / state.viewBox.w);
      state.viewBox.y = pt.y - (pt.y - state.viewBox.y) * (nh / state.viewBox.h);
      state.viewBox.w = nw;
      state.viewBox.h = nh;
      setVb();
    }, { passive: false });

    svg.querySelectorAll('.gr-node').forEach(function(el) {
      el.addEventListener('pointerenter', function() {
        state.hovered = el.getAttribute('data-node');
        applySpotlight(svg, vg);
      });
      el.addEventListener('pointerleave', function() {
        state.hovered = null;
        applySpotlight(svg, vg);
      });
      el.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          state.selected = el.getAttribute('data-node');
          draw();
        }
      });
    });

    renderInspector(vg);
  }

  async function load() {
    var qs = new URLSearchParams();
    if (state.center) qs.set('center', state.center);
    qs.set('depth', state.depth || '2');
    try {
      state.data = await api('/me/graph?' + qs.toString());
      state.selected = state.data.center;
      runLayout(state.data.nodes || [], state.data.edges || [], state.data.center);
      draw();
    } catch (err) {
      document.getElementById('g-status').textContent = err.message;
    }
  }

  depthEl.addEventListener('change', function() { state.depth = depthEl.value; load(); });
  patEl.addEventListener('change', function() { state.pattern = patEl.value; draw(); });
  prunedEl.addEventListener('change', function() { state.showPruned = prunedEl.checked; draw(); });
  document.querySelectorAll('[data-edge-type]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var t = btn.getAttribute('data-edge-type');
      activeEdges[t] = !activeEdges[t];
      btn.classList.toggle('is-on', activeEdges[t]);
      draw();
    });
  });

  function zoomBy(factor) {
    var cx = state.viewBox.x + state.viewBox.w / 2;
    var cy = state.viewBox.y + state.viewBox.h / 2;
    var nw = Math.max(180, Math.min(4800, state.viewBox.w * factor));
    var nh = nw * (580 / 960);
    state.viewBox = { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh };
    draw();
  }
  document.getElementById('g-zin').addEventListener('click', function() { zoomBy(0.78); });
  document.getElementById('g-zout').addEventListener('click', function() { zoomBy(1.28); });
  document.getElementById('g-fit').addEventListener('click', function() {
    fitView(visibleGraph().nodes);
    draw();
  });

  var searchTimer = null;
  searchEl.addEventListener('input', function() {
    clearTimeout(searchTimer);
    var q = searchEl.value.trim();
    if (!q) { resultsEl.classList.add('is-hidden'); resultsEl.innerHTML = ''; return; }
    searchTimer = setTimeout(async function() {
      try {
        var d = await api('/me/entries?q=' + encodeURIComponent(q) + '&state=all');
        var hits = (d.entries || []).slice(0, 8);
        if (!hits.length) {
          resultsEl.innerHTML = '<div class="gr-res-btn"><span>No matching notes</span></div>';
        } else {
          resultsEl.innerHTML = hits.map(function(n) {
            return '<button type="button" class="gr-res-btn" data-jump="' + esc(n.id) + '"><span>' + esc(n.title || n.id) + '</span>' +
              '<span class="gr-res-meta">' + esc(n.pattern || n.kind) + ' · ' + confText(n.confidence) + '</span></button>';
          }).join('');
        }
        resultsEl.classList.remove('is-hidden');
        resultsEl.querySelectorAll('[data-jump]').forEach(function(btn) {
          btn.addEventListener('click', function() {
            state.center = btn.getAttribute('data-jump');
            searchEl.value = '';
            resultsEl.classList.add('is-hidden');
            history.replaceState(null, '', '/graph?center=' + encodeURIComponent(state.center) + '&depth=' + encodeURIComponent(state.depth));
            load();
          });
        });
      } catch (e) {}
    }, 180);
  });
  if (document.addEventListener) document.addEventListener('click', function(ev) {
    if (!searchEl.contains(ev.target) && !resultsEl.contains(ev.target)) resultsEl.classList.add('is-hidden');
  });

  await load();
}

async function renderQuests() {
  root.innerHTML =
    mcpCard(
      'Post a quest through your agent',
      'Agents post, claim, update, and finish quests over MCP so every handoff keeps its evidence.',
      'post_quest',
      'Call Clyde post_quest with title "<short task>", brief "<what to do and why>", done_when "<check that proves completion>", priority "normal", context "both".',
      true
    ) +
    '<div id="q-board" class="app-cols-3">' +
      '<section class="app-qcol"><div class="app-qcol-head"><h2 class="cl-title-3">Open</h2><span class="cl-chip" id="cnt-open">0</span></div><div id="col-open" class="app-grid"></div></section>' +
      '<section class="app-qcol"><div class="app-qcol-head"><h2 class="cl-title-3">Claimed</h2><span class="cl-chip" id="cnt-claimed">0</span></div><div id="col-claimed" class="app-grid"></div></section>' +
      '<section class="app-qcol"><div class="app-qcol-head"><h2 class="cl-title-3">Done</h2><span class="cl-chip" id="cnt-done">0</span></div><div id="col-done" class="app-grid"></div></section>' +
    '</div>';

  var results = await Promise.all([api('/me/quests'), api('/me/agents')]);
  var qData = results[0], aData = results[1];
  var nickByAgent = {};
  (aData.agents || []).forEach(function(a) {
    nickByAgent[a.name] = a.nickname || a.name;
  });
  var groups = { open: [], claimed: [], done: [] };
  (qData.quests || []).forEach(function(q) {
    if (q.state === 'open') groups.open.push(q);
    else if (q.state === 'claimed') groups.claimed.push(q);
    else groups.done.push(q);
  });
  ['open', 'claimed', 'done'].forEach(function(col) {
    document.getElementById('cnt-' + col).textContent = String(groups[col].length);
    var el = document.getElementById('col-' + col);
    el.innerHTML = groups[col].length ? groups[col].map(function(q) {
      var claimant = q.claimed_by ? (nickByAgent[q.claimed_by] || q.claimed_by) : '';
      var claimPrompt = 'Call Clyde claim_quest with id ' + q.id + ', complete the task, save the result with remember, then call complete_quest.';
      return '<article class="cl-quest' + (col === 'done' ? ' is-done' : '') + '">' +
        '<div class="cl-quest__stub"><span class="cl-quest__no">#' + esc(q.id) + '</span><span class="cl-quest__pri' + (['urgent', 'high'].includes(q.priority) ? ' is-high' : '') + '">' + esc(q.priority) + '</span></div>' +
        '<div class="cl-quest__main">' +
          '<div class="cl-quest__head"><h3 class="cl-quest__title">' + esc(q.title) + '</h3>' +
          (q.unmatched ? '<span class="cl-chip cl-chip--warn">No matching agent</span>' : '') +
          '<span class="cl-stamp">' + esc(q.state) + '</span></div>' +
          '<p class="cl-quest__brief">' + esc(q.brief) + '</p>' +
          '<div class="cl-quest__done"><strong>Done when:</strong> ' + esc(q.done_when) + '</div>' +
          '<div class="cl-quest__for">' +
            (claimant ? 'Claimed by <b>' + esc(claimant) + '</b>' : 'For <b>' + esc(q.assignee || 'any') + '</b>') +
            (q.project ? ' · ' + esc(q.project) : '') +
          '</div>' +
          (col === 'open' ? '<div class="app-actions"><button type="button" class="cl-btn cl-btn--sm" data-copy="' + esc(claimPrompt) + '">Copy claim prompt</button></div>' : '') +
        '</div>' +
      '</article>';
    }).join('') : '<p class="cl-hint">No ' + col + ' quests.</p>';
  });
}

async function renderAgents() {
  var sp = new URLSearchParams(location.search);
  var connectMode = sp.get('connect') === '1';
  root.innerHTML =
    '<div id="ag-onb" class="app-grid"></div>' +
    '<section class="app-grid"><h2 class="cl-title-2">Registered agents</h2><div id="ag-list" class="app-grid"></div></section>' +
    '<section class="app-grid"><h2 class="cl-title-2">Connected devices</h2><div id="dev-list" class="app-grid"></div></section>';

  var results = await Promise.all([
    mountOnboarding(document.getElementById('ag-onb'), connectMode),
    api('/me/agents'),
    api('/me/devices')
  ]);
  var agents = results[1].agents || [], devices = results[2].devices || [];
  document.getElementById('ag-list').innerHTML = agents.length ? agents.map(function(a) {
    var updatePrompt = 'Call Clyde register_agent with name "' + a.name + '", context "' + (a.context || 'both') + '", surface "' + (a.surface || 'Antigravity') +
      '", description "' + (a.description || 'Coding and ops agent') + '", and update my nickname, type, harness, or repos as needed.';
    return '<article class="cl-card agent-card">' +
      '<div class="app-meta"><strong>' + esc(a.name) + '</strong>' +
      (a.nickname ? '<span class="cl-chip cl-chip--carbon">@' + esc(a.nickname) + '</span>' : '') +
      (a.type ? '<span class="cl-chip">' + esc(a.type) + '</span>' : '') +
      (a.surface ? '<span class="cl-chip">' + esc(a.surface) + '</span>' : '') +
      (a.harness && (!a.surface || a.harness.toLowerCase() !== a.surface.toLowerCase()) ? '<span class="cl-chip">' + esc(a.harness) + '</span>' : '') +
      (a.device ? '<span class="cl-chip">Device: ' + esc(a.device) + '</span>' : '') +
      '</div>' +
      (a.description ? '<p class="cl-hint">' + esc(a.description) + '</p>' : '') +
      ((a.repos && a.repos.length) ? '<div class="app-meta"><span class="cl-label">Repos</span>' + a.repos.map(function(r) { return '<span class="cl-chip">' + esc(r) + '</span>'; }).join('') + '</div>' : '') +
      '<div class="app-actions"><button type="button" class="cl-btn cl-btn--sm" data-copy="' + esc(updatePrompt) + '">Copy MCP update prompt</button></div>' +
    '</article>';
  }).join('') : '<p class="cl-hint">No agents registered yet. Follow Step 1 above to connect Claude or Antigravity.</p>';

  document.getElementById('dev-list').innerHTML = devices.length ? devices.map(function(dv) {
    return '<div class="cl-card app-actions"><strong>' + esc(dv.name) + '</strong>' +
      '<span class="cl-chip">Hooks: ' + esc(dv.hooks || 'full') + '</span>' +
      (dv.revoked_at ? '<span class="cl-chip cl-chip--bad">Revoked</span>' : '<span class="cl-state cl-state--settled">Active</span>') +
    '</div>';
  }).join('') : '<p class="cl-hint">No connected devices yet. Run the installer on a computer to add one.</p>';
}

async function renderApps() {
  root.innerHTML =
    '<div id="apps-list" class="app-grid"></div>' +
    mcpCard(
      'Connect another app',
      'Add Clyde as a custom MCP connector in Claude, ChatGPT, Gemini, Grok, or Antigravity using this URL.',
      'MCP server URL',
      MCP_ENDPOINT,
      false,
      'Copy URL'
    );
  var d = await api('/me/apps');
  var list = d.apps || [];
  document.getElementById('apps-list').innerHTML = list.length ? list.map(function(a) {
    return '<div class="cl-card app-actions"><div><strong>' + esc(a.name || a.id) + '</strong> <span class="cl-mono">(' + esc(a.id) + ')</span></div>' +
      '<span class="cl-state cl-state--settled">Connected</span></div>';
  }).join('') : '<div class="cl-empty"><p class="cl-empty__title">No connected apps</p><p class="cl-empty__text">Approve Clyde inside Claude, ChatGPT, Gemini, Grok, or Antigravity to see OAuth grants here.</p></div>';
}

var METER_LABEL = {
  ai: 'AI tokens (embeddings and judge)',
  storage_gb_hours: 'Storage (GB-hours)',
  egress_bytes: 'Network egress (bytes)',
  requests: 'Requests',
  db_bytes: 'Database storage (bytes)'
};

async function renderUsage() {
  root.innerHTML = '<div id="u-summary" class="cl-card app-grid"></div><div id="u-meters" class="meter-list"></div>';
  var PLAN_NAME = { free: 'Free', starter: 'Starter', clyde: 'Clyde', owner: 'Owner', none: 'None' };
  var STATE_NAME = { paid: 'Paid', past_due: 'Past due', comp: 'Comp', lapsed: 'Lapsed', refunded: 'Refunded', blocked: 'Blocked' };
  var d = await api('/me/usage');
  var limitDollars = d.spend_limit_cents == null ? 0 : (Number(d.spend_limit_cents) / 100);
  var statusText = d.state === 'paid' && d.cancel_at_period_end
    ? 'Canceling at period end'
    : (STATE_NAME[d.state] || d.state || (d.plan === 'free' ? 'Free seat' : 'No active plan'));
  var capChip = d.plan === 'owner'
    ? '<span class="cl-chip">Limits: unlimited</span>'
    : d.plan === 'none'
    ? '<span class="cl-chip">Access: subscription required</span>'
    : d.overage
    ? '<span class="cl-chip">Spend limit: $' + limitDollars.toFixed(2) + '</span>'
    : '<span class="cl-chip">Caps: hard limits (no overage)</span>';
  document.getElementById('u-summary').innerHTML =
    '<div class="app-meta"><span class="cl-chip cl-chip--carbon">Plan: ' + esc(PLAN_NAME[d.plan] || d.plan) + '</span>' +
    '<span class="cl-chip">Status: ' + esc(statusText) + '</span>' +
    '<span class="cl-chip">Period: ' + esc(d.period) + '</span>' +
    capChip +
    '</div>';

  document.getElementById('u-meters').innerHTML = (d.meters || []).map(function(m) {
    var inc = m.included == null ? 0 : Number(m.included);
    var used = Number(m.used || 0);
    var pct = inc > 0 ? Math.min(100, Math.round((used / inc) * 100)) : 0;
    return '<div class="cl-card meter-row">' +
      '<div class="meter-top"><strong>' + esc(METER_LABEL[m.kind] || m.kind) + '</strong>' +
      '<span class="cl-mono">' + used.toLocaleString('en-US') + (m.included != null ? ' / ' + inc.toLocaleString('en-US') : ' (no limit)') +
      (d.overage ? ' · Overage: $' + (Number(m.overage_cents || 0) / 100).toFixed(2) : '') + '</span></div>' +
      '<progress class="meter-bar" max="100" value="' + pct + '"></progress>' +
    '</div>';
  }).join('');
}

async function renderSettings() {
  var s = readSession();
  root.innerHTML =
    '<section class="cl-card app-grid">' +
      '<h2 class="cl-title-3">Agent-only workspace</h2>' +
      '<p class="cl-hint">There are no settings forms here. Connect an agent to register, save notes, and coordinate over MCP.</p>' +
      '<div class="app-meta">' +
        '<span class="cl-chip cl-chip--carbon">Account: ' + esc((s && s.email) || 'Signed in') + '</span>' +
        '<span class="cl-chip">MCP: ' + esc(MCP_ENDPOINT) + '</span>' +
      '</div>' +
    '</section>' +
    '<div class="mcp-list">' +
      mcpCard('Install Clyde on a new computer', 'Sets up Antigravity, Claude Code, Codex, and Gemini CLI with MCP and hooks.', 'CLI installer', INSTALL_CMD, true, 'Copy command') +
      mcpCard('Update an agent profile via MCP', 'Change nickname, type, harness, projects, or repos through register_agent.', 'register_agent', 'Call Clyde register_agent with my current agent name and update its nickname, type, repos, and projects.', false, 'Copy prompt') +
      mcpCard('Inspect or audit saved notes via MCP', 'Ask your agent to search, review, or supersede outdated notes.', 'recall + remember', 'Call Clyde recall to find outdated notes on this project, inspect them with get_entry, and supersede any that changed.', false, 'Copy prompt') +
    '</div>';
}

async function start() {
  if (view === 'callback') return finishProviderSignIn();
  parseCallbackHash();
  var s = readSession();
  updateUserBar(s);
  if (view === 'invite') return renderInvite();
  if (!s) { renderSignIn(); return; }
  if (!s.user_id) {
    try {
      var uRes = await fetch('/auth/v1/user', { headers: { authorization: 'Bearer ' + s.access_token } });
      if (uRes.ok) {
        var u = await uRes.json();
        s = writeSession({ access_token: s.access_token, refresh_token: s.refresh_token, user: u, expires_at: s.expires_at });
      }
    } catch (e) {}
  }
  if (view === 'entries') return renderEntries();
  if (view === 'entry') return renderEntryDetail();
  if (view === 'graph') return renderGraph();
  if (view === 'quests') return renderQuests();
  if (view === 'agents') return renderAgents();
  if (view === 'apps') return renderApps();
  if (view === 'usage') return renderUsage();
  if (view === 'settings') return renderSettings();
}

start();
})();`;

export function appPage(path, nonce) {
  let view = null;
  let id = "";
  if (path === "/memories") view = "entries";
  else if (path === "/graph") view = "graph";
  else if (path === "/quests") view = "quests";
  else if (path === "/agents") view = "agents";
  else if (path === "/apps") view = "apps";
  else if (path === "/usage") view = "usage";
  else if (path === "/settings") view = "settings";
  else if (path === "/entries") view = "entries";
  else if (path === "/invite") view = "invite";
  else if (path === "/auth/callback") view = "callback";
  else if (path.startsWith("/entries/")) {
    const raw = path.slice("/entries/".length);
    if (raw && !raw.includes("/")) {
      try {
        id = decodeURIComponent(raw);
        view = "entry";
      } catch {
        view = null;
      }
    }
  }
  if (!view) return null;

  const spec = PAGE_SPEC[view];
  const nav = APP_ROUTES.map(([href, label]) => {
    const active = (view === "entry" && href === "/memories") || path === href;
    return `<a class="cl-nav__item${active ? " is-current" : ""}" href="${href}"${active ? ' aria-current="page"' : ""}>${label}</a>`;
  }).join("");

  const header = `<header class="bar wrap"><a class="logo" href="/" aria-label="Clyde home">${LOGO()}</a>` +
    (view === "invite" ? "" : `<nav class="app-nav" aria-label="Workspace">${nav}</nav>`) +
    `<div id="app-user-bar" class="app-bar-user"></div></header>`;

  const headActs = view === "invite" || view === "callback"
    ? ""
    : `<div class="app-head-acts"><a class="cl-btn cl-btn--primary cl-btn--sm" href="/agents?connect=1">Connect new agent</a><a class="cl-btn cl-btn--sm" href="/agents">View agents</a></div>`;

  const main = `<main class="wrap app-wrap">` +
    `<div class="app-head"><div><span class="cl-label">${view === "invite" ? "Clyde invite" : "Clyde workspace"}</span><h1 class="cl-title-1">${esc(spec.heading)}</h1>` +
    `<p class="cl-hint">${esc(spec.sub)}</p></div>${headActs}</div>` +
    `<div id="app-root" class="app-grid" data-view="${view}" data-id="${esc(id)}"><noscript><p class="cl-error">Turn on JavaScript to use your Clyde workspace.</p></noscript></div>` +
    `</main>`;

  const footer = `<footer class="foot"><div class="wrap"><span class="brand">${MARK(22)}clyde</span>` +
    `<nav aria-label="Footer"><a href="/docs">Docs</a><a href="/faq">FAQ</a><a href="mailto:support@heyclyde.me">support@heyclyde.me</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="${DESIGN_URL}">Design system</a></nav>` +
    `<span class="legal">${LEGAL}</span></div></footer>`;

  return {
    status: 200,
    cacheControl: "no-store",
    html: shell({ nonce, title: spec.title, css: APP_CSS + AUTH_CSS, body: header + main + footer, script: APP_JS, noindex: true }),
  };
}
