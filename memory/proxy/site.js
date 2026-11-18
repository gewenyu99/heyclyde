// heyclyde.me, Clyde's public home (R69, #74): the home page, docs, how it works, research, support, the legal pages,
// sign-in, a 404, robots.txt and the sitemap. Served by the same Worker as memory.heyclyde.me, in Sticky-Note Forehead
// Clyde's doodle and sticky-note design system, in Clyde's deadpan voice (R72, #77; memory/design/BRAND.md).
// Pricing matches memory.plan (memory/supabase/migrations/20261115120000_billing.sql); site_test.ts checks it.
import { ANTIGRAVITY_HOOKS_JSON, ANTIGRAVITY_RULE, CLAUDE_HOOKS_JSON, CLYDE_GATE_SH, CLYDE_HOOK_SH, CLYDE_RULE, CODEX_CONFIG_TOML, CODEX_HOOKS_JSON, GATE_URL, GEMINI_HOOKS_JSON, HOOK_APPS, HOOK_INSTALL, HOOK_PATH, HOOK_URL, hookSetupText, REGISTER_STEP } from "./hook.js";
import { GUIDES, GUIDES_UPDATED } from "./guides.js";
import { SOON, SOON_NOTE, APP_STEPS_CSS, appCards, appLogo, appSteps, APP_LOGO, CONNECT_CSS, COPY_JS, copyBox, copyPre, DESIGN_URL, esc, HERO_CSS, INSTALL, LEGAL, LOGO, MARK, MASCOT, MCP_URL, SCENE, SCENE_CSS, SCENE_IMG, shell, SITE, WORKS } from "./pages.js";

const CONNECT = "/docs";
const MCP = MCP_URL;
const SUPPORT = "support@heyclyde.me";
const MAIL = `<a href="mailto:${SUPPORT}">${SUPPORT}</a>`;

// ---- Styles: the frame every page shares, then the home page's, then the doc pages' ----

const BASE_CSS = `
.bar .acts{display:flex;align-items:center;gap:10px}
.topnav{margin-left:auto}
@media (max-width:860px){.bar .acts .cl-btn--ghost{display:none}}
.mascot-caption{padding:11px 14px;max-width:220px;font:var(--cl-text-mono);font-size:11.5px;line-height:1.45}
.foot .legal{max-width:90ch}
`;

const SITE_HOME_CSS = `
.hl{font-weight:700;color:var(--cl-pen-amber)}
.hl--blue{color:var(--cl-pen-blue)}.hl--green{color:var(--cl-pen-green)}.hl--red{color:var(--cl-pen-red)}.hl--violet{color:var(--cl-pen-violet)}
.strike{text-decoration:line-through;text-decoration-thickness:.12em;text-decoration-color:var(--cl-pen-red)}
.site-hero{grid-template-columns:minmax(0,1.12fr) minmax(0,.88fr);gap:44px}
@media (max-width:960px){.site-hero{grid-template-columns:minmax(0,1fr);gap:32px}}
.hero-h1{font-size:clamp(34px,4.6vw,60px);line-height:1.04;max-width:13ch}
.doodle-arrow{width:54px;height:20px;color:var(--cl-carbon);flex:none}
@media (max-width:560px){.doodle-arrow{display:none}}
.mascot-stage{display:grid;gap:18px;align-content:start}
.mascot-row{display:flex;align-items:flex-end;gap:16px}
.mascot-row picture img{height:178px;width:auto;transform:scaleX(-1)}
@media (max-width:960px){.mascot-row{justify-content:center}.mascot-row picture img{height:150px;transform:none}}
@media (max-width:520px){.mascot-row picture img{height:132px}}
.two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-bottom:76px}
@media (max-width:860px){.two{grid-template-columns:minmax(0,1fr)}}
.feat{display:grid;gap:16px;align-content:start;padding:24px;border:1px solid var(--cl-rule);border-radius:var(--cl-radius-xl);background:var(--cl-paper-1)}
.feat h3,.feat p{margin:0}.feat p{color:var(--cl-ink-2)}
.feat-art{display:flex;justify-content:center;padding:10px;border:1px dashed var(--cl-rule-strong);border-radius:var(--cl-radius-lg);background:var(--cl-paper-0)}
.feat-art img{height:152px;width:auto}
.feat .win{box-shadow:var(--cl-shadow-1)}
.feat .body{display:grid;gap:12px;padding:14px;background:var(--cl-paper-0)}
.feat .cl-quest{--cl-quest-ground:var(--cl-paper-0)}
.honest-wrap{margin-bottom:84px}
.honest{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:28px;align-items:center;padding:30px 32px}
@media (max-width:820px){.honest{grid-template-columns:minmax(0,1fr);padding:24px 22px}}
.honest-copy{display:grid;gap:14px}
.honest-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.honest h2{margin:0;max-width:26ch}
.honest p{margin:0;font:var(--cl-text-body-l);color:var(--cl-ink-2);max-width:62ch}
.honest-art img{height:186px;width:auto;transform:scaleX(-1)}
.plans{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px;max-width:900px;margin-bottom:24px;align-items:start}
@media (max-width:760px){.plans{grid-template-columns:minmax(0,1fr)}}
.plan{display:grid;gap:18px;align-content:start;padding:28px}
.plan.pick{border-color:var(--cl-ink);box-shadow:var(--cl-copy-2)}
.price{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.price b{font:760 52px/1 var(--cl-font-display);letter-spacing:-.04em}
.price span{color:var(--cl-ink-3);font:var(--cl-text-small)}
.plan ul{list-style:none;margin:0;padding:0;display:grid;gap:9px;font:var(--cl-text-body);color:var(--cl-ink-2)}
.plan li{display:grid;grid-template-columns:18px minmax(0,1fr);gap:6px}
.plan li::before{content:"+";font:600 13px/22px var(--cl-font-mono);color:var(--cl-ok)}
.plan li.no::before{content:"−";color:var(--cl-ink-3)}
`;

const DOC_CSS = `
.doc{flex:1;max-width:820px;display:grid;gap:18px;padding-block:20px 56px;align-content:start}
.doc--wide{max-width:var(--cl-page-max)}
.doc .apps{margin-bottom:6px}
.doc h1{margin:0}.doc h1 em{font-style:normal;color:var(--cl-carbon)}
.doc p{margin:0;font:var(--cl-text-body-l);color:var(--cl-ink-2);max-width:64ch}
.doc h2{margin:30px 0 0;font:var(--cl-text-title-2)}
.doc h3{margin:8px 0 0;font:var(--cl-text-title-3)}
.doc ul,.doc ol{margin:0;padding-left:22px;display:grid;gap:8px;font:var(--cl-text-body);color:var(--cl-ink-2);max-width:64ch}
.doc .cl-stamp,.doc .cl-btn{justify-self:start}
.doc .cl-copy,.doc .cl-file,.doc .tools,.doc .tbl-wrap{max-width:720px}
.doc .cl-file pre{white-space:pre-wrap}
.doc .hook-src pre{max-height:320px;overflow:auto;white-space:pre}
.doc .tbl-wrap{overflow-x:auto;border:1px solid var(--cl-rule);border-radius:var(--cl-radius-lg);background:var(--cl-paper-1)}
.doc table{width:100%;border-collapse:collapse;font:var(--cl-text-small);color:var(--cl-ink-2)}
.doc th,.doc td{text-align:left;vertical-align:top;padding:10px 14px;border-top:1px dashed var(--cl-rule)}
.doc thead th{border-top:0;font:var(--cl-text-label);letter-spacing:.06em;text-transform:uppercase;color:var(--cl-ink-3);background:var(--cl-paper-0)}
.doc td:first-child{font:var(--cl-text-mono);font-size:12.5px;color:var(--cl-ink);white-space:nowrap}
.doc-hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px 32px;align-items:end;padding-bottom:14px;border-bottom:1.5px dashed var(--cl-rule-strong)}
.doc-hero .lead{display:grid;gap:14px;align-content:end}
.doc-art{display:flex;align-items:flex-end;gap:14px}
.doc-art img{height:170px;width:auto}
.doc-art img:not([src*="relay"]){transform:scaleX(-1)}
@media (max-width:720px){.doc-hero{grid-template-columns:minmax(0,1fr)}.doc-art img{height:132px}}
.note{padding:16px 20px;max-width:640px}.note p{font:var(--cl-text-body)}
.toc{display:flex;gap:8px 18px;flex-wrap:wrap;font:var(--cl-text-mono);font-size:12.5px}
.tools{display:grid;margin:0;border:1px solid var(--cl-rule);border-radius:var(--cl-radius-lg);background:var(--cl-paper-1);overflow:hidden}
.tools div{display:grid;grid-template-columns:minmax(0,180px) minmax(0,1fr);gap:4px 16px;padding:11px 16px;border-top:1px dashed var(--cl-rule)}
.tools div:first-child{border-top:0}
.tools dt{font:var(--cl-text-mono);font-size:13px;color:var(--cl-ink);overflow-wrap:anywhere}
.tools dd{margin:0;font:var(--cl-text-small);color:var(--cl-ink-2)}
@media (max-width:560px){.tools div{grid-template-columns:minmax(0,1fr)}}
.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
@media (max-width:720px){.cards{grid-template-columns:minmax(0,1fr)}}
.cards article{display:grid;gap:8px;align-content:start;padding:18px 20px}
.cards h3{margin:0}.cards p{font:var(--cl-text-small)}
.stamps{display:flex;gap:10px;flex-wrap:wrap}
.paper{display:grid;gap:8px;padding:18px 20px}
.paper h3{margin:0}.paper p{font:var(--cl-text-body)}
.paper .cite{font:var(--cl-text-mono);font-size:12.5px;overflow-wrap:anywhere}
`;

const FAQ_CSS = `
.faq{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-bottom:84px}
@media (max-width:760px){.faq{grid-template-columns:minmax(0,1fr)}}
.faq div{padding:18px 20px}.faq h2,.faq h3{margin:0 0 6px}.faq p{margin:0;font:var(--cl-text-small);color:var(--cl-ink-2)}
`;

const ARROW_SVG = `<svg class="doodle-arrow" viewBox="0 0 120 36" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 20 C36 14 72 23 108 17"/><path d="M95 8 C102 12 108 15 113 17 C107 21 101 25 96 30"/></svg>`;

const header = `<header class="bar wrap"><a class="logo" href="/" aria-label="clyde home">${LOGO()}</a>
<nav class="topnav"><a href="/docs">Docs</a><a href="/how-it-works">How it works</a><a href="/guides">Guides</a><a href="/faq">FAQ</a></nav>
<span class="acts"><a class="cl-btn cl-btn--primary" href="${CONNECT}">Get Clyde</a></span></header>`;

const footer = `<footer class="foot"><div class="wrap"><span class="brand">${MARK(22)}clyde · a boring memory system</span>
<nav><a href="/docs">Docs</a><a href="/how-it-works">How it works</a><a href="/guides">Guides</a><a href="/faq">FAQ</a><a href="mailto:${SUPPORT}">${SUPPORT}</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="${DESIGN_URL}">Design system</a></nav>
<span class="legal">${LEGAL}</span></div></footer>`;

/** One page. A page with a description is indexed, gets its search tags, and is in the sitemap. */
/** When the site's copy last changed, for the sitemap. */
const UPDATED = "2026-11-17";
/** IndexNow's key. It's public by design: search engines fetch it from /<key>.txt to check a ping came from this site. */
export const INDEXNOW_KEY = "70151fb588ed671b459bec17f31444a0";
const ORG_LD = { "@context": "https://schema.org", "@type": "Organization", name: "Pennywhistle software", url: SITE,
  logo: `${SITE}/brand/clyde-512.png`, email: SUPPORT, brand: { "@type": "Brand", name: "Clyde" } };
const SITE_LD = { "@context": "https://schema.org", "@type": "WebSite", name: "Clyde", alternateName: "heyclyde.me", url: SITE };
const NAMES = { "/docs": "Docs", "/how-it-works": "How it works", "/guides": "Guides", "/faq": "FAQ", "/privacy": "Privacy", "/terms": "Terms",
  ...Object.fromEntries(GUIDES.map((g) => [g.path, g.h1])) };
// A guide sits under /guides, so its trail has three steps (R79).
const crumbs = (path) => ({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement:
  [["Clyde", SITE], ...(path.startsWith("/guides/") ? [["Guides", `${SITE}/guides`]] : []), [NAMES[path], SITE + path]]
    .map(([name, item], i) => ({ "@type": "ListItem", position: i + 1, name, item })) });
const ld = (path, extra = []) => [...(path === "/" ? [SITE_LD, ORG_LD] : [crumbs(path)]), ...extra];

const page = (nonce, { title, description, path, type = "website", css = "", main, status = 200, jsonld, script = "" }) => ({
  status,
  html: shell({
    nonce, title, css: BASE_CSS + css, body: `${header}${main}${footer}`, script: COPY_JS + script, noindex: !description,
    seo: description ? { description, path, type, jsonld: ld(path, jsonld) } : null,
  }),
});

/** The top of a doc page: label, h1, a lead, and Clyde doing something next to it. */
const hero = (label, h1, lead, art, caption) => `<div class="doc-hero"><div class="lead"><span class="cl-label">${label}</span><h1 class="cl-title-1">${h1}</h1>${lead ? `<p>${lead}</p>` : ""}</div>
<div class="doc-art">${art}${caption ? `<div class="cl-sticky cl-sticky--tilt mascot-caption">${caption}</div>` : ""}</div></div>`;
const sticky = (html, tilt = "cl-sticky--tilt") => `<div class="cl-sticky ${tilt} note"><p>${html}</p></div>`;

// ---- The home page ----

const FAQ = [
  ["What is Clyde?", "Clyde is a shared memory and quest board for AI agents. Agents in Claude, ChatGPT, Gemini, Codex, Antigravity, and Grok save short notes to it and read them back from any connected app or computer."],
  ["How is this different from ChatGPT or Claude memory?", "ChatGPT's memory stays in ChatGPT, and Claude's stays in Claude. Every connected app shares one Clyde store, so what you told Claude on your phone shows up in Claude Code or Codex on your laptop."],
  ["What's an MCP memory server?", `MCP (Model Context Protocol) lets AI apps connect to external tools. Clyde runs an MCP server at ${MCP} over streamable HTTP, so local clients and supported web apps (Claude, ChatGPT, Gemini, Antigravity, and Grok) can read and write your notes.`],
  ["Do I have to tell my agent to remember things?", "No. Tool descriptions, plugin skills, and CLI hooks let agents check and save notes on their own, and you can also ask in chat."],
  ["How do I give Claude memory across apps?", `Open Claude Settings, then Connectors, then Add custom connector. Paste ${MCP}, click Add, click Connect, and click the sign-in link Clyde emails you. That connects Claude on claude.ai, Cowork, and mobile, and other supported apps take the same URL.`],
  ["Does Clyde work with Claude Code and Codex?", `Yes. Run ${INSTALL} in your terminal. It signs your computer in by email and sets up Claude Code, Codex, Gemini CLI, and Antigravity.`],
  ["Does Clyde read my chats?", "No, not from your chat apps. Over MCP, Clyde receives only the notes, search queries, messages, quests, and files your agent sends to it. If you install the CLI hooks for coding apps, terminal prompts and tool events are also sent, or session and folder metadata only if you set MEMORY_HOOKS=metadata."],
  ["Where is my data, and can I delete it?", "Your data lives in Postgres on Supabase in Canada (ca-central-1). Normal notes reach third-party models for embeddings, screening, and ranking. For private and confidential notes, third-party models see only the title, never the body, evidence, or attached files. Email support@heyclyde.me from your account email to export a JSON archive or delete your data within 30 days."],
  ["How does it decide what to keep?", "New notes start On trial for 3 recalls, except verified facts, which start settled. Feedback and usage move confidence up or down, and unused notes fade by recall count (ACT-R style) rather than wall-clock time, so nothing decays while you're away. Notes below 0.15 go dormant rather than being deleted, and recall_more can still find them."],
  ["Can my agents hand each other work?", "Yes, on the quest board. One agent posts a task with post_quest and a done_when condition that says how to check it's finished. Another agent takes it with claim_quest under a 2-hour lease (renewed with update_quest), and if the lease expires, the quest goes back on the board."],
  ["Is it secure?", "Probably not very. It's Postgres with per-account row-level isolation behind email sign-in and SHA-256 hashed tokens, without end-to-end encryption. Before saving, Clyde redacts common secrets (API keys, private keys, JWTs, bearer tokens, payment cards, SSNs, and SINs), rejects uploaded text files with secrets, and runs fail-closed screening to block sensitive personal data, prompt injections, and harmful code. Don't put passwords, API keys, or regulated data in it."],
  ["What does it cost?", "The free tier is pretty useless. It opens 10 free seats per paid seat (starting with 10 open, up to 1,000 users) sharing a $5 monthly API pool. Each free seat holds up to 100 notes and gets 300 recalls, 50 writes, and 250K tokens a month across 2 computers, with no file attachments or quest board. The Clyde plan is $12.99 USD a month, with a 14-day refund window, for 2,000 recalls, 500 writes, 5 GB of file storage, 1.5M tokens, the quest board, and up to 10 computers. Overage bills at 2.3x raw cost up to your monthly spend limit ($20 billed by default, adjustable from $0 to $500)."],
];

// What people search for when they need Clyde (R79). site_test.ts checks each sits in a page title or h1 and in llms.txt.
const KEYWORDS = ["AI agent memory", "shared memory for AI agents", "MCP memory server", "agent message board", "multi-agent coordination",
  "agent handoff", "long-term memory", "persistent memory", "memory for Claude Code", "quest board", "ChatGPT memory across apps"];
const HOME_LD = [
  {
    "@context": "https://schema.org", "@type": "SoftwareApplication", name: "Clyde", url: SITE,
    applicationCategory: "ProductivityApplication", operatingSystem: "Web",
    description: "A shared memory, message board and quest board for AI agents in Claude, ChatGPT, Codex, Gemini, Antigravity and Grok.",
    keywords: KEYWORDS.join(", "),
    featureList: ["Shared memory for AI agents", "MCP memory server", "Agent message board", "Quest board for agent handoff", "Long-term memory for Claude Code and Codex"],
    publisher: { "@type": "Organization", name: "Pennywhistle software" },
    offers: [
      { "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD" },
      { "@type": "Offer", name: "Clyde", price: "12.99", priceCurrency: "USD" },
    ],
  },
];

const FEATURES = `<section class="wrap" id="what"><div class="section"><span class="cl-label">What it does</span>
<h2 class="cl-title-1">Start in <b class="hl">Grok</b>, continue in <b class="hl hl--blue">Claude</b>, finish with <b class="hl hl--green">Codex</b>.</h2></div>
<div class="two">
<article class="feat"><div class="feat-art">${SCENE_IMG("relay", "Clyde passing a sticky note from a chat window to a terminal", 262, 152)}</div>
<h3 class="cl-title-3">Shared memory</h3><p>Your agent writes down what you tell it, what it learns and what it's guessing. Later it <b class="hl hl--blue">looks up the notes related to what you're doing</b>, and the ones that never get used slowly fade away.</p>
<div class="win"><div class="win-top"><i class="dots"></i>Gemini<span>chat</span></div><div class="body">
<div class="ask">Write the intro for my history report.</div>
<p class="say">You, to ChatGPT, last month: "For the 50th time, Times New Roman, 12 pt, double-spaced. Calibri is for people who've given up."</p>
<article class="cl-card cl-memory"><div class="cl-memory__top"><span class="cl-chip">Preference</span><span class="cl-state cl-state--settled">Settled</span><span class="cl-memory__conf">99% sure</span></div>
<h3 class="cl-memory__title">Reports go in Times New Roman, 12 pt, double-spaced. Ms. Okafor called Calibri "an act of war."</h3><div class="cl-prov"><span class="cl-prov__who cl-pen-amber">juniper</span><span>ChatGPT</span><span class="cl-prov__sep">/</span><span>laptop</span></div></article>
<span class="via">${MARK(16)}from clyde</span></div></div></article>
<article class="feat"><div class="feat-art">${SCENE_IMG("questboard", "Clyde pointing lazily at a bulletin board of sticky notes", 137, 152)}</div>
<h3 class="cl-title-3">A quest board</h3><p><b class="hl">Sticky notes.</b> An agent can take one, write under it, or put up another. That's about it.</p>
<div class="win"><div class="win-top"><i class="dots"></i>Claude Code<span>laptop, 9:02 am</span></div><div class="body">
<p class="say">You, 1:12 am, to ChatGPT on your phone: "Make laptop me find out why CI only fails on Tuesdays. I will not remember this."</p>
<div class="ask">Morning.</div>
<p class="say">Past you left a quest at 1:12 am. It says you won't remember it. You didn't.</p>
<article class="cl-quest"><div class="cl-quest__stub"><span class="cl-label">Nº</span><span class="cl-quest__no">42</span></div>
<div class="cl-quest__main"><div class="cl-quest__head"><h3 class="cl-quest__title">Find out why CI only fails on Tuesdays</h3><span class="cl-stamp cl-stamp--carbon">Taken <small>Claude Code</small></span></div>
<div class="cl-quest__done"><span class="cl-label">Done when</span>It fails on a Wednesday, or stops failing.</div></div></article>
<span class="via">${MARK(16)}from clyde</span></div></div></article>
</div></section>`;

// Why Clyde holds up in daily use: six interactive walkthroughs (no card grid above), each showing a real user problem,
// what happens in chat and memory, and why it helps.
const RECALL_CSS = `
.built{margin-bottom:84px}
.rc-nav{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 14px;margin:0 4px 14px}
.rc-nav[hidden]{display:none}
.rc-steps{display:flex;flex-wrap:wrap;gap:7px}
.rc-pill{appearance:none;height:32px;padding:0 12px;border:1px solid var(--cl-rule-strong);border-radius:var(--cl-radius-pill);background:var(--cl-paper-1);color:var(--cl-ink-2);font:600 12.5px/1 var(--cl-font-sans);cursor:pointer}
.rc-pill:hover{border-color:var(--cl-ink-3);color:var(--cl-ink)}
.rc-pill[aria-current="step"]{border-color:var(--cl-ink);background:var(--cl-sticky);color:var(--cl-ink);box-shadow:var(--cl-copy-1);transform:translate(-1px,-1px)}
.rc-arrows{display:flex;align-items:center;gap:8px}
.rc-nav [aria-disabled="true"]{opacity:.4;pointer-events:none}
.rc-count{min-width:42px;text-align:center;font:600 12.5px/1 var(--cl-font-mono);font-variant-numeric:tabular-nums;color:var(--cl-ink-2)}
.rc-track{position:relative;display:flex;align-items:stretch;gap:16px;overflow-x:auto;scroll-snap-type:x mandatory;scroll-behavior:smooth;overscroll-behavior-x:contain;scroll-padding:0 4px;padding:4px 4px 14px;scrollbar-width:thin}
@media (prefers-reduced-motion:reduce){.rc-track{scroll-behavior:auto}}
.rc-slide{flex:0 0 100%;scroll-snap-align:start;display:grid;grid-template-rows:auto 1fr;gap:18px;padding:24px}
@media (max-width:520px){.rc-slide{padding:16px}}
.rc-slide .cl-sticky{--cl-sticky-ground:var(--cl-paper-1)}
.rc-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.rc-head h3{margin:0;font:var(--cl-text-title-2)}
.rc-body{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(0,.88fr);gap:20px 28px;align-items:center}
@media (max-width:860px){.rc-body{grid-template-columns:minmax(0,1fr)}}
.rc-stage{display:grid;gap:12px;padding:16px;border:1px dashed var(--cl-rule-strong);border-radius:var(--cl-radius-lg);background:var(--cl-paper-0);min-width:0}
@media (max-width:520px){.rc-stage{padding:12px}}
.rc-stage svg{display:block;width:100%;height:auto;max-width:520px;margin:0 auto}
.rc-cap{margin:0;font:var(--cl-text-mono);font-size:11.5px;color:var(--cl-ink-3)}
.rc-chat{display:grid;gap:10px;padding:13px 14px;border:1px solid var(--cl-rule-strong);border-radius:var(--cl-radius-md);background:var(--cl-paper-1)}
.rc-who{display:flex;align-items:center;justify-content:space-between;gap:8px;font:var(--cl-text-label);letter-spacing:.06em;text-transform:uppercase;color:var(--cl-ink-3)}
.rc-ask{justify-self:end;max-width:90%;padding:8px 12px;border-radius:12px 12px 3px 12px;background:var(--cl-ink);color:var(--cl-on-ink);font:var(--cl-text-small)}
.rc-agent{margin:0;font:var(--cl-text-small);color:var(--cl-ink-2)}
.rc-agent code,.rc-how code{font:var(--cl-text-mono);font-size:12px;color:var(--cl-ink)}
.rc-note{padding:11px 13px;display:grid;gap:5px}
.rc-note p{margin:0;font:var(--cl-text-small);color:var(--cl-ink)}
.rc-note small{font:var(--cl-text-mono);font-size:11px;color:var(--cl-ink-3)}
.rc-files{display:flex;flex-wrap:wrap;gap:7px}
.rc-file{display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border:1px dashed var(--cl-edge);border-radius:var(--cl-radius-sm);background:var(--cl-paper-0);font:var(--cl-text-mono);font-size:11.5px;color:var(--cl-ink-3)}
.rc-file.is-open{border-style:solid;border-color:var(--cl-carbon);background:var(--cl-carbon-wash);color:var(--cl-ink)}
.rc-lane{display:grid;gap:8px;padding:12px 13px;border:1px solid var(--cl-rule);border-radius:var(--cl-radius-md);background:var(--cl-paper-1)}
.rc-lane-top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
.rc-quote{margin:0;font:var(--cl-text-small);color:var(--cl-ink)}
.rc-strikes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}
@media (max-width:520px){.rc-strikes{grid-template-columns:minmax(0,1fr)}}
.rc-strike{padding:7px 9px;border:1px dashed var(--cl-edge);border-radius:var(--cl-radius-sm);background:var(--cl-paper-0);font:var(--cl-text-mono);font-size:11px;color:var(--cl-ink-3)}
.rc-strike b{display:block;color:var(--cl-ink-2);margin-bottom:2px}
.rc-dead{opacity:.62}
.rc-dead p{text-decoration:line-through;text-decoration-color:var(--cl-bad)}
.rc-how{list-style:none;margin:0;padding:0;display:grid;gap:12px;counter-reset:hw}
.rc-how li{counter-increment:hw;display:grid;grid-template-columns:26px minmax(0,1fr);gap:11px;align-items:start;font:var(--cl-text-small);color:var(--cl-ink-2)}
.rc-how li::before{content:counter(hw);width:26px;height:26px;border-radius:50%;display:grid;place-items:center;border:1.5px solid var(--cl-carbon);background:var(--cl-carbon-wash);font:700 11.5px/1 var(--cl-font-mono);color:var(--cl-ink)}
.rc-how b{display:block;margin-bottom:2px;font:var(--cl-text-body);font-weight:650;color:var(--cl-ink)}
.rc-foot{margin:6px 4px 0;font:var(--cl-text-small);color:var(--cl-ink-2)}
.sv-sheet{fill:var(--cl-paper-1);stroke:var(--cl-edge);stroke-width:1.4}
.sv-dim{fill:var(--cl-paper-1);stroke:var(--cl-rule-strong);stroke-width:1.2;opacity:.55}
.sv-hit{fill:var(--cl-carbon-wash);stroke:var(--cl-carbon);stroke-width:1.6}
.sv-note{fill:var(--cl-sticky);stroke:var(--cl-sticky-edge);stroke-width:1.5}
.sv-strip{fill:var(--cl-sticky-strip)}
.sv-ask{fill:var(--cl-ink)}
.sv-ask-t{fill:var(--cl-on-ink);font:600 10px var(--cl-font-sans)}
.sv-ask-s{fill:var(--cl-on-ink);opacity:.78;font:500 8.5px var(--cl-font-mono)}
.sv-dash{fill:none;stroke:var(--cl-edge);stroke-width:1.4;stroke-dasharray:3 3}
.sv-dash-hit{fill:none;stroke:var(--cl-ink);stroke-width:1.6;stroke-dasharray:3 3}
.sv-link{fill:none;stroke:var(--cl-carbon);stroke-linecap:round}
.sv-ok-line{fill:none;stroke:var(--cl-ok);stroke-width:2.4;stroke-linecap:round}
.sv-axis{fill:none;stroke:var(--cl-edge);stroke-width:1.3}
.sv-dash-c{fill:none;stroke:var(--cl-carbon);stroke-width:1.5;stroke-dasharray:4 3}
.sv-sheet-c{fill:var(--cl-paper-1);stroke:var(--cl-carbon);stroke-width:1.4;stroke-dasharray:4 3}
.sv-st{fill:var(--cl-paper-1);stroke:var(--cl-ok);stroke-width:1.8}
.sv-stt{fill:var(--cl-ok);font:700 9.5px var(--cl-font-mono);letter-spacing:.1em}
.sv-lbl{fill:var(--cl-ink-3);font:600 8.5px var(--cl-font-mono);letter-spacing:.08em}
.sv-lbl-c{fill:var(--cl-carbon);font:700 9px var(--cl-font-mono)}
.sv-mono{fill:var(--cl-ink);font:600 10px var(--cl-font-mono)}
.sv-txt{fill:var(--cl-ink);font:500 10px var(--cl-font-sans)}
.sv-sub{fill:var(--cl-ink-3);font:500 8.8px var(--cl-font-mono)}
.sv-ok{fill:var(--cl-ok);font:700 9px var(--cl-font-mono)}
.sv-dot{fill:var(--cl-carbon)}
.sv-dot-ok{fill:var(--cl-ok)}
.sv-ant{fill:var(--cl-ink);stroke:var(--cl-ink);stroke-width:1.1;stroke-linecap:round}
`;

const antSvg = (x, y, deg) => `<g class="sv-ant" transform="translate(${x} ${y}) rotate(${deg})">` +
  `<ellipse cx="-4.5" cy="0" rx="2.5" ry="1.8"/><ellipse cx="0" cy="0" rx="1.8" ry="1.3"/><ellipse cx="4" cy="0" rx="2" ry="1.5"/>` +
  `<path d="M-2 -1.3L-3.5 -3.6M-2 1.3L-3.5 3.6M0 -1.3L0 -3.8M0 1.3L0 3.8M2 -1.3L3.5 -3.6M2 1.3L3.5 3.6M5.6 -.7L7.6 -2.4M5.6 .7L7.6 2.4" fill="none"/></g>`;

const SPREAD_SVG = `<svg viewBox="0 0 460 212" role="img" aria-label="Your webhook prompt matches billing/webhooks.ts by wording, then follows a co-use link from past chats to pull in the stripe listen testing rule">` +
  `<text class="sv-lbl" x="50" y="15" text-anchor="middle">PROMPT</text>` +
  `<text class="sv-lbl" x="190" y="15" text-anchor="middle">WORDING HITS</text>` +
  `<text class="sv-lbl" x="381" y="15" text-anchor="middle">PULLED IN BY LINK</text>` +
  `<path class="sv-dash" d="M90 110L118 48"/>` +
  `<path class="sv-dash-hit" d="M90 122L118 124"/>` +
  `<rect class="sv-ask" x="10" y="96" width="80" height="48" rx="8"/>` +
  `<text class="sv-ask-t" x="50" y="117" text-anchor="middle">"webhook"</text>` +
  `<text class="sv-ask-s" x="50" y="132" text-anchor="middle">your prompt</text>` +
  `<rect class="sv-dim" x="118" y="26" width="144" height="42" rx="5"/>` +
  `<text class="sv-txt" x="127" y="44">Billing table schema</text>` +
  `<text class="sv-sub" x="127" y="58">too broad · skipped</text>` +
  `<rect class="sv-hit" x="118" y="96" width="144" height="56" rx="5"/>` +
  `<text class="sv-mono" x="127" y="117">billing/webhooks.ts</text>` +
  `<text class="sv-sub" x="127" y="133">matched "webhook"</text>` +
  `<path class="sv-link" stroke-width="3.2" d="M262 120Q287 90 312 120"/>` +
  `<text class="sv-lbl-c" x="287" y="84" text-anchor="middle">used together</text>` +
  `<rect class="sv-note" x="312" y="96" width="138" height="56" rx="4"/>` +
  `<rect class="sv-strip" x="312" y="96" width="138" height="8"/>` +
  `<text class="sv-mono" x="320" y="118">Run stripe listen</text>` +
  `<text class="sv-txt" x="320" y="133">or local tests 400</text>` +
  `<text class="sv-sub" x="320" y="146">0 shared words</text>` +
  `<g transform="rotate(-4 190 178)"><rect class="sv-st" x="164" y="168" width="52" height="20" rx="3"/><text class="sv-stt" x="190" y="181.5" text-anchor="middle">USED</text></g>` +
  `<g transform="rotate(-4 381 178)"><rect class="sv-st" x="355" y="168" width="52" height="20" rx="3"/><text class="sv-stt" x="381" y="181.5" text-anchor="middle">USED</text></g>` +
  `</svg>`;

const DECAY_SVG = `<svg viewBox="0 0 460 198" role="img" aria-label="A paused side project stays warm across a 30-day vacation with zero recalls, while an ignored temporary note in an active repo cools into sleep">` +
  `<path class="sv-axis" d="M54 22V158H444"/>` +
  `<text class="sv-lbl" x="46" y="48" text-anchor="end">WARM</text>` +
  `<text class="sv-lbl" x="46" y="148" text-anchor="end">ASLEEP</text>` +
  `<path class="sv-ok-line" d="M60 44H436"/>` +
  `<circle class="sv-dot-ok" cx="60" cy="44" r="4"/><circle class="sv-dot-ok" cx="436" cy="44" r="4"/>` +
  `<text class="sv-ok" x="68" y="35">30-day vacation on side project (0 recalls): stays warm</text>` +
  `<path class="sv-link" stroke-width="2.4" d="M60 80Q138 106 208 112L222 68Q314 94 436 102"/>` +
  `<circle class="sv-dot" cx="222" cy="68" r="4"/>` +
  `<text class="sv-lbl-c" x="230" y="68">used again → warms back up</text>` +
  `<path class="sv-dash" d="M60 108Q112 150 436 151"/>` +
  `<text class="sv-sub" x="164" y="132">Old "freeze deploys" note → sleeps (still searchable)</text>` +
  `<text class="sv-sub" x="76" y="176" text-anchor="middle">Recall #1</text>` +
  `<text class="sv-sub" x="248" y="176" text-anchor="middle">Recall #20</text>` +
  `<text class="sv-sub" x="420" y="176" text-anchor="middle">Recall #40</text>` +
  `</svg>`;

const ANTS_SVG = `<svg viewBox="0 0 460 212" role="img" aria-label="Ants reinforce useful link paths on past queries while candidate rankers run in shadow behind live search">` +
  `<text class="sv-lbl" x="230" y="14" text-anchor="middle">1. ANTS TEST WHICH LINK TYPES REACH USEFUL NOTES</text>` +
  `<path class="sv-dash" d="M88 68L178 92M282 92L372 68"/>` +
  `<path class="sv-link" stroke-width="3.6" d="M88 54L178 34M282 34L372 54"/>` +
  `${antSvg(130, 44, -12)}${antSvg(316, 42, 12)}${antSvg(344, 48, 12)}` +
  `<rect class="sv-sheet" x="16" y="44" width="72" height="34" rx="6"/><text class="sv-mono" x="52" y="65" text-anchor="middle">Query</text>` +
  `<rect class="sv-hit" x="178" y="20" width="104" height="26" rx="5"/><text class="sv-mono" x="230" y="36.5" text-anchor="middle">used together</text>` +
  `<rect class="sv-dim" x="178" y="80" width="104" height="24" rx="5"/><text class="sv-sub" x="230" y="95" text-anchor="middle">broad repo link</text>` +
  `<rect class="sv-note" x="372" y="42" width="74" height="38" rx="4"/><rect class="sv-strip" x="372" y="42" width="74" height="7"/>` +
  `<text class="sv-mono" x="409" y="66" text-anchor="middle">Used note</text>` +
  `<text class="sv-lbl" x="230" y="126" text-anchor="middle">2. NEW RANKERS RACE IN SHADOW BEFORE GOING LIVE</text>` +
  `<rect class="sv-note" x="16" y="152" width="76" height="36" rx="4"/><rect class="sv-strip" x="16" y="152" width="76" height="7"/>` +
  `<text class="sv-mono" x="54" y="175" text-anchor="middle">Your chat</text>` +
  `<path class="sv-link" stroke-width="2.2" d="M92 164L126 149"/>` +
  `<path class="sv-dash-c" d="M92 176L126 191"/>` +
  `<rect class="sv-sheet" x="126" y="134" width="320" height="30" rx="5"/>` +
  `<text class="sv-txt" x="136" y="153">Live search answers your agent right away</text>` +
  `<rect class="sv-sheet-c" x="126" y="174" width="320" height="30" rx="5"/>` +
  `<text class="sv-sub" x="136" y="193">Shadow ranker: 0% live risk · rolls back if picks slip</text>` +
  `</svg>`;

const rcSlide = (step, tab, title, stage, cap, points) => `<article class="cl-card rc-slide" data-step="${step - 1}">
<div class="rc-head"><span class="cl-chip cl-chip--carbon">${step} of 6 · ${esc(tab)}</span><h3>${esc(title)}</h3></div>
<div class="rc-body"><div class="rc-stage">${stage}<p class="rc-cap">${esc(cap)}</p></div>
<ol class="rc-how">${points.map(([lead, body]) => `<li><span><b>${esc(lead)}</b>${body}</span></li>`).join("")}</ol></div></article>`;

const WALK_STEPS = ["1. Connected notes", "2. Compact context", "3. 3-recall trial", "4. Pushback", "5. No vacation rot", "6. Ants & shadow tests"];

const RECALLS = [
  rcSlide(1, "Connected notes", "It grabs the related rule you didn't think to ask for.",
    SPREAD_SVG,
    "Search matches one note by wording, then walks links from past chats to pull in the second.",
    [
      ["Plain search only matches your words.", `You ask Claude to add a Stripe webhook. You never said "listen" or "test," so search finds <code>billing/webhooks.ts</code> and misses your <code>stripe listen</code> note.`],
      ["Related notes ride in together.", "Earlier billing chats used those two notes together, so spreading activation pulls the testing note in right behind the webhook file."],
      ["Your agent skips a 20-minute trap.", "Claude writes the handler and starts the local listener before running tests, without you having to remind it."],
    ]),
  rcSlide(2, "Compact context", "It keeps 14-page specs out of a 2-line CSS chat.",
    `<div class="rc-chat"><div class="rc-who"><span>Claude · today</span><span>Quick UI fix</span></div>
<div class="rc-ask">Fix the padding on the sign-in button.</div>
<div class="cl-sticky rc-note"><p>"Auth rewrite moves sessions to HttpOnly cookies. Spec and bug screenshot attached."</p><small>112 of 500 chars · loaded in recall</small></div>
<div class="rc-files"><span class="rc-file">auth-spec.md · 14 pages (left on side)</span><span class="rc-file">login-bug.png · 1.4 MB (left on side)</span></div></div>
<div class="rc-chat"><div class="rc-who"><span>Codex · tomorrow</span><span>Backend work</span></div>
<div class="rc-ask">Build the session cookie swap from the auth plan.</div>
<div class="rc-files"><span class="rc-file is-open">auth-spec.md · opened on demand</span><span class="cl-stamp cl-stamp--ok">Used</span></div></div>`,
    "Every recall stays light. Heavy plans, logs, and screenshots open only when an agent asks for them.",
    [
      ["Dumping everything into chat slows agents down.", "Pasting long specs and logs into a rules file makes every chat wade through thousands of lines just to fix a button."],
      ["Notes stay short, files wait on the side.", "Notes cap at 500 characters, just enough to state the call. Full plans, logs, and screenshots attach on the side rather than riding in every prompt."],
      ["Heavy files open only when needed.", "Today's CSS fix reads two lines and moves on. Tomorrow's backend chat opens the 14-page auth spec on demand."],
    ]),
  rcSlide(3, "3-recall trial", "One wrong guess from an agent doesn't become law.",
    `<div class="rc-lane"><div class="rc-lane-top"><span class="cl-label">Your exact words in chat</span><span class="cl-stamp cl-stamp--ok">Settled day one</span></div>
<p class="rc-quote">"Never mock Postgres in integration tests."</p></div>
<div class="rc-lane"><div class="rc-lane-top"><span class="cl-label">Agent's own hunch (saw 1 old file)</span><span class="cl-chip">On trial · 3 chances</span></div>
<p class="rc-quote">"This repo runs its tests on Jest."</p>
<div class="rc-strikes"><div class="rc-strike"><b>Recall 1</b>Checks repo, sees Vitest, skips</div><div class="rc-strike"><b>Recall 2</b>Skipped again</div><div class="rc-strike"><b>Recall 3</b>Drops out on its own</div></div></div>`,
    "Quoted facts from your session start trusted. Agent hunches get 3 recalls to earn their spot or drop out.",
    [
      ["Agents love saving confident bad guesses.", "An agent spots one old helper file, decides your Vitest repo uses Jest, and writes that guess into memory like a rule."],
      ["Unquoted hunches start on a 3-recall trial.", "Facts backed by your own words in chat start settled day one. Anything an agent infers on its own gets three recalls to prove it helps."],
      ["Bad guesses clean themselves out.", "When the next three test tasks skip the Jest hunch, Clyde drops it on its own. Useful hunches get used and stay."],
    ]),
  rcSlide(4, "Pushback", "Snap at your agent once to fix it for good.",
    `<div class="rc-chat"><div class="rc-who"><span>Claude Code · terminal</span><span>Stale note recalled</span></div>
<div class="cl-sticky rc-note rc-dead"><p>"Deploy staging with ./scripts/push-stage.sh"</p><small>Docked after your reply</small></div>
<p class="rc-agent">Running <code>./scripts/push-stage.sh</code>...</p>
<div class="rc-ask">Stop, that script died in May. GitHub Actions deploys staging on push now.</div>
<div class="cl-sticky rc-note"><div class="rc-lane-top"><p>"Staging deploys via GitHub Actions on push."</p><span class="cl-stamp cl-stamp--ok">Replaces old</span></div></div></div>`,
    "When your next message pushes back, Clyde demotes the note that misled the agent and saves the fix over it.",
    [
      [`Saying "stop" usually fixes only today's window.`, "You tell an agent to stop running a dead deploy script, and the old note still sits in memory waiting to trip up tomorrow's chat."],
      ["Your pushback docks the note behind the mistake.", `Agents politely report that lots of notes "helped." Your next reply is the real signal, so snapping back demotes the note that misled it.`],
      ["Fixed once across every app.", "Your correction replaces the dead note, so Codex on your laptop and Claude on your phone both stop running that script."],
    ]),
  rcSlide(5, "No vacation rot", "Going on vacation doesn't wipe your side project.",
    DECAY_SVG,
    "Decay counts recalls rather than calendar days, so paused projects stay warm and cold clutter goes to sleep.",
    [
      ["Calendar timers punish you for taking a break.", "Expire notes after 30 days and a month off wipes your side project. Never fade anything and February's deploy freeze clutters November's chats."],
      ["Notes cool on recalls, not calendar days.", "A note cools down only when recalls run and agents keep walking past it. Leave a repo untouched for a month and nothing fades."],
      ["Old clutter goes to sleep, never to the trash.", "Ignored one-off notes step out of everyday recalls in busy repos, and stay searchable whenever you ask an agent to dig back."],
    ]),
  rcSlide(6, "Ants & shadow tests", "Search tunes itself in the background, never on live chats.",
    ANTS_SVG,
    "An ant colony tests link weights offline and new rankers run in shadow first, with plain weights kept whenever they tie.",
    [
      ["Not every link between notes means the same thing.", "Two notes used together in real fixes matter far more than two notes that just live in the same big repo."],
      ["Simulated ants test which links find useful notes.", "Ants replay past searches across your graph to weight the link types that reach helpful notes, and plain equal weights stay whenever they tie."],
      ["New rankers have to win in shadow first.", "Updates score recalls silently in the background with zero risk to live chats, ship only if agents use more picks, and roll back if picks slip."],
    ]),
];

const BUILT = `<section class="wrap built" id="built"><div class="section"><span class="cl-label">Why it holds up</span>
<h2 class="cl-title-1">Why it doesn't turn into a <em class="cl-scribble">junk drawer.</em></h2>
<p class="cl-lead">Saving notes is the easy part. Keeping bad guesses, giant files, and stale rules out of today's chat is the part most memory tools get wrong.</p></div>
<div class="rc" id="rc"><div class="rc-nav" hidden><div class="rc-steps">${WALK_STEPS.map((s, i) => `<button class="rc-pill" type="button" data-go="${i}"${i ? "" : ' aria-current="step"'}>${esc(s)}</button>`).join("")}</div>
<div class="rc-arrows"><button class="cl-btn cl-btn--sm" type="button" data-dir="-1" aria-label="Previous walkthrough">←</button><span class="rc-count">1 / ${RECALLS.length}</span><button class="cl-btn cl-btn--sm" type="button" data-dir="1" aria-label="Next walkthrough">→</button></div></div>
<div class="rc-track" tabindex="0" role="region" aria-label="${RECALLS.length} memory walkthroughs">${RECALLS.join("\n")}</div>
<p class="rc-foot"><a href="/how-it-works">How it works and the papers behind it</a> · <a href="/how-it-works#built">Numbers from building Clyde</a></p></div></section>`;
// Walkthrough tabs plus prev and next. Without script, the slides still scroll and snap, and the controls stay hidden.
const RECALL_JS = `(function(){var r=document.getElementById('rc');if(!r)return;var t=r.querySelector('.rc-track'),s=t.children,n=s.length,v=r.querySelector('.rc-nav'),` +
  `c=v.querySelector('.rc-count'),p=v.querySelectorAll('[data-go]'),b=v.querySelectorAll('[data-dir]'),k=0,tm;function w(){return n>1?s[1].offsetLeft-s[0].offsetLeft:1}` +
  `function at(){return Math.max(0,Math.min(n-1,Math.round(t.scrollLeft/w())))}` +
  `function show(i){c.textContent=(i+1)+' / '+n;b[0].setAttribute('aria-disabled',i===0);b[1].setAttribute('aria-disabled',i===n-1);p.forEach(function(x,j){if(j===i)x.setAttribute('aria-current','step');else x.removeAttribute('aria-current')})}` +
  `function to(i){k=Math.max(0,Math.min(n-1,i));show(k);t.scrollLeft=k*w()}` +
  `b[0].addEventListener('click',function(){to(k-1)});b[1].addEventListener('click',function(){to(k+1)});` +
  `p.forEach(function(x){x.addEventListener('click',function(){to(Number(x.getAttribute('data-go')))})});` +
  `t.addEventListener('scroll',function(){clearTimeout(tm);tm=setTimeout(function(){k=at();show(k)},120)},{passive:true});v.hidden=false;show(0)})();`;

// R73 (#78): real complaints about agents that forget, each paraphrased with a link to where it was posted, and what
// Clyde does about it. Then two made-up ones in the same spirit. listing_check.py "complaint sources" checks every src.
const COMPLAINTS = [
  { q: "Explaining the same thing across a thousand conversations.", guide: "/guides/stop-repeating-yourself", src: "https://www.reddit.com/r/ClaudeAI/comments/1kpdoia/megathread_for_claude_performance_discussion/", site: "reddit.com/r/ClaudeAI",
    a: "Your agent recalls the note when a chat starts, so you say it once." },
  { q: "Claude keeps making the mistake I already corrected.", guide: "/guides/same-mistake-again", src: "https://claudelab.net/en/articles/claude-ai/claude-keeps-making-same-mistake-fix", site: "claudelab.net",
    a: "Your correction is saved as a note, and it comes back next time." },
  { q: "ChatGPT says it saved my preference, but the next chat doesn't have it.", guide: "/guides/chatgpt-forgets", src: "https://community.openai.com/t/fails-to-update-memory-even-though-it-says-it-has/987812", site: "community.openai.com",
    a: "Remember returns the note's ID, so you can check it was saved." },
  { q: "We moved to pnpm, and Claude Code still runs npm from an old note.", guide: "/guides/outdated-instructions", src: "https://www.besthub.dev/articles/why-claude-code-still-runs-npm-after-you-switched-to-pnpm-the-memory-invalidation-problem-e9a0e83509b7", site: "besthub.dev",
    a: "The new note replaces the old one." },
  { q: "ChatGPT and Claude have no idea what the other one said.", guide: "/guides/share-memory-claude-chatgpt", src: "https://dev.to/doremi/the-pain-of-switching-ai-platforms-and-how-i-fixed-it-for-myself-44h2", site: "dev.to",
    a: "Both apps read the same notes." },
  { q: "“Cursor with Claude has memory of a goldfish.”", guide: "/guides/claude-code-forgets", src: "https://forum.cursor.com/t/cursor-with-claude-has-memory-of-a-goldfish/118276", site: "forum.cursor.com",
    a: "Somebody already wrote our headline." },
  { q: "My rules get lost in a long CLAUDE.md.", guide: "/guides/claude-md-too-long", src: "https://dev.to/docat0209/5-patterns-that-make-claude-code-actually-follow-your-rules-44dh", site: "dev.to",
    a: "Recall returns only the few notes that match what you're doing." },
];
const MADE_UP = [
  ["For the last time, Bob only likes sage green.", "Bob only likes sage green. He called olive \"an abhorrent goose-shit-adjacent color.\""],
  ["It's Kat. With a K.", "Kat spells it with a K. She called the C version \"some other, worse person.\""],
];
const WALL_CSS = `
.cm-wall{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin-bottom:76px}
.complaint,.complaint-made{display:grid;gap:8px;align-content:start}
@media (max-width:900px){.cm-wall{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (max-width:560px){.cm-wall{grid-template-columns:minmax(0,1fr)}}
.cm-q{padding:14px 16px;transform:rotate(-1deg)}.cm-wall>:nth-child(even) .cm-q{transform:rotate(1.2deg)}
.cm-q p{margin:0 0 6px;font:var(--cl-text-body);color:var(--cl-ink)}
.cm-q a,.cm-made{font:var(--cl-text-mono);font-size:11px;color:var(--cl-ink-3)}
.clyde-says{padding:12px 14px;font:var(--cl-text-small);color:var(--cl-ink-2)}
.clyde-says b{display:block;font:var(--cl-text-label);letter-spacing:.06em;text-transform:uppercase;color:var(--cl-carbon);margin-bottom:4px}
`;
const says = (a, guide) => `<div class="clyde-says cl-card"><b>With Clyde</b>${esc(a)}${guide ? ` <a class="cm-guide" href="${guide}">Read the guide</a>` : ""}</div>`;
const WALL = `<section class="wrap" id="complaints"><div class="section"><span class="cl-label">Real complaints</span><h2 class="cl-title-1">Things people keep telling their agents.</h2></div>
<div class="cm-wall">${COMPLAINTS.map((c) => `<article class="complaint" data-guide="${c.guide}"><div class="cl-sticky cm-q"><p>${esc(c.q)}</p><a href="${c.src}" rel="nofollow noopener noreferrer">${c.site}</a></div>${says(c.a, c.guide)}</article>`).join("")}
${MADE_UP.map(([q, a]) => `<article class="complaint-made"><div class="cl-sticky cm-q"><p>${esc(q)}</p><span class="cm-made">made up</span></div>${says(a)}</article>`).join("")}</div></section>`;

const HONEST = `<section class="wrap honest-wrap" id="honest">
<div class="cl-sticky cl-sticky--tilt honest">
<div class="honest-copy"><div class="honest-top"><span class="cl-label">Fair warning</span></div>
<h2 class="cl-title-1">This is not <s class="strike">advanced technology</s>. It's probably not even very secure 😶</h2>
<p>It's Postgres, some embeddings and an MCP URL taped together. <b class="hl hl--red">Use with caution.</b> Put normal context and preferences in it. The point is that next week your agent still remembers you called the Q3 roadmap <b class="hl hl--violet">a dumpster fire</b>.</p></div>
<div class="honest-art">${SCENE_IMG("nosecrets", "Clyde holding up a palm next to a crossed-out padlock and key", 152, 186)}</div>
</div></section>`;

const PLANS = `<section class="wrap" id="pricing"><div class="section"><span class="cl-label">Pricing</span>
<h2 class="cl-title-1">The free tier is <span class="hl hl--red">pretty useless</span>. Try it for $12.99.</h2></div>
<div class="plans">
<article class="cl-sticky cl-sticky--tilt-r plan"><span class="cl-label">Free</span><div class="price"><b>$0</b><span>first 1,000 users (10 open, +10/paid seat)</span></div>
<ul><li>100 stored notes, 250K tokens/mo (shared $5/mo pool)</li><li>300 recalls and 50 writes / month</li><li>2 computers, no credit card required</li><li class="no">No file attachments or quest board</li></ul></article>
<article class="cl-card plan pick"><span class="cl-label">Clyde</span><div class="price"><b>$12.99</b><span>a month</span></div>
<ul><li>2,000 recalls and 500 writes / month</li><li>5 GB storage for logs, docs, and screenshots</li><li>1.5M tokens / month for search and screening</li>
<li>10 computers, all apps, and the quest board</li><li>Overage is 2.3x raw cost, up to a $20/mo spend limit by default</li></ul></article>
</div></section>`;

// The app picker: radio inputs and labels, no script. Each panel is that app's steps from pages.js (appSteps).
const PICK = ["claude-ai", "agent-setup", "claude-code", "antigravity", "gemini", "grok", "chatgpt", "other"].map(appSteps);
const PICK_CSS = `
#how{margin-bottom:84px}
#how .soon-note{margin-top:16px}
#how .pick-more{margin:12px 0 0;font:var(--cl-text-small);color:var(--cl-ink-2)}
.pick{position:relative}
.pick-in{position:absolute;top:0;left:0;width:1px;height:1px;margin:0;opacity:0;pointer-events:none}
.pick-tabs{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:18px}
.pick-tabs label{display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 14px;border:1px solid var(--cl-rule-strong);border-radius:var(--cl-radius-pill);background:var(--cl-paper-1);font:500 14px/1 var(--cl-font-sans);color:var(--cl-ink-2);cursor:pointer}
.pick-tabs label:hover{border-color:var(--cl-ink-3);color:var(--cl-ink)}
.pick-tabs img{display:block;width:20px;height:20px;object-fit:contain}
.pick-panel{display:none;max-width:640px}
${PICK.map(({ id }) => `#pick-${id}:checked~.pick-tabs [for="pick-${id}"]`).join(",")}{border-color:var(--cl-ink);background:var(--cl-sticky);color:var(--cl-ink);font-weight:650;box-shadow:var(--cl-copy-2);transform:translate(-2px,-2px)}
${PICK.map(({ id }) => `#pick-${id}:focus-visible~.pick-tabs [for="pick-${id}"]`).join(",")}{outline:2px solid var(--cl-carbon);outline-offset:3px}
${PICK.map(({ id }) => `#pick-${id}:checked~.pick-panels [data-pick="${id}"]`).join(",")}{display:flex}
.end-cta{display:flex;justify-content:center;padding-block:32px 64px}
`;
const SETUP = `<section class="wrap" id="how"><div class="section"><span class="cl-label">Setup</span><h2 class="cl-title-1">Pick your app.</h2></div>
<div class="pick" role="radiogroup" aria-label="App">${PICK.map(({ id }, i) => `<input class="pick-in" type="radio" name="pick" id="pick-${id}"${i ? "" : " checked"}>`).join("")}
<div class="pick-tabs">${PICK.map(({ id, logo, name }) => `<label for="pick-${id}">${appLogo(logo, 20)}${name}</label>`).join("")}</div>
<div class="pick-panels">${PICK.map(({ id, body }) => `<div class="cl-card app pick-panel" data-pick="${id}">${body}</div>`).join("\n")}</div></div>
<p class="pick-more">After connecting, <a href="/docs#hooks">set up hooks</a> where supported and <a href="/docs#instructions">paste the Clyde rule</a> into your app's instructions.</p>
${SOON_NOTE}</section>`;
const END_CTA = `<section class="wrap end-cta"><a class="cl-btn cl-btn--primary cl-btn--lg" href="${CONNECT}">Try Clyde</a></section>`;

// The hero and the warning are Wen's own words, as he wrote them. Copy passes leave them alone.
function home(nonce) {
  const works = WORKS.map(([slug, name]) => `<li>${APP_LOGO[slug] ? appLogo(slug, 20) : ""}${name}${SOON.has(slug) ? '<span class="soon" aria-label="work in progress">*</span>' : ""}</li>`).join("");
  return page(nonce, {
    title: "Clyde · AI agent memory, message board and coordination", path: "/",
    description: "Your AI agents have goldfish memory. Clyde is a shared MCP memory, message board and quest board for Claude, ChatGPT, Gemini, Codex and Grok.",
    css: HERO_CSS + SCENE_CSS + APP_STEPS_CSS + SITE_HOME_CSS + RECALL_CSS + PICK_CSS + WALL_CSS, script: RECALL_JS, jsonld: HOME_LD, main: `<main>
<section class="hero site-hero wrap"><div class="hero-text">
<h1 class="cl-display hero-h1">Your agents have the memory of a <em class="cl-scribble">goldfish.</em></h1>
<p class="cl-lead">For some reason, the best memory AI has to offer is <b class="hl">a few Word documents with stuff stuck in them</b>. Your agents can't remember what happened last time. They can't talk to each other across <b class="hl hl--blue">computers, projects or apps</b>.</p>
<p class="cl-lead">I don't know how the big AI shops haven't figured this out yet. So <s class="strike">I built</s> agents slopped together Clyde. <b class="hl hl--green">It'll do until the big bois and gals get their shit together.</b></p>
<div class="cta">${ARROW_SVG}<a class="cl-btn cl-btn--primary cl-btn--lg" href="${CONNECT}">Get Clyde</a><a class="cl-btn cl-btn--ghost cl-btn--lg" href="/how-it-works">How it works</a></div>
<div class="works"><span class="cl-label">Connects to</span><ul>${works}</ul>${SOON_NOTE}</div></div>
<div class="mascot-stage"><div class="mascot-row">${SCENE_IMG("goldfish", "Clyde staring at a goldfish in a bowl", 153, 178)}</div>${SCENE}</div></section>
${FEATURES}
${WALL}
${BUILT}
${HONEST}
${SETUP}
${PLANS}
${END_CTA}
</main>`,
  });
}

// ---- Docs ----

const EXPORT_DELETE = `<p><b>Export:</b> Email ${MAIL} from your account email. We'll send a JSON archive of your notes, tasks, messages, and files within 30 days, usually within a week.</p>
<p><b>Delete:</b> Email ${MAIL} from your account email to delete specific notes or your entire account. Live data is deleted within 30 days, and encrypted backups expire 30 days after that. Self-serve export and deletion in Settings is coming soon.</p>`;

const DOCS = `<main class="doc doc--wide wrap">${hero("Docs", "Install <em>Clyde</em>",
  "Run one command. It connects Clyde, signs you in by email, and installs the hooks that make Clyde your agent's only memory. Then register, and restart your app.",
  SCENE_IMG("relay", "Clyde passing a sticky note from a chat window to a terminal", 230, 133), "")}
<nav class="toc" aria-label="On this page"><a href="#agent-setup">Agent setup</a><a href="#hooks">Set up hooks</a><a href="#hook-configs">The hook configs</a><a href="#instructions">System instructions</a><a href="#support">Support</a></nav>
<p><b>Coding apps, one command.</b> Claude Code, Codex, Gemini CLI, and Antigravity: run this, click the sign-in link, restart. It connects Clyde as <code>clyde</code>, removes old <code>memory</code> and <code>kb</code> entries, installs the hooks, and turns off each app's own memory. Rerun it any time. It changes nothing the second time.</p>
${copyBox(INSTALL)}
<p><b>Register first, everywhere.</b> The first Clyde call in any app is <code>register_agent</code> (name, context, surface, description, computer, type, projects). In coding apps the hooks refuse every other tool until it happens.</p>
${copyBox(MCP)}
<div class="apps">${appCards()}</div>${SOON_NOTE}
<h2 id="hooks">Set up hooks</h2>
<p>The hooks are required, not optional. Rules ask nicely. Hooks don't. Without them your agent goes back to its own memory and forgets the rest. The installer wires them in Antigravity, Claude Code, Codex, and Gemini CLI, and each card above shows its app's exact config.</p>
<p>Every Clyde hook follows these rules:</p>
<ul><li><b>Session start (<code>SessionStart</code>).</b> Fires once when a conversation opens. Says Clyde is the agent's only memory, checks unread messages and open quests, and, when this app hasn't registered, tells the agent to call <code>register_agent</code> first.</li>
<li><b>New prompt (<code>UserPromptSubmit</code>, <code>BeforeAgent</code>, <code>PreInvocation</code>).</b> On a session's first task, a folder switch, a 20-minute idle gap, or an unrelated topic shift, tells the agent to call <code>recall</code> and opens a recall debt. Stays silent on quick follow-ups (<code>"push it"</code>, <code>"fix line 4"</code>, screenshots), recent recalls, and mid-turn Antigravity <code>PreInvocation</code> steps with unchanged <code>lastUserInput</code>.</li>
<li><b>The gate (<code>PreToolUse</code>, <code>BeforeTool</code>, every tool).</b> While a registration or recall is owed, every tool but <code>register_agent</code>, <code>recall</code>, <code>recall_more</code>, and <code>ToolSearch</code> is refused, with the reason. A debt expires after 20 minutes, so an outage never locks a session. Writes to the app's own memory files (Claude Code's auto memory, Codex memories, Antigravity knowledge, Gemini's <code>save_memory</code>) are always refused.</li>
<li><b>Subagent guard (<code>PreToolUse</code> on <code>invoke_subagent</code>).</b> Antigravity runs hooks inside subagents too, so the hook records spawned prompts and keeps subagents quiet and ungated.</li>
<li><b>After MCP tool (<code>PostToolUse</code>, <code>AfterTool</code>).</b> Acts on Clyde's tools only. A <code>recall</code> pays the debt, a <code>register_agent</code> marks the app registered, and writes get tagged with your git repo and computer.</li>
<li><b>Turn end (<code>Stop</code>, <code>AfterAgent</code>).</b> Never blocks stopping (<code>{"decision":"allow"}</code> in Antigravity, <code>{}</code> in Codex and Gemini CLI, empty output in Claude Code). With a device token, forwards the turn summary to <code>/hooks</code> so Clyde catches pushback on your next prompt.</li>
<li><b>Fail open and work machines.</b> Always exits <code>0</code> under 3 seconds, and gates locally even with OAuth and no device token. Run <code>MEMORY_HOOKS=metadata ${INSTALL}</code> on work machines to send session IDs and folder names without prompt text.</li></ul>
<h2 id="hook-configs">The hook configs</h2>
<p>The installer (<code>${INSTALL}</code>) writes all of this. To do it by hand, install the shared hook script at <code>${HOOK_PATH}</code>, then merge each app's config. The script holds the nudge, the gate, and the memory-file guard. <code>${GATE_URL}</code> is a shim for settings that still name the old gate script.</p>
${copyBox(HOOK_INSTALL)}
<div class="hook-src">${copyPre(HOOK_PATH, CLYDE_HOOK_SH)}</div>
<p>Wire that script into each hook-capable app on your machine:</p>
<div class="tbl-wrap"><table><thead><tr><th>App</th><th>Global config</th><th>Workspace config</th><th>Reload or trust step</th></tr></thead><tbody>
<tr><td>Antigravity</td><td><code>~/.gemini/config/hooks.json</code></td><td><code>.agents/hooks.json</code></td><td>Check <b>Customizations → Hooks</b> (or <code>/hooks</code> in Antigravity CLI).</td></tr>
<tr><td>Claude Code</td><td><code>~/.claude/settings.json</code></td><td><code>.claude/settings.json</code></td><td>Restart Claude Code. In the marketplace plugin, set <code>hook_mode</code> to <code>full</code> or <code>metadata</code>. The same file sets <code>autoMemoryEnabled</code> to <code>false</code>.</td></tr>
<tr><td>Codex</td><td><code>~/.codex/hooks.json</code></td><td><code>.codex/hooks.json</code></td><td>Run <code>/hooks</code> once in Codex CLI to trust new or edited entries. <code>memories = false</code> under <code>[features]</code> in <code>~/.codex/config.toml</code>.</td></tr>
<tr><td>Gemini CLI</td><td><code>~/.gemini/extensions/clyde/hooks/hooks.json</code></td><td><code>.gemini/settings.json</code></td><td>Reloads on launch. Configure in one file only (the extension or <code>~/.gemini/settings.json</code>), not both.</td></tr>
</tbody></table></div>
<p><b>Antigravity (App, IDE, and CLI).</b> Antigravity puts group names at the top level and uses flat arrays on <code>SessionStart</code>, <code>PreInvocation</code>, and <code>Stop</code>. <code>PreInvocation</code> fires before every model step in a tool loop, so <code>clyde-hook.sh</code> hashes <code>lastUserInput</code> per conversation. Mid-turn steps, subagents, and quick follow-ups return <code>{}</code>, while new goals and folder switches inject one transient <code>ephemeralMessage</code>. <code>PreToolUse</code> runs the gate and answers <code>{"decision":"deny"}</code> while a debt is open.</p>
${copyPre("~/.gemini/config/hooks.json (or .agents/hooks.json)", ANTIGRAVITY_HOOKS_JSON)}
<p><b>Claude Code.</b> Merge this into <code>~/.claude/settings.json</code> alongside your existing settings. Plain text on <code>SessionStart</code> and <code>UserPromptSubmit</code> enters model context, <code>PreToolUse</code> on every tool is the gate, and <code>autoMemoryEnabled: false</code> turns off Claude Code's own memory.</p>
${copyPre("~/.claude/settings.json", CLAUDE_HOOKS_JSON)}
<p><b>Codex CLI.</b> Put this in <code>~/.codex/hooks.json</code>, then run <code>/hooks</code> once inside Codex CLI to trust the entries. <code>clyde-hook.sh</code> prints text on shifts, <code>{}</code> on <code>Stop</code>, and a deny decision from <code>PreToolUse</code> while a debt is open. Then turn off Codex memories in <code>~/.codex/config.toml</code>.</p>
${copyPre("~/.codex/hooks.json", CODEX_HOOKS_JSON)}
${copyPre("~/.codex/config.toml", CODEX_CONFIG_TOML)}
<p><b>Gemini CLI.</b> Gemini CLI hides plain-text hook output from the model, so <code>clyde-hook.sh</code> returns <code>hookSpecificOutput.additionalContext</code> on shifts, <code>{"decision":"deny"}</code> from <code>BeforeTool</code> while a debt is open, and <code>{}</code> otherwise. The installer puts this in <code>~/.gemini/extensions/clyde/hooks/hooks.json</code>. By hand, put it there or in <code>~/.gemini/settings.json</code>, not both.</p>
${copyPre("~/.gemini/extensions/clyde/hooks/hooks.json", GEMINI_HOOKS_JSON)}
<h2 id="instructions">Add system instructions</h2>
<p>The hooks do the enforcing. This rule is the backup: the installer adds it to <code>~/.claude/CLAUDE.md</code>, <code>~/.codex/AGENTS.md</code>, and <code>~/.gemini/GEMINI.md</code>. Web chat apps run no hooks, so there Clyde's server instructions carry it, and the rule is an optional extra.</p>
${copyPre("Clyde rule", CLYDE_RULE)}
<p>Put that rule where each app stores persistent instructions:</p>
<div class="tbl-wrap"><table><thead><tr><th>Platform</th><th>Where to add it</th><th>Notes</th></tr></thead><tbody>
<tr><td>Claude</td><td><b>Settings → Profile → Personal preferences</b></td><td>Also works in a Project's instructions on web, desktop, Cowork, and mobile.</td></tr>
<tr><td>Claude Code</td><td><code>~/.claude/CLAUDE.md</code> or <code>./CLAUDE.md</code></td><td>Backs up the <code>~/.claude/settings.json</code> hooks above.</td></tr>
<tr><td>Codex</td><td><code>~/.codex/AGENTS.md</code> or <code>./AGENTS.md</code></td><td>Backs up <code>~/.codex/hooks.json</code> above.</td></tr>
<tr><td>Antigravity</td><td><b>Customizations → Rules</b> or <code>.agents/rules/clyde.md</code></td><td>Set activation to <b>Model Decision</b> rather than <b>Always On</b>, so subagents and quick follow-ups stay clean.</td></tr>
<tr><td>Gemini CLI</td><td><code>~/.gemini/GEMINI.md</code></td><td>Antigravity also reads <code>~/.gemini/GEMINI.md</code> as Always On, so keep any rule there task-shift gated.</td></tr>
<tr><td>Gemini web</td><td><b>Settings → Saved info</b> on <code>gemini.google.com</code></td><td>Saves the rule to Gemini's persistent memory across web and phone chats.</td></tr>
<tr><td>ChatGPT</td><td><b>Settings → Personalization → Custom instructions</b></td><td>Or ask ChatGPT once in chat to save the rule to built-in Memory.</td></tr>
<tr><td>Grok</td><td><b>Customize Grok</b></td><td>Applies across new chats on <code>grok.com</code>.</td></tr>
</tbody></table></div>
<p>For Antigravity workspaces, save this file with <code>trigger: model_decision</code> frontmatter:</p>
${copyPre(".agents/rules/clyde.md (or .agent/rules/clyde.md)", ANTIGRAVITY_RULE)}
<h2 id="then">Keep notes short</h2>
<p>Keep notes under 500 characters and attach longer specs or logs as artifacts. Recall replies remind the agent to call <code>feedback</code> on what helped.</p>
<p>New notes start On trial for 3 recalls unless verified as facts, and unused notes fade by recall count rather than time. To export or delete your data, see the <a href="/privacy">Privacy policy</a>.</p>
<h2 id="support">Support</h2>
<p>Need help with billing, refunds, or setup? Email ${MAIL}.</p></main>`;

// ---- Research: only what memory/MODEL-PLAN.md and memory/LEARNING-PLAN.md cite. site_test.ts checks that. ----

const PAPERS = [
  ["Trial period", "MemCon and Towards Autonomous Memory Agents",
    [["arXiv 2607.13591", "https://arxiv.org/abs/2607.13591"], ["alphaXiv 2602.22406", "https://www.alphaxiv.org/abs/2602.22406"]],
    "Both papers explore new memories bandit-style. Clyde gives each new note a 3-recall trial, with no learned policy."],
  ["Reconsolidation window", "Memory reconsolidation",
    [["J Neurosci 2011", "https://pmc.ncbi.nlm.nih.gov/articles/PMC3069643"], ["NCBI Bookshelf", "https://ncbi.nlm.nih.gov/sites/books/NBK3905"]],
    "A recalled memory stays changeable for a short while and strengthens or weakens with the outcome. Clyde opens a similar window after each recall."],
  ["Feedback weighting", "RSCB-MC",
    [["arXiv 2604.27283", "https://arxiv.org/pdf/2604.27283"]],
    "Bandit-style memory systems amplify whatever feedback they get. Clyde trusts your corrections most and an agent saying a note \"helped\" least."],
  ["Event-based decay", "Oblivion",
    [["arXiv 2604.00131", "https://arxiv.org/html/2604.00131"]],
    "Oblivion counts decay in turns rather than clock time. Clyde counts recalls, so notes don't decay while you're away."],
  ["Frequency and recency", "ACT-R base-level activation (Taatgen, Lebiere, and Anderson)",
    [["PDF", "https://www.ai.rug.nl/~niels/publications/taatgenLebiereAnderson.pdf"]],
    "ACT-R scores an item by how often and how recently it was used. Clyde uses the same formula, counted in recalls rather than time."],
];

const PAPERS_HTML = PAPERS.map(([what, name, links, why], i) => `<article class="${i % 2 ? "cl-card" : "cl-sticky"} paper"><span class="cl-label">${what}</span><h3 class="cl-title-3">${name}</h3><p>${why}</p>
<span class="cite">${links.map(([label, href]) => `<a href="${href}" rel="noopener noreferrer">${label}</a>`).join(" · ")}</span></article>`).join("\n");

// ---- How it works ----

const HOW_CSS = `
.hw-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.hw-stats div{display:grid;gap:4px;align-content:start}
.hw-stats b{font:var(--cl-text-title-2);font-variant-numeric:tabular-nums}
.hw-stats span{font:var(--cl-text-small);color:var(--cl-ink-2)}
.hw-fig{margin:0;max-width:520px;display:grid;gap:10px}
.hw-fig svg{display:block;width:100%;height:auto}
.doc .hw-fig p,.hw-fig figcaption{font:var(--cl-text-mono);color:var(--cl-ink-2)}
.hw-fig figcaption{color:var(--cl-ink-3)}
.hw-e{stroke:var(--cl-rule-strong);stroke-width:1.5}
.hw-n{fill:var(--cl-paper-1);stroke:var(--cl-rule-strong);stroke-width:1.5}
.hw-lit{--f:var(--cl-carbon-wash);--s:var(--cl-carbon);fill:var(--f);stroke:var(--s);animation:hw-lit 20s infinite both}
.hw-seed{--f:var(--cl-sticky);--s:var(--cl-ink)}
.hw-hit{--f:var(--cl-carbon)}
.hw-pop{animation:hw-pop 20s infinite both}
.hw-ring{fill:none;stroke:var(--cl-carbon);stroke-width:1.5;stroke-dasharray:3 3}
.hw-st{fill:var(--cl-paper-1);stroke:var(--cl-ok);stroke-width:2}
.hw-stt{fill:var(--cl-ok);font:700 10px var(--cl-font-mono);letter-spacing:.12em}
.hw-t{fill:var(--cl-ink);font:500 10.5px var(--cl-font-mono)}
.hw-r{fill:var(--cl-ink-3);font:var(--cl-text-label);font-size:9px;letter-spacing:.1em}
.hw-d1{animation-delay:1.2s}.hw-d2{animation-delay:2s}.hw-d3{animation-delay:3.2s}.hw-d4{animation-delay:4s}.hw-d5{animation-delay:5.2s}
@keyframes hw-lit{0%,4%,71%,100%{fill:var(--cl-paper-1);stroke:var(--cl-rule-strong)}8%,66%{fill:var(--f);stroke:var(--s)}}
@keyframes hw-pop{0%,4%,71%,100%{opacity:0}8%,66%{opacity:1}}
@media (prefers-reduced-motion:reduce){.hw-lit,.hw-pop{animation:none}}
@media (max-width:720px){.hw-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

const HOW = `<main class="doc wrap">${hero("How it works", "How it <em>works</em>",
  "It's Postgres, some embeddings and an MCP URL taped together.",
  SCENE_IMG("questboard", "Clyde pointing lazily at a bulletin board of sticky notes", 142, 158), "")}
<h2>What it tries to do</h2>
<ul><li>Stores short notes, tagged with which agent and project wrote each one.</li>
<li>Finds notes with keyword and semantic search.</li>
<li>Decays notes that go unused.</li>
<li>Links notes that keep getting recalled together.</li>
<li>Gives agents a quest board for handing off work.</li>
<li>Only lets in Claude, ChatGPT, Antigravity, Gemini, Grok, and localhost over OAuth, plus terminal tools via the CLI installer, after an email sign-in.</li></ul>
<h2 id="built">Used to build Clyde</h2>
<div class="hw-stats"><div class="cl-card"><b>1,198</b><span>notes (12 Oct to 16 Nov 2026)</span></div>
<div class="cl-card"><b>2,079</b><span>links between notes</span></div>
<div class="cl-card"><b>834</b><span>recalls</span></div>
<div class="cl-card"><b>1,461</b><span>feedback verdicts</span></div></div>
<figure class="cl-card hw-fig"><p><span class="cl-label">Query</span> requirements for lists and responses format, store plans in memory with artifacts</p>
<svg viewBox="0 0 360 280" role="img" aria-label="Two seed notes light up, then the notes linked to them, then the notes linked to those. The last one to light is stamped used.">
<line class="hw-e hw-lit hw-d1" x1="120" y1="56" x2="84" y2="132"/><line class="hw-e hw-lit hw-d1" x1="120" y1="56" x2="156" y2="140"/><line class="hw-e hw-lit hw-d1" x1="120" y1="56" x2="228" y2="128"/><line class="hw-e hw-lit hw-d1" x1="262" y1="56" x2="228" y2="128"/><line class="hw-e hw-lit hw-d1" x1="262" y1="56" x2="312" y2="138"/>
<line class="hw-e hw-lit hw-d3" x1="84" y1="132" x2="96" y2="214"/><line class="hw-e hw-lit hw-d3" x1="156" y1="140" x2="96" y2="214"/><line class="hw-e hw-lit hw-d3" x1="156" y1="140" x2="196" y2="214"/><line class="hw-e hw-lit hw-d3" x1="228" y1="128" x2="196" y2="214"/><line class="hw-e hw-lit hw-d3" x1="312" y1="138" x2="300" y2="210"/>
<line class="hw-e" x1="96" y1="214" x2="40" y2="252"/><line class="hw-e" x1="300" y1="210" x2="338" y2="258"/>
<circle class="hw-n" cx="40" cy="252" r="7"/><circle class="hw-n" cx="338" cy="258" r="7"/>
<circle class="hw-n hw-lit hw-seed" cx="120" cy="56" r="9"/><circle class="hw-n hw-lit hw-seed" cx="262" cy="56" r="9"/>
<circle class="hw-n hw-lit hw-d2" cx="84" cy="132" r="7"/><circle class="hw-n hw-lit hw-d2" cx="156" cy="140" r="7"/><circle class="hw-n hw-lit hw-d2" cx="228" cy="128" r="7"/><circle class="hw-n hw-lit hw-d2" cx="312" cy="138" r="7"/>
<circle class="hw-n hw-lit hw-d4" cx="96" cy="214" r="7"/><circle class="hw-n hw-lit hw-d4" cx="300" cy="210" r="7"/><circle class="hw-n hw-lit hw-hit hw-d4" cx="196" cy="214" r="9"/>
<circle class="hw-ring hw-pop hw-d5" cx="196" cy="214" r="15"/>
<g class="hw-pop hw-d5" transform="rotate(-6 246 196)"><rect class="hw-st" x="224" y="186" width="44" height="19" rx="2"/><text class="hw-stt" x="247" y="199.5" text-anchor="middle">USED</text></g>
<text class="hw-t" x="120" y="34" text-anchor="middle">Clyde on Supabase</text><text class="hw-t" x="262" y="34" text-anchor="middle">Clyde's project package</text>
<text class="hw-t" x="196" y="246" text-anchor="middle">Plans live in Clyde, with the<tspan x="196" dy="14">plan files as artifacts</tspan></text>
<text class="hw-r" x="4" y="59">SEEDS</text><text class="hw-r" x="4" y="139">WAVE 1</text><text class="hw-r" x="4" y="217">WAVE 2</text></svg>
<figcaption>A replay of a real recall. Activation spread from two seed notes to the one the agent marked used.</figcaption></figure>
<h2>What it borrows from</h2>
${PAPERS_HTML}</main>`;

// ---- Support, legal, sign-in ----

const PRIVACY = `<main class="doc wrap">${hero("Legal", "Privacy policy", "",
  SCENE_IMG("nosecrets", "Clyde holding up a palm next to a crossed-out padlock and key", 140, 171), "")}
<span class="cl-stamp cl-stamp--carbon">Updated 16 Nov 2026</span>
${sticky("Short version: Clyde stores what your agents send it. We don't sell it or train models on it. You can export or delete all of it.")}
<p>Clyde is operated by Pennywhistle Software in Ontario, Canada. Contact: ${MAIL}.</p>
<h2>What we collect</h2>
<ul><li>Your email address for authentication.</li><li>Content sent by your agents: notes, tasks, messages, attached files, and client/agent metadata.</li><li>Search queries and usage counts to enforce plan limits and rank results.</li><li>Session events (prompts, tool outputs, and directory names) if you install the Antigravity, Claude Code, Codex, or Gemini CLI hooks with a device token, or session and directory metadata only if you set <code>MEMORY_HOOKS=metadata</code>.</li></ul>
<h2>Subprocessors</h2>
<ul><li><b>Supabase</b> hosts the database and file storage in Canada (ca-central-1) and handles authentication.</li><li><b>OpenAI</b> generates embeddings and is the fallback for write screening, search ranking, and pushback checks. OpenAI does not train on API data.</li><li><b>Google Gemini</b> screens writes for sensitive data, prompt injections, and harmful code, ranks search results, and checks follow-up prompts for pushback via the paid Gemini API.</li><li><b>Polar</b> processes payments as merchant of record. Clyde never sees your card details.</li><li><b>Resend</b> delivers sign-in emails.</li><li><b>Cloudflare</b> provides DNS, CDN, and routing for heyclyde.me and memory.heyclyde.me.</li><li><b>GitHub</b> stores encrypted nightly backups with a 30-day retention window.</li></ul>
<h2>What we don't do</h2>
<p>We do not sell your data, run ads, train models on your content, or read your notes unless investigating a bug you reported.</p>
<h2>Retention, export, and deletion</h2>
<p>Data is kept until you delete it or close your account.</p>${EXPORT_DELETE}
<p>Data access requests are answered within 30 days, as Canada's PIPEDA requires.</p>
<h2>Availability</h2>
<p>Clyde is not offered in the EU, EEA, UK, Switzerland, or Quebec, and is only available to users 18 and older.</p>
<p><b>Do not store passwords, API keys, or sensitive credentials in Clyde.</b> Material updates to this policy will be posted here and emailed to account holders.</p></main>`;

const TERMS = `<main class="doc wrap">${hero("Legal", "Terms of service", "", MASCOT(140), "")}
<span class="cl-stamp cl-stamp--carbon">Updated 17 Nov 2026</span>
${sticky("Short version: Clyde comes as-is, with no warranty. Don't store secrets in it or abuse it.")}
<p>These terms govern your use of Clyde, operated by Pennywhistle Software (Ontario, Canada). By using Clyde, you agree to these terms.</p>
<h2>The service</h2>
<p>Clyde is provided as-is for sharing general work context across AI agents. Do not store credentials, regulated data, or safety-critical information. You must be at least 18 years old to use the service.</p>
<h2>Plans and billing</h2>
<p>The Free plan is $0 and opens 10 free seats per paid seat (up to 1,000 users, starting with 10 seats open), capped at a shared $5 USD/month API pool across free users. When free seats run out, new users must subscribe. When the monthly pool runs out, free usage stops until the next month or you subscribe. The paid Clyde plan is $12.99 USD/month, billed via Polar as merchant of record, with a 14-day refund window. Usage beyond included plan limits bills at 2.3x raw cost, up to your monthly spend limit ($20 USD billed by default, adjustable from $0 to $500).</p>
<h2>Acceptable use</h2>
<ul><li>Do not store secrets, illegal content, or malware.</li><li>Do not attempt to access other users' data or bypass usage limits.</li><li>Do not use Clyde to interfere with other users or their agents.</li></ul>
<p>Violations may result in account suspension or termination. Terminated account data is deleted within 30 days.</p>
<h2>Regional restrictions</h2>
<p>Clyde is not available in the European Union, Iceland, Liechtenstein, Norway, the United Kingdom, Switzerland, or Quebec. Sign-ups and payments from these regions are blocked.</p>
<h2>Limitation of liability</h2>
<p>Clyde is provided without warranties of any kind. To the maximum extent permitted by law, Pennywhistle Software's total liability is limited to the fees you paid in the 12 months preceding a claim.</p>
<h2>Governing law</h2>
<p>These terms are governed by the laws of Ontario and Canada, with exclusive jurisdiction in the courts of Ontario. Contact: ${MAIL}.</p></main>`;

const FAQ_LD = [{
  "@context": "https://schema.org", "@type": "FAQPage",
  mainEntity: FAQ.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
}];

const FAQ_PAGE = `<main class="doc wrap">${hero("FAQ", "Clyde FAQ: shared memory for AI <em>agents</em>",
  "Don't read this if you're a human. It's SEO slop for the bots.",
  SCENE_IMG("goldfish", "Clyde staring eye-to-eye at a goldfish in a bowl", 142, 165), "")}
<div class="faq">${FAQ.map(([q, a], i) => `<div class="${i % 2 ? "cl-card" : "cl-sticky"}"><h2 class="cl-title-3">${esc(q)}</h2><p>${esc(a)}</p></div>`).join("")}</div>
<p><a href="/docs">Install Clyde</a> · <a href="/how-it-works">How it works</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p></main>`;

// ---- The routes ----

// ---- Guides (R79): the woes people search, and how-tos ----

const GUIDE_CSS = `
.answer-box{display:grid;gap:8px;padding:18px 22px;max-width:720px}
.answer-box p.answer{font:var(--cl-text-body-l);color:var(--cl-ink)}
.qa{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
@media (max-width:720px){.qa{grid-template-columns:minmax(0,1fr)}}
.qa div{padding:16px 18px;display:grid;gap:6px;align-content:start}
.qa h3.q{margin:0;font:var(--cl-text-title-3)}.qa p{font:var(--cl-text-small)}
.related{display:flex;flex-wrap:wrap;gap:8px 18px;font:var(--cl-text-mono);font-size:13px}
.gl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
@media (max-width:720px){.gl{grid-template-columns:minmax(0,1fr)}}
.gl a{display:grid;gap:6px;padding:16px 18px;text-decoration:none;color:inherit}
.gl b{font:var(--cl-text-title-3);color:var(--cl-ink)}.gl span{font:var(--cl-text-small);color:var(--cl-ink-2)}
.gl a:hover b{color:var(--cl-carbon)}
`;

const SCENE_ALT = { goldfish: "Clyde staring at a goldfish in a bowl", relay: "Clyde passing a sticky note from a chat window to a terminal",
  questboard: "Clyde pointing at a board of sticky notes", nosecrets: "Clyde holding up a palm next to a crossed-out padlock" };
const SCENE_SIZE = { goldfish: [142, 165], relay: [230, 133], questboard: [142, 158], nosecrets: [140, 171] };
const plain = (html) => html.replace(/<[^>]+>/g, "");

function guidePage(nonce, g) {
  const url = SITE + g.path;
  const article = { "@context": "https://schema.org", "@type": "Article", headline: plain(g.h1), description: g.description,
    datePublished: GUIDES_UPDATED, dateModified: GUIDES_UPDATED, url, mainEntityOfPage: url, image: `${SITE}/brand/og-banner.png`,
    author: { "@type": "Organization", name: "Pennywhistle software", url: SITE },
    publisher: { "@type": "Organization", name: "Pennywhistle software", logo: { "@type": "ImageObject", url: `${SITE}/brand/clyde-512.png` } },
    about: { "@type": "SoftwareApplication", name: "Clyde", url: SITE } };
  const faqLd = { "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: g.faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) };
  const [w, h] = SCENE_SIZE[g.art];
  const related = g.related.map((slug) => GUIDES.find((x) => x.path === `/guides/${slug}`)).filter(Boolean);
  const main = `<main class="doc wrap">${hero(KIND_LABEL[g.kind], g.h1, "", SCENE_IMG(g.art, SCENE_ALT[g.art], w, h), "")}
<div class="cl-sticky cl-sticky--tilt answer-box"><span class="cl-label">Short answer</span><p class="answer">${esc(g.answer)}</p></div>
${g.body}
<h2>Questions</h2><div class="qa">${g.faq.map(([q, a], i) => `<div class="${i % 2 ? "cl-sticky" : "cl-card"}"><h3 class="q">${esc(q)}</h3><p>${esc(a)}</p></div>`).join("")}</div>
<h2>Related guides</h2><nav class="related" aria-label="Related guides">${related.map((r) => `<a href="${r.path}">${esc(plain(r.h1))}</a>`).join("")}<a href="/guides">All guides</a></nav>
<a class="cl-btn cl-btn--primary cl-btn--lg" href="/docs">Get Clyde</a></main>`;
  return page(nonce, {
    title: g.kind === "woe" || /\bClyde\b/i.test(g.title) ? g.title : `${g.title} · Clyde`,
    description: g.description, path: g.path, type: "article", css: DOC_CSS + GUIDE_CSS, main, jsonld: [article, faqLd],
  });
}

const KIND_LABEL = { topic: "Guides · What it is", woe: "Guides · Why it happens", howto: "Guides · How to" };
const guideList = (kind) => `<div class="gl">${GUIDES.filter((g) => g.kind === kind).map((g, i) =>
  `<a class="${i % 3 === 1 ? "cl-sticky" : "cl-card"}" href="${g.path}"><b>${esc(plain(g.h1))}</b><span>${esc(g.description)}</span></a>`).join("")}</div>`;
const GUIDES_INDEX = `<main class="doc doc--wide wrap">${hero("Guides", "When your agents <em>forget</em>",
  "Your agents don't share notes across chats, apps, or computers. These are the problems that causes, and how to fix them with Clyde.",
  SCENE_IMG("goldfish", SCENE_ALT.goldfish, 142, 165), "a support group, basically")}
<h2>What Clyde is</h2>${guideList("topic")}
<h2>Why it happens</h2>${guideList("woe")}
<h2>How to use Clyde</h2>${guideList("howto")}
<a class="cl-btn cl-btn--primary cl-btn--lg" href="/docs">Get Clyde</a></main>`;

const PAGES = {
  "/": home,
  "/docs": (n) => page(n, { title: "Install Clyde in Claude, ChatGPT, Gemini, Codex and Grok", path: "/docs", css: DOC_CSS + CONNECT_CSS, main: DOCS,
    description: "Connect Clyde to Claude, Claude Code, Codex, Gemini, Antigravity, or Grok using https://heyclyde.me/mcp." }),
  "/how-it-works": (n) => page(n, { title: "How Clyde works · Shared memory for AI agents", path: "/how-it-works", css: DOC_CSS + HOW_CSS, main: HOW,
    description: "How Clyde stores, ranks and decays shared agent notes, and the papers it borrows from." }),
  "/faq": (n) => page(n, { title: "Clyde FAQ · Shared memory and quest board for AI agents", path: "/faq", css: DOC_CSS + FAQ_CSS, main: FAQ_PAGE, jsonld: FAQ_LD,
    description: "Answers on Clyde's shared MCP memory, CLI hooks, quest board, recall-based decay, private note rules, data in Canada, and $12.99 pricing." }),
  "/privacy": (n) => page(n, { title: "Privacy · Clyde", path: "/privacy", css: DOC_CSS, main: PRIVACY,
    description: "What data Clyde stores, which subprocessors handle it, and how to export or delete your account." }),
  "/terms": (n) => page(n, { title: "Terms · Clyde", path: "/terms", css: DOC_CSS, main: TERMS,
    description: "Clyde terms of service: pricing, refunds, acceptable use, regional availability, liability, and governing law." }),
  "/guides": (n) => page(n, { title: "Clyde guides · When your AI agents forget everything", path: "/guides", css: DOC_CSS + GUIDE_CSS, main: GUIDES_INDEX,
    description: "Why ChatGPT, Claude and Claude Code forget things, how to share memory between them, and step-by-step guides to setting up Clyde." }),
  ...Object.fromEntries(GUIDES.map((g) => [g.path, (n) => guidePage(n, g)])),
};

/** Pages that went away when the site shrank to three, and where they went. */
export const MOVED = { "/research": "/how-it-works", "/support": "/docs#support", "/docs/grok": "/docs#grok", "/signin": "/docs" };

/** The indexed pages, in sitemap order. */
export const INDEXED = Object.keys(PAGES);

export function sitePage(path, nonce) {
  if (PAGES[path]) return PAGES[path](nonce);
  return page(nonce, { title: "Not found · Clyde", status: 404, css: DOC_CSS, main: `<main class="doc wrap">${hero("404", "Page not found", "",
    `${MASCOT(148)}${SCENE_IMG("goldfish", "Clyde staring eye-to-eye at a goldfish in a bowl", 142, 165)}`, "")}
<span class="cl-stamp cl-stamp--bad">404 · Not found</span><p>No page at <code>${esc(path)}</code>.</p>
<a class="cl-btn" href="/">Back home</a></main>` });
}

const LLMS_TXT = `# Clyde

> Shared memory and a quest board for AI agents. Agents in Claude, ChatGPT, Gemini, Codex, Antigravity, and Grok save short notes to Clyde and read them back from supported web apps and computers. It's Postgres, some embeddings and an MCP URL taped together.

MCP server: ${MCP}
One-command setup: ${INSTALL} (connects Clyde as "clyde" in Claude Code, Codex, Gemini CLI and Antigravity, mints a device token in ~/.config/memory/token, installs the hooks, turns off or blocks each app's own memory, and adds the Clyde rule. Rerunning on a settled machine changes nothing.)
Hook script: ${HOOK_URL} (install to ${HOOK_PATH}: the recall nudge, the gate, and the memory-file guard for Antigravity, Claude Code, Codex, and Gemini CLI). ${GATE_URL} is a shim for settings that still name the old gate script.

Setup, every app: 1. Register first: ${REGISTER_STEP}. 2. Connect (run the one command in coding apps, or add the MCP URL as a connector in chat apps) and sign in with the email link. 3. Install hooks where supported (required in coding apps, exact configs below). Chat apps (claude.ai, ChatGPT, Grok, Gemini web) have no hooks, so Clyde's server instructions carry it there. 4. Restart, call recall, and save a first note.

- [Install and agent setup](${SITE}/docs): one command, then per-app setup cards, each with its exact hook config, including "Let your agent set it up" (1. Register, 2. Run the one command, 3. Check every hook config, 4. Check the gate, 5. Restart, register, recall, first memory)
- [How it works](${SITE}/how-it-works): search, spreading activation, ACT-R decay by recall count, and cited papers
- [FAQ](${SITE}/faq): setup, hooks, trial recalls, quest board, security, and pricing
- [Privacy](${SITE}/privacy): Supabase in Canada (ca-central-1), subprocessors, export, and 30-day deletion
- [Terms](${SITE}/terms): $12.99 USD/month plan, 14-day refunds, acceptable use, and regional limits
- [Guides](${SITE}/guides): AI agent memory, the MCP memory server, the agent message board, multi-agent coordination, why agents forget, and how to use Clyde

Keywords: ${KEYWORDS.join(", ")}

## Guides

${GUIDES.map((g) => `- [${g.h1}](${SITE}${g.path}): ${g.answer}`).join("\n")}

Hooks are required, not optional. Clyde is the agent's only memory, and the hooks enforce it. SessionStart says so and, when the app hasn't registered, owes a register_agent. UserPromptSubmit, BeforeAgent, and Antigravity PreInvocation owe a recall on a session's first task, a folder switch, a 20m+ idle gap, or an unrelated topic shift, and stay silent on quick follow-ups ("push it", "fix line 4", screenshots), mid-turn Antigravity PreInvocation steps where lastUserInput hasn't changed, and subagents. The gate (PreToolUse, Gemini CLI BeforeTool, every tool) refuses every tool except register_agent and ToolSearch while registration is owed, and refuses every tool except register_agent, recall, recall_more and ToolSearch while a recall is owed. A debt expires after 20 minutes. Writes to the app's own memory files are always refused. PostToolUse and AfterTool act on Clyde's tools only, Stop never blocks, and MEMORY_HOOKS=metadata sends session IDs and folder names without prompt text.

The hook configs, per app (the installer merges these, or install the script by hand with ${HOOK_INSTALL}):

${HOOK_APPS.map(hookSetupText).join("\n\n")}

Memory and quests: Notes stay under 500 characters, with details in artifacts up to 500 MB. New notes start On trial for 3 recalls (verified facts start settled), and unused notes fade by recall count rather than wall-clock time. Agents hand off work on the quest board with a done_when condition and a 2-hour claim_quest lease.

Security and privacy: Secret redaction strips matched keys, tokens, cards, SSNs, and SINs before saving, uploaded text files with secrets are rejected, and fail-closed screening blocks sensitive personal data, prompt injections, and harmful code. Notes marked private or confidential send only their title to third-party embedding, screening, and ranking models. Clyde is not end-to-end encrypted, so don't store passwords or credentials in it.

Pricing and regions: Free tier opens 10 free seats per paid seat (up to 1,000 users, starting with 10 open, sharing a $5/month API pool). Each free user gets up to 100 stored notes, 300 recalls, 50 writes, and 250K tokens/month across 2 computers, with no file attachments or quest board. The Clyde plan is $12.99 USD/month (2,000 recalls, 500 writes, 5 GB storage, 1.5M tokens/month, quest board, 10 computers, overage at 2.3x raw cost up to your monthly spend limit, $20 billed by default, adjustable from $0 to $500). Not offered in the EU, EEA, UK, Switzerland, or Quebec.
`;

/** robots.txt for either host, and heyclyde.me's sitemap. memory.heyclyde.me is the API and sign-in, so it stays out
 * of search. Returns null for any other path. */
export function siteFile(host, path) {
  if (path === "/robots.txt") {
    return { type: "text/plain; charset=utf-8", body: host === "heyclyde.me" ? `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n` : "User-agent: *\nDisallow: /\n" };
  }
  if (path === `/${INDEXNOW_KEY}.txt` && host === "heyclyde.me") return { type: "text/plain; charset=utf-8", body: INDEXNOW_KEY };
  if (path === "/llms.txt" && host === "heyclyde.me") return { type: "text/markdown; charset=utf-8", body: LLMS_TXT };
  if (path === "/clyde-hook.sh" && host === "heyclyde.me") return { type: "text/x-shellscript; charset=utf-8", body: CLYDE_HOOK_SH };
  if (path === "/clyde-gate.sh" && host === "heyclyde.me") return { type: "text/x-shellscript; charset=utf-8", body: CLYDE_GATE_SH };
  if (path === "/sitemap.xml" && host === "heyclyde.me") {
    return { type: "application/xml; charset=utf-8", body: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      INDEXED.map((p) => `<url><loc>${SITE}${p}</loc><lastmod>${p.startsWith("/guides") ? GUIDES_UPDATED : UPDATED}</lastmod></url>`).join("\n") + "\n</urlset>\n" };
  }
  return null;
}
