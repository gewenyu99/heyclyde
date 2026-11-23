/**
 * R67: a stand-in chat app for the cards, so headless Chrome can render them with no chat app at all. The page loads each
 * card into an iframe the way an MCP Apps host does: it answers ui/initialize with a theme, sends the tool result once the
 * card says it's initialized, and answers the card's tools/call from a table of canned results. When every frame has drawn,
 * it writes a JSON report into #report, which `chrome --dump-dom` prints: what each card's text says, whether any markup
 * from the data turned into elements, and every tools/call the card made.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export type Frame = {
  id: string; card: string; html: string; theme: 'light' | 'dark'; result: unknown;
  width?: number; clicks?: string[]; noIpc?: boolean; withOpenAi?: boolean; stripMeta?: boolean;
}

/** The markup every fixture string carries. A card that escapes properly shows it as text and creates no such element. */
export const XSS = `<img src=x onerror="window.top.__xss=1"><script>window.top.__xss=1</script><b class="injected">bold</b>`

/** A host page for these frames. `calls` answers tools/call by tool name. */
export function hostPage(frames: Frame[], calls: Record<string, unknown> = {}): string {
  const cells = frames.map((f) => `<section><h2>${f.id} · ${f.theme}</h2><iframe id="${f.id}" style="width:${f.width ?? 640}px;height:200px;border:0;display:block;background:${f.theme === 'dark' ? '#262624' : '#faf9f5'}"></iframe></section>`).join('')
  const data = JSON.stringify({ frames: frames.map(({ id, card, theme, result, clicks, noIpc, withOpenAi, stripMeta }) => ({ id, card, theme, result, clicks: clicks ?? [], noIpc: !!noIpc, withOpenAi: !!withOpenAi, stripMeta: !!stripMeta })), calls }).replace(/</g, '\\u003c')
  const docs = JSON.stringify(Object.fromEntries(frames.map((f) => {
    if (!f.withOpenAi) return [f.id, f.html]
    const meta = (f.result as any)?._meta ?? null
    const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c')
    const stub = `<script>window.openai={theme:${safeJson(f.theme)},displayMode:"inline",toolOutput:null,toolResponseMetadata:${f.stripMeta ? safeJson(meta) : 'null'},notifyIntrinsicHeight:function(h){window.__oaHeights=(window.__oaHeights||[]);window.__oaHeights.push(h);},callTool:function(){window.__oaCalls=(window.__oaCalls||0)+1;return Promise.resolve({});},openExternal:function(){}};</script>`
    return [f.id, f.html.replace('<script>', stub + '<script>')]
  }))).replace(/</g, '\\u003c')
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:16px;font:13px system-ui;background:#eee}section{margin:0 0 18px}h2{font-size:12px;margin:0 0 6px;color:#555}</style></head><body>${cells}
<pre id="report"></pre>
<script>
const { frames, calls } = ${data};
const docs = ${docs};
const log = { calls: [], sizes: {}, initialized: {}, requests: [], appCapabilities: {} };
window.__xss = 0;
window.addEventListener('message', (ev) => {
  const f = frames.find((x) => document.getElementById(x.id).contentWindow === ev.source);
  const m = ev.data;
  if (!f || !m || m.jsonrpc !== '2.0') return;
  const frame = document.getElementById(f.id);
  const reply = (result) => ev.source.postMessage({ jsonrpc: '2.0', id: m.id, result }, '*');
  const fail = (code, message) => ev.source.postMessage({ jsonrpc: '2.0', id: m.id, error: { code, message } }, '*');
  if (m.id !== undefined && m.method) log.requests.push({ frame: f.id, method: m.method, params: m.params });
  if (m.method === 'ui/initialize') log.appCapabilities[f.id] = m.params.appCapabilities;
  if (m.method === 'ui/initialize') reply({ protocolVersion: m.params.protocolVersion, hostInfo: { name: 'clyde-test-host', version: '1' }, hostCapabilities: {}, hostContext: { theme: f.theme, displayMode: 'inline' } });
  else if (m.method === 'ui/notifications/initialized') {
    log.initialized[f.id] = true;
    const payload = f.stripMeta && f.result && typeof f.result === 'object' ? { content: f.result.content } : f.result;
    ev.source.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: payload }, '*');
  }
  else if (m.method === 'ui/notifications/size-changed') { log.sizes[f.id] = m.params; frame.style.height = m.params.height + 'px'; }
  else if (m.method === 'tools/call') {
    log.calls.push({ frame: f.id, name: m.params.name, arguments: m.params.arguments });
    if (f.noIpc) fail(-32603, 'IPC not available for MCP tool call');
    else reply(calls[m.params.name] ?? { content: [{ type: 'text', text: 'no canned result' }], isError: true });
  }
  else if (m.id !== undefined) reply({});
});
for (const f of frames) document.getElementById(f.id).srcdoc = docs[f.id];
const click = (doc, sel) => { const el = doc.querySelector(sel); if (el) el.click(); return !!el; };
setTimeout(() => {
  for (const f of frames) { const doc = document.getElementById(f.id).contentDocument; for (const sel of f.clicks) click(doc, sel); }
}, 700);
setTimeout(() => {
  const out = {};
  for (const f of frames) {
    const doc = document.getElementById(f.id).contentDocument;
    out[f.id] = {
      ready: doc.getElementById('root')?.getAttribute('data-ready') ?? null,
      theme: doc.documentElement.getAttribute('data-theme'),
      text: doc.body.innerText,
      injected: doc.querySelectorAll('.injected, img[src="x"], #root script').length,
      buttons: [...doc.querySelectorAll('button:not([hidden])')].map((b) => b.textContent.trim()),
      visibleItems: doc.querySelectorAll('article.cl-memory:not([hidden]), article.cl-quest:not([hidden])').length,
      compactItems: doc.querySelectorAll('article.is-compact:not([hidden]), .cl-file.is-compact:not([hidden])').length,
      overflow: doc.documentElement.scrollWidth > doc.documentElement.clientWidth,
      background: getComputedStyle(doc.querySelector('.clyde') ?? doc.body).backgroundColor,
      memoryPadding: (() => { const m = doc.querySelector('.cl-memory'); return m ? getComputedStyle(m).padding : null; })(),
      docHeight: doc.documentElement.style.height,
      oaHeights: document.getElementById(f.id).contentWindow.__oaHeights ?? [],
      oaCalls: document.getElementById(f.id).contentWindow.__oaCalls ?? 0,
    };
  }
  document.getElementById('report').textContent = 'REPORT' + JSON.stringify({ frames: out, xss: window.__xss, ...log }) + 'END';
}, 1800);
</script></body></html>`
}

/** Chrome or Chromium on this computer, or null. CHROME names one. */
export function findChrome(): string | null {
  const candidates = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean) as string[]
  return candidates.find((c) => existsSync(c)) ?? null
}

const FLAGS = ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  '--allow-file-access-from-files', '--virtual-time-budget=4000']

/** The report a host page writes, read with --dump-dom. */
export function render(chrome: string, file: string, profile: string): any {
  const r = spawnSync(chrome, [...FLAGS, `--user-data-dir=${profile}`, '--dump-dom', `file://${file}`], { encoding: 'utf8', timeout: 90_000 })
  const m = /<pre id="report">REPORT(.*?)END<\/pre>/s.exec(r.stdout ?? '')
  if (!m) throw new Error(`no report from chrome: ${r.status} ${r.stderr?.slice(-2000)}`)
  return JSON.parse(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"'))
}

/** A PNG of a host page. */
export function screenshot(chrome: string, file: string, png: string, profile: string, width = 720, height = 1600) {
  return spawnSync(chrome, [...FLAGS, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, `--screenshot=${png}`, `file://${file}`], { encoding: 'utf8', timeout: 90_000 })
}
