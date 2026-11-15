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
  s.setAttribute("viewBox", "0 0 16 16"); s.setAttribute("class", "c-i"); s.setAttribute("aria-hidden", "true");
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
function head(what, b) {
  return h("div", { class: "c-head" }, logo(), h("span", { class: "c-what", text: what || "" }), agentBadge(b, false));
}
var LOGO = document.getElementById("clyde-logo");
function logo() { var w = h("span", { class: "cl-wordmark" }); if (LOGO) w.appendChild(LOGO.content.cloneNode(true)); return w; }
function sheet(what, b) { var s = h("div", { class: "clyde" }); s.appendChild(head(what, b)); return s; }
function desk() { return h("div", { class: "c-desk" }); }
function meter(v) { var i = h("i"); i.style.width = Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100) + "%"; return h("span", { class: "c-meter" }, i); }
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
  var state = m.superseded_by ? ["superseded", "superseded"] : m.trial ? ["trial", "on trial" + (m.chance ? " · " + m.chance + " of 3" : "")] : ["settled", m.unreviewed ? "unreviewed" : "settled"];
  return h("div", { class: "cl-memory__top" }, kindChip(m.kind, m.verified),
    h("span", { class: "cl-state cl-state--" + state[0], text: state[1] }),
    m.private ? h("span", { class: "cl-chip", text: "private" }) : null,
    h("span", { class: "cl-memory__conf", title: "confidence" }, meter(m.confidence), Math.round(Number(m.confidence || 0) * 100) + "%"));
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
function say(el, text, ok) { el.textContent = text; el.className = "c-say " + (ok ? "is-ok" : "is-bad"); el.hidden = false; resized(); }

// ---------- open: get_entry and get_blob inside a card ----------
function entryDetail(e) {
  var parts = [];
  if (e.links && e.links.length) {
    parts.push(h("span", { class: "cl-label", text: "Links" }), h("ul", { class: "c-links" }, e.links.map(function (l) {
      return h("li", null, icon("link"), h("span", { class: "cl-muted cl-mono", text: (l.dir === "to" ? "" : "from ") + l.type }), h("span", { text: l.title }));
    })));
  }
  if (e.artifacts && e.artifacts.length) parts.push(h("span", { class: "cl-label", text: "Artifacts" }), artChips(e.artifacts, true));
  parts.push(h("div", { class: "cl-memory__foot" }, [e.id, e.pattern, e.scope].filter(Boolean).map(function (t) { return h("span", { text: t }); })));
  return parts;
}
function openEntry(btn, m, holder, card) {
  if (holder.firstChild) { holder.hidden = !holder.hidden; btn.setAttribute("aria-expanded", String(!holder.hidden)); resized(); return; }
  btn.disabled = true;
  callTool("get_entry", { id: m.id }).then(function (r) {
    btn.disabled = false;
    var d = cardOf(r);
    holder.hidden = false; btn.setAttribute("aria-expanded", "true");
    if (d && d.entry) {
      var body = card.querySelector(".cl-memory__body"); if (body) { body.textContent = d.entry.body; body.className = "cl-memory__body is-open"; }
      add(holder, entryDetail(d.entry));
    } else add(holder, h("p", { class: "c-text", text: textOf(r) }));
    resized();
  }, function (e) { btn.disabled = false; holder.hidden = false; add(holder, h("p", { class: "c-say is-bad", text: e.message })); resized(); });
}
function preview(btn, a) {
  var card = btn.closest(".cl-memory") || btn.closest(".clyde"), box = card.querySelector(".c-preview[data-sha='" + a.sha256 + "']");
  if (box) { box.hidden = !box.hidden; resized(); return; }
  box = h("div", { class: "c-preview", "data-sha": a.sha256 }, h("div", { class: "c-skel" }));
  card.appendChild(box); resized();
  callTool("get_blob", { sha256: a.sha256 }).then(function (r) {
    box.textContent = "";
    var d = cardOf(r);
    add(box, d && d.artifact ? artifactView(d.artifact) : h("p", { class: "c-text", text: textOf(r) }));
    resized();
  }, function (e) { box.textContent = ""; add(box, h("p", { class: "c-say is-bad", text: e.message })); resized(); });
}
function artifactView(a) {
  var url = safeUrl(a.url), img = url && /^image\//.test(a.media_type || "");
  var file = h("div", { class: "cl-file" });
  var info = [a.media_type, a.size ? size(a.size) : a.total ? a.total + " characters" : ""].filter(Boolean).join(" · ");
  var dl = url && !img ? h("button", { class: "cl-btn cl-btn--sm", type: "button", onclick: function () { openLink(url); } }, icon("open"), "Download") : null;
  file.appendChild(h("div", { class: "cl-file__head" }, h("span", { class: "c-row" }, icon(img ? "image" : "file"), h("span", { text: a.name })), h("span", { text: info }), dl));
  if (img) file.appendChild(h("div", { style: null }, h("img", { class: "c-img", src: url, alt: a.name, loading: "lazy", onload: resized })));
  if (a.text !== null && a.text !== undefined) {
    var pre = h("pre", { text: a.text }); file.appendChild(pre);
    if (a.next) {
      var note = h("span", { class: "cl-muted", text: "Showing " + a.to + " of " + a.total + " characters" });
      var more = h("button", { class: "cl-btn cl-btn--sm cl-btn--ghost", type: "button", onclick: function () {
        more.disabled = true;
        callTool("get_blob", { sha256: a.sha256, offset: a.next }).then(function (r) {
          var d = cardOf(r);
          if (d && d.artifact) { pre.textContent += d.artifact.text; a.next = d.artifact.next; a.to = d.artifact.to; } else pre.textContent += "\n" + textOf(r);
          more.disabled = false; note.textContent = "Showing " + a.to + " of " + a.total + " characters"; if (!a.next) more.remove(); resized();
        }, function () { more.disabled = false; });
      } }, icon("more"), "Load more");
      file.appendChild(h("div", { class: "cl-file__head" }, note, more));
    }
  }
  return file;
}

// ---------- cards ----------
function recallCard(d) {
  var items = d.items || [];
  var s = sheet((d.page === "more" ? "more for " : "recall · ") + "“" + (d.query || "") + "”", d.badge), dk = desk();
  if (d.degraded) dk.appendChild(h("p", { class: "c-text" }, h("span", { class: "cl-chip cl-chip--warn", text: "degraded" }), " ", d.degraded));
  if (!items.length) {
    dk.appendChild(h("div", { class: "cl-empty" }, h("p", { class: "cl-empty__title", text: "Nothing filed matches yet." }),
      h("p", { class: "cl-empty__text", text: "Ask for more results, or tell your agent what to remember." })));
    s.appendChild(dk); return s;
  }
  var count = h("span", { class: "c-note" });
  var send = h("button", { class: "cl-btn cl-btn--primary cl-btn--sm", type: "button", onclick: function () { sendFeedback(false); } }, icon("check"), "Send feedback");
  var none = h("button", { class: "cl-btn cl-btn--ghost cl-btn--sm", type: "button", onclick: function () { sendFeedback(true); } }, "None helped");
  var msg = h("p", { class: "c-say", hidden: true });
  function refresh() {
    var n = Object.keys(st.verdicts).length;
    count.textContent = st.sent ? "Feedback logged." : n ? n + " of " + items.length + " marked. The rest count as not used." : "Mark what you used, then send it once.";
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
      say(msg, ok ? "Logged. Clyde ranks what you used higher next time." : t, ok); refresh();
      var bs = s.querySelectorAll("button.c-used,button.c-wrong"); for (var i = 0; i < bs.length; i++) bs[i].disabled = st.sent;
    }, function (e) { st.busy = false; say(msg, e.message, false); refresh(); });
  }
  items.forEach(function (m) {
    var card = h("article", { class: "cl-card cl-memory" + (m.superseded_by ? " is-superseded" : ""), "data-id": m.id });
    var holder = h("div", { class: "c-detail", hidden: true });
    var used = h("button", { class: "cl-btn cl-btn--sm c-used", type: "button", "aria-pressed": "false" }, icon("check"), "Used");
    var wrong = h("button", { class: "cl-btn cl-btn--sm c-wrong", type: "button", "aria-pressed": "false" }, icon("x"), "Wrong");
    function pick(v) {
      if (st.sent) return;
      if (st.verdicts[m.id] === v) delete st.verdicts[m.id]; else st.verdicts[m.id] = v;
      used.setAttribute("aria-pressed", String(st.verdicts[m.id] === "used")); wrong.setAttribute("aria-pressed", String(st.verdicts[m.id] === "wrong"));
      refresh();
    }
    used.addEventListener("click", function () { pick("used"); }); wrong.addEventListener("click", function () { pick("wrong"); });
    var open = h("button", { class: "cl-btn cl-btn--sm cl-btn--ghost c-open", type: "button", "aria-expanded": "false" }, "Open", icon("open"));
    open.addEventListener("click", function () { openEntry(open, m, holder, card); });
    add(card, [memoryParts(m, false), artChips(m.artifacts, false), h("div", { class: "c-row" }, used, wrong, h("span", { class: "c-sp" }), open), holder]);
    dk.appendChild(card);
  });
  s.appendChild(dk);
  s.appendChild(h("div", { class: "c-foot" }, count, none, send));
  s.appendChild(msg);
  refresh();
  return s;
}
function entryCard(d, saved) {
  var e = d.entry, s = sheet(saved ? "remember" : "memory", d.badge), dk = desk();
  if (saved) s.appendChild(h("div", { class: "c-hero" }, h("span", { class: "cl-stamp cl-stamp--ok is-new", text: "Filed" }),
    h("div", null, h("div", { text: "Every agent can recall it now." }), h("div", { class: "c-sub cl-mono", text: e.id }))));
  dk.appendChild(h("article", { class: "cl-card cl-memory" }, memoryParts(e, true), h("div", { class: "c-detail" }, entryDetail(e))));
  s.appendChild(dk);
  return s;
}
function artifactCard(d) { var s = sheet("artifact", d.badge), dk = desk(); dk.appendChild(artifactView(d.artifact)); s.appendChild(dk); return s; }
var STAMP = { open: "cl-stamp--carbon", claimed: "cl-stamp--warn", done: "cl-stamp--ok", abandoned: "cl-stamp--bad" };
function questCard(q, d) {
  var me = d.badge && d.badge.registered ? d.badge.name : null;
  var msg = h("p", { class: "c-say", hidden: true }), row = h("div", { class: "c-row" });
  var who = [h("span", null, "posted by ", h("b", { text: q.posted_by }))];
  if (q.assignee && q.assignee !== "any") who.push(h("span", null, " · for ", h("b", { text: q.assignee })));
  if (q.state === "claimed" && q.claimed_by) who.push(h("span", null, " · claimed by ", h("b", { text: q.claimed_by }), q.lease_until ? " until " + when(q.lease_until) : ""));
  if (q.state === "done") who.push(h("span", null, " · done by ", h("b", { text: q.claimed_by || "" }), q.closed_at ? " " + when(q.closed_at) : ""));
  var main = h("div", { class: "cl-quest__main" },
    h("div", { class: "cl-quest__head" }, h("h3", { class: "cl-quest__title", text: q.title }), h("span", { class: "cl-stamp " + (STAMP[q.state] || ""), text: q.state })),
    h("p", { class: "cl-quest__brief", text: q.brief }),
    h("div", { class: "cl-quest__done" }, h("span", { class: "cl-label", text: "Done when" }), h("span", { class: "c-text", text: q.done_when })),
    q.evidence ? h("p", { class: "c-quote", text: q.evidence }) : null,
    q.tags && q.tags.length ? h("div", { class: "c-row" }, q.tags.map(function (t) { return h("span", { class: "cl-chip", text: t }); })) : null,
    h("div", { class: "cl-quest__for" }, who, " · " + q.context), row, msg);
  var card = h("article", { class: "cl-quest" + (q.state === "done" ? " is-done" : ""), "data-quest": q.id },
    h("div", { class: "cl-quest__stub" }, h("span", { class: "cl-quest__pri" + (q.priority === "high" ? " is-high" : ""), text: q.priority }),
      h("span", { class: "cl-quest__no", text: "Nº" + q.id })), main);
  function act(name, args, btn) {
    btn.disabled = true;
    callTool(name, args).then(function (r) {
      var t = textOf(r), dd = cardOf(r), fresh = dd && dd.quests && dd.quests.filter(function (x) { return x.id === q.id; })[0];
      if ((r && r.isError) || !fresh) { btn.disabled = false; say(msg, t.split("\n")[0], false); return; }
      var next = questCard(fresh, d); card.replaceWith(next); say(next.querySelector(".c-say"), t.split("\n")[0], true);
      var stamp = next.querySelector(".cl-stamp"); if (stamp) stamp.className += " is-new";
    }, function (e) { btn.disabled = false; say(msg, e.message, false); });
  }
  if (q.state === "open") {
    var claim = h("button", { class: "cl-btn cl-btn--primary cl-btn--sm c-claim", type: "button" }, icon("bolt"), "Claim");
    claim.addEventListener("click", function () { act("claim_quest", { id: q.id }, claim); });
    row.appendChild(claim);
  }
  if (q.state === "claimed" && me && q.claimed_by === me) {
    var ev = h("textarea", { class: "cl-textarea", name: "evidence", maxlength: "2000", required: true, placeholder: "How you know done-when holds" });
    var en = h("input", { class: "cl-input", name: "entry", required: true, placeholder: "The memory the work produced", autocomplete: "off" });
    var go = h("button", { class: "cl-btn cl-btn--primary cl-btn--sm", type: "submit" }, icon("check"), "Complete quest");
    var form = h("form", { class: "c-complete", hidden: true }, h("div", { class: "cl-field" }, h("label", { text: "Evidence" }), ev),
      h("div", { class: "cl-field" }, h("label", { text: "Memory id" }), en), h("div", { class: "c-row" }, go));
    form.addEventListener("submit", function (e) { e.preventDefault(); act("complete_quest", { id: q.id, evidence: ev.value.trim(), entry_id: en.value.trim() }, go); });
    var done = h("button", { class: "cl-btn cl-btn--sm", type: "button" }, icon("check"), "Complete");
    done.addEventListener("click", function () { form.hidden = !form.hidden; resized(); });
    row.appendChild(done); main.insertBefore(form, msg);
  }
  if (!row.firstChild) row.hidden = true;
  return card;
}
function questsCard(d) {
  var s = sheet("quest board", d.badge), dk = desk(), qs = d.quests || [];
  if (d.head) dk.appendChild(h("p", { class: "c-text", text: d.head }));
  if (!qs.length) dk.appendChild(h("div", { class: "cl-empty" }, h("p", { class: "cl-empty__title", text: "No quests on the board." }),
    h("p", { class: "cl-empty__text", text: "Ask your agent to post one, with a done-when line anyone can check." })));
  qs.forEach(function (q) { dk.appendChild(questCard(q, d)); });
  s.appendChild(dk);
  return s;
}
function agentCard(d) {
  var a = d.agent, s = sheet("agent", d.badge), dk = desk();
  dk.appendChild(h("div", { class: "cl-card" }, h("div", { class: "c-hero" }, agentBadge({ name: a.name, context: a.context, surface: a.surface, registered: true }, true),
    h("span", { class: "c-sp" }), a.since ? h("span", { class: "cl-label", text: "since " + a.since }) : null),
    a.description ? h("p", { class: "c-text c-say", text: a.description }) : null));
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
  st = { data: d, verdicts: {}, sent: false, busy: false };
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
