// Self-contained local workspace UI with zero external CDNs and strict per-response CSP nonces.
import type { ClydeConfig } from "../runtime/config.ts";

export function renderWorkspaceHtml(nonce: string, config: ClydeConfig): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clyde Local</title>
<style nonce="${nonce}">
:root {
  --bg: #f6f4ef;
  --paper: #fffdf8;
  --ink: #1e1d1a;
  --muted: #6e6a61;
  --line: #e2ddd2;
  --accent: #b85d19;
  --accent-bg: #faede2;
  --ok: #266b43;
  --danger: #9f2d20;
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #171614;
    --paper: #211f1c;
    --ink: #efece4;
    --muted: #a19b90;
    --line: #34312b;
    --accent: #e58d46;
    --accent-bg: #362719;
    --ok: #59b37e;
    --danger: #e06c5f;
  }
}
* { box-sizing: border-box; }
body { margin: 0; font-family: var(--sans); background: var(--bg); color: var(--ink); line-height: 1.5; }
.wrap { max-width: 1100px; margin: 0 auto; padding: 20px 24px 64px; }
header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--line); padding-bottom: 16px; margin-bottom: 20px; }
.brand { display: flex; align-items: baseline; gap: 10px; }
.brand h1 { margin: 0; font-size: 20px; letter-spacing: -0.02em; }
.badge { font-family: var(--mono); font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--accent-bg); color: var(--accent); }
nav { display: flex; flex-wrap: wrap; gap: 8px; }
.tab { border: 1px solid var(--line); background: var(--paper); color: var(--ink); padding: 7px 14px; border-radius: 8px; cursor: pointer; font-size: 14px; }
.tab.active { background: var(--ink); color: var(--paper); border-color: var(--ink); }
.toolbar { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; align-items: center; }
input, select, textarea { font-family: inherit; font-size: 14px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); color: var(--ink); }
input[type="search"] { flex: 1; min-width: 220px; }
button.btn { border: 1px solid var(--line); background: var(--paper); color: var(--ink); padding: 8px 14px; border-radius: 8px; cursor: pointer; font-size: 14px; }
button.btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
button.btn.danger { color: var(--danger); border-color: var(--danger); }
.grid { display: grid; gap: 12px; }
.card { background: var(--paper); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 6px; }
.card-title { font-weight: 600; font-size: 15px; margin: 0; }
.meta { font-family: var(--mono); font-size: 12px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 10px; }
.body-text { margin: 8px 0 0; font-size: 14px; white-space: pre-wrap; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 18px; }
.stat { background: var(--paper); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.stat .k { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.stat .v { font-family: var(--mono); font-size: 20px; font-weight: 600; margin-top: 4px; }
.graph-box { background: var(--paper); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.auth-bar { background: var(--accent-bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; display: flex; gap: 10px; align-items: center; }
.empty { padding: 36px; text-align: center; color: var(--muted); border: 1px dashed var(--line); border-radius: 10px; }
.modal { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 12px; display: grid; gap: 8px; }
.btn-row { display: flex; gap: 6px; }
.btn-row-lg { display: flex; gap: 8px; }
.mt-lg { margin-top: 24px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">
      <h1>Clyde Local</h1>
      <span class="badge">${esc(config.database.connector)} · ${esc(config.server.owner_name)}</span>
    </div>
    <nav id="tabs">
      <button class="tab active" data-tab="notes">Notes</button>
      <button class="tab" data-tab="graph">Graph</button>
      <button class="tab" data-tab="agents">Agents</button>
      <button class="tab" data-tab="work">Messages &amp; Quests</button>
      <button class="tab" data-tab="system">Runtime</button>
    </nav>
  </header>
  ${config.auth.mode !== "none" ? `<div class="auth-bar" id="auth-bar"><span>Bearer token required:</span><input type="password" id="tok" placeholder="Paste bearer token"><button class="btn primary" id="tok-save">Connect</button></div>` : ""}
  <main id="root">Loading…</main>
</div>
<script nonce="${nonce}">
(function () {
  var state = { tab: "notes", q: "", pattern: "", editing: null };
  var tokenKey = "clyde_local_token";
  function headers() {
    var h = { "content-type": "application/json" };
    var t = sessionStorage.getItem(tokenKey);
    if (t) h.authorization = "Bearer " + t;
    return h;
  }
  async function api(path, init) {
    init = init || {};
    var res = await fetch(path, Object.assign({}, init, { headers: Object.assign(headers(), init.headers || {}) }));
    if (res.status === 401) throw new Error("Unauthorized. Enter your bearer token above.");
    if (!res.ok) throw new Error("Request failed (" + res.status + ")");
    var ct = res.headers.get("content-type") || "";
    return ct.includes("json") ? await res.json() : await res.text();
  }
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") node.className = attrs[k];
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c !== null && c !== undefined) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  async function renderNotes(root) {
    var toolbar = el("div", { class: "toolbar" }, [
      el("input", { type: "search", id: "q-in", placeholder: "Search notes…", value: state.q }),
      el("select", { id: "pat-sel", onchange: function (e) { state.pattern = e.target.value; load(); } },
        ["", "decisions", "preferences", "observations", "projects", "recommendations", "references", "reactions"].map(function (p) {
          var o = el("option", { value: p }, [p || "All patterns"]);
          if (p === state.pattern) o.selected = true;
          return o;
        })
      ),
      el("button", { class: "btn primary", onclick: function () { state.q = document.getElementById("q-in").value; load(); } }, ["Search"]),
    ]);
    root.appendChild(toolbar);
    document.getElementById("q-in").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { state.q = e.target.value; load(); }
    });
    var params = new URLSearchParams();
    if (state.q) params.set("q", state.q);
    if (state.pattern) params.set("pattern", state.pattern);
    var data = await api("/api/notes?" + params.toString());
    if (!data.items.length) {
      root.appendChild(el("div", { class: "empty" }, ["No matching notes. Save notes with the remember tool or clear your filter."]));
      return;
    }
    var list = el("div", { class: "grid" });
    data.items.forEach(function (n) {
      var card = el("div", { class: "card" }, [
        el("div", { class: "card-head" }, [
          el("h3", { class: "card-title" }, [n.title]),
          el("div", { class: "btn-row" }, [
            el("button", { class: "btn", onclick: function () { state.editing = state.editing === n.id ? null : n.id; load(); } }, ["Edit"]),
            el("button", { class: "btn danger", onclick: async function () {
              await api("/api/notes/" + encodeURIComponent(n.id), { method: "DELETE" });
              load();
            } }, ["Delete"]),
          ]),
        ]),
        el("div", { class: "meta" }, [
          el("span", null, [n.id]),
          el("span", null, [n.pattern + " · " + n.kind + " · " + Number(n.confidence).toFixed(2)]),
          el("span", null, [n.context + " / " + n.transferability]),
          el("span", null, [n.authority]),
        ]),
        el("p", { class: "body-text" }, [n.body]),
      ]);
      if (state.editing === n.id) {
        var tIn = el("input", { type: "text", value: n.title });
        var bIn = el("textarea", { rows: "3" }, [n.body]);
        card.appendChild(el("div", { class: "modal" }, [
          tIn,
          bIn,
          el("div", { class: "btn-row-lg" }, [
            el("button", { class: "btn primary", onclick: async function () {
              await api("/api/notes/" + encodeURIComponent(n.id), {
                method: "PATCH",
                body: JSON.stringify({ title: tIn.value, body: bIn.value }),
              });
              state.editing = null;
              load();
            } }, ["Save"]),
            el("button", { class: "btn", onclick: function () { state.editing = null; load(); } }, ["Cancel"]),
          ]),
        ]));
      }
      list.appendChild(card);
    });
    root.appendChild(list);
  }

  async function renderGraph(root) {
    var g = await api("/api/graph");
    if (!g.nodes.length) {
      root.appendChild(el("div", { class: "empty" }, ["No graph nodes yet. Save linked notes with remember to populate it."]));
      return;
    }
    var w = 960, h = 440, cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.36;
    var pos = {};
    g.nodes.forEach(function (n, i) {
      var a = (i / g.nodes.length) * Math.PI * 2;
      pos[n.id] = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), n: n };
    });
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", String(h));
    g.edges.forEach(function (e) {
      var a = pos[e.src], b = pos[e.dst];
      if (!a || !b) return;
      var line = document.createElementNS(ns, "line");
      line.setAttribute("x1", a.x); line.setAttribute("y1", a.y);
      line.setAttribute("x2", b.x); line.setAttribute("y2", b.y);
      line.setAttribute("stroke", "#8c867b"); line.setAttribute("stroke-opacity", "0.45");
      svg.appendChild(line);
    });
    g.nodes.forEach(function (n) {
      var p = pos[n.id];
      var grp = document.createElementNS(ns, "g");
      var c = document.createElementNS(ns, "circle");
      c.setAttribute("cx", p.x); c.setAttribute("cy", p.y); c.setAttribute("r", "8");
      c.setAttribute("fill", "#b85d19");
      var txt = document.createElementNS(ns, "text");
      txt.setAttribute("x", p.x + 11); txt.setAttribute("y", p.y + 4);
      txt.setAttribute("font-size", "11"); txt.setAttribute("fill", "currentColor");
      txt.textContent = String(n.title).slice(0, 26);
      grp.appendChild(c); grp.appendChild(txt);
      svg.appendChild(grp);
    });
    root.appendChild(el("div", { class: "graph-box" }, [svg]));
  }

  async function renderAgents(root) {
    var list = await api("/api/agents");
    if (!list.length) {
      root.appendChild(el("div", { class: "empty" }, ["No agents registered yet. Call register_agent from an MCP client."]));
      return;
    }
    var grid = el("div", { class: "grid" });
    list.forEach(function (a) {
      grid.appendChild(el("div", { class: "card" }, [
        el("h3", { class: "card-title" }, [a.name + (a.nickname ? " (@" + a.nickname + ")" : "")]),
        el("div", { class: "meta" }, [
          el("span", null, [a.surface]),
          el("span", null, ["context: " + a.context]),
          el("span", null, ["type: " + a.agent_type]),
          el("span", null, ["computer: " + (a.computer || "any")]),
        ]),
        el("p", { class: "body-text" }, [a.description]),
      ]));
    });
    root.appendChild(grid);
  }

  async function renderWork(root) {
    var res = await Promise.all([api("/api/quests"), api("/api/messages")]);
    var quests = res[0], msgs = res[1];
    root.appendChild(el("h3", null, ["Quests (" + quests.length + ")"]));
    if (!quests.length) root.appendChild(el("div", { class: "empty" }, ["No quests posted yet. Create one with post_quest."]));
    else {
      var qg = el("div", { class: "grid" });
      quests.forEach(function (q) {
        qg.appendChild(el("div", { class: "card" }, [
          el("h3", { class: "card-title" }, ["#" + q.id + " · " + q.title]),
          el("div", { class: "meta" }, [el("span", null, [q.status]), el("span", null, [q.priority]), el("span", null, ["poster: " + q.poster])]),
          el("p", { class: "body-text" }, [q.brief]),
        ]));
      });
      root.appendChild(qg);
    }
    root.appendChild(el("h3", { class: "mt-lg" }, ["Messages (" + msgs.length + ")"]));
    if (!msgs.length) root.appendChild(el("div", { class: "empty" }, ["No messages yet. Send one with post_message."]));
    else {
      var mg = el("div", { class: "grid" });
      msgs.forEach(function (m) {
        mg.appendChild(el("div", { class: "card" }, [
          el("div", { class: "meta" }, [el("span", null, [m.sender + " -> " + m.recipient]), el("span", null, [m.created_at])]),
          el("p", { class: "body-text" }, [m.body]),
        ]));
      });
      root.appendChild(mg);
    }
  }

  async function renderSystem(root) {
    var st = await api("/api/stats");
    var cards = [
      ["Connector", st.connector],
      ["Dialect", st.dialect],
      ["FTS5", st.fts5 ? "on" : "js-bm25"],
      ["Embeddings", st.embeddings],
      ["Entries", String(st.counts.entries)],
      ["Embedded", String(st.counts.embedded)],
      ["Links", String(st.counts.links)],
      ["Recall clock", String(st.clock)],
    ];
    var sg = el("div", { class: "stats-grid" });
    cards.forEach(function (pair) {
      sg.appendChild(el("div", { class: "stat" }, [el("div", { class: "k" }, [pair[0]]), el("div", { class: "v" }, [pair[1]])]));
    });
    root.appendChild(sg);
    root.appendChild(el("div", { class: "toolbar" }, [
      el("button", { class: "btn", onclick: async function () { await api("/learn", { method: "POST" }); load(); } }, ["Run Learner"]),
      el("button", { class: "btn", onclick: async function () { await api("/embeddings/sync", { method: "POST" }); load(); } }, ["Sync Embeddings"]),
      el("button", { class: "btn", onclick: async function () {
        var ndjson = await api("/export");
        var blob = new Blob([ndjson], { type: "application/x-ndjson" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "clyde-export.ndjson";
        a.click();
      } }, ["Export NDJSON"]),
    ]));
  }

  async function load() {
    var root = document.getElementById("root");
    clear(root);
    try {
      if (state.tab === "notes") await renderNotes(root);
      else if (state.tab === "graph") await renderGraph(root);
      else if (state.tab === "agents") await renderAgents(root);
      else if (state.tab === "work") await renderWork(root);
      else await renderSystem(root);
    } catch (err) {
      root.appendChild(el("div", { class: "empty" }, [String(err.message || err)]));
    }
  }

  document.getElementById("tabs").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-tab]");
    if (!btn) return;
    state.tab = btn.getAttribute("data-tab");
    document.querySelectorAll(".tab").forEach(function (b) { b.classList.toggle("active", b === btn); });
    load();
  });

  var saveBtn = document.getElementById("tok-save");
  if (saveBtn) {
    var tokInput = document.getElementById("tok");
    tokInput.value = sessionStorage.getItem(tokenKey) || "";
    saveBtn.addEventListener("click", function () {
      sessionStorage.setItem(tokenKey, tokInput.value.trim());
      load();
    });
  }
  load();
})();
</script>
</body>
</html>`;
}
