// What the agents did: sessions, hook events, recalls, feedback, the message board, the audit log and the recall playground.
import {
  api, enc, getMeta, href, replaceHash, h, fill, entryLink, link, num, score, when, authority, verdict, badge, arm, armsRevealed, note, loading,
  failed, pageHead, card, field, group, select, dl, json, table, listPage, flash, submit,
} from './lib.js';
import { ID_RE } from './entries.js';

const muted = (text) => h('span', { class: 'muted' }, text);
const mono = (text, cls = '') => h('span', { class: `mono ${cls}`, title: text }, text);
const VERDICTS = ['helpful', 'irrelevant', 'wrong'];
const AGENTS = ['claude', 'codex'];

// A superseded entry and what replaced it. Index still delivers it, struck through, so the agent saw it that way.
const superseded = (by) => (by?.length
  ? [' ', badge('superseded', 'warn'), ' ', muted('by '), by.map((x, i) => [i ? ', ' : '', entryLink(x)])] : '');

// ---------------------------------------------------------------- sessions
export async function sessionsView(root) {
  root.append(loading());
  const meta = await getMeta();
  listPage(root, {
    route: 'sessions', title: 'MCP sessions', path: '/sessions',
    filters: [
      { name: 'client', label: 'Client', type: 'text', placeholder: 'claude-code' },
      ...(armsRevealed() ? [{ name: 'arm', label: 'Arm', type: 'select', blank: 'Any', options: meta.arms }] : []),
    ],
    empty: 'No MCP sessions yet. The first recall starts one.',
    rowLink: (r) => href('session', r.id),
    cols: [
      { label: 'Session', render: (r) => h('a', { href: href('session', r.id), class: 'mono trunc', title: r.id }, r.id) },
      { label: 'Arm', render: (r) => arm(r.arm) },
      { label: 'Client', class: 'nowrap', render: (r) => r.client || muted('unknown') },
      { label: 'Client session', render: (r) => (r.claude_session_id
        ? h('a', { href: href('events', { session_id: r.claude_session_id }), class: 'mono trunc', title: r.claude_session_id }, r.claude_session_id)
        : muted('not linked')) },
      { label: 'Started', render: (r) => when(r.created_at) },
      { label: 'Recalls', class: 'num', render: (r) => num(r.recalls) },
      { label: 'Last recall', render: (r) => when(r.last_recall) },
      { label: 'Events', class: 'num', render: (r) => num(r.events) },
    ],
  });
}

const KIND = { recall: 'info', event: '', feedback: 'good', get_entry: 'muted' };

// What each kind adds to its line. Unknown kinds show their summary only.
function tlFacts(it) {
  if (it.kind === 'recall') {
    return [it.arm && arm(it.arm), it.latency_ms != null && muted(`${num(it.latency_ms)} ms`),
      Array.isArray(it.delivered) && muted(`${num(it.delivered.length)} delivered`), it.degraded && badge(it.degraded, 'warn')];
  }
  if (it.kind === 'feedback') return [verdict(it.verdict), it.source && muted(`from ${it.source}`)];
  return [it.event && it.event !== it.kind && mono(it.event), it.tool_name && it.tool_name !== it.summary && mono(it.tool_name)];
}

function timeline(items) {
  return h('ol', { class: 'timeline' }, items.map((it) => {
    const detail = h('div', { class: 'tl-detail' });
    const opened = it.kind === 'get_entry' && it.entry_id;
    const actions = [
      it.kind === 'recall' && link('Open recall', 'recall', it.id),
      it.kind === 'feedback' && it.retrieval_id && link('Open recall', 'recall', it.retrieval_id),
      it.entry_id && !opened && entryLink(it.entry_id),
      (it.kind === 'event' || it.kind === 'get_entry') && h('button', { type: 'button', class: 'small', onclick: () => {
        if (detail.firstChild) detail.replaceChildren(); else detail.replaceChildren(payloadView(it.id));
      } }, 'Payload'),
    ].filter(Boolean);
    return h('li', { class: `tl tl-${it.kind}` },
      h('div', { class: 'tl-head' }, when(it.at), badge(it.kind === 'get_entry' ? 'opened' : it.kind, KIND[it.kind] ?? ''), tlFacts(it)),
      opened ? h('p', { class: 'tl-summary' }, entryLink(it.entry_id))
        : it.summary && h('p', { class: 'tl-summary' }, it.summary),
      it.kind === 'recall' && it.task && h('p', { class: 'muted small tl-summary' }, `Task: ${it.task}`),
      actions.length ? h('div', { class: 'row tl-actions' }, actions) : '',
      detail);
  }));
}

export async function sessionView(root, id) {
  root.append(loading());
  const d = await api(`/sessions/${enc(id)}`);
  const s = d.session || {};
  const known = ['id', 'arm', 'client', 'claude_session_id', 'created_at'];
  const items = d.timeline || [];
  fill(root,
    pageHead('MCP session', h('a', { href: href('sessions') }, 'All sessions')),
    card('Session', dl([
      ['ID', mono(s.id ?? id)], ['Arm', arm(s.arm)], ['Client', s.client],
      ['Client session', s.claude_session_id && h('a', { href: href('events', { session_id: s.claude_session_id }), class: 'mono' }, s.claude_session_id)],
      ['Started', when(s.created_at)],
      ...Object.keys(s).filter((k) => !known.includes(k)).map((k) => [k, k.endsWith('_at') || k.startsWith('last') ? when(s[k]) : String(s[k] ?? '')]),
    ])),
    card(`Timeline (${num(items.length)})`, items.length ? timeline(items) : note('No activity in this session yet.', 'empty')));
}

// ---------------------------------------------------------------- hook events
export function payloadView(id) {
  const box = h('div', { class: 'payload' }, loading());
  api(`/events/${enc(id)}`)
    .then((d) => box.replaceChildren(json(d.event ? d.event.payload : d)))
    .catch((err) => box.replaceChildren(failed(err, () => box.replaceWith(payloadView(id)))));
  return box;
}

const HOOKS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'SessionEnd',
  'Notification', 'PreCompact', 'get_entry'];

export function eventsView(root) {
  listPage(root, {
    route: 'events', title: 'Events', path: '/events',
    filters: [
      { name: 'event', label: 'Type', type: 'text', list: HOOKS, placeholder: 'any type' },
      { name: 'session_id', label: 'Session', type: 'text', placeholder: 'client session id' },
      { name: 'agent', label: 'Agent', type: 'select', blank: 'Any', options: AGENTS },
      { name: 'since', label: 'Since', type: 'date' },
    ],
    empty: 'No hook events yet. memory-hook sends them from Claude Code and Codex.',
    expand: (r) => payloadView(r.id),
    cols: [
      { label: 'ID', class: 'num', render: (r) => r.id },
      { label: 'Received', render: (r) => when(r.received_at) },
      { label: 'Event', render: (r) => mono(r.event) },
      { label: 'Agent', render: (r) => r.agent || '' },
      { label: 'Summary', class: 'wide', render: (r) => h('div', { class: 'clip' }, r.summary || '') },
      { label: 'Tool', render: (r) => (r.tool_name ? mono(r.tool_name) : '') },
      { label: 'Session', render: (r) => (r.session_id
        ? h('a', { href: href('events', { session_id: r.session_id }), class: 'mono trunc', title: r.session_id }, r.session_id)
        : muted('none')) },
      { label: 'Directory', render: (r) => (r.cwd ? h('span', { class: 'mono trunc', title: r.cwd }, r.cwd.split('/').filter(Boolean).pop() || r.cwd) : '') },
    ],
  });
}

// ---------------------------------------------------------------- recalls
export async function recallsView(root) {
  root.append(loading());
  const meta = await getMeta();
  listPage(root, {
    route: 'recalls', title: 'Recalls', path: '/retrievals',
    filters: [
      { name: 'q', label: 'Query', type: 'search', placeholder: 'words in the query' },
      ...(armsRevealed() ? [{ name: 'arm', label: 'Arm', type: 'select', blank: 'Any', options: meta.arms }] : []),
      { name: 'client', label: 'Client', type: 'text', placeholder: 'claude-code' },
    ],
    empty: 'No recalls yet.',
    rowLink: (r) => href('recall', r.id),
    cols: [
      { label: 'When', render: (r) => when(r.created_at) },
      { label: 'Query', class: 'wide', render: (r) => [h('a', { href: href('recall', r.id) }, r.query),
        r.task && h('div', { class: 'muted small clip' }, r.task)] },
      { label: 'Arm', render: (r) => arm(r.arm) },
      { label: 'Client', class: 'nowrap', render: (r) => r.client || muted('unknown') },
      { label: 'Delivered', class: 'num', render: (r) => num(r.delivered_count) },
      { label: 'Latency', class: 'num nowrap', render: (r) => (r.latency_ms == null ? '' : `${num(r.latency_ms)} ms`) },
      { label: 'Degraded', render: (r) => (r.degraded ? badge(r.degraded, 'warn') : '') },
      { label: 'Feedback', class: 'num', render: (r) => num(r.feedback) },
    ],
  });
}

function candidatesTable(rows) {
  return table([
    { label: '#', class: 'num', render: (c) => c.rank },
    { label: 'Entry', render: (c) => (c.exists === false ? h('span', { class: 'mono missing', title: 'This entry no longer exists.' }, c.id) : entryLink(c.id)) },
    { label: 'Title', class: 'wide', render: (c) => [c.title ?? muted('deleted'), superseded(c.superseded_by)] },
    { label: 'Authority', render: (c) => authority(c.authority) },
    { label: 'Score', class: 'num', render: (c) => score(c.score) },
    { label: 'Packet', render: (c) => (c.delivered ? badge('delivered', 'accent') : '') },
  ], rows, { rowClass: (c) => (c.delivered ? 'hit' : '') });
}

function feedbackForm(rid, cands, done) {
  const out = flash();
  const radios = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Verdict' },
    VERDICTS.map((v) => h('label', null, h('input', { type: 'radio', name: 'verdict', value: v }), h('span', null, v))));
  const delivered = cands.filter((c) => c.delivered);
  const entry = select('entry_id', [
    ...delivered.map((c) => [c.id, `${c.id}${c.title ? `: ${c.title}` : ''}`]),
    ...cands.filter((c) => !c.delivered && c.exists !== false).map((c) => [c.id, `${c.id} (not delivered)`]),
  ], '', 'The whole recall');
  const noteEl = h('textarea', { name: 'note', rows: '2', placeholder: 'What helped or misled the agent' });
  const button = h('button', { type: 'submit', class: 'primary' }, 'Log feedback');
  const form = h('form', { class: 'form' }, group('Verdict', radios), field('Entry', entry), field('Note', noteEl),
    h('div', { class: 'row' }, button, out));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = form.elements.namedItem('verdict').value;
    if (!v) { out.show('Pick a verdict.', 'error'); return; }
    const body = { retrieval_id: rid, verdict: v };
    if (entry.value) body.entry_id = entry.value;
    if (noteEl.value.trim()) body.note = noteEl.value.trim();
    if (await submit(button, out, () => api('/feedback', { method: 'POST', body }))) done('Feedback logged.');
  });
  return form;
}

function feedbackTable(items) {
  if (!items.length) return note('No feedback on this recall yet.', 'empty');
  return table([
    { label: 'Verdict', render: (f) => verdict(f.verdict) },
    { label: 'From', render: (f) => f.source || '' },
    { label: 'Entry', render: (f) => (f.entry_id ? entryLink(f.entry_id) : muted('whole recall')) },
    { label: 'Note', class: 'wide', render: (f) => f.note || '' },
    { label: 'When', render: (f) => when(f.created_at) },
  ], items);
}

export async function recallView(root, id, message = '') {
  if (!root.firstChild) root.append(loading());
  const d = await api(`/retrievals/${enc(id)}`);
  const r = d.retrieval || {};
  const cands = d.candidates || [];
  const top = flash();
  if (message) top.show(message);
  const ids = (list) => (Array.isArray(list) && list.length ? list.map((x, i) => [i ? ', ' : '', entryLink(typeof x === 'object' ? x.id : x)]) : null);
  const refresh = (msg) => recallView(root, id, msg).catch((err) => root.replaceChildren(failed(err, () => recallView(root, id))));
  fill(root,
    pageHead('Recall', h('a', { href: href('recalls') }, 'All recalls')),
    h('blockquote', { class: 'query' }, r.query ?? ''),
    r.task && h('p', null, h('span', { class: 'muted' }, 'Task: '), r.task),
    top,
    h('div', { class: 'grid-2' },
      card('Details', dl([
        ['ID', mono(r.id ?? id)], ['When', when(r.created_at)], ['Arm', arm(r.arm)], ['Client', d.client],
        ['MCP session', r.mcp_session && h('a', { href: href('session', r.mcp_session), class: 'mono trunc', title: r.mcp_session }, r.mcp_session)],
        ['Latency', r.latency_ms == null ? null : `${num(r.latency_ms)} ms`],
        ['Degraded', r.degraded && badge(r.degraded, 'warn')],
        ['Delivered', `${num(cands.filter((c) => c.delivered).length)} of ${num(cands.length)} candidates`],
        ['Filter cut', ids(r.rejected)],
      ])),
      card('Feedback', feedbackTable(d.feedback || []), h('h3', null, 'Add feedback'), feedbackForm(r.id ?? id, cands, refresh))),
    card('Packet the agent read', r.packet
      ? h('div', { class: 'json-wrap' }, h('pre', { class: 'json' }, r.packet))
      : note('Recalls before this column existed did not store their packet.', 'empty')),
    card(`Ranked candidates (${num(cands.length)})`,
      cands.some((c) => c.superseded_by?.length)
        && h('p', { class: 'muted small' }, 'Superseded marks show each entry as it stands now, not as it stood at this recall.'),
      cands.length ? candidatesTable(cands) : note('This recall found nothing.', 'empty')));
}

// ---------------------------------------------------------------- feedback
export function feedbackView(root) {
  listPage(root, {
    route: 'feedback', title: 'Feedback', path: '/feedback',
    filters: [
      { name: 'verdict', label: 'Verdict', type: 'select', blank: 'Any', options: VERDICTS },
      { name: 'source', label: 'From', type: 'select', blank: 'Anyone', options: [['agent', 'Agent'], ['wen', 'Wen']] },
    ],
    empty: 'No feedback yet.',
    rowLink: (f) => (f.retrieval_id ? href('recall', f.retrieval_id) : null),
    cols: [
      { label: 'When', render: (f) => when(f.created_at) },
      { label: 'Verdict', render: (f) => verdict(f.verdict) },
      { label: 'From', render: (f) => f.source || '' },
      { label: 'Entry', render: (f) => (f.entry_id ? entryLink(f.entry_id) : muted('whole recall')) },
      { label: 'Note', class: 'wide', render: (f) => f.note || '' },
      { label: 'Query', class: 'wide', render: (f) => h('div', { class: 'clip' }, f.retrieval_id ? h('a', { href: href('recall', f.retrieval_id) }, f.query || 'Open recall') : f.query || '') },
    ],
  });
}

// ---------------------------------------------------------------- message board
function messageCard(m, reply) {
  const read = m.read_by || [];
  return h('article', { class: 'msg' },
    h('header', null, h('strong', null, m.sender), h('span', { class: 'muted' }, ' to '), h('strong', null, m.recipient),
      h('span', { class: 'spacer' }), when(m.created_at), h('span', { class: 'muted small' }, ` #${m.id}`)),
    h('p', { class: 'prose' }, m.body),
    h('footer', { class: 'row small muted' }, read.length ? `Read by ${read.join(', ')}.` : 'Unread.',
      AGENTS.includes(m.sender) && h('button', { type: 'button', class: 'small', onclick: () => reply(m) }, `Reply to ${m.sender}`)));
}

export function messagesView(root) {
  const out = flash();
  const to = select('to', [...AGENTS, 'all'], 'all');
  const body = h('textarea', { name: 'body', rows: '3', required: true, placeholder: 'A note for your agents' });
  const button = h('button', { type: 'submit', class: 'primary' }, 'Post');
  const form = h('form', { class: 'card form compose' },
    h('h2', null, 'Post a message'),
    field('To', to),
    field('Message', body, 'They see it at their next prompt or check. Reading here marks nothing read.'),
    h('div', { class: 'row' }, button, h('span', { class: 'muted small' }, 'Ctrl or Cmd and Enter posts.'), out));
  body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) form.requestSubmit(); });
  // A reply goes to that agent alone, so it never lands in the other one's context.
  const reply = (m) => {
    to.value = m.sender;
    out.show(`Replying to #${m.id} from ${m.sender}.`, 'ok');
    form.scrollIntoView({ block: 'start' });
    body.focus();
  };
  const list = listPage(root, {
    route: 'messages', title: 'Messages', path: '/messages', before: form, empty: 'No messages yet.',
    render: (items) => h('div', { class: 'cards' }, [...items].sort((a, b) => b.id - a.id).map((m) => messageCard(m, reply))),
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = body.value.trim();
    if (!text) { out.show('Write a message first.', 'error'); return; }
    const res = await submit(button, out, () => api('/messages', { method: 'POST', body: { to: to.value, body: text } }));
    if (!res) return;
    body.value = '';
    out.show(`Posted message ${res.id} to ${res.to}.`);
    list.reload();
  });
}

// ---------------------------------------------------------------- audit log
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// Changed fields between two snapshots. A create has no before, a delete has no after.
export function diff(before, after) {
  if (!isObj(before) && !isObj(after) && JSON.stringify(before) === JSON.stringify(after)) return [];
  if (!(isObj(before) || before == null) || !(isObj(after) || after == null)) return [{ key: 'value', before, after, had: true, has: true }];
  const b = before || {};
  const a = after || {};
  return [...new Set([...Object.keys(b), ...Object.keys(a)])]
    .filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]))
    .filter((k) => (before != null && after != null) || (before ?? after)[k] != null)
    .map((k) => ({ key: k, before: b[k], after: a[k], had: before != null && k in b, has: after != null && k in a }));
}

function shown(v, present) {
  if (!present) return muted('absent');
  if (v === null) return muted('null');
  return h('div', { class: 'val' }, typeof v === 'string' ? v : JSON.stringify(v, null, 2));
}

// Targets read kind:id, like entry:tea-oolong or retrieval:<uuid>, or embeddings for a sync. Known kinds link to their
// page. Anything else is plain text, so a target like embeddings never turns into a link to a missing entry.
function auditTarget(t) {
  const [kind, ...rest] = String(t ?? '').split(':');
  const id = rest.join(':');
  if (kind === 'entry' && ID_RE.test(id)) return entryLink(id);
  if (kind === 'retrieval' && id) return h('a', { href: href('recall', id), class: 'mono' }, t);
  if (kind === 'message') return h('a', { href: href('messages'), class: 'mono' }, t);
  if (t === 'embeddings') return h('a', { href: href('overview'), class: 'mono' }, t);
  return mono(t ?? '');
}

function auditItem(a) {
  const changes = diff(a.before, a.after);
  const target = auditTarget(a.target);
  const kind = /delete|remove/.test(a.action) ? 'bad' : /create|add|insert/.test(a.action) ? 'good' : 'info';
  return h('article', { class: 'audit' },
    h('header', null, badge(a.action, kind), target, h('span', { class: 'spacer' }), when(a.at), h('span', { class: 'muted small' }, ` #${a.id}`)),
    changes.length ? table([
      { label: 'Field', render: (c) => mono(c.key) },
      { label: 'Before', class: 'del', render: (c) => shown(c.before, c.had) },
      { label: 'After', class: 'ins', render: (c) => shown(c.after, c.has) },
    ], changes) : note('No field changed.', 'empty'));
}

export function auditView(root) {
  listPage(root, {
    route: 'audit', title: 'Audit log', path: '/audit', empty: 'No writes through the console yet.',
    render: (items) => h('div', { class: 'cards' }, items.map(auditItem)),
  });
}

// ---------------------------------------------------------------- recall playground
function armColumn(a) {
  const ranked = a.ranked || [];
  const packet = a.packet || [];
  return h('section', { class: 'card arm' },
    h('header', { class: 'arm-head' }, h('h2', null, a.arm), h('span', { class: 'muted num' }, a.latency_ms == null ? '' : `${num(a.latency_ms)} ms`),
      a.degraded ? badge(a.degraded, 'warn') : ''),
    h('p', { class: 'packet' }, h('span', { class: 'muted' }, `Packet (${packet.length}): `),
      packet.length ? packet.map((id) => entryLink(id, 'mono chip')) : muted('empty')),
    a.text && h('details', { class: 'packet-text' }, h('summary', null, 'What the agent reads'), h('pre', { class: 'json' }, a.text)),
    ranked.length ? h('ol', { class: 'ranked' }, ranked.map((r) => h('li', { class: r.in_packet ? 'hit' : '', 'data-id': r.id },
      h('span', { class: 'rank num' }, r.rank),
      h('div', { class: 'ranked-main' }, entryLink(r.id), r.in_packet ? [' ', badge('packet', 'accent')] : '',
        h('div', { class: 'ranked-title' }, r.title ?? muted('no title'), superseded(r.superseded_by))),
      h('div', { class: 'ranked-meta' }, h('span', { class: 'num muted' }, score(r.score)), authority(r.authority)))))
      : note('This arm found nothing.', 'empty'));
}

export async function playgroundView(root, params) {
  root.append(loading());
  const meta = await getMeta();
  const all = meta.arms || [];
  const live = meta.live_arms || [];
  const picked = params.arms ? params.arms.split(',') : all;
  const query = h('input', { type: 'search', name: 'query', value: params.q || '', required: true, placeholder: 'What would an agent ask?' });
  const task = h('input', { name: 'task', value: params.task || '', placeholder: 'What the agent is doing' });
  const arms = h('div', { class: 'checks' }, all.map((a) => h('label', null,
    h('input', { type: 'checkbox', name: 'arms', value: a, checked: picked.includes(a) }), ' ', a, live.includes(a) ? muted(' (live)') : '')));
  const out = flash();
  const button = h('button', { type: 'submit', class: 'primary' }, 'Run');
  const results = h('div', { class: 'arms-grid' });
  const form = h('form', { class: 'card form' },
    h('div', { class: 'form-grid' }, field('Query', query), field('Task', task, 'Optional.')),
    group('Arms', arms),
    h('div', { class: 'row' }, button, h('span', { class: 'muted small' }, 'Previews every chosen arm. It writes no recall and no session.'), out));

  // Hovering an entry in one arm marks it in every arm, so rank differences jump out.
  results.addEventListener('mouseover', (e) => {
    const id = e.target.closest('[data-id]')?.dataset.id;
    for (const li of results.querySelectorAll('li.same')) li.classList.remove('same');
    if (id) for (const li of results.querySelectorAll(`li[data-id="${CSS.escape(id)}"]`)) li.classList.add('same');
  });
  results.addEventListener('mouseleave', () => { for (const li of results.querySelectorAll('li.same')) li.classList.remove('same'); });

  async function run() {
    const q = query.value.trim();
    const t = task.value.trim();
    const sel = [...form.querySelectorAll('[name=arms]:checked')].map((i) => i.value);
    if (!q) { out.show('Type a query.', 'error'); return; }
    if (!sel.length) { out.show('Pick at least one arm.', 'error'); return; }
    replaceHash('playground', { q, task: t, arms: sel.length === all.length ? '' : sel.join(',') });
    if (results.firstChild) results.classList.add('busy'); else results.replaceChildren(loading());
    const res = await submit(button, out, () => api('/recall/preview', { method: 'POST', body: { query: q, task: t || undefined, arms: sel } }));
    results.classList.remove('busy');
    if (!res) { if (results.querySelector('.loading')) results.replaceChildren(); return; }
    const cols = res.arms || [];
    results.replaceChildren(...(cols.length ? cols.map(armColumn) : [note('No arm answered.', 'empty')]));
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  root.replaceChildren(pageHead('Playground', h('span', { class: 'muted' }, 'Compare arms on one query.')), form, results);
  if (params.q) run(); else query.focus();
}
