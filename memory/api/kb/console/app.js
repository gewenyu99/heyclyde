// The kb console: login, shell, router and the overview. Other views live in entries.js, logs.js and charts.js.
import {
  api, auth, onUnauthorized, forgetMeta, readHash, href, leave, onLeave, h, note, loading, failed, pageHead, card,
  num, when, toDate, ago, dl, table, flash, plural, ApiError, armsRevealed, revealArms,
} from './lib.js';
import { entriesView, entryView, newEntryView } from './entries.js';
import { sessionsView, sessionView, eventsView, recallsView, recallView, feedbackView, messagesView, auditView, playgroundView } from './logs.js';
import { graphView, activityChart, resetPalette } from './charts.js';

const NAV = [
  ['overview', 'Overview'], ['entries', 'Entries'], ['graph', 'Graph'], ['sessions', 'Sessions'], ['events', 'Events'],
  ['recalls', 'Recalls'], ['feedback', 'Feedback'], ['messages', 'Messages'], ['playground', 'Playground'], ['audit', 'Audit'],
];

// route name -> [view, nav item it lights up]
const ROUTES = {
  overview: [overview, 'overview'],
  entries: [(root, [sub], p) => (sub === 'new' ? newEntryView(root, p) : entriesView(root, p)), 'entries'],
  entry: [(root, [id]) => entryView(root, id), 'entries'],
  graph: [(root, _, p) => graphView(root, p), 'graph'],
  sessions: [(root) => sessionsView(root), 'sessions'],
  session: [(root, [id]) => sessionView(root, id), 'sessions'],
  events: [(root) => eventsView(root), 'events'],
  recalls: [(root) => recallsView(root), 'recalls'],
  recall: [(root, [id]) => recallView(root, id), 'recalls'],
  feedback: [(root) => feedbackView(root), 'feedback'],
  messages: [(root) => messagesView(root), 'messages'],
  playground: [(root, _, p) => playgroundView(root, p), 'playground'],
  audit: [(root) => auditView(root), 'audit'],
};

const app = document.getElementById('app');
let shell = null;

// ---------------------------------------------------------------- login
function showLogin(message = '') {
  leave();
  shell = null;
  auth.clear();
  forgetMeta();
  resetPalette();
  const input = h('input', { type: 'password', name: 'token', autocomplete: 'current-password', spellcheck: 'false', required: true });
  const msg = h('p', { class: 'flash error', role: 'alert' }, message);
  const button = h('button', { type: 'submit', class: 'primary' }, 'Sign in');
  const form = h('form', { class: 'login-card' },
    h('h1', null, 'kb'),
    h('p', { class: 'muted' }, "Wen's memory console."),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Admin token'), input,
      h('span', { class: 'hint' }, "KB_ADMIN_TOKEN. The agents' token won't open it.")),
    msg, button);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = input.value.trim();
    if (!token) { msg.textContent = 'Enter the admin token.'; return; }
    button.disabled = true;
    msg.textContent = '';
    auth.token = token;
    try {
      await api('/meta');
      auth.save(token);
      route();
    } catch (err) {
      // A 401 already re-rendered this screen with "Wrong token."
      if (!(err instanceof ApiError && err.status === 401)) {
        auth.token = '';
        msg.textContent = err.message;
        button.disabled = false;
      }
    }
  });
  app.replaceChildren(h('main', { class: 'login' }, form));
  document.title = 'Sign in · kb';
  input.focus();
}

onUnauthorized(() => showLogin('Wrong token.'));

// ---------------------------------------------------------------- shell and router
function buildShell() {
  const links = NAV.map(([key, label]) => h('li', null, h('a', { href: href(key), 'data-key': key }, label)));
  const menu = h('button', { type: 'button', class: 'menu', 'aria-expanded': 'false', 'aria-controls': 'nav-list' }, 'Menu');
  const nav = h('nav', { class: 'side', 'aria-label': 'Sections' },
    h('div', { class: 'brand' }, h('a', { href: href('overview') }, h('strong', null, 'kb'), h('span', null, 'console')), menu),
    h('div', { class: 'nav-body', id: 'nav-list' },
      h('ul', null, links),
      h('button', { type: 'button', class: 'link logout', onclick: () => { revealArms(!armsRevealed()); location.reload(); } },
        armsRevealed() ? 'Hide arms' : 'Reveal arms'),
      h('button', { type: 'button', class: 'link logout', onclick: () => showLogin() }, 'Log out')));
  menu.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    menu.setAttribute('aria-expanded', String(open));
  });
  const main = h('main', { id: 'main', tabindex: '-1' });
  app.replaceChildren(h('a', { class: 'skip', href: '#main', onclick: (e) => { e.preventDefault(); main.focus(); } }, 'Skip to content'),
    h('div', { class: 'shell' }, nav, main));
  return { nav, main, menu };
}

function route() {
  if (!auth.token) return showLogin();
  if (!shell) shell = buildShell();
  leave();
  const { segs, params } = readHash();
  const [name = 'overview', ...rest] = segs;
  const [view, key] = ROUTES[name] || [notFound, ''];
  for (const a of shell.nav.querySelectorAll('a[data-key]')) {
    if (a.dataset.key === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  shell.nav.classList.remove('open');
  shell.menu.setAttribute('aria-expanded', 'false');
  document.title = `${NAV.find(([k]) => k === key)?.[1] || 'Not found'} · kb`;
  // Each route renders into a fresh node. A slow response for an old route lands in a detached node and is never seen.
  const root = h('div', { class: 'view' });
  shell.main.replaceChildren(root);
  window.scrollTo(0, 0);
  Promise.resolve()
    .then(() => view(root, rest, params))
    .catch((err) => {
      if (!(err instanceof ApiError && err.status === 401)) root.replaceChildren(failed(err, route));
    });
}

function notFound(root) {
  root.append(pageHead('Not found'), note('No page lives at this address.', 'empty'), h('p', null, h('a', { href: href('overview') }, 'Go to the overview')));
}

// ---------------------------------------------------------------- overview
const TILES = [
  ['entries', 'Current entries', href('entries')],
  ['superseded', 'Superseded', href('entries', { superseded: 'superseded' })],
  ['private', 'Private', href('entries', { sensitivity: 'private', superseded: 'all' })],
  ['links', 'Links', href('graph', { superseded: '1' })],
  ['sources', 'Sources', null],
  ['projects', 'Projects', href('graph')],
  ['events', 'Events', href('events')],
  ['client_sessions', 'Client sessions', null],
  ['mcp_sessions', 'MCP sessions', href('sessions')],
  ['recalls', 'Recalls', href('recalls')],
  ['feedback', 'Feedback', href('feedback')],
  ['messages', 'Messages', href('messages')],
];

const LIVE_SECONDS = 3600;

// The IANA zone, like America/New_York. A browser that won't say gets UTC days.
function localZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

// Driven by hooks only. An agent opening an entry over MCP writes an event too, but says nothing about the hooks.
function liveIndicator(last) {
  const d = last && toDate(last);
  if (!d) return h('span', { class: 'live off' }, h('span', { class: 'dot' }), 'No hooks yet.');
  const fresh = (Date.now() - d.getTime()) / 1000 < LIVE_SECONDS;
  return h('span', { class: `live ${fresh ? 'on' : 'off'}`, title: d.toString() }, h('span', { class: 'dot' }),
    fresh ? `Live. Last hook ${ago(d)}.` : `Quiet. Last hook ${ago(d)}.`);
}

function healthLine(hl) {
  const chip = (ok, text) => h('span', { class: `chip ${ok ? 'good' : 'bad'}` }, h('span', { class: 'dot' }), text);
  return h('div', { class: 'health' },
    chip(hl.db, hl.db ? 'Database up' : 'Database down'),
    chip(hl.vector, hl.vector ? 'Vector search on' : 'Vector search off. Hybrid runs keyword only'),
    h('span', { class: 'chip' }, 'Live arms: ', h('strong', null, (hl.arms || []).join(', ') || 'none')),
    h('span', { class: 'chip' }, 'Embeddings: ', h('strong', null, hl.embedding_model || 'unknown')));
}

function tiles(c) {
  const tile = (label, value, to, sub) => h(to ? 'a' : 'div', { class: 'tile', href: to },
    h('span', { class: 'tile-label' }, label), h('span', { class: 'tile-value' }, value), sub && h('span', { class: 'tile-sub muted' }, sub));
  const unread = c.unread || {};
  // One message to all waits for both agents. The tile counts it once, so it never tops Messages.
  return h('div', { class: 'tiles' },
    TILES.map(([k, label, to]) => tile(label, num(c[k]), to)),
    tile('Unread messages', num(c.unread_messages), href('messages'), `claude ${num(unread.claude || 0)} waiting, codex ${num(unread.codex || 0)}`));
}

// How the server's latest embedding sync went, the startup one included.
function syncNote(s) {
  if (!s) return '';
  const at = toDate(s.finished_at || s.started_at);
  const since = at ? ago(at) : '';
  if (s.running) {
    return h('p', { class: 'flash warn' }, `Syncing now. ${s.trigger === 'startup' ? 'The server started it at startup' : 'The console started it'} ${since}.`);
  }
  if (s.error) return h('p', { class: 'flash error' }, `The last sync failed ${since}. ${s.error}`);
  return h('p', { class: 'flash ok' }, `The last sync embedded ${plural(s.embedded ?? 0, 'entry', 'entries')} ${since}.`);
}

function embeddingsCard(e, sync, refresh) {
  const total = (e.embedded || 0) + (e.stale_or_missing || 0);
  const pct = total ? Math.round((e.embedded / total) * 100) : 0;
  const out = flash();
  const button = h('button', { type: 'button', disabled: !!sync?.running }, sync?.running ? 'Syncing' : 'Sync embeddings');
  button.addEventListener('click', async () => {
    button.disabled = true;
    out.clear();
    try {
      await api('/embeddings/sync', { method: 'POST' });
    } catch (err) {
      // A 409 means one is running already. The refresh below shows it.
      if (err.status !== 409) { out.show(err.message, 'error'); button.disabled = false; return; }
    }
    refresh();
  });
  return card('Embeddings',
    h('div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Embedding coverage' },
      h('span', { class: 'meter-fill', 'data-pct': pct })),
    h('p', null, total ? `${num(e.embedded)} of ${num(total)} current entries embedded (${pct}%).` : 'No current entries.',
      e.stale_or_missing ? ` ${num(e.stale_or_missing)} stale or missing.` : ' All fresh.'),
    h('div', { class: 'sync-status', role: 'status', 'aria-live': 'polite' }, syncNote(sync)),
    h('div', { class: 'row' }, button, out));
}

function lastCard(last) {
  return card('Last activity', dl([
    ['Hook', when(last.hook)], ['Any event', when(last.event)], ['Recall', when(last.recall)], ['Message', when(last.message)],
    ['Feedback', when(last.feedback)],
  ]));
}

function activitySection(promise) {
  const chart = h('div', { class: 'chart' }, loading());
  const agents = h('div', null, loading());
  const byType = h('div', null, loading());
  const clients = h('div', null, loading());
  promise.then((a) => {
    activityChart(chart, a.days || []);
    const ag = a.agents || [];
    agents.replaceChildren(ag.length ? table([
      { label: 'Agent', render: (r) => (r.agent === 'unknown' ? h('span', { class: 'muted' }, 'not named') : r.agent) },
      { label: 'Hook events', class: 'num', render: (r) => num(r.events) },
      { label: 'Sessions', class: 'num', render: (r) => num(r.sessions) },
      { label: 'Last', render: (r) => when(r.last) },
    ], ag, { rowLink: (r) => href('events', r.agent === 'unknown' ? {} : { agent: r.agent }) })
      : note('No hooks fired in these 14 days.', 'empty'));
    const types = a.events_by_type || [];
    const max = Math.max(1, ...types.map((t) => t.count));
    byType.replaceChildren(types.length ? table([
      { label: 'Event', render: (t) => h('span', { class: 'mono' }, t.event) },
      { label: 'Count', class: 'num bar-cell', render: (t) => [h('span', { class: 'inline-bar', 'data-w': t.count / max }), num(t.count)] },
      { label: 'Last', render: (t) => when(t.last) },
    ], types, { rowLink: (t) => href('events', { event: t.event }) }) : note('No hook events yet.', 'empty'));
    const cl = a.clients || [];
    clients.replaceChildren(cl.length ? table([
      { label: 'Client', render: (c) => c.client || h('span', { class: 'muted' }, 'unknown') },
      { label: 'Sessions', class: 'num', render: (c) => num(c.sessions) },
      { label: 'Recalls', class: 'num', render: (c) => num(c.recalls) },
      { label: 'Last', render: (c) => when(c.last) },
    ], cl, { rowLink: (c) => href('sessions', { client: c.client && c.client !== 'unknown' ? c.client : '' }) }) : note('No clients yet.', 'empty'));
    sizeBars(byType);
  }, (err) => {
    for (const el of [chart, agents, byType, clients]) el.replaceChildren(failed(err, () => location.reload()));
  });
  return [
    card('Last 14 days', chart),
    h('div', { class: 'grid-2' },
      card('Hooks by agent', agents, h('p', { class: 'muted small' }, 'Agents name themselves through kb-hook. Older hooks sent no name.')),
      card('Events by type', byType)),
    card('MCP clients', clients),
  ];
}

// Bar widths go through the CSSOM, never a style attribute, so a strict style-src policy still holds.
function sizeBars(el) {
  for (const b of el.querySelectorAll('[data-w]')) b.style.width = `${Math.max(2, Number(b.dataset.w) * 100)}%`;
  for (const b of el.querySelectorAll('[data-pct]')) b.style.width = `${Number(b.dataset.pct)}%`;
}

async function overview(root) {
  const live = h('span');
  const top = h('div', { class: 'stack' }, loading());
  root.append(pageHead('Overview', live), top);
  // Days follow this browser's time zone, so the chart's dates match the local calendar. A zone the database doesn't
  // know gets a 400, and the chart falls back to UTC days.
  const activity = api('/activity', { params: { days: 14, tz: localZone() } })
    .catch((err) => (err.status === 400 ? api('/activity', { params: { days: 14 } }) : Promise.reject(err)));
  activity.catch(() => {});

  // While a sync runs, check every 3 s, so its end shows without a reload.
  let soon = null;
  const refresh = async () => {
    clearTimeout(soon);
    try {
      const o = await api('/overview');
      if (root.isConnected) paint(o);
    } catch { /* The next tick tries again. */ }
  };
  const paint = (o) => {
    live.replaceChildren(liveIndicator(o.last?.hook));
    top.replaceChildren(healthLine(o.health || {}), tiles(o.counts || {}),
      h('div', { class: 'grid-2' }, embeddingsCard(o.embeddings || {}, o.health?.sync, refresh), lastCard(o.last || {})));
    sizeBars(top);
    clearTimeout(soon);
    if (o.health?.sync?.running) soon = setTimeout(refresh, 3000);
  };
  paint(await api('/overview'));
  root.append(...activitySection(activity));

  // Keep the live indicator and counts honest while the page stays open.
  const timer = setInterval(refresh, 60000);
  onLeave(() => { clearInterval(timer); clearTimeout(soon); });
}

// ---------------------------------------------------------------- boot
window.addEventListener('hashchange', route);
route();

