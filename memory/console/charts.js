// d3 pieces: the overview's activity chart and the entry graph. Both degrade to a note when d3 failed to load.
import {
  api, getMeta, href, replaceHash, onLeave, h, note, loading, failed, pageHead, field, select, table, entryLink, badge, lock, num, plural, debounce,
} from './lib.js';

const d3ok = () => typeof window.d3 !== 'undefined';
const NO_D3 = 'Charts need d3 from cdnjs, which did not load. Showing the table instead.';

// ---------------------------------------------------------------- activity: one small chart per series, shared days
const SERIES = [['events', 'Events', 1], ['recalls', 'Recalls', 2], ['feedback', 'Feedback', 3]];
const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dayLong = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const localDay = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };

function dayTable(days) {
  return table([
    { label: 'Day', class: 'nowrap', render: (d) => dayLong.format(localDay(d.day)) },
    ...SERIES.map(([k, label]) => ({ label, class: 'num', render: (d) => num(d[k] || 0) })),
    { label: 'Messages', class: 'num', render: (d) => num(d.messages || 0) },
  ], days);
}

// A column with a 4px rounded top, square at the baseline.
function barPath(x, y, w, hgt, r = 4) {
  const rr = Math.min(r, w / 2, hgt);
  const b = y + hgt;
  return `M${x},${b}V${y + rr}A${rr},${rr} 0 0 1 ${x + rr},${y}H${x + w - rr}A${rr},${rr} 0 0 1 ${x + w},${y + rr}V${b}Z`;
}

export function activityChart(el, days) {
  if (!days.length) { el.replaceChildren(note('No activity yet.', 'empty')); return; }
  const tableBox = h('div', { hidden: true }, dayTable(days));
  const toggle = h('button', { type: 'button', class: 'small', 'aria-expanded': 'false' }, 'Show table');
  toggle.addEventListener('click', () => {
    tableBox.hidden = !tableBox.hidden;
    toggle.textContent = tableBox.hidden ? 'Show table' : 'Hide table';
    toggle.setAttribute('aria-expanded', String(!tableBox.hidden));
  });
  if (!d3ok()) {
    tableBox.hidden = false;
    el.replaceChildren(note(NO_D3, 'error'), tableBox);
    return;
  }
  const plot = h('div', { class: 'chart-plot' });
  const tip = h('div', { class: 'tooltip', hidden: true, role: 'status' });
  el.replaceChildren(h('div', { class: 'chart-wrap' }, plot, tip), h('div', { class: 'row' }, toggle), tableBox);
  let drawn = 0;
  const draw = () => {
    const w = plot.clientWidth;
    if (!w || w === drawn) return;
    drawn = w;
    drawActivity(plot, tip, days, w);
  };
  draw();
  const ro = new ResizeObserver(debounce(draw, 80));
  ro.observe(plot);
  onLeave(() => ro.disconnect());
}

function drawActivity(plot, tip, days, W) {
  const d3 = window.d3;
  const pad = 8;
  const labelH = 20;
  const rowH = 64;
  const gap = 12;
  const axisH = 22;
  const H = SERIES.length * (labelH + rowH + gap) + axisH;
  const x = d3.scaleBand().domain(days.map((d) => d.day)).range([pad, W - pad]).paddingInner(0.3).paddingOuter(0.15);
  const bw = Math.min(24, x.bandwidth());
  const off = (x.bandwidth() - bw) / 2;
  const svg = d3.create('svg').attr('width', W).attr('height', H).attr('viewBox', `0 0 ${W} ${H}`)
    .attr('role', 'group').attr('aria-label', `Daily events, recalls and feedback over the last ${days.length} days`);
  const band = svg.append('rect').attr('class', 'hover-band').attr('y', 0).attr('height', H - axisH).attr('width', x.step()).attr('visibility', 'hidden');

  SERIES.forEach(([key, label, slot], i) => {
    const top = i * (labelH + rowH + gap);
    const vals = days.map((d) => d[key] || 0);
    const max = d3.max(vals) || 0;
    const y = d3.scaleLinear().domain([0, max || 1]).range([rowH, 16]);
    const title = svg.append('text').attr('class', 'row-label').attr('x', pad).attr('y', top + 14).text(label);
    title.append('tspan').attr('class', 'row-total').text(`  ${num(d3.sum(vals))} total`);
    const g = svg.append('g').attr('transform', `translate(0,${top + labelH})`);
    g.append('line').attr('class', 'baseline').attr('x1', pad).attr('x2', W - pad).attr('y1', rowH + 0.5).attr('y2', rowH + 0.5);
    g.selectAll('path').data(days.filter((d) => d[key] > 0)).join('path')
      .attr('class', 'bar').style('fill', `var(--s${slot})`)
      .attr('d', (d) => { const hgt = Math.max(2, rowH - y(d[key])); return barPath(x(d.day) + off, rowH - hgt, bw, hgt); });
    if (max > 0) {
      const peak = days[vals.lastIndexOf(max)];
      g.append('text').attr('class', 'value-label').attr('text-anchor', 'middle')
        .attr('x', x(peak.day) + x.bandwidth() / 2).attr('y', y(max) - 4).text(num(max));
    }
  });

  const every = Math.max(1, Math.ceil(44 / x.step()));
  svg.append('g').attr('class', 'axis').selectAll('text').data(days.filter((_, i) => (days.length - 1 - i) % every === 0)).join('text')
    .attr('x', (d) => x(d.day) + x.bandwidth() / 2).attr('y', H - 6).attr('text-anchor', 'middle')
    .text((d) => dayFmt.format(localDay(d.day)));

  // One hit column per day, wider than its bars. It shows every series for that day, on hover and on keyboard focus.
  const show = (e, d) => {
    band.attr('x', x(d.day) - (x.step() - x.bandwidth()) / 2).attr('visibility', 'visible');
    tip.replaceChildren(h('strong', null, dayLong.format(localDay(d.day))),
      ...SERIES.map(([k, label, slot]) => h('div', { class: 'tip-row' }, h('span', { class: `key s${slot}` }), h('b', null, num(d[k] || 0)), ` ${label}`)),
      h('div', { class: 'tip-row' }, h('span', { class: 'key' }), h('b', null, num(d.messages || 0)), ' Messages'));
    tip.hidden = false;
    const cx = x(d.day) + x.bandwidth() / 2;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.max(0, Math.min(W - tw, cx + 12 > W - tw ? cx - tw - 12 : cx + 12))}px`;
    tip.style.top = '24px';
  };
  const hide = () => { band.attr('visibility', 'hidden'); tip.hidden = true; };
  svg.append('g').selectAll('rect').data(days).join('rect').attr('class', 'hitbox')
    .attr('x', (d) => x(d.day) - (x.step() - x.bandwidth()) / 2).attr('width', x.step()).attr('y', 0).attr('height', H)
    .attr('tabindex', 0).attr('aria-label', (d) => `${dayLong.format(localDay(d.day))}: ${SERIES.map(([k, l]) => `${d[k] || 0} ${l}`).join(', ')}`)
    .on('pointerenter focus', show).on('pointerleave blur', hide);
  plot.replaceChildren(svg.node());
}

// ---------------------------------------------------------------- the entry graph
// Project colors follow the project, never its rank in a filtered view. The 7 largest projects get slots 1 to 7.
// Everything else shares "Other" so a ninth hue never appears.
let slots = null;
export const resetPalette = () => { slots = null; };
const projectOf = (n) => n.project || (n.pattern === 'projects' ? n.id : '');
const colorOf = (p) => (slots?.has(p) ? `var(--s${slots.get(p) + 1})` : 'var(--other)');

async function ensurePalette(g, filtered) {
  if (slots) return;
  let full = g;
  if (filtered) {
    try { full = await api('/graph'); } catch { /* The filtered graph still gives a stable enough order. */ }
  }
  const counts = new Map();
  for (const n of full.nodes || []) { const p = projectOf(n); if (p) counts.set(p, (counts.get(p) || 0) + 1); }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p]) => p);
  slots = new Map(ranked.slice(0, ranked.length > 8 ? 7 : 8).map((p, i) => [p, i]));
}

const LOCK = 'M-2.2 -0.5v-1.3a2.2 2.2 0 0 1 4.4 0v1.3M-3 -0.5h6v4.2h-6z';
const LINK_CLASS = { part_of: 'part-of', supersedes: 'supersedes' };
const AUTH_CLASS = { approved: 'approved', observed: 'observed', draft: 'draft' };

function graphTable(nodes, names, q) {
  const s = q.trim().toLowerCase();
  const rows = s ? nodes.filter((n) => n.id.toLowerCase().includes(s) || (n.title || '').toLowerCase().includes(s)) : nodes;
  if (!rows.length) return note(s ? `No entries match "${q.trim()}". Clear Find to see all loaded entries.` : 'No entries match these filters.', 'empty');
  return table([
    { label: 'ID', class: 'nowrap', render: (n) => entryLink(n.id) },
    {
      label: 'Title',
      class: 'wide',
      render: (n) => [n.title || n.id, n.private && [' ', lock()], n.current === false && [' ', badge('superseded', 'muted')]],
    },
    { label: 'Pattern', render: (n) => n.pattern || '' },
    { label: 'Authority', render: (n) => n.authority || '' },
    { label: 'Project', render: (n) => { const p = projectOf(n); return n.project_title || names.get(p) || p || ''; } },
  ], rows);
}

export async function graphView(root, params) {
  root.append(loading());
  const meta = await getMeta();
  const names = new Map(meta.projects.map((p) => [p.id, p.title || p.id]));
  const st = { project: params.project || '', superseded: params.superseded === '1' };
  const proj = select('project', meta.projects.map((p) => [p.id, p.title || p.id]), st.project, 'All projects');
  const sup = h('input', { type: 'checkbox', name: 'superseded', checked: st.superseded });
  const find = h('input', { type: 'search', name: 'find', placeholder: 'id or title', autocomplete: 'off' });
  const zinBtn = h('button', { type: 'button', class: 'small', 'aria-label': 'Zoom in' }, '+');
  const zoutBtn = h('button', { type: 'button', class: 'small', 'aria-label': 'Zoom out' }, '−');
  const fitBtn = h('button', { type: 'button', class: 'small' }, 'Fit to view');
  let showTable = !d3ok();
  const tableBtn = h('button', { type: 'button', class: 'small', 'aria-pressed': String(showTable), disabled: !d3ok() }, showTable ? 'Show graph' : 'Show table');
  const stats = h('span', { class: 'count muted' });
  const legend = h('div', { class: 'legend' });
  const stage = h('div', { class: 'graph-stage' }, loading());
  const hint = h('p', { class: 'muted small' });
  root.replaceChildren(
    pageHead('Graph', stats),
    h('form', { class: 'filters', onsubmit: (e) => e.preventDefault() },
      field('Project', proj), field('Find', find),
      h('label', { class: 'check' }, sup, ' Show superseded'), zinBtn, zoutBtn, fitBtn, tableBtn),
    legend, stage,
    hint);

  let graph = null;
  let lastData = null;
  let seq = 0;

  function renderStage() {
    zinBtn.disabled = showTable || !d3ok();
    zoutBtn.disabled = showTable || !d3ok();
    fitBtn.disabled = showTable || !d3ok();
    tableBtn.textContent = showTable ? 'Show graph' : 'Show table';
    tableBtn.setAttribute('aria-pressed', String(showTable));
    hint.textContent = (showTable || !d3ok())
      ? 'Click an entry ID to open it.'
      : 'Drag to move a node. Scroll, pinch, or press + and - to zoom. Arrow keys pan, 0 fits. Click or press Enter on a node to open its entry.';
    if (!lastData) return;
    graph?.stop();
    graph = null;
    if (showTable || !d3ok()) {
      const nodes = lastData.nodes || [];
      const linkCount = (lastData.links || []).length;
      stats.textContent = `${plural(nodes.length, 'entry', 'entries')}, ${plural(linkCount, 'link')}`;
      legend.replaceChildren(...legendItems(lastData, names));
      const tbl = graphTable(nodes, names, find.value);
      stage.replaceChildren(...(!d3ok() ? [note(NO_D3, 'error'), tbl] : [tbl]));
      return;
    }
    graph = drawGraph(stage, lastData, names);
    stats.textContent = `${plural(graph.nodes, 'entry', 'entries')}, ${plural(graph.links, 'link')}`;
    legend.replaceChildren(...legendItems(lastData, names));
    graph.find(find.value);
  }

  async function load() {
    const my = ++seq;
    replaceHash('graph', { project: st.project, superseded: st.superseded ? '1' : '' });
    if (lastData) stage.classList.add('busy'); else stage.replaceChildren(loading());
    try {
      const g = await api('/graph', { params: { project: st.project, include_superseded: st.superseded } });
      await ensurePalette(g, !!st.project);
      if (my !== seq) return;
      lastData = g;
      renderStage();
    } catch (err) {
      if (my === seq) stage.replaceChildren(failed(err, load));
    } finally {
      if (my === seq) stage.classList.remove('busy');
    }
  }
  proj.addEventListener('change', () => { st.project = proj.value; load(); });
  sup.addEventListener('change', () => { st.superseded = sup.checked; load(); });
  find.addEventListener('input', debounce(() => {
    if (showTable || !d3ok()) renderStage(); else graph?.find(find.value);
  }, 150));
  zinBtn.addEventListener('click', () => graph?.zoomBy(1.25));
  zoutBtn.addEventListener('click', () => graph?.zoomBy(0.8));
  fitBtn.addEventListener('click', () => graph?.fit());
  tableBtn.addEventListener('click', () => {
    if (!d3ok()) return;
    showTable = !showTable;
    renderStage();
  });
  // A wider window or a turned phone resizes the stage. The graph follows it, like the activity chart does.
  const ro = new ResizeObserver(debounce(() => graph?.resize(), 120));
  ro.observe(stage);
  onLeave(() => { seq += 1; graph?.stop(); ro.disconnect(); });
  await load();
}

function legendItems(g, names) {
  const present = new Set((g.nodes || []).map(projectOf));
  const projects = [...slots].filter(([p]) => present.has(p)).sort((a, b) => a[1] - b[1]);
  const other = [...present].some((p) => !slots.has(p));
  const sw = (cls, color) => { const s = h('span', { class: `sw ${cls}` }); if (color) s.style.background = color; return s; };
  return [
    ...projects.map(([p]) => h('span', { class: 'legend-item' }, sw('', colorOf(p)), names.get(p) || p)),
    other ? h('span', { class: 'legend-item' }, sw('', 'var(--other)'), 'Other projects') : '',
    h('span', { class: 'legend-sep' }),
    h('span', { class: 'legend-item' }, sw('ring'), 'approved'),
    h('span', { class: 'legend-item' }, sw('faded'), 'draft'),
    h('span', { class: 'legend-item' }, sw('hollow'), 'superseded'),
    h('span', { class: 'legend-item' }, sw('lock'), 'private'),
  ];
}

const stageSize = (stage) => [Math.max(240, stage.clientWidth), Math.max(380, Math.min(window.innerHeight - 260, 760))];

function drawGraph(stage, g, names) {
  const d3 = window.d3;
  let [W, H] = stageSize(stage);
  const nodes = (g.nodes || []).map((n) => ({ ...n }));
  const ids = new Set(nodes.map((n) => n.id));
  const links = (g.links || []).filter((l) => ids.has(l.src) && ids.has(l.dst) && l.src !== l.dst)
    .map((l) => ({ source: l.src, target: l.dst, type: l.type }));
  if (!nodes.length) {
    stage.replaceChildren(note('No entries match these filters.', 'empty'));
    return { stop() {}, fit() {}, zoomBy() {}, find() {}, resize() {}, nodes: 0, links: 0 };
  }
  const radius = (n) => (n.pattern === 'projects' ? 9 : 5);
  const hitboxRadius = (n, k = 1) => Math.max(12 / Math.min(k, 1), radius(n) + 6);
  const tip = h('div', { class: 'tooltip', hidden: true });
  const svg = d3.create('svg').attr('width', W).attr('height', H).attr('viewBox', `0 0 ${W} ${H}`).attr('class', 'graph')
    .attr('tabindex', 0).attr('role', 'group')
    .attr('aria-label', `Entry graph with ${nodes.length} entries and ${links.length} links. Arrow keys pan, plus and minus zoom, 0 fits.`);
  svg.append('defs').append('marker').attr('id', 'arrow').attr('viewBox', '0 -4 8 8').attr('refX', 14).attr('refY', 0)
    .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
    .append('path').attr('d', 'M0,-4L8,0L0,4').attr('class', 'arrow');
  const world = svg.append('g');
  const nodeLabel = (n) => [n.title || n.id, n.pattern, n.authority, n.private ? 'private' : '', n.current === false ? 'superseded' : ''].filter(Boolean).join(', ');

  const link = world.append('g').attr('class', 'links').selectAll('line').data(links).join('line')
    .attr('class', (l) => LINK_CLASS[l.type] || 'other')
    .attr('marker-end', (l) => (l.type === 'supersedes' ? 'url(#arrow)' : null));
  const node = world.append('g').attr('class', 'nodes').selectAll('g').data(nodes).join('g')
    .attr('class', (n) => ['node', AUTH_CLASS[n.authority] || '', n.current === false ? 'old' : '', n.private ? 'private' : ''].join(' '))
    .attr('tabindex', 0).attr('role', 'button').attr('aria-label', nodeLabel);
  node.filter((n) => n.authority === 'approved').append('circle').attr('class', 'ring').attr('r', (n) => radius(n) + 2.5);
  node.append('circle').attr('class', 'dot').attr('r', radius)
    .style('fill', (n) => (n.current === false ? 'var(--surface)' : colorOf(projectOf(n))))
    .style('stroke', (n) => (n.current === false ? colorOf(projectOf(n)) : null));
  node.filter((n) => n.private).append('path').attr('class', 'lock').attr('d', LOCK)
    .attr('transform', (n) => `translate(${radius(n) + 3},${-radius(n) - 2})`);
  node.filter((n) => n.pattern === 'projects').append('text').attr('class', 'node-label').attr('x', 13).attr('y', 4)
    .text((n) => n.title || n.id);
  node.append('circle').attr('class', 'hitbox').attr('r', (n) => hitboxRadius(n, 1));

  const zoom = d3.zoom().scaleExtent([0.1, 8]).on('zoom', (e) => {
    world.attr('transform', e.transform);
    const k = Math.max(0.1, e.transform.k || 1);
    node.select('.hitbox').attr('r', (n) => hitboxRadius(n, k));
  });
  svg.call(zoom).on('dblclick.zoom', null);

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id((n) => n.id).distance((l) => (l.type === 'part_of' ? 36 : 60)).strength((l) => (l.type === 'part_of' ? 0.25 : 0.6)))
    .force('charge', d3.forceManyBody().strength(-45).distanceMax(400))
    .force('collide', d3.forceCollide((n) => radius(n) + 3))
    .force('x', d3.forceX(W / 2).strength(0.04))
    .force('y', d3.forceY(H / 2).strength(0.04));

  const paint = () => {
    link.attr('x1', (l) => l.source.x).attr('y1', (l) => l.source.y).attr('x2', (l) => l.target.x).attr('y2', (l) => l.target.y);
    node.attr('transform', (n) => `translate(${n.x},${n.y})`);
  };

  const fit = (animate = true) => {
    const [x0, x1] = d3.extent(nodes, (n) => n.x);
    const [y0, y1] = d3.extent(nodes, (n) => n.y);
    const k = Math.min(2, 0.9 / Math.max((x1 - x0 + 40) / W, (y1 - y0 + 40) / H));
    const t = d3.zoomIdentity.translate(W / 2, H / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    (animate ? svg.transition().duration(400) : svg).call(zoom.transform, t);
  };

  const showTip = (n, px, py) => {
    const p = projectOf(n);
    tip.replaceChildren(h('strong', null, n.title || n.id), h('div', { class: 'mono small' }, n.id),
      h('div', { class: 'small' }, [n.pattern, n.authority, n.private ? 'private' : '', n.current === false ? 'superseded' : ''].filter(Boolean).join(', ')),
      p && p !== n.id ? h('div', { class: 'small muted' }, n.project_title || names.get(p) || p) : '');
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.max(0, Math.min(W - tw, px + 14 + tw > W ? px - tw - 14 : px + 14))}px`;
    tip.style.top = `${Math.max(0, Math.min(H - 60, py - 10))}px`;
  };

  // Settle most of the layout before the first paint, so the graph opens in place instead of exploding from a corner.
  // With reduced motion it settles fully and never animates.
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  sim.stop();
  sim.tick(still ? 300 : Math.min(200, Math.ceil(40000 / nodes.length)));
  paint();
  fit(false);
  if (!still) {
    sim.on('tick', paint);
    sim.on('end.fit', () => { fit(); sim.on('end.fit', null); });
    sim.restart();
  }

  node.call(d3.drag()
    .on('start', (e, n) => { if (!e.active) sim.alphaTarget(0.25).restart(); n.fx = n.x; n.fy = n.y; })
    .on('drag', (e, n) => { n.fx = e.x; n.fy = e.y; if (!sim.on('tick')) paint(); })
    .on('end', (e, n) => { if (!e.active) sim.alphaTarget(0); n.fx = null; n.fy = null; }));

  svg.on('keydown', (e) => {
    if (e.target !== svg.node()) return;
    const k = d3.zoomTransform(svg.node()).k || 1;
    if (e.key === 'ArrowLeft') { e.preventDefault(); svg.call(zoom.translateBy, 40 / k, 0); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); svg.call(zoom.translateBy, -40 / k, 0); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); svg.call(zoom.translateBy, 0, 40 / k); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); svg.call(zoom.translateBy, 0, -40 / k); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); svg.call(zoom.scaleBy, 1.25); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); svg.call(zoom.scaleBy, 0.8); }
    else if (e.key === '0') { e.preventDefault(); fit(); }
  });

  node.on('click', (e, n) => { location.hash = href('entry', n.id); })
    .on('keydown', (e, n) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        location.hash = href('entry', n.id);
      }
    })
    .on('pointerenter', (e, n) => {
      const [px, py] = d3.pointer(e, stage);
      showTip(n, px, py);
    })
    .on('pointermove', (e, n) => {
      const [px, py] = d3.pointer(e, stage);
      showTip(n, px, py);
    })
    .on('pointerleave', () => { tip.hidden = true; })
    .on('focus', (e, n) => {
      const t = d3.zoomTransform(svg.node());
      const [px, py] = t.apply([n.x, n.y]);
      showTip(n, px, py);
    })
    .on('blur', () => { tip.hidden = true; });

  stage.replaceChildren(svg.node(), tip);
  return {
    nodes: nodes.length,
    links: links.length,
    stop: () => sim.stop(),
    fit: () => fit(),
    zoomBy: (factor) => svg.call(zoom.scaleBy, factor),
    // New size, new centers for the layout forces, then fit to it. Nodes keep their places until the next drag.
    resize() {
      const [w, hh] = stageSize(stage);
      if (w === W && hh === H) return;
      [W, H] = [w, hh];
      svg.attr('width', W).attr('height', H).attr('viewBox', `0 0 ${W} ${H}`);
      sim.force('x', d3.forceX(W / 2).strength(0.04)).force('y', d3.forceY(H / 2).strength(0.04));
      fit(false);
    },
    find(q) {
      const s = q.trim().toLowerCase();
      node.classed('match', (n) => !!s && (n.id.includes(s) || (n.title || '').toLowerCase().includes(s)));
      svg.classed('finding', !!s);
    },
  };
}

