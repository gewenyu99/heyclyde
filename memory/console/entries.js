// Entries: the filtered list, one entry's page with its edit, link, supersede and delete forms, and the new entry form.
import {
  api, enc, getMeta, forgetMeta, href, onLeave, h, fill, lock, entryLink, safeUrl, num, when, authority, verdict, badge, note,
  loading, failed, pageHead, card, field, select, datalist, entryPicker, confirmButton, dl, table, listPage, flash, submit, plural, isoDay,
} from './lib.js';

// The server's rule for new ids. Kept identical so the form never promises an id the API refuses.
export const ID_RE = /^[a-z0-9][a-z0-9-]{1,100}$/;
const TYPE_RE = /^[a-z_]{2,40}$/;
const EDITABLE = ['title', 'body', 'pattern', 'authority', 'scope', 'sensitivity', 'lang', 'valid_from', 'source_id',
  'evidence_kind', 'evidence', 'project'];
// The API clears these with null. Every other field must stay a non-empty string.
const NULLABLE = new Set(['valid_from', 'source_id', 'evidence_kind', 'evidence', 'project']);
// The seed's own vocabularies (seed/build.py). /meta adds whatever the store holds beyond them.
const EVIDENCE_KINDS = ['quote', 'assistant', 'summary', 'memory'];
const SEED_PATTERNS = ['projects', 'decisions', 'observations', 'preferences', 'recommendations', 'references', 'reactions'];
const SEED_LINKS = ['supersedes', 'supports', 'contradicts', 'derived_from', 'relates', 'part_of', 'corrects'];
const union = (...lists) => [...new Set(lists.flat())].sort();
const HIDDEN = new Set(['title', 'body', 'evidence', 'project_title', 'search_text', 'tsv_en', 'tsv_zh']);
const FIELD_ORDER = ['id', 'pattern', 'authority', 'scope', 'sensitivity', 'lang', 'valid_from', 'project', 'source_id',
  'evidence_kind', 'evidence_sha256'];

const projectName = (meta, id) => meta.projects.find((p) => p.id === id)?.title || id;

// ---------------------------------------------------------------- list
export async function entriesView(root) {
  root.append(loading());
  const meta = await getMeta();
  listPage(root, {
    route: 'entries', title: 'Entries', path: '/entries', sort: 'id',
    head: h('a', { class: 'button primary', href: href('entries', 'new') }, 'New entry'),
    filters: [
      { name: 'q', label: 'Search', type: 'search', placeholder: 'id, title or text' },
      { name: 'project', label: 'Project', type: 'select', blank: 'All projects', options: meta.projects.map((p) => [p.id, p.title || p.id]) },
      { name: 'authority', label: 'Authority', type: 'select', blank: 'Any', options: meta.authorities },
      { name: 'pattern', label: 'Pattern', type: 'select', blank: 'Any', options: meta.patterns },
      { name: 'sensitivity', label: 'Sensitivity', type: 'select', blank: 'Any', options: meta.sensitivities },
      { name: 'superseded', label: 'Show', type: 'select', default: 'current',
        options: [['current', 'Current'], ['superseded', 'Superseded'], ['all', 'All']] },
      { name: 'sort', label: 'Sort', type: 'select', default: 'id',
        options: [['id', 'ID'], ['title', 'Title'], ['valid_from', 'Valid from'], ['updated', 'Recently updated']] },
    ],
    empty: 'No entries yet. Add the first one.',
    rowLink: (r) => href('entry', r.id),
    rowClass: (r) => (r.superseded_by?.length ? 'dim' : ''),
    cols: [
      { label: 'ID', sort: 'id', class: 'nowrap', render: (r) => entryLink(r.id) },
      { label: 'Title', sort: 'title', class: 'wide', render: (r) => [r.title, r.sensitivity === 'private' && [' ', lock()],
        r.superseded_by?.length ? [' ', badge('superseded', 'muted')] : ''] },
      { label: 'Pattern', key: 'pattern' },
      { label: 'Authority', render: (r) => authority(r.authority) },
      { label: 'Project', render: (r) => r.project_title || r.project || '' },
      { label: 'Valid from', sort: 'valid_from', desc: true, class: 'nowrap', key: 'valid_from' },
      { label: 'Links', class: 'num', render: (r) => num(r.links) },
      { label: 'Delivered', class: 'num', render: (r) => num(r.delivered) },
    ],
  });
}

// ---------------------------------------------------------------- shared form fields
function entryFields(meta, e, { isNew, idField } = {}) {
  const [pid, plist] = datalist(union(meta.patterns, SEED_PATTERNS));
  const [kid, klist] = datalist(EVIDENCE_KINDS);
  // Defaults only fill a new entry. An edit shows what the store holds, so an untouched field never counts as a change.
  const v = (k, dflt) => e[k] ?? (isNew ? dflt : '');
  return [
    field('Title', h('input', { name: 'title', value: e.title ?? '', required: true, maxlength: '500' })),
    idField,
    h('div', { class: 'form-grid' },
      field('Pattern', h('span', null, h('input', { name: 'pattern', value: e.pattern ?? '', required: true, list: pid, autocomplete: 'off' }), plist),
        'Pick one or type a new one.'),
      field('Authority', select('authority', meta.authorities, v('authority', 'approved'))),
      field('Sensitivity', select('sensitivity', meta.sensitivities, v('sensitivity', 'normal'))),
      field('Scope', h('input', { name: 'scope', value: e.scope ?? '', required: !!isNew, placeholder: 'domain:pkg' }), 'global, domain:x or repo:x'),
      field('Language', h('input', { name: 'lang', value: v('lang', 'en'), maxlength: '20' })),
      field('Valid from', h('input', { type: 'date', name: 'valid_from', value: v('valid_from', isoDay(new Date())) })),
      field('Project', select('project', meta.projects.map((p) => [p.id, p.title || p.id]), e.project ?? '', 'No project'),
        isNew ? 'Adds the part_of link too.' : null),
      field('Source', select('source_id', meta.sources.map((s) => [s.id, `${s.title || s.id}${s.date ? ` (${s.date})` : ''}`]),
        e.source_id ?? '', 'No source')),
      field('Evidence kind', h('span', null, h('input', { name: 'evidence_kind', value: e.evidence_kind ?? '', list: kid, autocomplete: 'off' }), klist))),
    field('Body', h('textarea', { name: 'body', rows: '7', value: e.body ?? '', required: true })),
    field('Evidence', h('textarea', { name: 'evidence', rows: '3', value: e.evidence ?? '' }),
      'Quote Wen word for word when the kind is quote. The server hashes it.'),
  ];
}

// What a field holds once the form has had its say: body and evidence lose trailing whitespace, the rest is trimmed.
// The edit form compares both sides through this, so a stored trailing newline never counts as a change.
const clean = (k, v) => (k === 'body' || k === 'evidence' ? String(v ?? '').replace(/\s+$/, '') : String(v ?? '').trim());

function readFields(form) {
  const out = {};
  for (const k of EDITABLE) {
    const el = form.elements.namedItem(k);
    if (!el) continue;
    const raw = clean(k, el.value);
    out[k] = raw === '' && NULLABLE.has(k) ? null : raw;
  }
  return out;
}

// ---------------------------------------------------------------- new entry
const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-')
  .replace(/^-|-$/g, '').slice(0, 60);

export async function newEntryView(root, params) {
  root.append(loading());
  const meta = await getMeta();
  const out = flash();
  const id = h('input', { name: 'id', required: true, autocomplete: 'off', spellcheck: 'false', maxlength: '101', class: 'mono' });
  const idHint = h('span', { class: 'hint' }, 'Lowercase letters, digits and hyphens. 2 to 101 characters.');
  let idTouched = false;
  const checkId = () => {
    const v = id.value.trim();
    const ok = ID_RE.test(v);
    id.setCustomValidity(v && !ok ? 'Use lowercase letters, digits and hyphens. Start with a letter or digit.' : '');
    idHint.classList.toggle('bad', !!v && !ok);
    idHint.textContent = v && !ok ? 'Not a valid id. Lowercase letters, digits and hyphens, starting with a letter or digit.'
      : 'Lowercase letters, digits and hyphens. 2 to 101 characters.';
  };
  id.addEventListener('input', () => { idTouched = true; checkId(); });

  const linkRows = h('div', { class: 'link-rows' });
  const [tid, tlist] = datalist(union(meta.link_types, SEED_LINKS));
  const addLinkRow = (dst = '', type = 'relates') => {
    const row = h('div', { class: 'row link-row' },
      entryPicker('dst', { placeholder: 'target entry id', value: dst, class: 'mono' }),
      h('input', { name: 'type', value: type, list: tid, placeholder: 'type', class: 'type-input', autocomplete: 'off' }),
      h('button', { type: 'button', class: 'small', onclick: () => row.remove() }, 'Remove'));
    linkRows.append(row);
  };

  const button = h('button', { type: 'submit', class: 'primary' }, 'Create entry');
  let dirty = false;
  let submitted = false;
  const cancelLink = h('a', { href: href('entries') }, 'Cancel');
  const allLink = h('a', { href: href('entries') }, 'All entries');
  const form = h('form', { class: 'card form', novalidate: true },
    entryFields(meta, { project: params.project || '' },
      { isNew: true, idField: h('label', { class: 'field' }, h('span', { class: 'label' }, 'ID'), id, idHint) }),
    h('fieldset', null, h('legend', null, 'Links'), linkRows, tlist,
      h('button', { type: 'button', class: 'small', onclick: () => { dirty = true; addLinkRow(); } }, 'Add a link')),
    h('div', { class: 'row' }, button, cancelLink, out));

  form.addEventListener('input', () => { dirty = true; });
  form.addEventListener('change', () => { dirty = true; });
  const confirmLeave = (e) => {
    if (dirty && !submitted && !confirm('Discard unsaved changes?')) e.preventDefault();
  };
  cancelLink.addEventListener('click', confirmLeave);
  allLink.addEventListener('click', confirmLeave);
  const onBeforeUnload = (e) => {
    if (dirty && !submitted) { e.preventDefault(); e.returnValue = ''; }
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  onLeave(() => window.removeEventListener('beforeunload', onBeforeUnload));

  form.elements.namedItem('title').addEventListener('input', (e) => {
    if (!idTouched) { id.value = slug(e.target.value); checkId(); }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    checkId();
    if (!form.reportValidity()) {
      form.querySelector(':invalid')?.focus();
      return;
    }
    const body = { id: id.value.trim(), ...readFields(form) };
    for (const k of Object.keys(body)) if (body[k] === null) delete body[k];
    const links = [...linkRows.querySelectorAll('.link-row')].map((r) => ({
      dst: r.querySelector('[name=dst]').value.trim(), type: r.querySelector('[name=type]').value.trim(),
    })).filter((l) => l.dst);
    const bad = links.find((l) => !TYPE_RE.test(l.type) || l.dst === body.id);
    if (bad) { out.show(bad.dst === body.id ? 'An entry cannot link to itself.' : `Link type "${bad.type}" must be 2 to 40 lowercase letters or underscores.`, 'error'); return; }
    // The seed's rule: every entry belongs to its project through one part_of link.
    if (body.project && body.pattern !== 'projects' && !links.some((l) => l.type === 'part_of')) links.push({ dst: body.project, type: 'part_of' });
    if (links.length) body.links = links;
    const res = await submit(button, out, () => api('/entries', { method: 'POST', body }));
    if (!res) return;
    submitted = true;
    dirty = false;
    window.removeEventListener('beforeunload', onBeforeUnload);
    forgetMeta();
    location.hash = href('entry', res.entry?.id || body.id);
  });

  root.replaceChildren(pageHead('New entry', allLink), form);
  form.elements.namedItem('title').focus();
}

// ---------------------------------------------------------------- one entry
export async function entryView(root, id) {
  if (!id) { root.append(note('No entry id in the address.', 'error')); return; }
  root.append(loading());
  const [d, meta] = await Promise.all([api(`/entries/${enc(id)}`), getMeta()]);
  renderEntry(root, d, meta);
}

async function reload(root, id, message) {
  try {
    const [d, meta] = await Promise.all([api(`/entries/${enc(id)}`), getMeta()]);
    renderEntry(root, d, meta, message);
  } catch (err) {
    root.replaceChildren(failed(err, () => reload(root, id)));
  }
}

function value(k, v, meta, e) {
  if (v == null || v === '') return null;
  if (k === 'project') return h('span', null, entryLink(v), ' ', e.project_title || projectName(meta, v));
  if (k === 'evidence_sha256') return h('span', { class: 'mono hash', title: v }, v);
  if (k === 'authority') return authority(v);
  if (k === 'sensitivity') return v === 'private' ? h('span', null, lock(), ' private') : v;
  if (k.endsWith('_at')) return when(v);
  if (typeof v === 'object') return h('code', null, JSON.stringify(v));
  return String(v);
}

function renderEntry(root, d, meta, message = '') {
  const e = d.entry;
  const id = e.id;
  const panel = h('div', { class: 'panel-slot' });
  const top = flash();
  if (message) { top.show(message); window.scrollTo(0, 0); }
  document.title = `${e.title || id} · memory`;

  let activeBtn = null;
  let panelCleanup = null;
  let checkDirty = () => false;
  const editBtn = h('button', { type: 'button', 'aria-expanded': 'false' }, 'Edit');
  const supBtn = h('button', { type: 'button', 'aria-expanded': 'false' }, 'Supersede');
  const delBtn = h('button', { type: 'button', class: 'danger-outline', 'aria-expanded': 'false' }, 'Delete');
  const panelBtns = [editBtn, supBtn, delBtn];

  const closePanel = (restoreFocus = false) => {
    if (panelCleanup) { panelCleanup(); panelCleanup = null; }
    checkDirty = () => false;
    panel.replaceChildren();
    for (const b of panelBtns) b.setAttribute('aria-expanded', 'false');
    if (restoreFocus && activeBtn && typeof activeBtn.focus === 'function') activeBtn.focus();
    activeBtn = null;
  };

  const open = (make, triggerBtn) => {
    top.clear();
    const showing = panel.firstChild?.dataset?.kind === make.name;
    if (checkDirty() && !confirm('Discard unsaved changes?')) return;
    if (showing) {
      closePanel(true);
      return;
    }
    closePanel(false);
    activeBtn = triggerBtn;
    triggerBtn.setAttribute('aria-expanded', 'true');
    const node = make(root, d, meta, () => {
      if (checkDirty() && !confirm('Discard unsaved changes?')) return;
      closePanel(true);
    }, (fn, cleanup) => {
      checkDirty = fn;
      panelCleanup = cleanup || null;
    });
    panel.replaceChildren(node);
    panel.firstChild?.querySelector?.('input, textarea, select, button')?.focus();
  };
  editBtn.addEventListener('click', () => open(editPanel, editBtn));
  supBtn.addEventListener('click', () => open(supersedePanel, supBtn));
  delBtn.addEventListener('click', () => open(deletePanel, delBtn));

  const linkRow = (dir) => (l) => {
    const other = dir === 'out' ? l.dst : l.src;
    const [src, dst] = dir === 'out' ? [id, l.dst] : [l.src, id];
    return { ...l, other, remove: () => confirmButton('Remove', 'Really remove?', async () => {
      try {
        await api(`/entries/${enc(src)}/links/${enc(l.type)}/${enc(dst)}`, { method: 'DELETE' });
        await reload(root, id, `Removed ${src} ${l.type} ${dst}.`);
      } catch (err) { top.show(err.message, 'error'); }
    }, { 'aria-label': `Remove ${l.type} link ${dir === 'out' ? 'to' : 'from'} ${other}` }) };
  };
  const linkTable = (rows, dir) => (rows.length ? table([
    { label: 'Type', render: (l) => h('span', { class: 'mono' }, l.type) },
    { label: dir === 'out' ? 'To' : 'From', render: (l) => entryLink(l.other) },
    { label: 'Title', render: (l) => l.title ?? '' },
    { label: 'Authority', render: (l) => authority(l.authority) },
    { label: '', class: 'actions', render: (l) => l.remove() },
  ], rows.map(linkRow(dir))) : note(dir === 'out' ? 'No links out.' : 'No links in.', 'empty'));

  const ids = (list) => (list?.length ? list.map((x, i) => [i ? ', ' : '', entryLink(x)]) : null);
  const rest = Object.keys(e).filter((k) => !FIELD_ORDER.includes(k) && !HIDDEN.has(k));
  const src = d.source;
  const emb = d.embedding;
  const usage = d.usage || {};
  const srcUrl = src?.uri && safeUrl(src.uri);

  fill(root,
    pageHead(e.title || id, h('div', { class: 'head-actions' },
      e.pattern === 'projects' && h('a', { class: 'button', href: href('entries', 'new', { project: id }) }, 'New entry here'),
      editBtn, supBtn, delBtn)),
    h('p', { class: 'entry-sub' }, h('span', { class: 'mono' }, id), ' ', authority(e.authority), ' ', badge(e.pattern || 'no pattern'),
      e.sensitivity === 'private' ? [' ', badge([lock(), ' private'], 'private')] : '',
      d.current ? '' : [' ', badge('superseded', 'warn')]),
    !d.current && h('div', { class: 'banner warn' }, 'Superseded by ', ids(d.superseded_by) || 'another entry',
      '. Recall hides it from hybrid and strikes it through in index.'),
    top, panel,
    h('div', { class: 'entry-grid' },
      h('div', { class: 'col' },
        card('Body', h('div', { class: 'prose' }, e.body || h('span', { class: 'muted' }, 'Empty.'))),
        card('Evidence', e.evidence
          ? [h('p', { class: 'muted small' }, e.evidence_kind || 'unknown kind'), h('blockquote', null, e.evidence)]
          : note('No evidence recorded.', 'empty')),
        card('Links out', linkTable(d.links_out || [], 'out'), addLinkForm(root, d, meta)),
        card('Links in', linkTable(d.links_in || [], 'in')),
        card('Supersession', dl([['Superseded by', ids(d.superseded_by)], ['Supersedes', ids(d.supersedes)]]))),
      h('div', { class: 'col' },
        card('Fields', dl([...FIELD_ORDER, ...rest].filter((k) => k in e).map((k) => [k, value(k, e[k], meta, e)]))),
        card('Source', src ? dl([
          ['Title', src.title], ['Kind', src.kind], ['Date', src.date],
          ['Link', srcUrl ? h('a', { href: srcUrl, target: '_blank', rel: 'noopener noreferrer' }, src.uri) : src.uri],
          ['ID', src.id && h('span', { class: 'mono' }, src.id)],
        ]) : note('No source.', 'empty')),
        card('Embedding', emb ? dl([
          ['Status', emb.fresh ? badge('fresh', 'good') : badge('stale', 'warn')],
          ['Model', emb.model], ['Updated', when(emb.updated_at)],
        ]) : note('No embedding yet. Sync embeddings from the overview.', 'empty')),
        card('Usage', dl([
          ['Delivered', plural(usage.delivered ?? 0, 'time')], ['Candidate', plural(usage.candidate ?? 0, 'time')],
          ['Last delivered', when(usage.last_delivered)],
        ]), feedbackList(usage.feedback || [])))));
}

function feedbackList(items) {
  if (!items.length) return note('No feedback on this entry.', 'empty');
  return table([
    {
      label: 'Verdict',
      render: (f) => (f.retrieval_id
        ? h('a', { href: href('recall', f.retrieval_id) }, verdict(f.verdict))
        : verdict(f.verdict)),
    },
    { label: 'From', key: 'source' },
    { label: 'Note', class: 'wide', render: (f) => f.note || '' },
    { label: 'When', render: (f) => when(f.created_at) },
  ], items, { rowLink: (f) => (f.retrieval_id ? href('recall', f.retrieval_id) : null) });
}

function addLinkForm(root, d, meta) {
  const id = d.entry.id;
  const out = flash();
  const [tid, tlist] = datalist(union(meta.link_types, SEED_LINKS));
  const type = h('input', { name: 'type', value: 'relates', list: tid, class: 'type-input', autocomplete: 'off', required: true });
  const button = h('button', { type: 'submit', class: 'small' }, 'Add link');
  const form = h('form', { class: 'row add-link' },
    entryPicker('dst', { placeholder: 'target entry id', class: 'mono', required: true }), type, tlist, button, out);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const dst = form.elements.namedItem('dst').value.trim();
    const t = type.value.trim();
    if (!dst) return out.show('Name the entry to link to.', 'error');
    if (dst === id) return out.show('An entry cannot link to itself.', 'error');
    if (!TYPE_RE.test(t)) return out.show('Type must be 2 to 40 lowercase letters or underscores.', 'error');
    const res = await submit(button, out, () => api(`/entries/${enc(id)}/links`, { method: 'POST', body: { dst, type: t } }));
    if (res) await reload(root, id, `Linked ${id} ${t} ${dst}.`);
  });
  return form;
}

function editPanel(root, d, meta, close, registerDirty) {
  const e = d.entry;
  const out = flash();
  const button = h('button', { type: 'submit', class: 'primary' }, 'Save changes');
  const form = h('form', { class: 'card form', 'data-kind': 'editPanel' },
    h('h2', null, 'Edit entry'), entryFields(meta, e),
    h('div', { class: 'row' }, button, h('button', { type: 'button', onclick: close }, 'Cancel'), out));
  let saved = false;
  const isDirty = () => {
    if (saved) return false;
    const now = readFields(form);
    return Object.entries(now).some(([k, v]) => clean(k, v) !== clean(k, e[k]));
  };
  const onBeforeUnload = (ev) => {
    if (isDirty()) { ev.preventDefault(); ev.returnValue = ''; }
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  onLeave(() => window.removeEventListener('beforeunload', onBeforeUnload));
  if (registerDirty) registerDirty(isDirty, () => window.removeEventListener('beforeunload', onBeforeUnload));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!form.reportValidity()) return;
    const now = readFields(form);
    const changed = Object.fromEntries(Object.entries(now).filter(([k, v]) => clean(k, v) !== clean(k, e[k])));
    if (!Object.keys(changed).length) return out.show('Nothing changed.', 'warn');
    const res = await submit(button, out, () => api(`/entries/${enc(e.id)}`, { method: 'PATCH', body: changed }));
    if (!res) return;
    saved = true;
    window.removeEventListener('beforeunload', onBeforeUnload);
    forgetMeta();
    renderEntry(root, res, await getMeta().catch(() => meta), `Saved ${Object.keys(changed).join(', ')}.`);
  });
  return form;
}

function supersedePanel(root, d, meta, close) {
  const id = d.entry.id;
  const out = flash();
  const button = h('button', { type: 'submit', class: 'primary' }, 'Supersede');
  const form = h('form', { class: 'card form', 'data-kind': 'supersedePanel' },
    h('h2', null, 'Supersede this entry'),
    h('p', null, `Name the entry that replaces ${id}. Hybrid then hides it. Index strikes it through.`),
    field('Replaced by', entryPicker('by', { required: true, class: 'mono', placeholder: 'newer entry id' })),
    h('div', { class: 'row' }, button, h('button', { type: 'button', onclick: close }, 'Cancel'), out));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const by = form.elements.namedItem('by').value.trim();
    if (!by) return out.show('Name the newer entry.', 'error');
    if (by === id) return out.show('An entry cannot supersede itself.', 'error');
    const res = await submit(button, out, () => api(`/entries/${enc(id)}/supersede`, { method: 'POST', body: { by } }));
    if (res) renderEntry(root, res, meta, `${by} now supersedes ${id}.`);
  });
  return form;
}

function deletePanel(root, d, meta, close) {
  const id = d.entry.id;
  const out = flash();
  const button = h('button', { type: 'button', class: 'danger' }, 'Delete for good');
  button.addEventListener('click', async () => {
    const res = await submit(button, out, () => api(`/entries/${enc(id)}`, { method: 'DELETE' }));
    if (!res) return;
    forgetMeta();
    document.title = 'Deleted · memory';
    root.replaceChildren(pageHead('Deleted'), note(`Deleted ${res.deleted || id}.`, 'empty'),
      h('p', null, h('a', { href: href('entries') }, 'Back to entries')));
  });
  return h('div', { class: 'card danger-zone', 'data-kind': 'deletePanel' },
    h('h2', null, `Delete ${id}?`),
    h('p', null, 'This removes the entry and its embedding. It cannot be undone. The server refuses while links or past recalls point at it.'),
    h('div', { class: 'row' }, button, h('button', { type: 'button', onclick: close }, 'Cancel'), out));
}

