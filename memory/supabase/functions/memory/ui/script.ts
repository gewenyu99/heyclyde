// R67: the script every card runs. It talks to the chat app over the MCP Apps postMessage protocol (JSON-RPC 2.0 with the
// host window), or over ChatGPT's window.openai when that is there, then draws the card from the tool result's card data.
// Every string from memory goes into the page through textContent or an attribute set by the DOM, never as HTML, so a note
// that holds markup shows as text. Plain ES5-ish JS with no template literals, so it can sit in a TS string untouched.
export const CARD_JS = String.raw`(function () {
"use strict";
var KIND = document.documentElement.getAttribute("data-card");
var root = document.getElementById("root");
var NS = "http://www.w3.org/2000/svg";
var KEY = "clyde/card";
var oa = window.openai || null;
var st = { data: null, verdicts: {}, sent: false, busy: false };

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
  from: "M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 9.8 8 14 8 14zM8 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
  flag: "M3.5 14V2.5M3.5 3h8l-1.5 3 1.5 3h-8", link: "M6.5 9.5l3-3M5 7.5L3.8 8.7a2.3 2.3 0 0 0 3.3 3.3L8.3 10.8M11 8.5l1.2-1.2a2.3 2.3 0 0 0-3.3-3.3L7.7 5.2",
  more: "M4 6.5l4 4 4-4", bolt: "M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z"
};
function icon(name) {
  var s = document.createElementNS(NS, "svg"), p = document.createElementNS(NS, "path");
  s.setAttribute("viewBox", "0 0 16 16"); s.setAttribute("class", "i"); s.setAttribute("aria-hidden", "true");
  p.setAttribute("d", PATHS[name] || PATHS.file); s.appendChild(p); return s;
}
function size(b) { b = Number(b) || 0; return b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : (b / 1048576).toFixed(1) + " MB"; }
function when(iso) { if (!iso) return ""; var d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function safeUrl(u) { try { var x = new URL(String(u)); return x.protocol === "https:" ? x.href : null; } catch (e) { return null; } }

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
// The card data rides in the result's _meta, which the model never reads. ChatGPT hands the widget _meta as
// toolResponseMetadata, and a host that drops _meta still passes structuredContent, so that is read as well.
function cardOf(result) {
  if (!result) return null;
  var m = result._meta || result.toolResponseMetadata || null;
  if (m && m[KEY]) return m[KEY];
  if (result.structuredContent && result.structuredContent[KEY]) return result.structuredContent[KEY];
  if (result[KEY]) return result[KEY];
  return null;
}
function theme(t) { if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t); }
function context(c) {
  if (!c) return;
  theme(c.theme);
  var vars = c.styles && c.styles.variables;
  if (vars && vars["--font-sans"]) document.documentElement.style.setProperty("--font", vars["--font-sans"]);
}
var lastH = 0;
function resized() {
  var height = Math.ceil(document.documentElement.getBoundingClientRect().height);
  if (height === lastH) return; lastH = height;
  if (oa) { if (typeof oa.notifyIntrinsicHeight === "function") oa.notifyIntrinsicHeight(height); return; }
  notify("ui/notifications/size-changed", { width: Math.ceil(document.documentElement.getBoundingClientRect().width), height: height });
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
function badge(b) {
  if (!b) return null;
  var on = !!b.registered;
  return h("span", { class: "badge" + (on ? " on" : ""), title: on ? (b.name + ", a " + (b.context || "") + " agent on " + (b.surface || "")) : "This app hasn't registered with Clyde yet" },
    h("span", { class: "dot" }), on ? h("b", { text: b.name }) : h("span", { text: "not registered" }),
    on && b.context ? h("span", { text: b.context }) : null);
}
function bar(what, b) {
  return h("div", { class: "bar" }, h("span", { class: "mark", "aria-hidden": "true", text: "c" }), h("span", { class: "brand", text: "Clyde" }),
    h("span", { class: "what", text: what || "" }), badge(b));
}
function meter(v) { var i = h("i"); i.style.width = Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100) + "%"; return h("span", { class: "meter" }, i); }
function kindChip(kind, verified) {
  var k = String(kind || "observation");
  return h("span", { class: "chip " + (k === "fact" || k === "wen" || k === "plan" ? k : ""), text: k + (verified === false ? " · unverified" : "") });
}
function artChips(list, openable) {
  if (!list || !list.length) return null;
  return h("div", { class: "arts" }, list.map(function (a) {
    var label = h("span", { text: a.name + " · " + a.kind + " · " + size(a.size) });
    if (openable && a.sha256) return h("button", { class: "art", type: "button", title: "Preview " + a.name, onclick: function () { preview(this, a); } }, icon(a.kind === "image" ? "image" : "file"), label);
    return h("span", { class: "art" }, icon(a.kind === "image" ? "image" : "file"), label);
  }));
}
function memoryMeta(m) {
  return h("div", { class: "meta" }, kindChip(m.kind, m.verified),
    h("span", { class: "conf", title: "confidence" }, meter(m.confidence), Number(m.confidence || 0).toFixed(2)),
    m.unreviewed ? h("span", { class: "chip warn", text: "unreviewed" }) : null,
    m.trial ? h("span", { class: "chip accent", text: "on trial" + (m.chance ? " · " + m.chance + " of 3" : "") }) : null,
    m.superseded_by ? h("span", { class: "chip bad", text: "replaced by " + m.superseded_by }) : null,
    m.private ? h("span", { class: "chip", text: "private" }) : null);
}
function memoryBody(m, full) {
  return [h("h3", { text: m.title }), m.body ? h("p", { class: full ? "" : "clamp", text: m.body }) : null,
    m.quote ? h("blockquote", { text: "Wen: “" + m.quote + "”" }) : null,
    m.provenance ? h("div", { class: "prov" }, icon("from"), h("span", { text: m.provenance })) : null];
}
function status(el, text, ok) { el.textContent = text; el.className = "status " + (ok ? "ok" : "bad"); el.hidden = false; resized(); }

// ---------- open: get_entry and get_blob inside a card ----------
function entryDetail(e) {
  var parts = [];
  if (e.links && e.links.length) {
    parts.push(h("h4", { text: "Links" }), h("ul", { class: "links" }, e.links.map(function (l) {
      return h("li", null, icon("link"), h("span", { class: "muted", text: (l.dir === "to" ? "" : "from ") + l.type }), h("span", { text: l.title }));
    })));
  }
  if (e.artifacts && e.artifacts.length) parts.push(h("h4", { text: "Artifacts" }), artChips(e.artifacts, true));
  parts.push(h("div", { class: "small muted mono", text: [e.id, e.pattern, e.scope, e.valid_from].filter(Boolean).join(" · ") }));
  return parts;
}
function openEntry(btn, m, holder) {
  if (holder.firstChild) { holder.hidden = !holder.hidden; btn.setAttribute("aria-expanded", String(!holder.hidden)); resized(); return; }
  btn.disabled = true;
  callTool("get_entry", { id: m.id }).then(function (r) {
    btn.disabled = false;
    var d = cardOf(r);
    holder.hidden = false; btn.setAttribute("aria-expanded", "true");
    if (d && d.entry) {
      var body = holder.parentNode.querySelector("p.clamp"); if (body) { body.textContent = d.entry.body; body.className = ""; }
      add(holder, entryDetail(d.entry));
    } else add(holder, h("pre", { text: textOf(r) }));
    resized();
  }, function (e) { btn.disabled = false; add(holder, h("div", { class: "status bad", text: e.message })); holder.hidden = false; resized(); });
}
function preview(btn, a) {
  var item = btn.closest(".item") || root, box = item.querySelector(".preview[data-sha='" + a.sha256 + "']");
  if (box) { box.hidden = !box.hidden; resized(); return; }
  box = h("div", { class: "preview detail", "data-sha": a.sha256 }, h("div", { class: "skel" }));
  item.appendChild(box); resized();
  callTool("get_blob", { sha256: a.sha256 }).then(function (r) {
    box.textContent = "";
    var d = cardOf(r);
    add(box, d && d.artifact ? artifactView(d.artifact) : h("pre", { text: textOf(r) }));
    resized();
  }, function (e) { box.textContent = ""; add(box, h("div", { class: "status bad", text: e.message })); resized(); });
}
function artifactView(a) {
  var url = safeUrl(a.url), img = url && /^image\//.test(a.media_type || "");
  var head = h("div", { class: "meta" }, icon(img ? "image" : "file"), h("b", { text: a.name, style: null }),
    h("span", { text: [a.media_type, a.size ? size(a.size) : a.total ? a.total + " characters" : ""].filter(Boolean).join(" · ") }));
  var out = [head];
  if (img) out.push(h("div", { class: "preview", style: null }, h("img", { src: url, alt: a.name, loading: "lazy", onload: resized })));
  else if (url) out.push(h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", onclick: function () { openLink(url); } }, icon("open"), "Download")));
  if (a.text !== null && a.text !== undefined) {
    var pre = h("pre", { text: a.text }); out.push(h("div", { style: null }, pre));
    if (a.next) {
      var more = h("button", { class: "btn", type: "button", onclick: function () {
        more.disabled = true;
        callTool("get_blob", { sha256: a.sha256, offset: a.next }).then(function (r) {
          var d = cardOf(r);
          if (d && d.artifact) { pre.textContent += d.artifact.text; a.next = d.artifact.next; } else pre.textContent += "\n" + textOf(r);
          more.disabled = false; if (!a.next) more.remove(); resized();
        }, function () { more.disabled = false; });
      } }, icon("more"), "Load more");
      out.push(h("div", { class: "actions" }, more, h("span", { class: "small muted", text: "Showing " + a.to + " of " + a.total + " characters" })));
    }
  }
  return out;
}

// ---------- cards ----------
function recallCard(d) {
  var items = d.items || [];
  var title = (d.page === "more" ? "More results for " : "Recall: ") + "“" + (d.query || "") + "”";
  var shell = h("div", { class: "clyde" }, bar(title, d.badge));
  if (d.degraded) shell.appendChild(h("div", { class: "item small", style: null }, h("span", { class: "chip warn", text: "degraded" }), " ", d.degraded));
  if (!items.length) {
    shell.appendChild(h("div", { class: "empty" }, h("div", { text: "Nothing in Clyde matches yet." }),
      h("div", { class: "small", text: "Ask for more results, or tell Clyde what to remember." })));
    return shell;
  }
  var count = h("span", { class: "muted" });
  var send = h("button", { class: "btn primary", type: "button", onclick: function () { sendFeedback(false); } }, icon("check"), "Send feedback");
  var none = h("button", { class: "btn ghost", type: "button", onclick: function () { sendFeedback(true); } }, "Nothing helped");
  var msg = h("div", { class: "status", hidden: true });
  function refresh() {
    var n = Object.keys(st.verdicts).length;
    count.textContent = st.sent ? "Feedback sent." : n ? n + " of " + items.length + " marked. The rest count as not used." : "Mark what you used, then send it once.";
    send.disabled = st.sent || st.busy || !n; none.disabled = st.sent || st.busy || n > 0;
  }
  function sendFeedback(nothing) {
    st.busy = true; refresh();
    var args = { retrieval_id: d.retrieval_id };
    if (nothing) args.nothing_useful = true;
    else args.entries = Object.keys(st.verdicts).map(function (id) { return { entry_id: id, verdict: st.verdicts[id] }; });
    callTool("feedback", args).then(function (r) {
      st.busy = false; var t = textOf(r), ok = /^Logged\./.test(t);
      st.sent = ok || /^Already logged/.test(t);
      status(msg, ok ? "Thanks. Clyde will rank these better next time." : t, ok); refresh();
      var bs = shell.querySelectorAll("button.used,button.wrong"); for (var i = 0; i < bs.length; i++) bs[i].disabled = st.sent;
    }, function (e) { st.busy = false; status(msg, e.message, false); refresh(); });
  }
  var list = h("div", { class: "list" });
  items.forEach(function (m) {
    var holder = h("div", { class: "detail", hidden: true });
    var used = h("button", { class: "btn used", type: "button", "aria-pressed": "false" }, icon("check"), "Used");
    var wrong = h("button", { class: "btn wrong", type: "button", "aria-pressed": "false" }, icon("x"), "Wrong");
    function pick(v) {
      if (st.sent) return;
      if (st.verdicts[m.id] === v) delete st.verdicts[m.id]; else st.verdicts[m.id] = v;
      used.setAttribute("aria-pressed", String(st.verdicts[m.id] === "used")); wrong.setAttribute("aria-pressed", String(st.verdicts[m.id] === "wrong"));
      refresh();
    }
    used.addEventListener("click", function () { pick("used"); }); wrong.addEventListener("click", function () { pick("wrong"); });
    var open = h("button", { class: "btn ghost", type: "button", "aria-expanded": "false" }, "Open", icon("open"));
    open.addEventListener("click", function () { openEntry(open, m, holder); });
    list.appendChild(h("article", { class: "item", "data-id": m.id }, memoryMeta(m), memoryBody(m, false), artChips(m.artifacts, false),
      h("div", { class: "actions" }, used, wrong, h("span", { class: "sp" }), open), holder));
  });
  shell.appendChild(list);
  var foot = h("div", { class: "foot" }, count, none, send);
  shell.appendChild(foot);
  msg.style.margin = "0"; msg.style.padding = "0 14px 10px"; shell.appendChild(msg);
  refresh();
  return shell;
}
function entryCard(d, saved) {
  var e = d.entry;
  var shell = h("div", { class: "clyde" }, bar(saved ? "Remembered" : "Memory", d.badge));
  if (saved) shell.appendChild(h("div", { class: "hero" }, h("span", { class: "tick" }, icon("check")),
    h("div", null, h("div", { style: null }, h("b", { text: "Saved to Clyde." })),
      h("div", { class: "small muted", text: "Every agent can recall it now." }))));
  shell.appendChild(h("article", { class: "item" }, memoryMeta(e), memoryBody(e, true), entryDetail(e)));
  return shell;
}
function artifactCard(d) {
  return h("div", { class: "clyde" }, bar("Artifact", d.badge), h("div", { class: "item" }, artifactView(d.artifact)));
}
function questRow(q, d) {
  var me = d.badge && d.badge.registered ? d.badge.name : null;
  var msg = h("div", { class: "status", hidden: true });
  var stateClass = q.state === "done" ? "ok" : q.state === "claimed" ? "accent" : q.state === "abandoned" ? "bad" : "";
  var who = ["posted by " + q.posted_by];
  if (q.assignee && q.assignee !== "any") who.push("for " + q.assignee);
  if (q.claimed_by && q.state === "claimed") who.push("claimed by " + q.claimed_by + (q.lease_until ? " until " + when(q.lease_until) : ""));
  if (q.state === "done") who.push("done by " + q.claimed_by + (q.closed_at ? " on " + when(q.closed_at) : ""));
  var actions = h("div", { class: "actions" }), form = null;
  var row = h("article", { class: "item", "data-quest": q.id },
    h("div", { class: "meta" }, h("span", { class: "prio " + q.priority, text: q.priority }), h("span", { class: "chip " + stateClass, text: q.state }),
      h("span", { class: "mono", text: "#" + q.id }), h("span", { text: q.context })),
    h("h3", { text: q.title }), h("p", { class: "clamp", text: q.brief }),
    h("div", { class: "done" }, h("b", { text: "Done when" }), q.done_when),
    q.evidence ? h("blockquote", { text: q.evidence }) : null,
    q.tags && q.tags.length ? h("div", { class: "arts" }, q.tags.map(function (t) { return h("span", { class: "chip", text: "#" + t }); })) : null,
    h("div", { class: "prov" }, icon("flag"), h("span", { text: who.join(" \u00b7 ") })), actions);
  function act(name, args, btn) {
    btn.disabled = true;
    callTool(name, args).then(function (r) {
      var t = textOf(r), dd = cardOf(r), fresh = dd && dd.quests && dd.quests.filter(function (x) { return x.id === q.id; })[0];
      if ((r && r.isError) || !fresh) { btn.disabled = false; status(msg, t.split("\n")[0], false); return; }
      var next = questRow(fresh, d); row.replaceWith(next); status(next.querySelector(".status"), t.split("\n")[0], true);
    }, function (e) { btn.disabled = false; status(msg, e.message, false); });
  }
  if (q.state === "open") {
    var claim = h("button", { class: "btn primary", type: "button" }, icon("bolt"), "Claim");
    claim.addEventListener("click", function () { act("claim_quest", { id: q.id }, claim); });
    actions.appendChild(claim);
  }
  if (q.state === "claimed" && me && q.claimed_by === me) {
    form = h("form", { class: "complete", hidden: true });
    var ev = h("textarea", { name: "evidence", maxlength: "2000", required: true, placeholder: "How you know done_when holds" });
    var en = h("input", { name: "entry", required: true, placeholder: "The memory the work produced, like a1b2c3", autocomplete: "off" });
    var go = h("button", { class: "btn primary", type: "submit" }, icon("check"), "Complete quest");
    add(form, [h("label", { text: "Evidence" }), ev, h("label", { text: "Entry id" }), en, h("div", { class: "actions" }, go)]);
    form.addEventListener("submit", function (e) { e.preventDefault(); act("complete_quest", { id: q.id, evidence: ev.value.trim(), entry_id: en.value.trim() }, go); });
    var done = h("button", { class: "btn primary", type: "button" }, icon("check"), "Complete");
    done.addEventListener("click", function () { form.hidden = !form.hidden; resized(); });
    actions.appendChild(done);
    row.appendChild(form);
  }
  row.appendChild(msg);
  return row;
}
function questsCard(d) {
  var shell = h("div", { class: "clyde" }, bar("Quest board", d.badge));
  var qs = d.quests || [];
  if (d.head) shell.appendChild(h("div", { class: "item small muted", text: d.head }));
  if (!qs.length) { shell.appendChild(h("div", { class: "empty", text: "No quests here." })); return shell; }
  var list = h("div", { class: "list" }); qs.forEach(function (q) { list.appendChild(questRow(q, d)); });
  shell.appendChild(list);
  return shell;
}
function agentCard(d) {
  var a = d.agent;
  return h("div", { class: "clyde" }, bar("Agent", d.badge),
    h("div", { class: "hero" }, h("span", { class: "avatar", text: String(a.name).replace(/[^a-z0-9]/gi, "").slice(0, 2) || "?" }),
      h("div", { style: null }, h("h3", { text: a.name }),
        h("div", { class: "meta" }, h("span", { class: "chip accent", text: a.context }), h("span", { class: "chip", text: a.surface }),
          a.since ? h("span", { text: "since " + a.since }) : null))),
    a.description ? h("div", { class: "item" }, h("p", { text: a.description })) : null);
}
function errorCard(d) {
  return h("div", { class: "clyde" }, bar("", d.badge), h("div", { class: "hero bad" }, h("span", { class: "tick" }, icon("x")), h("p", { text: d.error })));
}
function failed(text) { root.textContent = ""; root.appendChild(errorCard({ error: text })); resized(); }
function show(result) {
  var d = cardOf(result);
  root.textContent = "";
  st = { data: d, verdicts: {}, sent: false, busy: false };
  if (!d) { root.appendChild(h("div", { class: "clyde" }, bar("", null), h("div", { class: "item" }, h("pre", { text: textOf(result) })))); resized(); return; }
  var el = d.error ? errorCard(d) : d.card === "recall" ? recallCard(d) : d.card === "entry" ? entryCard(d, false)
    : d.card === "remembered" ? entryCard(d, true) : d.card === "artifact" ? artifactCard(d) : d.card === "quests" ? questsCard(d)
    : d.card === "agent" ? agentCard(d) : null;
  root.appendChild(el || h("pre", { text: textOf(result) }));
  root.setAttribute("data-ready", d.card);
  resized();
}

// ---------- start ----------
root.appendChild(h("div", { class: "clyde" }, bar("", null), h("div", { class: "item" }, h("div", { class: "skel" }), h("div", { class: "skel" }))));
if (typeof ResizeObserver === "function") new ResizeObserver(resized).observe(document.documentElement);
if (oa) {
  theme(oa.theme);
  var ready = function () { var r = { _meta: oa.toolResponseMetadata, structuredContent: oa.toolOutput }; if (cardOf(r)) show(r); };
  window.addEventListener("openai:set_globals", function (e) { var g = e.detail && e.detail.globals; if (g && g.theme) theme(g.theme); ready(); });
  ready();
} else {
  request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "clyde-" + KIND, version: "1" }, appCapabilities: {} }).then(function (r) {
    context(r && r.hostContext);
    notify("ui/notifications/initialized", {});
    resized();
  }, function () { notify("ui/notifications/initialized", {}); });
}
window.__clyde = { show: show, theme: theme };
})();`;
