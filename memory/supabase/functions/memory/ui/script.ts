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
var mcpHost = false;
var mcpResult = false;
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
function richText(str) {
  var s = String(str == null ? "" : str);
  if (s.indexOf("\x60") === -1) return document.createTextNode(s);
  var frag = document.createDocumentFragment();
  var re = /\x60([^\x60\n]+)\x60/g, last = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
    frag.appendChild(h("code", { class: "c-code", text: m[1] }));
    last = re.lastIndex;
  }
  if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
  return frag;
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
    setTimeout(function () { if (waiting[id]) { delete waiting[id]; fail(new Error("The chat app didn't answer. Try again, or ask your agent in chat.")); } }, 30000);
  });
}
function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); }
function callTool(name, args) {
  if (mcpHost && !noIpc) return request("tools/call", { name: name, arguments: args });
  if (oa && typeof oa.callTool === "function") return Promise.resolve(oa.callTool(name, args));
  if (noIpc) return Promise.reject(new Error("IPC not available for MCP tool call"));
  return request("tools/call", { name: name, arguments: args });
}
function openLink(url) {
  url = safeUrl(url); if (!url) return;
  if (!mcpHost && oa && typeof oa.openExternal === "function") oa.openExternal({ href: url });
  else request("ui/open-link", { url: url }).catch(function () {
    if (oa && typeof oa.openExternal === "function") oa.openExternal({ href: url });
    else window.open(url, "_blank", "noopener");
  });
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
  if (oa && typeof oa.notifyIntrinsicHeight === "function") oa.notifyIntrinsicHeight(height);
  if (window.parent && window.parent !== window) notify("ui/notifications/size-changed", { width: Math.ceil(r.width), height: height });
}
window.addEventListener("message", function (ev) {
  if (ev.source !== window.parent) return;
  var m = ev.data;
  if (!m || m.jsonrpc !== "2.0") return;
  if (m.id !== undefined && !m.method) {
    var w = waiting[m.id]; if (!w) return; delete waiting[m.id];
    if (m.error) w.fail(new Error(m.error.message || "The chat app refused that action. Try again, or ask your agent in chat.")); else w.ok(m.result);
    return;
  }
  if (m.method === "ui/notifications/tool-result") {
    var res = m.params;
    if (!cardOf(res) && oa && (oa.toolResponseMetadata || oa.toolOutput)) {
      res = { content: res && res.content, structuredContent: (res && res.structuredContent) || oa.toolOutput, _meta: oa.toolResponseMetadata };
    }
    if (cardOf(res)) { mcpResult = true; show(res); }
    else if (!st.data) show(res);
  }
  else if (m.method === "ui/notifications/host-context-changed") context(m.params);
  else if (m.method === "ui/notifications/tool-cancelled") failed("The call was cancelled.", "Cancelled");
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
function toggleBtn(onFlip, multi) {
  var exp = multi ? "Expand all" : "Expand", col = multi ? "Collapse all" : "Collapse";
  var label = h("span", { class: "cl-sr-only", text: exp });
  var btn = h("button", { class: GH + "c-toggle", type: "button", "aria-expanded": "false", "aria-label": exp, title: exp, onclick: function () { onFlip(btn.getAttribute("aria-expanded") !== "true"); } }, label, icon("more"));
  btn.sync = function (open) {
    var text = open ? col : exp;
    btn.setAttribute("aria-expanded", String(!!open));
    btn.setAttribute("aria-label", text);
    btn.title = text;
    label.textContent = text;
  };
  return btn;
}
function foldBtn(onclick) {
  return h("button", { class: GH + "c-fold", type: "button", "aria-label": "Collapse", title: "Collapse", onclick: onclick },
    h("span", { class: "cl-sr-only", text: "Collapse" }), icon("more"));
}
var LOGO = document.getElementById("clyde-logo");
function logo() { var w = h("span", { class: "cl-wordmark" }); if (LOGO) w.appendChild(LOGO.content.cloneNode(true)); return w; }
function sheet(mid, right) {
  var head = h("div", { class: "c-head" }, logo(), typeof mid === "string" ? h("span", { class: "c-what" }, h("span", { class: "c-what__txt", text: mid })) : mid);
  if (right) add(head, right);
  return h("div", { class: "clyde" }, head);
}
function desk() { return h("div", { class: "c-desk" }); }
function realLinks(links) {
  if (!Array.isArray(links)) return [];
  return links.filter(function (l) {
    return !(l && l.type === "part_of" && /^Notes by /i.test(String(l.title || "")));
  });
}
function cleanProv(m) {
  return m && m.provenance
    ? String(m.provenance).replace(/(?:^|\s+)on\s+oauth:\S+/gi, "").replace(/\s*\(you wrote this\)/gi, "").trim()
    : "";
}
var KIND_CHIP = { fact: "cl-chip--ok", wen: "cl-chip--carbon", plan: "cl-chip--warn" };
function notableMark(m) {
  if (m.superseded_by) return h("span", { class: "cl-state cl-state--superseded", text: "superseded" });
  if (m.private) return h("span", { class: "cl-chip", text: "private" });
  if (m.trial) return h("span", { class: "cl-state cl-state--trial", text: "on trial" + (m.chance ? " · " + m.chance + " of 3" : "") });
  if (Number(m.confidence || 0) < 0.15) return h("span", { class: "cl-state cl-state--dormant", text: "dormant" });
  if (m.kind === "wen" || m.kind === "fact" || m.kind === "plan") {
    return h("span", { class: "cl-chip " + (KIND_CHIP[m.kind] || ""), text: m.kind });
  }
  return null;
}
function sumMark(m) {
  if (m.superseded_by) return h("span", { class: "cl-state cl-state--superseded", text: "superseded" });
  if (m.private) return h("span", { class: "cl-chip", text: "private" });
  if (m.trial) return h("span", { class: "cl-state cl-state--trial", text: "on trial" + (m.chance ? " · " + m.chance + " of 3" : "") });
  if (Number(m.confidence || 0) < 0.15) return h("span", { class: "cl-state cl-state--dormant", text: "dormant" });
  return null;
}
function entryState(m) {
  var out = [];
  if (m.superseded_by) out.push(h("span", { class: "cl-state cl-state--superseded", text: "superseded" }));
  else if (m.trial) out.push(h("span", { class: "cl-state cl-state--trial", text: "on trial" + (m.chance ? " · " + m.chance + " of 3" : "") }));
  else if (Number(m.confidence || 0) < 0.15) out.push(h("span", { class: "cl-state cl-state--dormant", text: "dormant" }));
  if (m.private) out.push(h("span", { class: "cl-chip", text: "private" }));
  return out.length ? h("div", { class: "c-row" }, out) : null;
}
function linksList(links) {
  var list = realLinks(links);
  if (!list.length) return null;
  return h("ul", { class: "c-links" }, list.map(function (l) {
    return h("li", null, icon("link"),
      h("span", { class: "cl-muted cl-mono", text: (l.dir === "to" ? "" : "from ") + l.type }),
      h("span", null, richText(l.title)));
  }));
}
function artChips(list, openable) {
  if (!list || !list.length) return null;
  return h("div", { class: "c-row" }, list.map(function (a) {
    var label = h("span", { text: a.name + " · " + a.kind + " · " + size(a.size) });
    var ic = icon(a.kind === "image" ? "image" : "file");
    if (openable && a.sha256) return h("button", { class: "c-art", type: "button", "aria-expanded": "false", title: "Preview " + a.name, onclick: function () { preview(this, a); } }, ic, label);
    return h("span", { class: "c-art" }, ic, label);
  }));
}
function entryFoot(m) {
  var parts = [];
  var k = m.kind && m.kind !== "observation" ? String(m.kind) : "";
  if (m.verified === false) k = k ? k + " · unverified" : "unverified";
  if (k) parts.push(k);
  if (m.confidence !== null && m.confidence !== undefined) parts.push(Math.round(Number(m.confidence) * 100) + "%");
  var prov = cleanProv(m);
  if (prov) parts.push(prov);
  if (m.valid_from) parts.push(m.valid_from);
  return parts.length ? h("div", { class: "c-meta-foot", text: parts.join(" · ") }) : null;
}
function recallFoot(m) {
  var parts = [cleanProv(m), m.valid_from].filter(Boolean);
  return parts.length ? h("div", { class: "c-meta-foot", text: parts.join(" · ") }) : null;
}
function say(el, text, tone) {
  el.textContent = text; el.className = "c-say " + (tone === "muted" ? "is-muted" : tone ? "is-ok" : "is-bad"); el.hidden = false; resized();
}
function openClydeBtn(id) {
  if (!id) return null;
  return h("button", { class: GH + "c-ext", type: "button", "aria-label": "Open in Clyde", title: "Open in Clyde", onclick: function () {
    openLink("https:" + "//heyclyde.me/entries/" + encodeURIComponent(id));
  } }, "Open", icon("open"));
}

// ---------- open: get_entry and get_blob inside a card ----------
function entryDetail(e, openable) {
  var parts = [], ln = linksList(e.links);
  if (ln) parts.push(ln);
  if (openable !== false && e.artifacts && e.artifacts.length) parts.push(artChips(e.artifacts, true));
  if (e.id) parts.push(h("div", { class: "c-row" }, openClydeBtn(e.id)));
  return parts;
}
function syncOpenBtn(btn, m, isOpen) {
  var lbl = isOpen ? "Hide details" : "Details";
  btn.textContent = lbl;
  btn.setAttribute("aria-expanded", String(!!isOpen));
  btn.setAttribute("aria-label", lbl + " for " + (m.title || "note"));
}
function openLocal(btn, m, holder, card) {
  holder.hidden = false; syncOpenBtn(btn, m, true);
  var body = card.querySelector(".cl-memory__body"); if (body) body.className = "cl-memory__body is-open";
  add(holder, entryDetail(m, false));
  resized();
}
function openEntry(btn, m, holder, card) {
  if (holder.firstChild) {
    holder.hidden = !holder.hidden;
    syncOpenBtn(btn, m, !holder.hidden);
    var body = card.querySelector(".cl-memory__body");
    if (body) body.className = "cl-memory__body" + (holder.hidden ? "" : " is-open");
    resized();
    return;
  }
  if (noIpc) { openLocal(btn, m, holder, card); return; }
  btn.disabled = true; btn.setAttribute("aria-busy", "true");
  callTool("get_entry", { id: m.id }).then(function (r) {
    btn.disabled = false; btn.removeAttribute("aria-busy"); var d = cardOf(r);
    holder.hidden = false; syncOpenBtn(btn, m, true);
    if (d && d.entry) {
      var body = card.querySelector(".cl-memory__body");
      if (body) { body.textContent = ""; add(body, richText(d.entry.body)); body.className = "cl-memory__body is-open"; }
      add(holder, entryDetail(d.entry, true));
    } else add(holder, h("p", { class: "c-text", text: textOf(r) }));
    resized();
  }, function (e) {
    btn.disabled = false; btn.removeAttribute("aria-busy");
    if (isNoIpc(e)) { noIpc = true; openLocal(btn, m, holder, card); return; }
    holder.hidden = false; add(holder, h("p", { class: "c-say is-bad", role: "alert", text: (e && e.message) || "Couldn't open note. Try again, or ask your agent in chat." })); resized();
  });
}
function preview(btn, a) {
  var host = btn.closest(".c-full") || btn.closest(".cl-memory") || btn.closest(".clyde");
  var box = host.querySelector(".c-preview[data-sha='" + a.sha256 + "']");
  if (box) { box.hidden = !box.hidden; btn.setAttribute("aria-expanded", String(!box.hidden)); resized(); return; }
  box = h("div", { class: "c-preview", "data-sha": a.sha256 }, h("div", { class: "c-skel" }));
  btn.setAttribute("aria-expanded", "true"); btn.setAttribute("aria-busy", "true");
  host.appendChild(box); resized();
  callTool("get_blob", { sha256: a.sha256 }).then(function (r) {
    btn.removeAttribute("aria-busy");
    box.textContent = ""; var d = cardOf(r);
    add(box, d && d.artifact ? artifactView(d.artifact, true, null, true).el : h("p", { class: "c-text", text: textOf(r) })); resized();
  }, function (e) {
    btn.removeAttribute("aria-busy");
    box.textContent = "";
    if (isNoIpc(e)) { noIpc = true; add(box, h("p", { class: "c-say is-muted", role: "status", "aria-live": "polite", text: "Actions can't send from this card right now, so ask your agent in chat." })); resized(); return; }
    add(box, h("p", { class: "c-say is-bad", role: "alert", text: (e && e.message) || "Couldn't load preview. Try again, or ask your agent in chat." })); resized();
  });
}
function artifactView(a, startOpen, onFlip, embedded, onOpenFocus) {
  var url = safeUrl(a.url), img = url && /^image\//.test(a.media_type || ""), open = !!startOpen;
  var file = h("div", { class: "cl-file" + (open ? "" : " is-compact") });
  var info = [a.size ? size(a.size) : a.total ? a.total + (a.total === 1 ? " character" : " characters") : "", a.media_type].filter(Boolean).join(" · ");
  var dl = url && !img ? h("button", { class: GH + "c-ext", type: "button", "aria-label": "Download " + (a.name || "file"), title: "Download link expires in 10 minutes", onclick: function () { openLink(url); } }, "Download", icon("open")) : null;
  var hasBody = !!(img || (a.text !== null && a.text !== undefined)), bodyWrap = h("div", { hidden: !open });
  var sum = !embedded && hasBody ? h("button", {
    class: "c-sum", type: "button", hidden: open, "aria-expanded": String(open),
    onclick: function () { setOpen(true); if (onOpenFocus) onOpenFocus(); }
  }, icon(img ? "image" : "file"), h("span", { class: "c-sum__title", text: a.name }),
     info ? h("span", { class: "cl-muted cl-mono", text: info }) : null, icon("more")) : null;
  if (embedded) {
    file.appendChild(h("div", { class: "cl-file__head" },
      h("span", { class: "c-row" }, icon(img ? "image" : "file"), h("span", { text: a.name })),
      h("span", { class: "c-row" }, info ? h("span", { text: info }) : null, dl)));
  } else if (sum) {
    file.appendChild(sum);
  } else if (dl) {
    file.appendChild(h("p", { class: "c-say is-muted is-bin-note", text: "No inline preview for this file type. The download link expires in 10 minutes." }));
  }
  if (img) bodyWrap.appendChild(h("div", null, h("img", { class: "c-img", src: url, alt: a.name, loading: "lazy", onload: resized })));
  if (a.text !== null && a.text !== undefined) {
    var pre = h("pre", { text: a.text }); bodyWrap.appendChild(pre);
    if (a.next) {
      var note = h("span", { class: "cl-muted", text: "Showing " + a.to + " of " + a.total + " characters" });
      var more = h("button", { class: GH.trim(), type: "button", onclick: function () {
        more.disabled = true; more.setAttribute("aria-busy", "true");
        callTool("get_blob", { sha256: a.sha256, offset: a.next }).then(function (r) {
          more.removeAttribute("aria-busy");
          var d = cardOf(r);
          if (d && d.artifact) { pre.textContent += d.artifact.text; a.next = d.artifact.next; a.to = d.artifact.to; } else pre.textContent += "\n" + textOf(r);
          more.disabled = false; note.textContent = "Showing " + a.to + " of " + a.total + " characters"; if (!a.next) more.remove(); resized();
        }, function (e) {
          more.removeAttribute("aria-busy");
          if (isNoIpc(e)) { noIpc = true; note.textContent = "Actions can't send from this card right now, so ask your agent in chat."; }
          else { more.disabled = false; note.textContent = (e && e.message) || "Couldn't load more. Try again."; }
          resized();
        });
      } }, icon("more"), "Load more");
      bodyWrap.appendChild(h("div", { class: "cl-file__foot" }, note, more));
    }
  }
  if (hasBody) file.appendChild(bodyWrap);
  function setOpen(v) {
    if (!hasBody) return;
    open = !!v; file.className = "cl-file" + (open ? "" : " is-compact"); bodyWrap.hidden = !open;
    if (sum) { sum.hidden = open; sum.setAttribute("aria-expanded", String(open)); }
    if (onFlip) onFlip(); resized();
  }
  return { el: file, hasBody: hasBody, isOpen: function () { return open; }, setOpen: setOpen, info: info, dl: dl };
}

// ---------- compact items & list cap ----------
function memoryItem(m, opts) {
  opts = opts || {};
  var open = false, fold = opts.fold ? foldBtn(function () { setOpen(false, true); }) : null;
  var card = h("article", { class: "cl-memory is-compact" + (m.superseded_by ? " is-superseded" : ""), "data-id": m.id });
  var mark = opts.saved ? h("span", { class: "c-saved", text: "Saved" }) : sumMark(m);
  var sum = h("button", { class: "c-sum", type: "button", "aria-expanded": "false", onclick: function () { setOpen(true, true); } },
    mark, opts.saved ? h("span", { class: "c-sep", text: "·" }) : null,
    h("span", { class: "c-sum__title" }, richText(m.title)),
    opts.recall ? h("span", { class: "cl-memory__conf", text: Math.round(Number(m.confidence || 0) * 100) + "%" }) : null,
    icon("more"));
  var full = h("div", { class: "c-full", hidden: true });
  if (opts.recall) {
    var holder = h("div", { class: "c-detail", hidden: true });
    var openBtn = h("button", { class: GH + "c-open", type: "button", "aria-expanded": "false", "aria-label": "Details for " + (m.title || "note"), onclick: function () { openEntry(openBtn, m, holder, card); } }, "Details");
    var acts = h("span", { class: "c-mem-actions" },
      notableMark(m),
      h("span", { class: "cl-memory__conf", text: Math.round(Number(m.confidence || 0) * 100) + "%" }),
      openBtn, fold);
    full.appendChild(h("div", { class: "cl-memory__top" }, h("h3", { class: "cl-memory__title" }, richText(m.title)), acts));
    if (m.body) full.appendChild(h("p", { class: "cl-memory__body" }, richText(m.body)));
    if (m.quote) full.appendChild(h("p", { class: "c-quote" }, "Wen: “", richText(m.quote), "”"));
    if (m.artifacts && m.artifacts.length) full.appendChild(artChips(m.artifacts, false));
    var rf = recallFoot(m); if (rf) full.appendChild(rf);
    full.appendChild(holder);
  } else if (opts.saved) {
    full.appendChild(h("h3", { class: "cl-memory__title" }, richText(m.title)));
    if (m.body) {
      var bText = String(m.body);
      var bodyEl = h("p", { class: "cl-memory__body c-clamp4" }, richText(bText));
      full.appendChild(bodyEl);
      var isExp = false;
      var bMore = h("button", { class: "c-body-more", type: "button", hidden: true, "aria-expanded": "false", onclick: function () {
        isExp = bodyEl.classList.toggle("is-open");
        bMore.setAttribute("aria-expanded", String(isExp));
        bMore.textContent = isExp ? "Less" : "More";
        bMore.hidden = false;
        resized();
      } }, "More");
      var syncMore = function () {
        if (isExp || !bodyEl.isConnected) return;
        var nextHidden = bodyEl.scrollHeight <= bodyEl.clientHeight + 2;
        if (bMore.hidden !== nextHidden) { bMore.hidden = nextHidden; resized(); }
      };
      full.appendChild(bMore);
      if (typeof ResizeObserver === "function") new ResizeObserver(syncMore).observe(bodyEl);
      setTimeout(syncMore, 0);
    }
    var ln = linksList(m.links); if (ln) full.appendChild(ln);
    if (m.artifacts && m.artifacts.length) full.appendChild(artChips(m.artifacts, true));
  } else {
    var es = entryState(m); if (es) full.appendChild(es);
    full.appendChild(h("h3", { class: "cl-memory__title" }, richText(m.title)));
    if (m.body) full.appendChild(h("p", { class: "cl-memory__body is-open" }, richText(m.body)));
    if (m.quote) full.appendChild(h("p", { class: "c-quote" }, "Wen: “", richText(m.quote), "”"));
    if (m.superseded_by) full.appendChild(h("p", { class: "c-text" }, "Superseded by ", h("code", { class: "c-code", text: m.superseded_by }), "."));
    var eln = linksList(m.links); if (eln) full.appendChild(eln);
    if (m.artifacts && m.artifacts.length) full.appendChild(artChips(m.artifacts, true));
    var ef = entryFoot(m); if (ef) full.appendChild(ef);
  }
  card.appendChild(sum); card.appendChild(full);
  function setOpen(v, moveFocus) {
    open = !!v;
    card.className = "cl-memory" + (open ? "" : " is-compact") + (m.superseded_by ? " is-superseded" : "");
    sum.hidden = open; sum.setAttribute("aria-expanded", String(open)); full.hidden = !open;
    if (moveFocus) {
      var target = open ? (fold || (opts.onOpenFocus && opts.onOpenFocus())) : sum;
      if (target) target.focus();
    }
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
    rows.forEach(function (r) { r.setOpen(want); });
    sync(); resized();
  }, true) : null;
  var headTxt = items.length
    ? items.length + (d.page === "more" ? (items.length === 1 ? " more memory" : " more memories") : (items.length === 1 ? " memory" : " memories")) + (d.query ? " for “" + d.query + "”" : "")
    : (d.page === "more" ? "more" : "recall") + (d.query ? " · “" + d.query + "”" : "");
  var s = sheet(headTxt, toggle), dk = desk();
  dk.classList.add("c-recall-scroll");
  if (d.degraded) {
    var deg = String(d.degraded), hasEmbed = /embed/i.test(deg), hasFilter = /filter/i.test(deg), hasFeat = /features/i.test(deg);
    var chips = [hasEmbed && "Keyword-only", hasFilter && "Unfiltered", hasFeat && "Partial ranking"].filter(Boolean);
    var chip = chips.length ? chips.join(" · ") : "Partial ranking";
    var msgTxt = hasEmbed && !hasFilter && !hasFeat ? "Keyword search fallback active."
      : hasFilter && !hasEmbed && !hasFeat ? "Relevance filter failed, so results are unfiltered."
      : [hasEmbed && "Keyword search fallback active", hasFilter && "relevance filter failed, so results are unfiltered", hasFeat && "some ranking signals failed"].filter(Boolean).join("; ") + ".";
    if (!hasEmbed && !hasFilter && !hasFeat) msgTxt = "Some ranking signals failed, so results use partial scoring.";
    dk.appendChild(h("div", { class: "c-banner" }, h("span", { class: "cl-chip cl-chip--warn", text: chip }), h("span", { text: msgTxt })));
  }
  if (!items.length) {
    var emptyTitle = d.page === "more" ? "Nothing more in Clyde matches that." : "Nothing in Clyde matches that yet.";
    var emptyText = d.page === "more"
      ? "You reached the end of matches for this query. Rephrase it, or tell your agent what to save."
      : "Either nobody wrote it down, or it was phrased differently. Ask your agent to search deeper, or tell it what to save.";
    dk.appendChild(h("div", { class: "cl-empty" }, h("p", { class: "cl-empty__title", text: emptyTitle }),
      h("p", { class: "cl-empty__text", text: emptyText })));
    s.appendChild(dk); return s;
  }
  var msg = h("p", { class: "c-say", role: "status", "aria-live": "polite", hidden: true });
  var yes = h("button", { class: PR + "c-used", type: "button", "aria-pressed": "false", onclick: function () { rate("helpful"); } }, "That helped");
  var no = h("button", { class: GH + "c-wrong", type: "button", "aria-pressed": "false", onclick: function () { rate("nothing_useful"); } }, "That didn't");
  var foot = h("div", { class: "c-foot" }, yes, no, msg);
  function refresh() {
    yes.disabled = no.disabled = st.busy || st.sent || noIpc;
    yes.setAttribute("aria-pressed", String(st.vote === "helpful"));
    no.setAttribute("aria-pressed", String(st.vote === "nothing_useful"));
  }
  function sync() {
    if (toggle) toggle.sync(rows.some(function (r) { return !r.el.hidden && r.isOpen(); }));
  }
  function rate(verdict) {
    if (st.busy || st.sent) return;
    st.busy = true; st.vote = verdict; refresh();
    var args = { retrieval_id: d.retrieval_id, verdict: verdict, card_vote: true };
    if (d.card_receipt) args.card_receipt = d.card_receipt;
    callTool("feedback", args).then(function (reply) {
      st.busy = false; var result = textOf(reply);
      st.sent = /^Logged\./.test(result) || /^Already logged/.test(result);
      if (!st.sent) st.vote = null;
      var errTxt = /^No retrieval /i.test(result) ? "This recall session expired, so feedback couldn't be saved here." : result;
      say(msg, /^Logged\./.test(result) ? "Feedback recorded." : (errTxt || (st.sent ? "Feedback recorded." : "Couldn't save feedback. Try again.")), st.sent); refresh();
    }, function (error) {
      st.busy = false; st.vote = null;
      if (isNoIpc(error)) { noIpc = true; say(msg, "Feedback can't send from this card right now, so tell your agent in chat.", "muted"); }
      else say(msg, (error && error.message) || "Couldn't save feedback. Try again.", false);
      refresh();
    });
  }
  items.forEach(function (m) {
    var item = memoryItem(m, { recall: true, fold: true, onFlip: sync });
    rows.push(item); dk.appendChild(item.el);
  });
  cap = capList(dk, rows, sync);
  rows.forEach(function (r) { r.setOpen(true); });
  s.appendChild(dk); s.appendChild(foot);
  refresh(); sync();
  return s;
}
function entryCard(d, saved) {
  var m = d.entry || {};
  var item = null, toggle = toggleBtn(function (want) { if (item) item.setOpen(want); });
  var mid;
  if (saved) {
    var tag = m.project_slug || (m.category && m.category !== "general" ? m.category : null);
    mid = h("span", { class: "c-what" }, h("span", { class: "c-saved", text: "Saved" }),
      tag ? h("span", { class: "cl-chip c-head-chip", text: tag }) : null);
  } else {
    mid = [m.project_slug, m.category && m.category !== "general" ? m.category : m.pattern].filter(Boolean).join(" · ") || "entry";
  }
  var s = sheet(mid, [m.id ? openClydeBtn(m.id) : null, toggle]), dk = desk();
  item = memoryItem(m, { saved: saved, fold: false, onOpenFocus: function () { return toggle; }, onFlip: function () { toggle.sync(item.isOpen()); } });
  item.setOpen(true);
  dk.appendChild(item.el); s.appendChild(dk);
  return s;
}
function artifactCard(d) {
  var a = d.artifact || {}, view = null;
  var toggle = toggleBtn(function (want) { if (view) view.setOpen(want); });
  view = artifactView(a, false, function () { toggle.sync(view.isOpen()); }, false, function () { toggle.focus(); });
  var mid = [a.name, view.info].filter(Boolean).join(" · ");
  var s = sheet(mid, [view.dl, view.hasBody ? toggle : null]), dk = desk();
  view.setOpen(true);
  dk.appendChild(view.el); s.appendChild(dk);
  return s;
}
var QSTATE = { open: "c-qstate--open", claimed: "c-qstate--claimed", done: "c-qstate--done", abandoned: "c-qstate--abandoned" };
function questCard(q, d, startOpen, onFlip) {
  var open = !!startOpen, me = d.badge && d.badge.registered ? d.badge.name : null;
  var msg = h("p", { class: "c-say", role: "status", "aria-live": "polite", hidden: true });
  var fold = foldBtn(function () { setOpen(false, true); });
  var who = [h("span", null, "posted by ", h("b", { text: q.posted_by }))];
  if (q.assignee && q.assignee !== "any") who.push(h("span", null, " · for ", h("b", { text: q.assignee })));
  if (q.state === "claimed" && q.claimed_by) who.push(h("span", null, " · claimed by ", h("b", { text: q.claimed_by }), q.lease_until ? " until " + when(q.lease_until) : ""));
  if (q.state === "done") who.push(h("span", null, " · done by ", h("b", { text: q.claimed_by || "" }), q.closed_at ? " " + when(q.closed_at) : ""));
  var actRow = h("span", { class: "c-qact" }, h("span", { class: "c-qstate " + (QSTATE[q.state] || ""), text: q.state }));
  var main = h("div", { class: "cl-quest__main", hidden: !open },
    h("div", { class: "cl-quest__head" },
      h("span", { class: "c-qno", text: "#" + q.id }),
      ["urgent", "high"].includes(q.priority) ? h("span", { class: "cl-chip cl-chip--bad", text: q.priority }) : null,
      h("h3", { class: "cl-quest__title" }, richText(q.title)),
      actRow),
    h("p", { class: "cl-quest__brief" }, richText(q.brief)),
    h("div", { class: "cl-quest__done" }, h("span", { class: "cl-label", text: "Done when:" }), h("span", null, richText(q.done_when))),
    q.evidence ? h("p", { class: "c-quote" }, richText(q.evidence)) : null,
    q.tags && q.tags.length ? h("div", { class: "c-row" }, q.tags.map(function (t) { return h("span", { class: "cl-chip", text: t }); })) : null,
    h("div", { class: "cl-quest__for" }, who, q.context ? " · " + q.context : ""),
    msg);
  var sum = h("button", { class: "c-qsum", type: "button", hidden: open, "aria-expanded": String(open), onclick: function () { setOpen(true, true); } },
    h("span", { class: "c-qno", text: "#" + q.id }),
    ["urgent", "high"].includes(q.priority) ? h("span", { class: "cl-chip cl-chip--bad", text: q.priority }) : null,
    h("span", { class: "c-sum__title" }, richText(q.title)),
    h("span", { class: "c-qstate " + (QSTATE[q.state] || ""), text: q.state }), icon("more"));
  var card = h("article", { class: "cl-quest" + (open ? "" : " is-compact") + (q.state === "done" ? " is-done" : ""), "data-quest": q.id }, sum, main);
  function setOpen(v, moveFocus) {
    open = !!v; card.className = "cl-quest" + (open ? "" : " is-compact") + (q.state === "done" ? " is-done" : "");
    sum.hidden = open; sum.setAttribute("aria-expanded", String(open)); main.hidden = !open;
    if (moveFocus) (open ? fold : sum).focus();
    if (onFlip) onFlip(); resized();
  }
  var item = { el: card, isOpen: function () { return open; }, setOpen: setOpen };
  function act(name, args, btn) {
    btn.disabled = true; btn.setAttribute("aria-busy", "true");
    callTool(name, args).then(function (r) {
      var t = textOf(r), dd = cardOf(r), fresh = dd && dd.quests && dd.quests.filter(function (x) { return x.id === q.id; })[0];
      if ((r && r.isError) || !fresh) { btn.disabled = false; btn.removeAttribute("aria-busy"); say(msg, (r && r.isError ? t.split("\n").slice(0, 2).join(" ") : t.split("\n")[0]) || "Couldn't update quest. Try again.", false); return; }
      var next = questCard(fresh, d, true, onFlip); card.replaceWith(next.el); item.el = next.el; item.isOpen = next.isOpen; item.setOpen = next.setOpen;
      var badge = next.el.querySelector(".cl-quest__main .c-qstate"); if (badge) badge.className += " is-new";
      say(next.el.querySelector(".c-say"), t.split("\n")[0] || "Updated.", true);
      var focusEl = next.el.querySelector(".c-complete-btn, .c-claim, .c-fold");
      if (focusEl) focusEl.focus();
      resized();
    }, function (e) {
      btn.disabled = false; btn.removeAttribute("aria-busy");
      if (isNoIpc(e)) { noIpc = true; btn.disabled = true; say(msg, "Actions can't send from this card right now, so ask your agent in chat.", "muted"); return; }
      say(msg, (e && e.message) || "Action failed.", false);
    });
  }
  if (q.state === "open") {
    var claim = h("button", { class: PR + "c-claim", type: "button", onclick: function () { act("claim_quest", { id: q.id }, claim); } }, icon("bolt"), "Claim");
    actRow.appendChild(claim);
  }
  if (q.state === "claimed" && me && q.claimed_by === me) {
    var evId = "c-ev-" + q.id, enId = "c-en-" + q.id;
    var ev = h("textarea", { id: evId, class: "cl-textarea", name: "evidence", maxlength: "2000", required: true, placeholder: "How you know done-when holds" });
    var en = h("input", { id: enId, class: "cl-input", name: "entry", required: true, placeholder: "Entry id from remember for this work", autocomplete: "off" });
    var go = h("button", { class: PR.trim(), type: "submit" }, icon("check"), "Complete quest");
    var form = h("form", { class: "c-complete", novalidate: true, hidden: true }, h("div", { class: "cl-field" }, h("label", { for: evId, text: "Evidence" }), ev),
      h("div", { class: "cl-field" }, h("label", { for: enId, text: "Entry id" }), en), h("div", { class: "c-row" }, go));
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var evVal = ev.value.trim(), enVal = en.value.trim();
      if (!evVal) { say(msg, "Add evidence showing done-when holds.", false); ev.focus(); return; }
      if (!enVal) { say(msg, "Add the entry id for this work.", false); en.focus(); return; }
      act("complete_quest", { id: q.id, evidence: evVal, entry_id: enVal }, go);
    });
    var toggleForm = h("button", { class: SM + "c-complete-btn", type: "button", "aria-expanded": "false", onclick: function () { form.hidden = !form.hidden; toggleForm.setAttribute("aria-expanded", String(!form.hidden)); if (!form.hidden) ev.focus(); resized(); } }, icon("check"), "Complete");
    actRow.appendChild(toggleForm);
    main.insertBefore(form, msg);
  }
  actRow.appendChild(fold);
  return item;
}
function questsCard(d) {
  var qs = d.quests || [], rows = [], cap = null;
  function sync() { if (toggle) toggle.sync(rows.some(function (r) { return !r.el.hidden && r.isOpen(); })); }
  var toggle = qs.length ? toggleBtn(function (want) {
    rows.forEach(function (r) { r.setOpen(want); });
    sync(); resized();
  }, true) : null;
  var s = sheet("quest board" + (qs.length ? " · " + qs.length : ""), toggle), dk = desk();
  if (!qs.length) {
    var qEmptyTitle = !d.show || d.show === "open" ? "Quest board's empty."
      : d.show === "done" ? "No completed quests yet."
      : d.show === "mine" ? "No quests for this agent yet."
      : "No quests match.";
    var qEmptyText = !d.show || d.show === "open"
      ? "Nobody has pinned a quest yet. Ask your agent to post one with a done-when line anyone can check."
      : "No quests match that filter. Ask your agent to check open quests or post a new one.";
    dk.appendChild(h("div", { class: "cl-empty" }, h("p", { class: "cl-empty__title", text: qEmptyTitle }),
      h("p", { class: "cl-empty__text", text: qEmptyText })));
  }
  qs.forEach(function (q) { var item = questCard(q, d, true, sync); rows.push(item); dk.appendChild(item.el); });
  cap = capList(dk, rows, sync);
  sync();
  s.appendChild(dk);
  return s;
}
function agentCard(d) {
  var a = d.agent || {};
  var desc = a.description ? h("p", { class: "c-text c-agent-desc" }, richText(a.description)) : null;
  var body = h("div", { class: "c-agent-body" },
    agentBadge({ name: a.name, context: a.context, surface: a.surface, registered: true }, false),
    desc);
  var sum = h("button", {
    class: "c-sum c-agent-sum", type: "button", hidden: true, "aria-expanded": "false",
    onclick: function () { body.hidden = false; sum.hidden = true; sum.setAttribute("aria-expanded", "true"); toggle.sync(true); toggle.focus(); resized(); }
  }, h("span", { class: "c-sum__title", text: a.name || "" }),
     a.context || a.surface ? h("span", { class: "cl-muted cl-mono", text: [a.context, a.surface].filter(Boolean).join(" · ") }) : null,
     icon("more"));
  var toggle = toggleBtn(function (want) {
    body.hidden = !want;
    sum.hidden = want;
    sum.setAttribute("aria-expanded", String(!!want));
    toggle.sync(want);
    resized();
  });
  toggle.sync(true);
  var mid = h("span", { class: "c-what" },
    h("span", { class: "c-saved", text: "Registered" }),
    a.since ? h("span", { class: "cl-muted c-what__txt", text: "since " + a.since }) : null);
  var s = sheet(mid, toggle), dk = desk();
  dk.appendChild(sum);
  dk.appendChild(body);
  s.appendChild(dk);
  return s;
}
function errorCard(d) {
  var s = sheet("", null);
  var lbl = d.label || (/^Error:/i.test(String(d.error || "")) ? "Error" : "Refused");
  s.appendChild(h("div", { class: "c-err-row", role: "alert" },
    h("span", { class: "cl-chip cl-chip--bad", text: lbl }),
    h("p", { class: "c-text" }, richText(d.error))));
  return s;
}
function failed(text, label) { root.textContent = ""; root.appendChild(errorCard({ error: text, label: label })); resized(); }
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
  var ready = function () {
    if (mcpResult || st.data) return;
    var r = { _meta: oa.toolResponseMetadata, structuredContent: oa.toolOutput };
    if (cardOf(r)) show(r);
  };
  window.addEventListener("openai:set_globals", function (e) { var g = e.detail && e.detail.globals; if (g && g.theme) theme(g.theme); ready(); });
  ready();
}
// ChatGPT mounts MCP Apps frames with both window.openai and a postMessage bridge; always run the MCP Apps handshake so the
// host receives ui/initialize + ui/notifications/initialized instead of timing out waiting for the frame.
if (window.parent && window.parent !== window) {
  request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "clyde-" + KIND, version: "1" }, appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] } }).then(function (r) {
    mcpHost = true;
    if (r && r.hostCapabilities && r.hostCapabilities.serverTools === false) noIpc = true;
    context(r && r.hostContext);
    notify("ui/notifications/initialized", {});
    // The card shows inline and open in the conversation (R78). The host answers with the mode it set, and may keep its own.
    request("ui/request-display-mode", { mode: "inline" }).catch(function () {});
    lastH = 0;
    resized();
  }, function () { notify("ui/notifications/initialized", {}); });
}
window.__clyde = { show: show, theme: theme };
})();`;

export const CARD_JS = RAW_CARD_JS.replace(/^\s*\/\/.*$/gm, "").replace(/\n\s*/g, "\n").trim();