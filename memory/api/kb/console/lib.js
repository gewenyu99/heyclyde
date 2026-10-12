// Helpers every view shares. Server strings reach the page through h() as text nodes, never as HTML.

// ---------------------------------------------------------------- token and API
const KEY = 'kb-token';

function stored() {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}

export const auth = {
  token: stored(),
  save(t) {
    this.token = t;
    try { localStorage.setItem(KEY, t); } catch { /* Storage is off. The token lives until reload. */ }
  },
  clear() {
    this.token = '';
    try { localStorage.removeItem(KEY); } catch { /* Nothing was stored. */ }
  },
};

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let unauthorized = () => {};
export const onUnauthorized = (fn) => { unauthorized = fn; };

export async function api(path, { method = 'GET', body, params } = {}) {
  const q = qs(params);
  const headers = { Authorization: `Bearer ${auth.token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`/api/v1${path}${q ? `?${q}` : ''}`,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "Can't reach the server.");
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401) {
    unauthorized();
    throw new ApiError(401, 'Wrong token.');
  }
  if (!res.ok) throw new ApiError(res.status, (data && typeof data.error === 'string' && data.error) || `The server answered ${res.status}.`);
  return data;
}

export const enc = encodeURIComponent;

export function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== '' && v != null && v !== false) q.set(k, String(v));
  return q.toString();
}

// /meta changes only when entries do, so one copy serves every view until a write.
let metaP = null;
export function getMeta() {
  if (!metaP) {
    const p = api('/meta');
    metaP = p;
    p.catch(() => { if (metaP === p) metaP = null; });
  }
  return metaP;
}
export const forgetMeta = () => { metaP = null; };

// ---------------------------------------------------------------- hash routes
// href('entry', id) is '#/entry/<id>'. A trailing object becomes the query string.
export function href(...segs) {
  const last = segs.at(-1);
  const params = last && typeof last === 'object' ? segs.pop() : null;
  const q = qs(params);
  return `#/${segs.map((s) => enc(s)).join('/')}${q ? `?${q}` : ''}`;
}

function decode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function readHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const i = raw.indexOf('?');
  const path = i < 0 ? raw : raw.slice(0, i);
  return { segs: path.split('/').filter(Boolean).map(decode),
           params: Object.fromEntries(new URLSearchParams(i < 0 ? '' : raw.slice(i + 1))) };
}

// Filters and pages rewrite the hash in place, so they never trigger a full re-render.
export const replaceHash = (...segs) => history.replaceState(null, '', href(...segs));

// Views register teardown (timers, simulations, observers). The router runs it on every route change.
const leaving = [];
export const onLeave = (fn) => { leaving.push(fn); };
export function leave() {
  while (leaving.length) {
    try { leaving.pop()(); } catch { /* A broken teardown must not block the next view. */ }
  }
}

// ---------------------------------------------------------------- DOM
const PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'open', 'selected', 'indeterminate']);

export function h(tag, attrs, ...kids) {
  if (attrs != null && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    kids.unshift(attrs);
    attrs = null;
  }
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  return add(el, kids);
}

export function add(el, kids) {
  for (const k of [kids].flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}

// replaceChildren that skips null, false and undefined, so `cond && node` never renders as text.
export const fill = (el, ...kids) => { el.replaceChildren(); return add(el, kids); };

const SVGNS = 'http://www.w3.org/2000/svg';
const ICONS = {
  lock: [['path', { d: 'M5 7V5a3 3 0 0 1 6 0v2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' }],
         ['rect', { x: '3', y: '7', width: '10', height: '7.5', rx: '1.5', fill: 'currentColor' }]],
};
export function icon(name, label) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `icon icon-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of ICONS[name]) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return label ? h('span', { class: 'icon-wrap', title: label, role: 'img', 'aria-label': label }, svg) : svg;
}
export const lock = () => icon('lock', 'Private');

export const link = (text, ...segs) => h('a', { href: href(...segs) }, text);
export const entryLink = (id, cls = 'mono') => h('a', { href: href('entry', id), class: cls }, id);

// Only http(s) links leave the console. A source uri like javascript:... renders as plain text.
export function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

export function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------------------------------------------------------------- formatting
const nf = new Intl.NumberFormat();
export const num = (n) => (n == null || n === '' ? '–' : nf.format(n));

export function score(s) {
  if (s == null || s === '') return '';
  const n = Number(s);
  return Number.isFinite(n) ? String(Number(n.toPrecision(3))) : String(s);
}

const UNITS = [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60]];
export function ago(d) {
  const s = (Date.now() - d.getTime()) / 1000;
  const a = Math.abs(s);
  if (a < 60) return 'just now';
  const [u, sec] = UNITS.find(([, n]) => a >= n);
  const n = `${Math.floor(a / sec)}${u}`;
  return s < 0 ? `in ${n}` : `${n} ago`;
}

const thisYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const otherYear = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' });

export function toDate(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

// YYYY-MM-DD of the local calendar day, the format date inputs take.
export const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const localTime = (d) => (d.getFullYear() === new Date().getFullYear() ? thisYear : otherYear).format(d);

// A timestamp as local time plus its age. The full date with timezone sits in the tooltip.
export function when(ts, { never = 'never' } = {}) {
  if (!ts) return h('span', { class: 'muted' }, never);
  const d = toDate(ts);
  if (!d) return h('span', null, String(ts));
  return h('time', { datetime: d.toISOString(), title: full.format(d), class: 'when' },
    h('span', null, localTime(d)), ' ', h('span', { class: 'ago' }, ago(d)));
}

export const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- small UI pieces
const AUTH = { approved: 'good', observed: 'info', draft: 'warn' };
const VERDICT = { helpful: 'good', irrelevant: 'muted', wrong: 'bad' };

export const badge = (text, kind = '') => h('span', { class: `badge ${kind}` }, text);
export const authority = (a) => (a ? badge(a, AUTH[a] || '') : '');
export const verdict = (v) => (v ? badge(v, VERDICT[v] || '') : '');

// The experiment keeps Wen blind to the arm each session drew, so his reactions stay fair. Arms show only once revealed.
const ARMS_KEY = 'kb-reveal-arms';
export function armsRevealed() {
  try { return localStorage.getItem(ARMS_KEY) === '1'; } catch { return false; }
}
export function revealArms(on) {
  try { if (on) localStorage.setItem(ARMS_KEY, '1'); else localStorage.removeItem(ARMS_KEY); } catch { /* Storage is off. Arms stay hidden. */ }
}
export const arm = (a) => (!a ? '' : armsRevealed() ? badge(a)
  : h('span', { class: 'muted', title: 'Hidden so the experiment stays blind. Reveal arms in the menu.' }, 'hidden'));

export const note = (text, kind = '') => h('div', { class: `state ${kind}`, role: kind === 'error' ? 'alert' : null }, text);
export const loading = () => note('Loading…', 'loading');

export function failed(err, retry) {
  return h('div', { class: 'state error', role: 'alert' },
    h('span', null, err?.message || 'Something broke.'),
    retry && !(err?.status >= 400 && err.status < 500) && h('button', { type: 'button', class: 'link', onclick: retry }, 'Try again'));
}

export const pageHead = (title, ...extra) => h('header', { class: 'page-head' }, h('h1', null, title), ...extra);
export const card = (title, ...kids) => h('section', { class: 'card' }, title && h('h2', null, title), ...kids);

// For radio and checkbox sets. A <label> around them would tie its text to the first box only.
export function group(label, control, hint) {
  return h('div', { class: 'field', role: 'group', 'aria-label': label }, h('span', { class: 'label' }, label), control,
    hint && h('span', { class: 'hint' }, hint));
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'label' }, label), control, hint && h('span', { class: 'hint' }, hint));
}

// options are strings or [value, label] pairs. A value missing from the options still shows, so a stale filter is visible.
export function select(name, options, value, blank) {
  const opts = options.map((o) => (Array.isArray(o) ? o : [o, o]));
  const v = value ?? '';
  if (v !== '' && !opts.some(([o]) => String(o) === String(v))) opts.push([v, v]);
  const el = h('select', { name }, blank != null && h('option', { value: '' }, blank),
    opts.map(([o, l]) => h('option', { value: o }, l ?? o)));
  el.value = String(v);
  return el;
}

let listSeq = 0;
export function datalist(values) {
  const id = `dl-${++listSeq}`;
  return [id, h('datalist', { id }, values.map((v) => (Array.isArray(v) ? h('option', { value: v[0] }, v[1]) : h('option', { value: v }))))];
}

// A text input whose suggestions are entries matching what you type.
export function entryPicker(name, attrs = {}) {
  const [id, list] = datalist([]);
  const input = h('input', { name, list: id, autocomplete: 'off', spellcheck: 'false', ...attrs });
  let seq = 0;
  input.addEventListener('input', debounce(async () => {
    const q = input.value.trim();
    const my = ++seq;
    if (q.length < 2) return;
    try {
      const d = await api('/entries', { params: { q, superseded: 'all', limit: 20 } });
      if (my === seq) list.replaceChildren(...d.items.map((e) => h('option', { value: e.id }, e.title)));
    } catch { /* Suggestions are a convenience. Typing the id still works. */ }
  }, 250));
  return h('span', { class: 'picker' }, input, list);
}

// Two clicks for small reversible deletes. The first arms it, the second acts.
export function confirmButton(label, armed, action) {
  let timer;
  const b = h('button', { type: 'button', class: 'small' }, label);
  b.addEventListener('click', async () => {
    if (!b.classList.contains('armed')) {
      b.classList.add('armed', 'danger');
      b.textContent = armed;
      timer = setTimeout(() => { b.classList.remove('armed', 'danger'); b.textContent = label; }, 4000);
      return;
    }
    clearTimeout(timer);
    b.disabled = true;
    try { await action(); } finally { b.disabled = false; }
  });
  return b;
}

export function copyButton(getText) {
  const b = h('button', { type: 'button', class: 'small' }, 'Copy');
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(getText());
      b.textContent = 'Copied';
    } catch {
      b.textContent = 'Copy failed';
    }
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  });
  return b;
}

// Definition list from [label, value] pairs. Null values read as "none".
export function dl(rows) {
  return h('dl', { class: 'kv' }, rows.filter(Boolean).map(([k, v]) =>
    [h('dt', null, k), h('dd', null, v == null || v === '' ? h('span', { class: 'muted' }, 'none') : v)]));
}

export function json(value) {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  return h('div', { class: 'json-wrap' }, copyButton(() => text), h('pre', { class: 'json' }, text));
}

// ---------------------------------------------------------------- tables and paged lists
// cols: [{label, key | render(row), class, sort, desc}]. rowLink makes rows open a route. expand(row) toggles a detail row.
export function table(cols, rows, { rowLink, rowClass, expand, sort, onSort } = {}) {
  const head = h('tr', null, cols.map((c) => {
    const active = c.sort && sort === c.sort;
    const label = c.sort && onSort
      ? h('button', { type: 'button', class: 'sort', onclick: () => onSort(c.sort) }, c.label, active ? (c.desc ? ' ↓' : ' ↑') : '')
      : c.label;
    return h('th', { class: c.class, scope: 'col', 'aria-sort': active ? (c.desc ? 'descending' : 'ascending') : null }, label);
  }));
  const body = h('tbody');
  for (const r of rows) {
    const tr = h('tr', { class: [rowClass?.(r), (rowLink || expand) && 'click'].filter(Boolean).join(' ') || null },
      cols.map((c) => h('td', { class: c.class }, c.render ? c.render(r) : r[c.key] ?? '')));
    if (rowLink || expand) {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('a, button, input, select, textarea, label') || getSelection().toString()) return;
        if (rowLink) { const to = rowLink(r); if (to) location.hash = to; return; }
        const next = tr.nextElementSibling;
        if (next?.classList.contains('detail')) { next.remove(); tr.classList.remove('open'); return; }
        tr.classList.add('open');
        tr.after(h('tr', { class: 'detail' }, h('td', { colspan: cols.length }, expand(r))));
      });
    }
    if (expand) {
      // Expandable rows hold no link, so the row itself takes focus and opens on Enter or Space.
      tr.tabIndex = 0;
      tr.addEventListener('keydown', (e) => {
        if (e.target === tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); tr.click(); }
      });
    }
    body.append(tr);
  }
  return h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, head), body));
}

export function pager({ total, limit, offset }, go) {
  const end = Math.min(offset + limit, total);
  return h('nav', { class: 'pager', 'aria-label': 'Pages' },
    h('span', { class: 'muted' }, total ? `${num(offset + 1)}–${num(end)} of ${num(total)}` : 'None'),
    h('button', { type: 'button', class: 'small', disabled: offset <= 0, onclick: () => go(Math.max(0, offset - limit)) }, 'Previous'),
    h('button', { type: 'button', class: 'small', disabled: end >= total, onclick: () => go(offset + limit) }, 'Next'));
}

function control(f, value, set) {
  if (f.type === 'select') {
    const el = select(f.name, f.options, value || f.default || '', f.blank);
    el.addEventListener('change', () => set(el.value));
    return el;
  }
  if (f.type === 'date') {
    // The hash keeps an ISO instant. The input shows its local day.
    const d = value && toDate(value);
    const el = h('input', { type: 'date', name: f.name, value: d ? isoDay(d) : '' });
    el.addEventListener('change', () => set(el.value ? new Date(`${el.value}T00:00`).toISOString() : ''));
    return el;
  }
  const [id, list] = f.list ? datalist(f.list) : [null, null];
  const el = h('input', { type: f.type === 'search' ? 'search' : 'text', name: f.name, value: value || '', placeholder: f.placeholder,
    list: id, autocomplete: 'off', spellcheck: 'false' });
  el.addEventListener('input', debounce(() => set(el.value.trim()), 300));
  return list ? h('span', null, el, list) : el;
}

// A filtered, sorted, paged list whose state lives in the hash. Refetches keep the old rows at reduced opacity.
export function listPage(root, { route, title, path, cols, filters = [], rowLink, rowClass, expand, render, sort,
  empty = 'Nothing here yet.', limit = 50, head = [], before = null }) {
  const st = { ...readHash().params };
  const count = h('span', { class: 'count muted' });
  const area = h('div', { class: 'list-area' }, loading());
  let seq = 0;

  let form = null;
  // A debounced filter can fire after the route changed. It must not rewrite the new route's address.
  const go = () => { if (!root.isConnected) return; replaceHash(route, st); load(); };
  const set = (f) => (v) => {
    if (v && v !== f.default) st[f.name] = v; else delete st[f.name];
    delete st.offset;
    go();
  };

  async function load() {
    const my = ++seq;
    if (area.querySelector('.table-wrap, .cards')) area.classList.add('busy');
    else area.replaceChildren(loading());
    try {
      const data = await api(path, { params: { ...st, limit, offset: st.offset || 0 } });
      if (my !== seq) return;
      const items = data.items || [];
      const page = { total: data.total ?? items.length, limit: data.limit ?? limit, offset: data.offset ?? Number(st.offset || 0) };
      count.textContent = plural(page.total, 'item');
      const filtered = filters.some((f) => st[f.name]);
      const body = !items.length
        ? note(filtered ? 'Nothing matches these filters.' : page.offset ? 'No more items.' : empty, 'empty')
        : render ? render(items)
        : table(cols, items, { rowLink, rowClass, expand, sort: sort && (st.sort || sort),
                               onSort: sort && ((s) => {
                                 if (s === sort) delete st.sort; else st.sort = s;
                                 delete st.offset;
                                 const el = form?.elements.namedItem('sort');
                                 if (el) el.value = st.sort || sort;
                                 go();
                               }) });
      area.replaceChildren(body, items.length || page.offset ? pager(page, (off) => {
        if (off) st.offset = off; else delete st.offset;
        go();
        root.scrollIntoView({ block: 'start' });
      }) : '');
    } catch (err) {
      if (my !== seq) return;
      count.textContent = '';
      area.replaceChildren(failed(err, load));
    } finally {
      if (my === seq) area.classList.remove('busy');
    }
  }

  form = filters.length ? h('form', { class: 'filters', role: 'search', onsubmit: (e) => e.preventDefault() },
    filters.map((f) => field(f.label, control(f, st[f.name], set(f))))) : null;
  fill(root, pageHead(title, count, ...[head].flat()), before, form, area);
  load();
  return { reload: load, state: st };
}

// Inline form status: errors in red, confirmations in green.
export function flash() {
  const el = h('p', { class: 'flash', role: 'status', 'aria-live': 'polite' });
  el.show = (text, kind = 'ok') => { el.className = `flash ${kind}`; el.textContent = text; };
  el.clear = () => { el.className = 'flash'; el.textContent = ''; };
  return el;
}

// Runs a write, disabling the button and showing the result. Returns the response or null.
export async function submit(button, out, fn) {
  button.disabled = true;
  out.clear();
  try {
    return await fn();
  } catch (err) {
    out.show(err.message, 'error');
    return null;
  } finally {
    button.disabled = false;
  }
}
