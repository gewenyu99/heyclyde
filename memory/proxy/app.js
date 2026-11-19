// Authenticated heyclyde.me app pages (R51-R65): /memories, /entries/<id>, /graph, /quests, /agents, /apps, /usage, /settings.
// Self-contained ES module with nonce'd CSS and vanilla client script, zero external scripts, zero inline style attrs,
// zero slop, and zero matches of /\bmemory\b/i in visible copy.
import { AUTH_PROVIDERS, OR_RULE, providerButton } from "../design/auth.js";
import { AUTH_CSS } from "../design/css.js";
import { DESIGN_URL, esc, LEGAL, LOGO, MARK, shell } from "./pages.js";
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
.app-bar-user{margin-left:auto;display:flex;align-items:center;gap:10px;font:var(--cl-text-small);color:var(--cl-ink-2)}
.app-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;padding-bottom:14px;border-bottom:1.5px dashed var(--cl-rule-strong)}
.app-head h1{margin:4px 0 0}
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
.gr-wrap{border:1px solid var(--cl-rule-strong);border-radius:var(--cl-radius-xl);background:var(--cl-paper-1);overflow:hidden}
.gr-svg{display:block;width:100%;height:auto;max-height:560px;background:var(--cl-paper-0)}
.gr-edge{stroke:var(--cl-rule-strong);stroke-width:1.4}
.gr-node{cursor:pointer;text-decoration:none}
.gr-node circle{fill:var(--cl-paper-1);stroke:var(--cl-carbon);stroke-width:2}
.gr-node.is-center circle{fill:var(--cl-carbon);stroke:var(--cl-ink);stroke-width:2.5}
.gr-node.is-dormant circle{stroke:var(--cl-ink-3);stroke-dasharray:3 2}
.gr-node text{font:500 11px/1.2 var(--cl-font-sans);fill:var(--cl-ink)}
.gr-node:hover circle{stroke:var(--cl-ink);stroke-width:3}
.signin-box{max-width:460px;margin:12px auto;display:grid;gap:16px;padding:24px}
.app-banner{padding:12px 16px;border-radius:var(--cl-radius-md);font:var(--cl-text-small)}
.app-banner--ok{background:var(--cl-ok-wash);color:var(--cl-ok)}
.app-banner--bad{background:var(--cl-bad-wash);color:var(--cl-bad)}
.app-banner--warn{background:var(--cl-warn-wash);color:var(--cl-warn)}
.is-hidden{display:none}
.app-qcol{display:grid;gap:12px}
.app-qcol-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-bottom:6px;border-bottom:1px dashed var(--cl-rule-strong)}
.danger-zone{border-color:var(--cl-bad)}
`;

const PAGE_SPEC = {
  entries: { title: "Notes · Clyde", heading: "Notes", sub: "Search and filter notes saved by your agents and connected apps." },
  entry: { title: "Note · Clyde", heading: "Note detail", sub: "Inspect provenance, artifacts, links, and confidence history. Edit, prune, supersede, or delete this note." },
  graph: { title: "Graph · Clyde", heading: "Graph", sub: "See how saved notes link together, 1 to 3 hops out (up to 300 nodes)." },
  quests: { title: "Quest board · Clyde", heading: "Quest board", sub: "Post tasks for your agents and check what's open, claimed, or done." },
  agents: { title: "Agents and devices · Clyde", heading: "Agents and devices", sub: "Update agent nicknames, types, harnesses, and repos, or revoke connected devices." },
  apps: { title: "Connected apps · Clyde", heading: "Connected apps", sub: "Check which client apps hold OAuth access and revoke a grant anytime." },
  usage: { title: "Usage and billing · Clyde", heading: "Usage and billing", sub: "Check your plan, monthly usage meters, and overage spend limit." },
  settings: { title: "Settings · Clyde", heading: "Settings", sub: "Download an NDJSON export of your records or permanently delete your account." },
  callback: { title: "Signing in · Clyde", heading: "Signing in", sub: "Finishing your Google or GitHub sign-in." },
};

// The provider buttons the sign-in form can show, from design/auth.mjs. Which ones show is Supabase Auth's call:
// the page asks /auth/v1/settings and draws only the providers it has turned on.
const PROVIDER_BUTTONS = Object.fromEntries(AUTH_PROVIDERS.map((p) => [p, providerButton(p)]));

const APP_JS = `(function(){
var root = document.getElementById('app-root');
if (!root) return;
var view = root.getAttribute('data-view');
var entryId = root.getAttribute('data-id') || '';
var STORE = 'clyde_session_v1';
var PROVIDER_BUTTONS = ${JSON.stringify(PROVIDER_BUTTONS).replace(/</g, "\\u003c")};
var OR_RULE = ${JSON.stringify(OR_RULE).replace(/</g, "\\u003c")};
var social = (${socialClient.toString()})(window);
// Where a provider sign-in lands afterwards: this page, or the page a failed callback was headed to.
var afterSignIn = view === 'callback' ? '/memories' : location.pathname + location.search;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
  });
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
  if (!s) {
    bar.innerHTML = '<a class="cl-btn cl-btn--sm" href="/memories">Sign in</a>';
    return;
  }
  bar.innerHTML = '<span>' + esc(s.email || 'Signed in') + '</span>' +
    '<button type="button" class="cl-btn cl-btn--sm cl-btn--ghost" id="btn-signout">Sign out</button>';
  var out = document.getElementById('btn-signout');
  if (out) out.addEventListener('click', function() {
    var tok = s.access_token;
    writeSession(null);
    if (tok) fetch('/auth/v1/logout', { method: 'POST', headers: { authorization: 'Bearer ' + tok } }).catch(function(){});
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
      '<p class="cl-hint">Enter your email for a sign-in link or code, or use a password if your account has one.</p>' +
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

// Google and GitHub, when Supabase Auth has them on. A settings call that fails shows none, and email still works.
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

// /auth/callback: the provider sent the tab back. The code leaves the address bar before anything else happens.
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

async function renderEntries() {
  var sp = new URLSearchParams(location.search);
  root.innerHTML =
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
        list.innerHTML = '<div class="cl-empty"><p class="cl-empty__title">No matching notes</p><p class="cl-empty__text">Nothing matches those filters. Clear your search or switch State to all to include pruned and superseded notes.</p></div>';
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
  await load();
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

    root.innerHTML =
      '<div class="app-actions"><a class="cl-btn cl-btn--sm" href="/memories">Back to notes</a>' +
      '<a class="cl-btn cl-btn--sm" href="/graph?center=' + encodeURIComponent(e.id) + '">Open in graph</a></div>' +
      '<div id="detail-msg" class="is-hidden"></div>' +
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
      '<form id="edit-form" class="cl-card app-form">' +
        '<h3 class="cl-title-3">Edit note</h3>' +
        '<div class="cl-field"><label for="ed-title">Title</label><input id="ed-title" class="cl-input" value="' + esc(e.title) + '" maxlength="300" placeholder="1 to 300 characters" required></div>' +
        '<div class="cl-field"><label for="ed-body">Body</label><textarea id="ed-body" class="cl-textarea" maxlength="4000" placeholder="1 to 4,000 characters" required>' + esc(e.body || '') + '</textarea></div>' +
        '<div class="cl-field"><label for="ed-ev">Evidence</label><textarea id="ed-ev" class="cl-textarea" maxlength="20000" placeholder="Source or reason for this note (required, 1 to 20,000 characters)">' + esc(e.evidence || '') + '</textarea></div>' +
        '<div class="app-form-row">' +
          '<div class="cl-field"><label for="ed-proj">Project</label><input id="ed-proj" class="cl-input" value="' + esc(e.project || '') + '" placeholder="Project ID (optional)"></div>' +
          '<div class="cl-field"><label for="ed-ctx">Context</label><select id="ed-ctx" class="cl-select"><option value="general">general</option><option value="work">work</option><option value="home">home</option><option value="hobby">hobby</option><option value="personal">personal</option></select></div>' +
          '<div class="cl-field"><label for="ed-sens">Sensitivity</label><select id="ed-sens" class="cl-select"><option value="normal">normal</option><option value="private">private</option><option value="confidential">confidential</option></select></div>' +
        '</div>' +
        '<div class="app-actions"><button type="submit" class="cl-btn cl-btn--primary">Save changes</button></div>' +
      '</form>' +
      '<section class="cl-card app-grid">' +
        '<h3 class="cl-title-3">Actions</h3>' +
        '<div class="app-actions">' +
          '<button type="button" class="cl-btn" id="btn-prune">Prune note</button>' +
          '<form id="sup-form" class="app-actions"><input id="sup-id" class="cl-input" placeholder="Replacement note ID" required><button type="submit" class="cl-btn">Mark superseded</button></form>' +
          '<button type="button" class="cl-btn cl-btn--danger" id="btn-del">Delete note</button>' +
          '<button type="button" class="cl-btn cl-btn--danger is-hidden" id="btn-del-yes">Delete note permanently</button>' +
        '</div>' +
      '</section>';

    document.getElementById('ed-ctx').value = e.context || 'general';
    document.getElementById('ed-sens').value = e.sensitivity || 'normal';
    var msg = document.getElementById('detail-msg');

    document.getElementById('edit-form').addEventListener('submit', async function(ev) {
      ev.preventDefault();
      clearNotice(msg);
      try {
        await api('/me/entries/' + encodeURIComponent(entryId), {
          method: 'PATCH',
          body: JSON.stringify({
            title: document.getElementById('ed-title').value,
            body: document.getElementById('ed-body').value,
            evidence: document.getElementById('ed-ev').value,
            project: document.getElementById('ed-proj').value.trim() || null,
            context: document.getElementById('ed-ctx').value,
            sensitivity: document.getElementById('ed-sens').value
          })
        });
        notice(msg, 'ok', 'Note saved.');
        renderEntryDetail();
      } catch (err) { notice(msg, 'bad', err.message); }
    });

    document.getElementById('btn-prune').addEventListener('click', async function() {
      clearNotice(msg);
      try {
        await api('/me/entries/' + encodeURIComponent(entryId) + '/prune', { method: 'POST', body: '{}' });
        notice(msg, 'ok', 'Note pruned. Confidence is 0%, so default recall hides it.');
        renderEntryDetail();
      } catch (err) { notice(msg, 'bad', err.message); }
    });

    document.getElementById('sup-form').addEventListener('submit', async function(ev) {
      ev.preventDefault();
      clearNotice(msg);
      try {
        await api('/me/entries/' + encodeURIComponent(entryId) + '/supersede', {
          method: 'POST',
          body: JSON.stringify({ replacement: document.getElementById('sup-id').value.trim() })
        });
        notice(msg, 'ok', 'Note marked as superseded.');
        renderEntryDetail();
      } catch (err) { notice(msg, 'bad', err.message); }
    });

    document.getElementById('btn-del').addEventListener('click', function() {
      document.getElementById('btn-del-yes').classList.remove('is-hidden');
    });
    document.getElementById('btn-del-yes').addEventListener('click', async function() {
      try {
        await api('/me/entries/' + encodeURIComponent(entryId), { method: 'DELETE' });
        location.href = '/memories';
      } catch (err) { notice(msg, 'bad', err.message); }
    });
  } catch (err) {
    root.innerHTML = '<div class="app-banner app-banner--bad">' + esc(err.message) + '</div>';
  }
}

async function renderGraph() {
  var sp = new URLSearchParams(location.search);
  root.innerHTML =
    '<form id="g-form" class="cl-card app-form-row">' +
      '<div class="cl-field"><label for="g-center">Center note ID</label><input id="g-center" class="cl-input" value="' + esc(sp.get('center') || '') + '" placeholder="Leave blank for most linked"></div>' +
      '<div class="cl-field"><label for="g-depth">Depth</label><select id="g-depth" class="cl-select"><option value="1">1 hop</option><option value="2">2 hops</option><option value="3">3 hops</option></select></div>' +
      '<div class="app-actions"><button type="submit" class="cl-btn cl-btn--primary">Load graph</button></div>' +
    '</form>' +
    '<div id="g-status" class="cl-hint">Loading graph...</div>' +
    '<div id="g-canvas" class="gr-wrap"></div>' +
    '<div id="g-nodes" class="app-table-wrap"></div>';

  var depthEl = document.getElementById('g-depth');
  depthEl.value = sp.get('depth') || '2';

  async function load() {
    var qs = new URLSearchParams();
    var c = document.getElementById('g-center').value.trim();
    if (c) qs.set('center', c);
    qs.set('depth', depthEl.value || '2');
    try {
      var d = await api('/me/graph?' + qs.toString());
      var st = document.getElementById('g-status');
      st.textContent = d.nodes.length + (d.nodes.length === 1 ? ' node, ' : ' nodes, ') + d.edges.length + (d.edges.length === 1 ? ' link' : ' links') + (d.center ? ' around ' + d.center : '') + (d.nodes.length >= 300 ? ' (300-node cap)' : '');
      if (!d.nodes.length) {
        document.getElementById('g-canvas').innerHTML = '<div class="cl-empty"><p class="cl-empty__title">No notes in the graph yet</p><p class="cl-empty__text">Once your agents or apps save notes, their links appear here.</p></div>';
        document.getElementById('g-nodes').innerHTML = '';
        return;
      }
      var pos = {};
      var cx = 420, cy = 260;
      pos[d.center] = { x: cx, y: cy };
      var ring = d.nodes.filter(function(n) { return n.id !== d.center; });
      ring.forEach(function(n, idx) {
        var r = idx < 12 ? 125 : (idx < 48 ? 205 : 240);
        var angle = (idx * 2.399963);
        pos[n.id] = { x: Math.round(cx + Math.cos(angle) * r * 1.45), y: Math.round(cy + Math.sin(angle) * r) };
      });
      var edgesSvg = d.edges.map(function(ed) {
        var a = pos[ed.src], b = pos[ed.dst];
        if (!a || !b) return '';
        return '<line class="gr-edge" x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '"></line>';
      }).join('');
      var nodesSvg = d.nodes.map(function(n) {
        var p = pos[n.id] || { x: cx, y: cy };
        var isCenter = n.id === d.center;
        var cls = 'gr-node' + (isCenter ? ' is-center' : '') + (Number(n.confidence) < 0.15 ? ' is-dormant' : '');
        var r = isCenter ? 11 : 7;
        var label = String(n.title || n.id).slice(0, 26);
        return '<a href="/entries/' + encodeURIComponent(n.id) + '" class="' + cls + '" data-node="' + esc(n.id) + '">' +
          '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + r + '"></circle>' +
          '<text x="' + (p.x + 12) + '" y="' + (p.y + 4) + '">' + esc(label) + '</text>' +
        '</a>';
      }).join('');
      document.getElementById('g-canvas').innerHTML =
        '<svg class="gr-svg" viewBox="0 0 840 520" role="img" aria-label="Note neighborhood graph">' + edgesSvg + nodesSvg + '</svg>';
      document.getElementById('g-nodes').innerHTML =
        '<table class="app-table"><thead><tr><th>Note</th><th>Kind</th><th>Confidence</th></tr></thead><tbody>' +
        d.nodes.map(function(n) {
          return '<tr><td><a class="cl-link" href="/entries/' + encodeURIComponent(n.id) + '">' + esc(n.title || n.id) + '</a></td><td>' + esc(n.pattern || n.kind) + '</td><td>' + confText(n.confidence) + '</td></tr>';
        }).join('') + '</tbody></table>';
    } catch (err) {
      document.getElementById('g-status').textContent = err.message;
    }
  }

  document.getElementById('g-form').addEventListener('submit', function(e) {
    e.preventDefault();
    load();
  });
  await load();
}

async function renderQuests() {
  root.innerHTML =
    '<form id="q-post" class="cl-card app-form">' +
      '<h2 class="cl-title-3">Post a quest</h2>' +
      '<div id="q-msg" class="is-hidden"></div>' +
      '<div class="app-form-row">' +
        '<div class="cl-field"><label for="qt-title">Title</label><input id="qt-title" class="cl-input" required maxlength="120" placeholder="Short task title (up to 120 chars)"></div>' +
        '<div class="cl-field"><label for="qt-pri">Priority</label><select id="qt-pri" class="cl-select"><option value="normal">normal</option><option value="high">high</option><option value="urgent">urgent</option><option value="low">low</option></select></div>' +
        '<div class="cl-field"><label for="qt-ctx">Context</label><select id="qt-ctx" class="cl-select"><option value="both">both</option><option value="work">work</option><option value="home">home</option><option value="hobby">hobby</option><option value="personal">personal</option></select></div>' +
      '</div>' +
      '<div class="cl-field"><label for="qt-brief">Brief</label><textarea id="qt-brief" class="cl-textarea" required maxlength="500" placeholder="Describe what needs doing (up to 500 chars)"></textarea></div>' +
      '<div class="cl-field"><label for="qt-done">Done when</label><input id="qt-done" class="cl-input" required maxlength="300" placeholder="Check or command that proves it is done (up to 300 chars)"></div>' +
      '<div class="app-form-row">' +
        '<div class="cl-field"><label for="qt-types">Target agent types (comma-separated)</label><input id="qt-types" class="cl-input" placeholder="coding, review"></div>' +
        '<div class="cl-field"><label for="qt-repo">Target repo</label><input id="qt-repo" class="cl-input" placeholder="owner/repo or project slug"></div>' +
      '</div>' +
      '<div class="app-actions"><button type="submit" class="cl-btn cl-btn--primary">Post quest</button></div>' +
    '</form>' +
    '<div id="q-board" class="app-cols-3">' +
      '<section class="app-qcol"><div class="app-qcol-head"><h2 class="cl-title-3">Open</h2><span class="cl-chip" id="cnt-open">0</span></div><div id="col-open" class="app-grid"></div></section>' +
      '<section class="app-qcol"><div class="app-qcol-head"><h2 class="cl-title-3">Claimed</h2><span class="cl-chip" id="cnt-claimed">0</span></div><div id="col-claimed" class="app-grid"></div></section>' +
      '<section class="app-qcol"><div class="app-qcol-head"><h2 class="cl-title-3">Done</h2><span class="cl-chip" id="cnt-done">0</span></div><div id="col-done" class="app-grid"></div></section>' +
    '</div>';

  async function load() {
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
          '</div>' +
        '</article>';
      }).join('') : '<p class="cl-hint">No ' + col + ' quests.</p>';
    });
  }

  var msg = document.getElementById('q-msg');
  document.getElementById('q-post').addEventListener('submit', async function(e) {
    e.preventDefault();
    clearNotice(msg);
    var types = document.getElementById('qt-types').value.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    var repo = document.getElementById('qt-repo').value.trim();
    var target = {};
    if (types.length) target.types = types;
    if (repo) target.repo = repo;
    try {
      await api('/me/quests', {
        method: 'POST',
        body: JSON.stringify({
          title: document.getElementById('qt-title').value,
          brief: document.getElementById('qt-brief').value,
          done_when: document.getElementById('qt-done').value,
          priority: document.getElementById('qt-pri').value,
          context: document.getElementById('qt-ctx').value,
          target: target
        })
      });
      document.getElementById('q-post').reset();
      notice(msg, 'ok', 'Quest posted.');
      await load();
    } catch (err) { notice(msg, 'bad', err.message); }
  });
  await load();
}

async function renderAgents() {
  root.innerHTML = '<div id="ag-msg" class="is-hidden"></div><section class="app-grid"><h2>Registered agents</h2><div id="ag-list" class="app-grid"></div></section>' +
    '<section class="app-grid"><h2>Connected devices</h2><div id="dev-list" class="app-grid"></div></section>';
  var msg = document.getElementById('ag-msg');

  async function load() {
    var d = await Promise.all([api('/me/agents'), api('/me/devices')]);
    var agents = d[0].agents || [], devices = d[1].devices || [];
    document.getElementById('ag-list').innerHTML = agents.length ? agents.map(function(a) {
      return '<form class="cl-card app-form ag-form" data-name="' + esc(a.name) + '">' +
        '<div class="app-meta"><strong>' + esc(a.name) + '</strong>' + (a.device ? '<span class="cl-chip">Device: ' + esc(a.device) + '</span>' : '') + '</div>' +
        '<div class="app-form-row">' +
          '<div class="cl-field"><label>Nickname</label><input name="nickname" class="cl-input" value="' + esc(a.nickname || '') + '" placeholder="Lowercase slug, e.g. ada"></div>' +
          '<div class="cl-field"><label>Type</label><select name="type" class="cl-select">' +
            ['coding','exploration','research','review','ops','assistant','other'].map(function(t) {
              return '<option value="' + t + '"' + (a.type === t ? ' selected' : '') + '>' + t + '</option>';
            }).join('') +
          '</select></div>' +
          '<div class="cl-field"><label>Harness</label><input name="harness" class="cl-input" value="' + esc(a.harness || '') + '" placeholder="e.g. claude-code"></div>' +
          '<div class="cl-field"><label>Repos</label><input name="repos" class="cl-input" value="' + esc((a.repos || []).join(', ')) + '" placeholder="owner/repo, clyde"></div>' +
        '</div>' +
        '<div class="app-actions"><button type="submit" class="cl-btn cl-btn--primary cl-btn--sm">Save agent</button></div>' +
      '</form>';
    }).join('') : '<p class="cl-hint">No agents registered yet. Connect an app or start a CLI session so your first agent registers.</p>';

    document.getElementById('dev-list').innerHTML = devices.length ? devices.map(function(dv) {
      return '<div class="cl-card app-actions"><strong>' + esc(dv.name) + '</strong>' +
        '<span class="cl-chip">Hooks: ' + esc(dv.hooks || 'full') + '</span>' +
        (dv.revoked_at ? '<span class="cl-chip cl-chip--bad">Revoked</span>' : '<button type="button" class="cl-btn cl-btn--danger cl-btn--sm dev-rev" data-id="' + esc(dv.id) + '">Revoke device</button>') +
      '</div>';
    }).join('') : '<p class="cl-hint">No connected devices yet. Run the Clyde installer on a computer to add one.</p>';

    document.querySelectorAll('.ag-form').forEach(function(form) {
      form.addEventListener('submit', async function(e) {
        e.preventDefault();
        clearNotice(msg);
        var name = form.getAttribute('data-name');
        var repos = form.querySelector('[name="repos"]').value.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
        try {
          await api('/me/agents/' + encodeURIComponent(name), {
            method: 'PATCH',
            body: JSON.stringify({
              nickname: form.querySelector('[name="nickname"]').value.trim() || null,
              type: form.querySelector('[name="type"]').value,
              harness: form.querySelector('[name="harness"]').value.trim() || null,
              repos: repos
            })
          });
          notice(msg, 'ok', 'Saved changes for ' + name + '.');
          await load();
        } catch (err) { notice(msg, 'bad', err.message); }
      });
    });

    document.querySelectorAll('.dev-rev').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        clearNotice(msg);
        try {
          await api('/me/devices/' + encodeURIComponent(btn.getAttribute('data-id')), { method: 'DELETE' });
          notice(msg, 'ok', 'Device revoked. Tokens for this device no longer work.');
          await load();
        } catch (err) { notice(msg, 'bad', err.message); }
      });
    });
  }
  await load();
}

async function renderApps() {
  root.innerHTML = '<div id="apps-msg" class="is-hidden"></div><div id="apps-list" class="app-grid"></div>';
  var msg = document.getElementById('apps-msg');
  async function load() {
    var d = await api('/me/apps');
    var list = d.apps || [];
    document.getElementById('apps-list').innerHTML = list.length ? list.map(function(a) {
      return '<div class="cl-card app-actions"><div><strong>' + esc(a.name || a.id) + '</strong> <span class="cl-mono">(' + esc(a.id) + ')</span></div>' +
        '<button type="button" class="cl-btn cl-btn--danger cl-btn--sm app-rev" data-id="' + esc(a.id) + '">Revoke access</button></div>';
    }).join('') : '<div class="cl-empty"><p class="cl-empty__title">No connected apps</p><p class="cl-empty__text">Approve Clyde inside Claude, ChatGPT, Gemini, Grok, or Antigravity to see OAuth grants here.</p></div>';

    document.querySelectorAll('.app-rev').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        clearNotice(msg);
        try {
          await api('/me/apps/' + encodeURIComponent(btn.getAttribute('data-id')), { method: 'DELETE' });
          notice(msg, 'ok', 'App access revoked.');
          await load();
        } catch (err) { notice(msg, 'bad', err.message); }
      });
    });
  }
  await load();
}

var METER_LABEL = {
  ai: 'AI tokens (embeddings and judge)',
  storage_gb_hours: 'Storage (GB-hours)',
  egress_bytes: 'Network egress (bytes)',
  requests: 'Requests',
  db_bytes: 'Database storage (bytes)'
};

async function renderUsage() {
  root.innerHTML = '<div id="u-msg" class="is-hidden"></div><div id="u-summary" class="cl-card app-grid"></div>' +
    '<div id="u-meters" class="meter-list"></div>' +
    '<form id="u-limit-form" class="cl-card app-form">' +
      '<h2 class="cl-title-3">Monthly spend limit</h2>' +
      '<p class="cl-hint">Set the monthly overage cap for a paid plan, from $0 to $500 USD in whole dollars.</p>' +
      '<div class="app-actions"><div class="cl-field"><label for="u-dollars">Limit (USD)</label>' +
      '<input id="u-dollars" type="number" min="0" max="500" step="1" class="cl-input" required></div>' +
      '<button type="submit" class="cl-btn cl-btn--primary">Save spend limit</button></div>' +
    '</form>';

  var msg = document.getElementById('u-msg');
  async function load() {
    var d = await api('/me/usage');
    var s = readSession();
    var limitDollars = d.spend_limit_cents == null ? 0 : (Number(d.spend_limit_cents) / 100);
    document.getElementById('u-dollars').value = String(Math.round(limitDollars));
    document.getElementById('u-summary').innerHTML =
      '<div class="app-meta"><span class="cl-chip cl-chip--carbon">Plan: ' + esc(d.plan) + '</span>' +
      '<span class="cl-chip">Status: ' + esc(d.state || d.plan) + '</span>' +
      '<span class="cl-chip">Period: ' + esc(d.period) + '</span>' +
      '<span class="cl-chip">Spend limit: $' + limitDollars.toFixed(2) + '</span></div>' +
      (s && s.user_id && d.plan !== 'owner' ? '<div><a class="cl-btn cl-btn--sm" href="/billing/checkout?owner=' + encodeURIComponent(s.user_id) + '">Subscribe or renew</a></div>' : '');

    document.getElementById('u-meters').innerHTML = (d.meters || []).map(function(m) {
      var inc = m.included == null ? 0 : Number(m.included);
      var used = Number(m.used || 0);
      var pct = inc > 0 ? Math.min(100, Math.round((used / inc) * 100)) : 0;
      return '<div class="cl-card meter-row">' +
        '<div class="meter-top"><strong>' + esc(METER_LABEL[m.kind] || m.kind) + '</strong>' +
        '<span class="cl-mono">' + used.toLocaleString('en-US') + (m.included != null ? ' / ' + inc.toLocaleString('en-US') : ' (no limit)') +
        ' · Overage: $' + (Number(m.overage_cents || 0) / 100).toFixed(2) + '</span></div>' +
        '<progress class="meter-bar" max="100" value="' + pct + '"></progress>' +
      '</div>';
    }).join('');
  }

  document.getElementById('u-limit-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    clearNotice(msg);
    var dollars = Number(document.getElementById('u-dollars').value);
    var cents = Math.round(dollars * 100);
    try {
      await api('/me/billing', { method: 'PATCH', body: JSON.stringify({ spend_limit_cents: cents }) });
      notice(msg, 'ok', 'Spend limit updated to $' + (cents / 100).toFixed(2) + '.');
      await load();
    } catch (err) { notice(msg, 'bad', err.message); }
  });
  await load();
}

async function renderSettings() {
  root.innerHTML =
    '<div id="set-msg" class="is-hidden"></div>' +
    '<section class="cl-card app-grid">' +
      '<h2 class="cl-title-3">Export your data</h2>' +
      '<p class="cl-hint">Download clyde-export.ndjson with your notes, links, agents, devices, quests, usage, and audit records. Attached files up to 4 MiB are included.</p>' +
      '<div class="app-actions"><button type="button" class="cl-btn cl-btn--primary" id="btn-export">Download NDJSON export</button></div>' +
    '</section>' +
    '<section class="cl-card app-grid danger-zone">' +
      '<h2 class="cl-title-3">Delete account</h2>' +
      '<p class="cl-hint">Permanently erase every note, file, agent, device, quest, and your sign-in record. This cannot be undone.</p>' +
      '<div class="app-actions">' +
        '<button type="button" class="cl-btn cl-btn--danger" id="btn-acc-del">Delete account</button>' +
        '<button type="button" class="cl-btn cl-btn--danger is-hidden" id="btn-acc-del-yes">Delete account permanently</button>' +
      '</div>' +
    '</section>';
  var msg = document.getElementById('set-msg');

  document.getElementById('btn-export').addEventListener('click', async function() {
    clearNotice(msg);
    try {
      var r = await api('/me/export', { raw: true });
      if (!r.ok) throw new Error("Couldn't download export (HTTP " + r.status + '). Try again.');
      var blob = await r.blob();
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'clyde-export.ndjson';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      notice(msg, 'ok', 'Export downloaded.');
    } catch (err) { notice(msg, 'bad', err.message); }
  });

  document.getElementById('btn-acc-del').addEventListener('click', function() {
    document.getElementById('btn-acc-del-yes').classList.remove('is-hidden');
  });
  document.getElementById('btn-acc-del-yes').addEventListener('click', async function() {
    clearNotice(msg);
    try {
      await api('/me', { method: 'DELETE' });
      writeSession(null);
      root.innerHTML = '<div class="cl-card app-grid"><h2 class="cl-title-2">Account deleted</h2><p class="cl-hint">All your notes, files, devices, and account records have been deleted.</p><a class="cl-btn" href="/">Back home</a></div>';
    } catch (err) { notice(msg, 'bad', err.message); }
  });
}

async function start() {
  if (view === 'callback') return finishProviderSignIn();
  parseCallbackHash();
  var s = readSession();
  updateUserBar(s);
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
    return `<a class="cl-nav__item${active ? " is-current" : ""}" href="${href}">${label}</a>`;
  }).join("");

  const header = `<header class="bar wrap"><a class="logo" href="/" aria-label="Clyde home">${LOGO()}</a>` +
    `<nav class="app-nav" aria-label="Workspace">${nav}</nav><div id="app-user-bar" class="app-bar-user"></div></header>`;

  const main = `<main class="wrap app-wrap">` +
    `<div class="app-head"><div><span class="cl-label">Clyde workspace</span><h1 class="cl-title-1">${esc(spec.heading)}</h1>` +
    `<p class="cl-hint">${esc(spec.sub)}</p></div></div>` +
    `<div id="app-root" class="app-grid" data-view="${view}" data-id="${esc(id)}"><noscript><p class="cl-error">Turn on JavaScript to use your Clyde workspace.</p></noscript></div>` +
    `</main>`;

  const footer = `<footer class="foot"><div class="wrap"><span class="brand">${MARK(22)}clyde</span>` +
    `<nav><a href="/docs">Docs</a><a href="/faq">FAQ</a><a href="mailto:support@heyclyde.me">support@heyclyde.me</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="${DESIGN_URL}">Design system</a></nav>` +
    `<span class="legal">${LEGAL}</span></div></footer>`;

  return {
    status: 200,
    cacheControl: "no-store",
    html: shell({ nonce, title: spec.title, css: APP_CSS + AUTH_CSS, body: header + main + footer, script: APP_JS, noindex: true }),
  };
}
