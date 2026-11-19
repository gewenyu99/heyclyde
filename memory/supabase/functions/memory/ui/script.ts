// R67: the script every card runs. It talks to the chat app over the MCP Apps postMessage protocol (JSON-RPC 2.0 with the
// host window), or over ChatGPT's window.openai when that is there, then draws the card from the tool result's card data.
// Every string from memory goes into the page through textContent or an attribute set by the DOM, never as HTML, so a note
// that holds markup shows as text. Plain ES5-ish JS with no template literals, stripped of indent and comments on export.
const RAW_CARD_JS = String.raw`(function () {
"use strict";
var docEl = document.documentElement;
var KIND = docEl.getAttribute("data-card");
var root = document.getElementById("root");
var NS = "http://www.w3.org/2000/svg";
var KEY = "clyde/card";
var TOP = 3;
var SM = "cl-btn cl-btn--sm ";
var GH = SM + "cl-btn--ghost ";
var PR = SM + "cl-btn--primary ";
var oa = window.openai || null;
var noIpc = false;
var st = { data: null, verdicts: {}, sent: false, busy: false, vote: null };

// ---------- DOM ----------
function h(tag, props) {
  var el = document.createElement(tag), k, v;
  if (props) for (k in props) {
    v = props[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = String(v);
    else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
  return el;
}
function add(el, c) {
  if (c === null || c === undefined || c === false) return;
  if (Array.isArray(c)) { for (var i = 0; i < c.length; i++) add(el, c[i]); return; }
  el.appendChild(typeof c === "object" && c.nodeType ? c : document.createTextNode(String(c)));
}
var PATHS = {
  check: "M3.5 8.5l3 3 6-7", x: "M4.5 4.5l7 7M11.5 4.5l-7 7", open: "M9 3h4v4M13 3L7.5 8.5M12 9.5V13H3V4h3.5",
  file: "M4 1.8h5l3 3v9.4H4zM9 1.8v3h3", image: "M2.5 3h11v10h-11zM2.5 11l3.5-3.5 3 3 2-2 2.5 2.5M10.5 6.2h.01",
  link: "M6.5 9.5l3-3M5 7.5L3.8 8.7a2.3 2.3 0 0 0 3.3 3.3L8.3 10.8M11 8.5l1.2-1.2a2.3 2.3 0 0 0-3.3-3.3L7.7 5.2",
  more: "M4 6.5l4 4 4-4", bolt: "M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z"
};
function icon(name) {
  var s = document.createElementNS(NS, "svg"), p = document.createElementNS(NS, "path");
  s.setAttribute("viewBox", "0 0 16 16"); s.setAttribute("class", "c-i"); s.setAttribute("aria-hidden", "true");
  p.setAttribute("d", PATHS[name] || PATHS.file); s.appendChild(p); return s;
}
function size(b) { b = Number(b) || 0; return b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : (b / 1048576).toFixed(1) + " MB"; }
function when(iso) { if (!iso) return ""; var d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function safeUrl(u) { try { var x = new URL(String(u)); return x.protocol === "https:" ? x.href : null; } catch (e) { return null; } }
function isNoIpc(e) { return /IPC not available/i.test((e && e.message) || ""); }

// ---------- host ----------
var seq = 0, waiting = {};
function post(msg) { window.parent.postMessage(msg, "*"); }
function request(method, params) {
  return new Promise(function (ok, fail) {
    var id = "clyde-" + (++seq);
    waiting[id] = { ok: ok, fail: fail };
    post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    setTimeout(function () { if (waiting[id]) { delete waiting[id]; fail(new Error("The chat app didn't answer.")); } }, 30000);
  });
}
function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); }
function callTool(name, args) {
  if (oa && typeof oa.callTool === "function") return Promise.resolve(oa.callTool(name, args));
  if (noIpc) return Promise.reject(new Error("IPC not available for MCP tool call"));
  return request("tools/call", { name: name, arguments: args });
}
function openLink(url) {
  url = safeUrl(url); if (!url) return;
  if (oa && typeof oa.openExternal === "function") oa.openExternal({ href: url });
  else request("ui/open-link", { url: url }).catch(function () { window.open(url, "_blank", "noopener"); });
}
function textOf(result) {
  var c = result && result.content, out = [];
  if (Array.isArray(c)) for (var i = 0; i < c.length; i++) if (c[i] && c[i].type === "text") out.push(String(c[i].text));
  return out.join("\n");
}
function cardOf(result) {
  if (!result) return null;
  var m = result._meta || result.toolResponseMetadata || null;
  if (m && m[KEY]) return m[KEY];
  if (result.structuredContent && result.structuredContent[KEY]) return result.structuredContent[KEY];
  return result[KEY] || null;
}
function theme(t) { if (t === "dark" || t === "light") docEl.setAttribute("data-theme", t); }
function context(c) { if (c) theme(c.theme); }
var lastH = 0;
// The card's height is its content's. It goes on the document too, since claude.ai sizes the frame from the document's
// height rather than from size-changed (anthropics/claude-ai-mcp#69), and a frame sized short reads as collapsed.
function resized() {
  var r = docEl.getBoundingClientRect(), height = Math.ceil(document.body.getBoundingClientRect().height);
  if (height > 0) docEl.style.height = height + "px";
  if (height === lastH) return; lastH = height;
  if (oa) { if (typeof oa.notifyIntrinsicHeight === "function") oa.notifyIntrinsicHeight(height); return; }
  notify("ui/notifications/size-changed", { width: Math.ceil(r.width), height: height });
}
window.addEventListener("message", function (ev) {
  if (ev.source !== window.parent) return;
  var m = ev.data;
  if (!m || m.jsonrpc !== "2.0") return;
  if (m.id !== undefined && !m.method) {
    var w = waiting[m.id]; if (!w) return; delete waiting[m.id];
    if (m.error) w.fail(new Error(m.error.message || "The chat app refused.")); else w.ok(m.result);
    return;
  }
  if (m.method === "ui/notifications/tool-result") show(m.params);
  else if (m.method === "ui/notifications/host-context-changed") context(m.params);
  else if (m.method === "ui/notifications/tool-cancelled") failed("The call was cancelled.");
  else if (m.id !== undefined && (m.method === "ui/resource-teardown" || m.method === "ping")) post({ jsonrpc: "2.0", id: m.id, result: {} });
});

// ---------- pieces ----------
var PENS = ["blue", "red", "green", "violet", "amber", "teal", "graphite"];
function penOf(name) { var n = 0, s = String(name || ""); for (var i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0; return "cl-pen-" + PENS[n % PENS.length]; }
function initials(name) { var p = String(name || "").split(/[^a-z0-9]+/i).filter(Boolean); return ((p[0] || "?").charAt(0) + (p[1] || p[0] || "").charAt(p[1] ? 0 : 1)).toUpperCase(); }
function agentBadge(b, big) {
  if (!b) return null;
  var on = !!b.registered;
  return h("span", { class: "cl-agent " + (big ? "c-big " : "cl-agent--sm ") + penOf(b.name), title: on ? b.name + ", a " + (b.context || "") + " agent on " + (b.surface || "") : "This app hasn't registered with Clyde yet" },
    h("span", { class: "cl-agent__sq", text: initials(b.name) }),
    h("span", { class: "cl-agent__text" }, h("span", { class: "cl-agent__name", text: b.name }),
      h("span", { class: "cl-agent__meta", text: on ? [b.context, b.surface].filter(Boolean).join(" · ") : "not registered" })));
}
function toggleBtn(onFlip) {
  var label = h("span", { text: "Expand" });
  var btn = h("button", { class: GH + "c-toggle", type: "button", "aria-expanded": "false", onclick: function () { onFlip(btn.getAttribute("aria-expanded") !== "true"); } }, label, icon("more"));
  btn.sync = function (open) { btn.setAttribute("aria-expanded", String(!!open)); label.textContent = open ? "Compact" : "Expand"; };
  return btn;
}
function foldBtn(onclick) { return h("button", { class: GH + "c-fold", type: "button", title: "Collapse", onclick: onclick }, "Less", icon("more")); }
var LOGO = document.getElementById("clyde-logo");
function logo() { var w = h("span", { class: "cl-wordmark" }); if (LOGO) w.appendChild(LOGO.content.cloneNode(true)); return w; }
function sheet(what, b, toggle) { return h("div", { class: "clyde" }, h("div", { class: "c-head" }, logo(), h("span", { class: "c-what", text: what || "" }), agentBadge(b, false), toggle || null)); }
function desk() { return h("div", { class: "c-desk" }); }
function meter(v) { var i = h("i"); i.style.width = Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100) + "%"; return h("span", { class: "c-meter" }, i); }
function confEl(m) { return h("span", { class: "cl-memory__conf" }, meter(m.confidence), Math.round(Number(m.confidence || 0) * 100) + "% confidence"); }
function stateOf(m) {
  if (m.superseded_by) return ["superseded", "superseded"];
  if (m.trial) return ["trial", "on trial" + (m.chance ? " · " + m.chance + " of 3" : "")];
  if (Number(m.confidence || 0) < 0.15) return ["dormant", "dormant"];
  return ["settled", m.unreviewed ? "agent-filed" : "settled"];
}
var KIND_CHIP = { fact: "cl-chip--ok", wen: "cl-chip--carbon", plan: "cl-chip--warn" };
function kindChip(kind, verified) {
  var k = String(kind || "observation");
  return h("span", { class: "cl-chip " + (KIND_CHIP[k] || ""), text: k + (verified === false ? " · unverified" : "") });
}
function artChips(list, openable) {
  if (!list || !list.length) return null;
  return h("div", { class: "c-row" }, list.map(function (a) {
    var label = h("span", { text: a.name + " · " + a.kind + " · " + size(a.size) });
    var ic = icon(a.kind === "image" ? "image" : "file");
    if (openable && a.sha256) return h("button", { class: "c-art", type: "button", title: "Preview " + a.name, onclick: function () { preview(this, a); } }, ic, label);
    return h("span", { class: "c-art" }, ic, label);
  }));
}
function memoryTop(m) {
  var s = stateOf(m);
  return h("div", { class: "cl-memory__top" }, kindChip(m.kind, m.verified),
    m.category && m.category !== "general" ? h("span", { class: "cl-chip", text: m.category }) : null,
    m.context && m.context !== "general" ? h("span", { class: "cl-chip", text: m.context }) : null,
    h("span", { class: "cl-state cl-state--" + s[0], text: s[1] }),
    m.private ? h("span", { class: "cl-chip", text: "private" }) : null,
    confEl(m));
}
function provLine(m) {
  if (!m.provenance) return null;
  var who = /^from (\S+)/.exec(m.provenance), rest = who ? m.provenance.slice(who[0].length) : m.provenance;
  return h("div", { class: "cl-prov " + (who ? penOf(who[1]) : "") }, who ? h("span", null, "from ", h("span", { class: "cl-prov__who", text: who[1] })) : null, h("span", { text: rest.trim() }),
    m.valid_from ? h("span", { class: "cl-prov__sep", text: "·" }) : null, m.valid_from ? h("span", { text: m.valid_from }) : null);
}
function memoryParts(m, full) {
  return [memoryTop(m), h("h3", { class: "cl-memory__title", text: m.title }),
    m.body ? h("p", { class: "cl-memory__body" + (full ? " is-open" : ""), text: m.body }) : null,
    m.quote ? h("p", { class: "c-quote", text: "Wen: “" + m.quote + "”" }) : null,
    m.superseded_by ? h("p", { class: "c-text", text: "Superseded by " + m.superseded_by + "." }) : null,
    provLine(m)];
}
function say(el, text, tone) {
  el.textContent = text; el.className = "c-say " + (tone === "muted" ? "is-muted" : tone ? "is-ok" : "is-bad"); el.hidden = false; resized();
}

// ---------- open: get_entry and get_blob inside a card ----------
function entryDetail(e, openable) {
  var parts = [], foot = [e.id, e.pattern, e.scope].filter(Boolean);
  if (e.links && e.links.length) {
    parts.push(h("span", { class: "cl-label", text: "Links" }), h("ul", { class: "c-links" }, e.links.map(function (l) {
      return h("li", null, icon("link"), h("span", { class: "cl-muted cl-mono", text: (l.dir === "to" ? "" : "from ") + l.type }), h("span", { text: l.title }));
    })));
  }
  if (e.artifacts && e.artifacts.length) parts.push(h("span", { class: "cl-label", text: "Artifacts" }), artChips(e.artifacts, openable !== false));
  if (foot.length) parts.push(h("div", { class: "cl-memory__foot" }, foot.map(function (t) { return h("span", { text: t }); })));
  return parts;
}
function openLocal(btn, m, holder, card) {
  holder.hidden = false; btn.setAttribute("aria-expanded", "true");
  var body = card.querySelector(".cl-memory__body"); if (body) body.className = "cl-memory__body is-open";
  add(holder, entryDetail(m, false)); resized();
}
function openEntry(btn, m, holder, card) {
  if (holder.firstChild) { holder.hidden = !holder.hidden; btn.setAttribute("aria-expanded", String(!holder.hidden)); resized(); return; }
  if (noIpc) { openLocal(btn, m, holder, card); return; }
  btn.disabled = true;
  callTool("get_entry", { id: m.id }).then(function (r) {
    btn.disabled = false; var d = cardOf(r);
    holder.hidden = false; btn.setAttribute("aria-expanded", "true");
    if (d && d.entry) {
      var body = card.querySelector(".cl-memory__body"); if (body) { body.textContent = d.entry.body; body.className = "cl-memory__body is-open"; }
      add(holder, entryDetail(d.entry, true));
    } else add(holder, h("p", { class: "c-text", text: textOf(r) }));
    resized();
  }, function (e) {
    btn.disabled = false;
    if (isNoIpc(e)) { noIpc = true; openLocal(btn, m, holder, card); return; }
    holder.hidden = false; add(holder, h("p", { class: "c-say is-bad", role: "alert", text: e.message })); resized();
  });
}
function preview(btn, a) {
  var card = btn.closest(".cl-memory") || btn.closest(".clyde"), box = card.querySelector(".c-preview[data-sha='" + a.sha256 + "']");
  if (box) { box.hidden = !box.hidden; resized(); return; }
  box = h("div", { class: "c-preview", "data-sha": a.sha256 }, h("div", { class: "c-skel" }));
  card.appendChild(box); resized();
  callTool("get_blob", { sha256: a.sha256 }).then(function (r) {
    box.textContent = ""; var d = cardOf(r);
    add(box, d && d.artifact ? artifactView(d.artifact, true).el : h("p", { class: "c-text", text: textOf(r) })); resized();
  }, function (e) {
    box.textContent = "";
    if (isNoIpc(e)) { noIpc = true; add(box, h("p", { class: "c-say is-muted", role: "status", "aria-live": "polite", text: "Actions can't send from this card right now, so ask your agent in chat." })); resized(); return; }
    add(box, h("p", { class: "c-say is-bad", role: "alert", text: e.message })); resized();
  });
}
function artifactView(a, startOpen, onFlip) {
  var url = safeUrl(a.url), img = url && /^image\//.test(a.media_type || ""), open = !!startOpen;
  var file = h("div", { class: "cl-file" + (open ? "" : " is-compact") });
  var info = [a.media_type, a.size ? size(a.size) : a.total ? a.total + " characters" : ""].filter(Boolean).join(" · ");
  var dl = url && !img ? h("button", { class: SM.trim(), type: "button", onclick: function () { openLink(url); } }, icon("open"), "Download") : null;
  var hasBody = !!(img || (a.text !== null && a.text !== undefined)), bodyWrap = h("div", { hidden: !open });
  var flipLbl = h("span", { text: open ? "Less" : "Open" });
  var flip = hasBody && !startOpen ? h("button", { class: GH + "c-fold-art", type: "button", "aria-expanded": String(open), onclick: function () { setOpen(!open); } }, flipLbl, icon("more")) : null;
  file.appendChild(h("div", { class: "cl-file__head" }, h("span", { class: "c-row" }, icon(img ? "image" : "file"), h("span", { text: a.name })), h("span", { class: "c-row" }, h("span", { text: info }), dl, flip)));
  if (img) bodyWrap.appendChild(h("div", null, h("img", { class: "c-img", src: url, alt: a.name, loading: "lazy", onload: resized })));
  if (a.text !== null && a.text !== undefined) {
    var pre = h("pre", { text: a.text }); bodyWrap.appendChild(pre);
    if (a.next) {
      var note = h("span", { class: "cl-muted", text: "Showing " + a.to + " of " + a.total + " characters" });
      var more = h("button", { class: GH.trim(), type: "button", onclick: function () {
        more.disabled = true;
        callTool("get_blob", { sha256: a.sha256, offset: a.next }).then(function (r) {
          var d = cardOf(r);
          if (d && d.artifact) { pre.textContent += d.artifact.text; a.next = d.artifact.next; a.to = d.artifact.to; } else pre.textContent += "\n" + textOf(r);
          more.disabled = false; note.textContent = "Showing " + a.to + " of " + a.total + " characters"; if (!a.next) more.remove(); resized();
        }, function (e) { if (isNoIpc(e)) noIpc = true; more.disabled = false; });
      } }, icon("more"), "Load more");
      bodyWrap.appendChild(h("div", { class: "cl-file__head" }, note, more));
    }
  }
  if (hasBody) file.appendChild(bodyWrap);
  function setOpen(v) {
    if (!hasBody) return;
    open = !!v; file.className = "cl-file" + (open ? "" : " is-compact"); bodyWrap.hidden = !open;
    if (flip) { flip.setAttribute("aria-expanded", String(open)); flipLbl.textContent = open ? "Less" : "Open"; }
    if (onFlip) onFlip(); resized();
  }
  return { el: file, isOpen: function () { return open; }, setOpen: setOpen };
}

// ---------- compact items & list cap ----------
function memoryItem(m, opts) {
  opts = opts || {};
  var open = false, s = stateOf(m), fold = foldBtn(function () { setOpen(false, true); });
  var card = h("article", { class: "cl-card cl-memory is-compact" + (m.superseded_by ? " is-superseded" : ""), "data-id": m.id });
  var sum = h("button", { class: "c-sum", type: "button", "aria-expanded": "false", onclick: function () { setOpen(true, true); } },
    opts.saved ? h("span", { class: "cl-stamp cl-stamp--ok", text: "Saved" }) : null,
    h("span", { class: "cl-state cl-state--" + s[0], text: s[1] }),
    h("span", { class: "c-sum__title", text: m.title }), confEl(m), icon("more"));
  var full = h("div", { class: "c-full", hidden: true });
  if (opts.saved) full.appendChild(h("div", { class: "c-row" }, h("span", { class: "cl-stamp cl-stamp--ok is-new", text: "Saved" }),
    h("span", { class: "c-text", text: "Your other agents won't forget this now." }), h("span", { class: "c-sp" }), h("span", { class: "cl-muted cl-mono", text: m.id }), fold));
  add(full, memoryParts(m, !opts.recall));
  if (opts.extra) add(full, opts.extra(card, fold));
  if (opts.detail) {
    full.appendChild(h("div", { class: "c-detail" }, entryDetail(m, true)));
    if (!opts.saved) full.appendChild(h("div", { class: "c-row" }, h("span", { class: "c-sp" }), fold));
  }
  card.appendChild(sum); card.appendChild(full);
  function setOpen(v, moveFocus) {
    open = !!v;
    card.className = "cl-card cl-memory" + (open ? "" : " is-compact") + (m.superseded_by ? " is-superseded" : "");
    sum.hidden = open; sum.setAttribute("aria-expanded", String(open)); full.hidden = !open;
    if (moveFocus) (open ? fold : sum).focus();
    if (opts.onFlip) opts.onFlip(); resized();
  }
  return { el: card, isOpen: function () { return open; }, setOpen: setOpen };
}
function capList(dk, rows, sync) {
  var showAll = false, extra = rows.length - TOP;
  if (extra <= 0) return { isAll: function () { return true; }, setAll: function () {} };
  var more = h("button", { class: GH + "c-more", type: "button", "aria-expanded": "false", onclick: function () { showAll = !showAll; paint(); if (sync) sync(); resized(); } });
  function paint() {
    for (var j = TOP; j < rows.length; j++) rows[j].el.hidden = !showAll;
    more.textContent = showAll ? "Show top " + TOP : "Show " + extra + " more";
    more.setAttribute("aria-expanded", String(showAll));
  }
  paint(); dk.appendChild(more);
  return { isAll: function () { return showAll; }, setAll: function (v) { showAll = !!v; paint(); } };
}

// ---------- cards ----------
function recallCard(d) {
  var items = d.items || [], rows = [], cap = null;
  var toggle = items.length ? toggleBtn(function (want) {
    if (cap) cap.setAll(want);
    rows.forEach(function (r) { r.setOpen(want); });
    sync(); resized();
  }) : null;
  var s = sheet((d.page === "more" ? "more for " : "recall · ") + "“" + (d.query || "") + "”" + (items.length ? " · " + items.length : ""), d.badge, toggle), dk = desk();
  if (d.degraded) dk.appendChild(h("p", { class: "c-text" }, h("span", { class: "cl-chip cl-chip--warn", text: "degraded" }), " ", d.degraded));
  if (!items.length) {
    dk.appendChild(h("div", { class: "cl-empty" }, h("p", { class: "cl-empty__title", text: "Nothing in Clyde matches that yet." }),
      h("p", { class: "cl-empty__text", text: "Either nobody wrote it down, or it was phrased differently. Ask for more results, or tell your agent to remember it." })));
  }
  var msg = h("p", { class: "c-say", role: "status", "aria-live": "polite", hidden: true });
  var yes = h("button", { class: PR + "c-used", type: "button", "aria-pressed": "false", onclick: function () { rate("helpful"); } }, "That helped");
  var no = h("button", { class: GH + "c-wrong", type: "button", "aria-pressed": "false", onclick: function () { rate("nothing_useful"); } }, "That didn’t");
  var foot = h("div", { class: "c-foot" }, yes, no);
  function refresh() {
    yes.disabled = no.disabled = st.busy || st.sent || noIpc;
    yes.setAttribute("aria-pressed", String(st.vote === "helpful"));
    no.setAttribute("aria-pressed", String(st.vote === "nothing_useful"));
  }
  function sync() { if (toggle) toggle.sync(rows.every(function (r) { return r.isOpen(); }) && (!cap || cap.isAll())); }
  function rate(verdict) {
    if (st.busy || st.sent) return;
    st.busy = true; st.vote = verdict; refresh();
    var args = { retrieval_id: d.retrieval_id, verdict: verdict, card_vote: true };
    if (d.card_receipt) args.card_receipt = d.card_receipt;
    callTool("feedback", args).then(function (reply) {
      st.busy = false; var result = textOf(reply);
      st.sent = /^Logged\./.test(result) || /^Already logged/.test(result);
      if (!st.sent) st.vote = null;
      say(msg, /^Logged\./.test(result) ? "Feedback recorded." : result, st.sent); refresh();
    }, function (error) {
      st.busy = false; st.vote = null;
      if (isNoIpc(error)) { noIpc = true; say(msg, "Feedback can't send from this card right now.", "muted"); }
      else say(msg, error.message, false);
      refresh();
    });
  }
  items.forEach(function (m) {
    var item = memoryItem(m, {
      recall: true, onFlip: sync,
      extra: function (card, fold) {
        var holder = h("div", { class: "c-detail", hidden: true });
        var open = h("button", { class: GH + "c-open", type: "button", "aria-expanded": "false", onclick: function () { openEntry(open, m, holder, card); } }, "Open", icon("open"));
        return [artChips(m.artifacts, false), h("div", { class: "c-row" }, h("span", { class: "c-sp" }), fold, open), holder];
      }
    });
    rows.push(item); dk.appendChild(item.el);
  });
  cap = capList(dk, rows, sync);
  rows.forEach(function (r) { r.setOpen(true); });
  s.appendChild(dk); s.appendChild(foot); s.appendChild(msg);
  refresh(); sync();
  return s;
}
function entryCard(d, saved) {
  var item = null, toggle = toggleBtn(function (want) { if (item) item.setOpen(want); });
  var s = sheet(saved ? "remember" : "memory", d.badge, toggle), dk = desk();
  item = memoryItem(d.entry, { saved: saved, detail: true, onFlip: function () { toggle.sync(item.isOpen()); } });
  item.setOpen(true);
  dk.appendChild(item.el); s.appendChild(dk);
  return s;
}
function artifactCard(d) {
  var view = null, toggle = toggleBtn(function (want) { if (view) view.setOpen(want); });
  var s = sheet("artifact · " + (d.artifact && d.artifact.name || ""), d.badge, toggle), dk = desk();
  view = artifactView(d.artifact, false, function () { toggle.sync(view.isOpen()); });
  view.setOpen(true);
  dk.appendChild(view.el); s.appendChild(dk);
  return s;
}
var STAMP = { open: "cl-stamp--carbon", claimed: "cl-stamp--warn", done: "cl-stamp--ok", abandoned: "cl-stamp--bad" };
function questCard(q, d, startOpen, onFlip) {
  var open = !!startOpen, me = d.badge && d.badge.registered ? d.badge.name : null;
  var msg = h("p", { class: "c-say", role: "status", "aria-live": "polite", hidden: true }), row = h("div", { class: "c-row" });
  var fold = foldBtn(function () { setOpen(false, true); });
  var who = [h("span", null, "posted by ", h("b", { text: q.posted_by }))];
  if (q.assignee && q.assignee !== "any") who.push(h("span", null, " · for ", h("b", { text: q.assignee })));
  if (q.state === "claimed" && q.claimed_by) who.push(h("span", null, " · claimed by ", h("b", { text: q.claimed_by }), q.lease_until ? " until " + when(q.lease_until) : ""));
  if (q.state === "done") who.push(h("span", null, " · done by ", h("b", { text: q.claimed_by || "" }), q.closed_at ? " " + when(q.closed_at) : ""));
  var stub = h("div", { class: "cl-quest__stub", hidden: !open }, h("span", { class: "cl-quest__pri" + (["urgent", "high"].includes(q.priority) ? " is-high" : ""), text: q.priority }),
    h("span", { class: "cl-quest__no", text: "Nº" + q.id }));
  var main = h("div", { class: "cl-quest__main", hidden: !open },
    h("div", { class: "cl-quest__head" }, h("h3", { class: "cl-quest__title", text: q.title }),
      h("span", { class: "c-row" }, h("span", { class: "cl-stamp " + (STAMP[q.state] || ""), text: q.state }), fold)),
    h("p", { class: "cl-quest__brief", text: q.brief }),
    h("div", { class: "cl-quest__done" }, h("span", { class: "cl-label", text: "Done when" }), h("span", { class: "c-text", text: q.done_when })),
    q.evidence ? h("p", { class: "c-quote", text: q.evidence }) : null,
    q.tags && q.tags.length ? h("div", { class: "c-row" }, q.tags.map(function (t) { return h("span", { class: "cl-chip", text: t }); })) : null,
    h("div", { class: "cl-quest__for" }, who, " · " + q.context), row, msg);
  var sum = h("button", { class: "c-qsum", type: "button", hidden: open, "aria-expanded": String(open), onclick: function () { setOpen(true, true); } },
    h("span", { class: "c-qno", text: "Nº" + q.id }),
    ["urgent", "high"].includes(q.priority) ? h("span", { class: "cl-quest__pri is-high", text: q.priority }) : null,
    h("span", { class: "c-sum__title", text: q.title }),
    h("span", { class: "cl-stamp " + (STAMP[q.state] || ""), text: q.state }), icon("more"));
  var card = h("article", { class: "cl-quest" + (open ? "" : " is-compact") + (q.state === "done" ? " is-done" : ""), "data-quest": q.id }, sum, stub, main);
  function setOpen(v, moveFocus) {
    open = !!v; card.className = "cl-quest" + (open ? "" : " is-compact") + (q.state === "done" ? " is-done" : "");
    sum.hidden = open; sum.setAttribute("aria-expanded", String(open)); stub.hidden = !open; main.hidden = !open;
    if (moveFocus) (open ? fold : sum).focus();
    if (onFlip) onFlip(); resized();
  }
  var item = { el: card, isOpen: function () { return open; }, setOpen: setOpen };
  function act(name, args, btn) {
    btn.disabled = true;
    callTool(name, args).then(function (r) {
      var t = textOf(r), dd = cardOf(r), fresh = dd && dd.quests && dd.quests.filter(function (x) { return x.id === q.id; })[0];
      if ((r && r.isError) || !fresh) { btn.disabled = false; say(msg, t.split("\n")[0], false); return; }
      var next = questCard(fresh, d, true, onFlip); card.replaceWith(next.el); item.el = next.el; item.isOpen = next.isOpen; item.setOpen = next.setOpen;
      say(next.el.querySelector(".c-say"), t.split("\n")[0], true);
      var stamp = next.el.querySelector(".cl-quest__main .cl-stamp"); if (stamp) stamp.className += " is-new";
    }, function (e) {
      btn.disabled = false;
      if (isNoIpc(e)) { noIpc = true; btn.disabled = true; say(msg, "Actions can't send from this card right now, so ask your agent in chat.", "muted"); return; }
      say(msg, e.message, false);
    });
  }
  if (q.state === "open") {
    var claim = h("button", { class: PR + "c-claim", type: "button", onclick: function () { act("claim_quest", { id: q.id }, claim); } }, icon("bolt"), "Claim");
    row.appendChild(claim);
  }
  if (q.state === "claimed" && me && q.claimed_by === me) {
    var evId = "c-ev-" + q.id, enId = "c-en-" + q.id;
    var ev = h("textarea", { id: evId, class: "cl-textarea", name: "evidence", maxlength: "2000", required: true, placeholder: "How you know done-when holds" });
    var en = h("input", { id: enId, class: "cl-input", name: "entry", required: true, placeholder: "The memory the work produced", autocomplete: "off" });
    var go = h("button", { class: PR.trim(), type: "submit" }, icon("check"), "Complete quest");
    var form = h("form", { class: "c-complete", hidden: true }, h("div", { class: "cl-field" }, h("label", { for: evId, text: "Evidence" }), ev),
      h("div", { class: "cl-field" }, h("label", { for: enId, text: "Memory id" }), en), h("div", { class: "c-row" }, go));
    form.addEventListener("submit", function (e) { e.preventDefault(); act("complete_quest", { id: q.id, evidence: ev.value.trim(), entry_id: en.value.trim() }, go); });
    var toggleForm = h("button", { class: SM.trim(), type: "button", "aria-expanded": "false", onclick: function () { form.hidden = !form.hidden; toggleForm.setAttribute("aria-expanded", String(!form.hidden)); if (!form.hidden) ev.focus(); resized(); } }, icon("check"), "Complete");
    row.appendChild(toggleForm);
    main.insertBefore(form, msg);
  }
  if (!row.firstChild) row.hidden = true;
  return item;
}
function questsCard(d) {
  var qs = d.quests || [], rows = [], cap = null;
  function sync() { if (toggle) toggle.sync(rows.length > 0 && rows.every(function (r) { return r.isOpen(); }) && (!cap || cap.isAll())); }
  var toggle = qs.length ? toggleBtn(function (want) {
    if (cap) cap.setAll(want);
    rows.forEach(function (r) { r.setOpen(want); });
    sync(); resized();
  }) : null;
  var s = sheet("quest board" + (qs.length ? " · " + qs.length : ""), d.badge, toggle), dk = desk();
  if (d.head && !qs.length) dk.appendChild(h("p", { class: "c-text", text: d.head }));
  if (!qs.length) dk.appendChild(h("div", { class: "cl-empty" }, h("p", { class: "cl-empty__title", text: "Quest board's empty." }),
    h("p", { class: "cl-empty__text", text: "Nobody has pinned anything. Ask your agent to post one, with a done-when line anyone can check." })));
  qs.forEach(function (q) { var item = questCard(q, d, true, sync); rows.push(item); dk.appendChild(item.el); });
  cap = capList(dk, rows, sync);
  sync();
  s.appendChild(dk);
  return s;
}
function agentCard(d) {
  var a = d.agent, desc = a.description ? h("p", { class: "c-text c-say", text: a.description }) : null;
  var toggle = desc ? toggleBtn(function (want) { desc.hidden = !want; toggle.sync(want); resized(); }) : null;
  if (toggle) toggle.sync(true);
  var s = sheet("agent · " + a.name, d.badge, toggle), dk = desk();
  dk.appendChild(h("div", { class: "cl-card" }, h("div", { class: "c-hero" }, agentBadge({ name: a.name, context: a.context, surface: a.surface, registered: true }, true),
    h("span", { class: "c-sp" }), a.since ? h("span", { class: "cl-label", text: "since " + a.since }) : null), desc));
  s.appendChild(dk);
  return s;
}
function errorCard(d) {
  var s = sheet("", d.badge);
  s.appendChild(h("div", { class: "c-hero" }, h("span", { class: "cl-stamp cl-stamp--bad", text: "Refused" }), h("p", { class: "c-text", text: d.error })));
  return s;
}
function failed(text) { root.textContent = ""; root.appendChild(errorCard({ error: text })); resized(); }
function show(result) {
  var d = cardOf(result);
  root.textContent = "";
  st = { data: d, verdicts: {}, sent: false, busy: false, vote: null };
  if (!d) { var s = sheet("", null); s.appendChild(h("div", { class: "c-desk" }, h("p", { class: "c-text", text: textOf(result) }))); root.appendChild(s); resized(); return; }
  var el = d.error ? errorCard(d) : d.card === "recall" ? recallCard(d) : d.card === "entry" ? entryCard(d, false)
    : d.card === "remembered" ? entryCard(d, true) : d.card === "artifact" ? artifactCard(d) : d.card === "quests" ? questsCard(d)
    : d.card === "agent" ? agentCard(d) : null;
  root.appendChild(el || h("p", { class: "c-text", text: textOf(result) }));
  root.setAttribute("data-ready", d.card);
  resized();
}

// ---------- start ----------
(function () { var s = sheet("", null); s.appendChild(h("div", { class: "c-desk" }, h("div", { class: "c-skel" }), h("div", { class: "c-skel" }))); root.appendChild(s); })();
if (typeof ResizeObserver === "function") new ResizeObserver(resized).observe(document.body);
if (oa) {
  theme(oa.theme);
  // Inline, in the conversation, is where a card belongs. ChatGPT starts there; this asks for it back if it isn't.
  if (oa.displayMode && oa.displayMode !== "inline" && typeof oa.requestDisplayMode === "function") {
    try { oa.requestDisplayMode({ mode: "inline" }); } catch (e) { /* the host keeps its mode */ }
  }
  var ready = function () { var r = { _meta: oa.toolResponseMetadata, structuredContent: oa.toolOutput }; if (cardOf(r)) show(r); };
  window.addEventListener("openai:set_globals", function (e) { var g = e.detail && e.detail.globals; if (g && g.theme) theme(g.theme); ready(); });
  ready();
} else {
  request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "clyde-" + KIND, version: "1" }, appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] } }).then(function (r) {
    if (r && r.hostCapabilities && r.hostCapabilities.serverTools === false) noIpc = true;
    context(r && r.hostContext);
    notify("ui/notifications/initialized", {});
    // The card shows inline and open in the conversation (R78). The host answers with the mode it set, and may keep its own.
    request("ui/request-display-mode", { mode: "inline" }).catch(function () {});
    resized();
  }, function () { notify("ui/notifications/initialized", {}); });
}
window.__clyde = { show: show, theme: theme };
})();`;

export const CARD_JS = RAW_CARD_JS.replace(/^\s*\/\/.*$/gm, "").replace(/\n\s*/g, "\n").trim();
