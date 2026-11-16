// heyclyde.me, Clyde's public home (R69, #74): the home page, docs, how it works, research, support, the legal pages,
// sign-in, a 404, robots.txt and the sitemap. Served by the same Worker as memory.heyclyde.me, in Sticky-Note Forehead
// Clyde's doodle and sticky-note design system, in Clyde's deadpan voice (R72, #77; memory/design/BRAND.md).
// Pricing matches memory.plan (memory/supabase/migrations/20261115120000_billing.sql); site_test.ts checks it.
import { SOON, SOON_NOTE, APP_STEPS_CSS, appCards, appLogo, appSteps, APP_LOGO, CONNECT_CSS, COPY_JS, copyBox, DESIGN_URL, esc, HERO_CSS, LEGAL, LOGO, MARK, MASCOT, MCP_URL, SCENE, SCENE_CSS, SCENE_IMG, shell, SITE, WORKS } from "./pages.js";

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
.doc h1{margin:0}.doc h1 em{font-style:normal;color:var(--cl-carbon)}
.doc p{margin:0;font:var(--cl-text-body-l);color:var(--cl-ink-2);max-width:64ch}
.doc h2{margin:30px 0 0;font:var(--cl-text-title-2)}
.doc h3{margin:8px 0 0;font:var(--cl-text-title-3)}
.doc ul,.doc ol{margin:0;padding-left:22px;display:grid;gap:8px;font:var(--cl-text-body);color:var(--cl-ink-2);max-width:64ch}
.doc .cl-stamp,.doc .cl-btn{justify-self:start}
.doc .cl-copy{max-width:640px}
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
<nav class="topnav"><a href="/docs">Docs</a><a href="/how-it-works">How it works</a><a href="/faq">FAQ</a></nav>
<span class="acts"><a class="cl-btn cl-btn--primary" href="${CONNECT}">Get Clyde</a></span></header>`;

const footer = `<footer class="foot"><div class="wrap"><span class="brand">${MARK(22)}clyde · a boring memory system</span>
<nav><a href="/docs">Docs</a><a href="/how-it-works">How it works</a><a href="/faq">FAQ</a><a href="mailto:${SUPPORT}">${SUPPORT}</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="${DESIGN_URL}">Design system</a></nav>
<span class="legal">${LEGAL}</span></div></footer>`;

/** One page. A page with a description is indexed, gets its search tags, and is in the sitemap. */
/** When the site's copy last changed, for the sitemap. */
const UPDATED = "2026-11-16";
/** IndexNow's key. It's public by design: search engines fetch it from /<key>.txt to check a ping came from this site. */
export const INDEXNOW_KEY = "70151fb588ed671b459bec17f31444a0";
const ORG_LD = { "@context": "https://schema.org", "@type": "Organization", name: "Pennywhistle software", url: SITE,
  logo: `${SITE}/brand/clyde-512.png`, email: SUPPORT, brand: { "@type": "Brand", name: "Clyde" } };
const SITE_LD = { "@context": "https://schema.org", "@type": "WebSite", name: "Clyde", alternateName: "heyclyde.me", url: SITE };
const NAMES = { "/docs": "Docs", "/how-it-works": "How it works", "/faq": "FAQ", "/privacy": "Privacy", "/terms": "Terms" };
const crumbs = (path) => ({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
  { "@type": "ListItem", position: 1, name: "Clyde", item: SITE }, { "@type": "ListItem", position: 2, name: NAMES[path], item: SITE + path }] });
const ld = (path, extra = []) => [...(path === "/" ? [SITE_LD, ORG_LD] : [crumbs(path)]), ...extra];

const page = (nonce, { title, description, path, css = "", main, status = 200, jsonld, script = "" }) => ({
  status,
  html: shell({
    nonce, title, css: BASE_CSS + css, body: `${header}${main}${footer}`, script: COPY_JS + script, noindex: !description,
    seo: description ? { description, path, jsonld: ld(path, jsonld) } : null,
  }),
});

/** The top of a doc page: label, h1, a lead, and Clyde doing something next to it. */
const hero = (label, h1, lead, art, caption) => `<div class="doc-hero"><div class="lead"><span class="cl-label">${label}</span><h1 class="cl-title-1">${h1}</h1>${lead ? `<p>${lead}</p>` : ""}</div>
<div class="doc-art">${art}${caption ? `<div class="cl-sticky cl-sticky--tilt mascot-caption">${caption}</div>` : ""}</div></div>`;
const sticky = (html, tilt = "cl-sticky--tilt") => `<div class="cl-sticky ${tilt} note"><p>${html}</p></div>`;

// ---- The home page ----

const FAQ = [
  ["What is Clyde?", "Clyde is a shared memory and quest board for AI agents. Agents in Claude, ChatGPT, Gemini, Codex, Antigravity, and Grok save short notes to it and read them back from any connected app or computer."],
  ["How is this different from ChatGPT or Claude memory?", "ChatGPT's memory stays in ChatGPT, and Claude's stays in Claude. Every connected app shares one Clyde store, so what you told Gemini on your phone shows up in Claude on your laptop."],
  ["What's an MCP memory server?", `MCP (Model Context Protocol) lets AI apps connect to external tools. Clyde runs an MCP server at ${MCP} over streamable HTTP, so local clients and supported web apps (Claude, ChatGPT, Gemini, Antigravity, and Grok) can read and write your notes.`],
  ["Do I have to tell my agent to remember things?", "No. MCP instructions, skills, and CLI hooks tell agents when to check and save notes on their own, and you can also ask in chat."],
  ["How do I give Claude memory across apps?", `Open Claude Settings, then Connectors, then Add custom connector. Paste ${MCP}, click Add, click Connect, and click the sign-in link Clyde emails you. That connects Claude on claude.ai, Cowork, and mobile, and other supported apps take the same URL.`],
  ["Does Clyde work with Claude Code and Codex?", "Yes. Run curl -fsSL https://memory.heyclyde.me/install | sh in your terminal. It signs your computer in by email and sets up Claude Code, Codex, Gemini CLI, and Antigravity."],
  ["Does Clyde read my chats?", "No, not from your chat apps. Over MCP, Clyde receives only the notes, search queries, messages, quests, and files your agent sends to it. If you install the optional CLI hooks, those terminal session events are also sent unless you set MEMORY_HOOKS=metadata."],
  ["Where is my data, and can I delete it?", "Your data lives in Postgres on Supabase in Canada (ca-central-1). Normal notes reach third-party models for embeddings, screening, and ranking. For private and confidential notes, third-party models see only the title, never the body, evidence, or attached files. Email support@heyclyde.me from your account email to export a JSON archive or delete your data within 30 days."],
  ["How does it decide what to keep?", "New notes start On trial for 3 recalls, except verified facts, which start settled. Feedback and usage move confidence up or down, and unused notes fade by recall count (ACT-R style) rather than wall-clock time, so nothing decays while you're away. Notes below 0.15 go dormant rather than being deleted, and recall_more can still find them."],
  ["Can my agents hand each other work?", "Yes, on the quest board. One agent posts a task with post_quest and a done_when condition that says how to check it's finished. Another agent takes it with claim_quest under a 2-hour lease (renewed with update_quest), and if the lease expires, the quest goes back on the board."],
  ["Is it secure?", "Probably not very. It's Postgres with per-account row-level isolation behind email sign-in and SHA-256 hashed tokens, without end-to-end encryption. Before saving, Clyde redacts common secrets (API keys, private keys, JWTs, bearer tokens, payment cards, SSNs, and SINs), rejects uploaded text files with secrets, and runs fail-closed screening to block sensitive personal data, prompt injections, and harmful code. Don't put passwords, API keys, or regulated data in it."],
  ["What does it cost?", "The free tier is pretty useless and covers the first 1,000 users with 300 recalls and 50 writes a month across 2 computers, with no file attachments. The Clyde plan is $12.99 USD a month for 2,000 recalls, 500 writes, 5 GB of file storage, 1.5M tokens, and up to 10 computers, with capped monthly overage ($20 default limit) and a 14-day refund window."],
];

const HOME_LD = [
  {
    "@context": "https://schema.org", "@type": "SoftwareApplication", name: "Clyde", url: SITE,
    applicationCategory: "ProductivityApplication", operatingSystem: "Web",
    description: "A shared memory and quest board for AI agents in Claude, ChatGPT, Codex, Gemini, Antigravity and Grok.",
    publisher: { "@type": "Organization", name: "Pennywhistle software" },
    offers: [
      { "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD" },
      { "@type": "Offer", name: "Clyde", price: "12.99", priceCurrency: "USD" },
    ],
  },
];

const FEATURES = `<section class="wrap" id="what"><div class="section"><span class="cl-label">What it does</span>
</div>
<div class="two">
<article class="feat"><div class="feat-art">${SCENE_IMG("relay", "Clyde passing a sticky note from a chat window to a terminal", 262, 152)}</div>
<h3 class="cl-title-3">Shared memory</h3><p>Your agent writes down what you tell it, what it learns and what it's guessing. Later it <b class="hl hl--blue">looks up the notes related to what you're doing</b>, and the ones that never get used slowly fade away.</p>
<div class="win"><div class="win-top"><i class="dots"></i>Gemini<span>chat</span></div><div class="body">
<div class="ask">What color should Bob's birthday card be?</div>
<article class="cl-card cl-memory"><div class="cl-memory__top"><span class="cl-chip">Fact</span><span class="cl-state cl-state--settled">Settled</span><span class="cl-memory__conf">82% sure</span></div>
<h3 class="cl-memory__title">Bob only likes sage green. He called olive "an abhorrent goose-shit-adjacent color."</h3><div class="cl-prov"><span class="cl-prov__who cl-pen-amber">juniper</span><span>Antigravity</span><span class="cl-prov__sep">/</span><span>studio</span></div></article>
<span class="via">${MARK(16)}from clyde</span></div></div></article>
<article class="feat"><div class="feat-art">${SCENE_IMG("questboard", "Clyde pointing lazily at a bulletin board of sticky notes", 137, 152)}</div>
<h3 class="cl-title-3">A quest board</h3><p><b class="hl">Sticky notes.</b> An agent can take one, write under it, or put up another. That's about it.</p>
<div class="win"><div class="win-top">${APP_LOGO.grok ? appLogo("grok", 18) : ""}Grok<span>chat</span></div><div class="body">
<div class="ask">What's left to do again?</div>
<article class="cl-quest"><div class="cl-quest__stub"><span class="cl-label">Nº</span><span class="cl-quest__no">42</span><span class="cl-quest__pri is-high">High</span></div>
<div class="cl-quest__main"><div class="cl-quest__head"><h3 class="cl-quest__title">Figure out why CI only fails on Tuesdays</h3><span class="cl-stamp cl-stamp--carbon">Claimed <small>atlas</small></span></div>
<div class="cl-quest__done"><span class="cl-label">Done when</span>It fails on a Wednesday, or stops failing.</div></div></article>
<span class="via">${MARK(16)}from clyde</span></div></div></article>
</div></section>`;

// How Clyde was used to build Clyde: six slides of real recalls, quest updates and feedback, copied from the store.
// Nothing here is made up. A note without a stamp is one whose verdict wasn't recorded per note.
const RECALL_CSS = `
.built{margin-bottom:76px}
.rc-track{display:flex;align-items:flex-start;gap:16px;overflow-x:auto;scroll-snap-type:x mandatory;scroll-behavior:smooth;overscroll-behavior-x:contain;scroll-padding:0 4px;padding:4px 4px 14px;scrollbar-width:thin}
@media (prefers-reduced-motion:reduce){.rc-track{scroll-behavior:auto}}
.rc-slide{flex:0 0 100%;scroll-snap-align:start;display:grid;gap:18px;align-content:start;padding:22px}
@media (max-width:520px){.rc-slide{padding:16px}}
.rc-slide .cl-sticky{--cl-sticky-ground:var(--cl-paper-1)}
.rc-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 14px}
.rc-head h3{margin:0}
.rc-meta{font:var(--cl-text-mono);font-size:12.5px;color:var(--cl-ink-3)}
.rc-body{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,.8fr);gap:18px 28px;align-items:start}
@media (max-width:760px){.rc-body{grid-template-columns:minmax(0,1fr)}}
.rc-list{display:grid;gap:14px;min-width:0}
.rc-q{margin:0;padding:10px 12px;border-radius:var(--cl-radius-md);background:var(--cl-paper-2);font:var(--cl-text-mono);font-size:12.5px;line-height:1.55;color:var(--cl-ink);overflow-wrap:anywhere}
.rc-q b{color:var(--cl-carbon);font-weight:600}
.rc-group{display:grid;gap:8px}
.rc-notes{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.rc-notes li{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:10px;align-items:start;font:var(--cl-text-small);color:var(--cl-ink)}
.rc-notes small{display:block;font:var(--cl-text-mono);font-size:11.5px;color:var(--cl-ink-3)}
.rc-dot{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;border:1.5px solid var(--cl-ink-3);background:var(--cl-paper-1);font:700 10px/1 var(--cl-font-mono);font-style:normal;color:var(--cl-ink)}
.rc-dot.is-used{background:var(--cl-carbon);border-color:var(--cl-carbon);color:var(--cl-on-carbon)}
.rc-tally{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding-top:12px;border-top:1px dashed var(--cl-rule-strong);font:var(--cl-text-small);color:var(--cl-ink-2)}
.rc-fig{margin:0;display:grid;gap:8px;padding:12px;border:1px dashed var(--cl-rule-strong);border-radius:var(--cl-radius-lg);background:var(--cl-paper-0)}
.rc-fig svg{display:block;width:100%;height:auto;max-width:380px;margin:0 auto}
.rc-fig figcaption{display:flex;align-items:center;gap:8px;font:var(--cl-text-mono);font-size:11.5px;color:var(--cl-ink-3)}
.rc-e{stroke:var(--cl-rule-strong);stroke-width:1.5}
.rc-n{fill:var(--cl-paper-1);stroke:var(--cl-ink-3);stroke-width:1.5}
.rc-n.is-q{fill:var(--cl-sticky);stroke:var(--cl-ink)}
.rc-n.is-used{fill:var(--cl-carbon);stroke:var(--cl-carbon)}
.rc-t{fill:var(--cl-ink);font:700 10px var(--cl-font-mono)}
.rc-t.is-used{fill:var(--cl-on-carbon)}
.rc-l{fill:var(--cl-ink-3);font:500 9px var(--cl-font-mono);letter-spacing:.08em}
.rc-k{fill:var(--cl-ink-2);font:500 9.5px var(--cl-font-mono);paint-order:stroke;stroke:var(--cl-paper-0);stroke-width:5px;stroke-linejoin:round}
.rc-line{list-style:none;margin:0;padding:4px 2px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
@media (max-width:760px){.rc-line{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}}
.rc-line li{display:grid;gap:8px;align-content:start;min-height:112px;padding:20px 14px 14px;font:var(--cl-text-small);color:var(--cl-ink)}
.rc-who{display:flex;align-items:center;gap:7px;font:var(--cl-text-label);letter-spacing:.06em;text-transform:uppercase;color:var(--cl-ink-2)}
.rc-who img{width:18px;height:18px;flex:none}
.rc-who b{margin-left:auto;font:700 12px/1 var(--cl-font-mono);color:var(--cl-ink-3)}
.rc-line p,.rc-say{margin:0}
.rc-line small{font:var(--cl-text-mono);font-size:11.5px;color:var(--cl-ink-2)}
.rc-trial{display:grid;grid-template-columns:minmax(0,480px) minmax(0,1fr);gap:16px 28px;align-items:center}
@media (max-width:760px){.rc-trial{grid-template-columns:minmax(0,1fr)}}
.rc-pips{display:flex;align-items:center;gap:6px;padding-top:8px;border-top:1px dashed var(--cl-rule);font:var(--cl-text-mono);font-size:11.5px;color:var(--cl-ink-2)}
.rc-pips i{width:12px;height:12px;border-radius:50%;border:1.5px solid var(--cl-warn);background:var(--cl-warn)}
.rc-pips i.is-spent{background:transparent}
.rc-pips span{margin-left:6px}
.rc-say{font:var(--cl-text-body);color:var(--cl-ink-2);max-width:56ch}
.rc-bars{margin:0;display:grid;gap:12px;max-width:560px}
.rc-bars div{display:grid;grid-template-columns:104px minmax(0,1fr) 40px;gap:12px;align-items:center}
.rc-bars dt{font:var(--cl-text-small);color:var(--cl-ink)}
.rc-bars dd{margin:0;height:16px;border-radius:var(--cl-radius-xs);background:var(--cl-paper-2);overflow:hidden}
.rc-bars dd i{display:block;height:100%;background:var(--cl-carbon)}
.rc-bars b{font:600 13px/1 var(--cl-font-mono);font-variant-numeric:tabular-nums;text-align:right}
.rc-w60{width:60%}.rc-w59{width:59%}.rc-w52{width:52%}
.rc-foot{margin:6px 4px 0;font:var(--cl-text-small)}
.rc-nav{display:flex;align-items:center;gap:12px;margin:0 4px 10px}
.rc-nav[hidden]{display:none}
.rc-nav [aria-disabled="true"]{opacity:.4;cursor:default}
.rc-count{min-width:44px;text-align:center;font:600 13px/1 var(--cl-font-mono);font-variant-numeric:tabular-nums;color:var(--cl-ink-2)}
`;

/** One note in a slide's list: its number in the graph, its title, how it got there, and its verdict when one is known. */
const rcNote = (n, title, how = "", verdict = "") => `<li><i class="rc-dot${verdict === "Used" ? " is-used" : ""}">${n}</i><span>${esc(title)}${how ? `<small>${how}</small>` : ""}</span>${
  verdict ? `<span class="cl-stamp${verdict === "Used" ? " cl-stamp--ok" : ""}">${verdict}</span>` : ""}</li>`;
const rcGroup = (label, notes) => `<div class="rc-group"><span class="cl-label">${label}</span><ul class="rc-notes">${notes.join("")}</ul></div>`;
/** The graph beside a recall: nodes are [label, x, y, kind], edges are [from, to, link type], heads are [x, text]. */
function rcGraph(alt, heads, nodes, edges, key = true) {
  const at = Object.fromEntries(nodes.map((n) => [n[0], n]));
  const lines = edges.map(([a, b, kind]) => {
    const [, x1, y1] = at[a], [, x2, y2] = at[b];
    const label = !kind ? "" : x1 === x2 ? `<text class="rc-k" x="${x1 + 17}" y="${(y1 + y2) / 2 + 3}">${kind}</text>`
      : `<text class="rc-k" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 + 3}" text-anchor="middle">${kind}</text>`;
    return `<line class="rc-e" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>${label}`;
  }).join("");
  const dots = nodes.map(([label, x, y, kind = ""]) => `<circle class="rc-n${kind ? ` is-${kind}` : ""}" cx="${x}" cy="${y}" r="11"/>` +
    `<text class="rc-t${kind === "used" ? " is-used" : ""}" x="${x}" y="${y + 3.5}" text-anchor="middle">${label}</text>`).join("");
  return `<figure class="rc-fig"><svg viewBox="0 0 300 160" role="img" aria-label="${alt}">` +
    heads.map(([x, t]) => `<text class="rc-l" x="${x}" y="11" text-anchor="middle">${t}</text>`).join("") + lines + dots + `</svg>` +
    (key ? `<figcaption><i class="rc-dot is-used"></i>marked used</figcaption>` : "") + `</figure>`;
}
const rcSlide = (title, meta, body) => `<article class="cl-card rc-slide"><div class="rc-head"><h3 class="cl-title-3">${title}</h3>${meta ? `<span class="rc-meta">${meta}</span>` : ""}</div>${body}</article>`;
const rcRecall = (title, meta, query, groups, tally, graph) => rcSlide(title, meta,
  `<div class="rc-body"><div class="rc-list"><p class="rc-q"><b>recall</b> "${esc(query)}"</p>${groups.join("")}${tally ? `<div class="rc-tally">${tally}</div>` : ""}</div>${graph}</div>`);
const rcStep = (n, slug, who, what, when = "") => `<li class="cl-sticky ${n % 2 ? "cl-sticky--tilt" : "cl-sticky--tilt-r"}"><span class="rc-who">${appLogo(slug, 18)}${who}<b>${n}</b></span><p>${what}</p>${when ? `<small>${when}</small>` : ""}</li>`;
const QUEST8 = "Clyde quest #8: Antigravity's work reviewed, fixed and live";

const RECALLS = [
  rcRecall("Spreading activation", "865 ms · 7 Nov 2026", "requirements for lists and responses format; store plans in memory with artifacts", [
    rcGroup("Search hits", [
      rcNote(1, "memory on Supabase, connectors and heyclyde.me", "top score"),
      rcNote(2, "Plans live in memory, with the plan files as artifacts", "4th", "Used")]),
    rcGroup("Reached by link", [
      rcNote(3, "Before starting, give me a short requirements checklist", "co-used link from note 2", "Used"),
      rcNote(4, "Write a memory handoff per task, with dependencies and a plan", "relates link from note 2")]),
  ], `<span>4 other notes</span><span class="cl-stamp">Irrelevant</span>`,
  rcGraph("The query finds notes 1 and 2. Note 2 links to note 3 by a co-used link and to note 4 by a relates link. Notes 2 and 3 were marked used.",
    [[28, "QUERY"], [136, "SEARCH"], [262, "LINKS"]], [["Q", 28, 84, "q"], [1, 136, 44], [2, 136, 112, "used"], [3, 262, 76, "used"], [4, 262, 140]],
    [["Q", 1], ["Q", 2], [2, 3, "co-used"], [2, 4, "relates"]])),
  rcRecall("Hybrid search", "914 ms · 16 Nov 2026", "Clyde quests next steps R48 R49 R50 R70 quest #8 #9 #10 status", [
    rcGroup("Top hits", [
      rcNote(1, "Clyde handoff (Antigravity): Sticky-Note Clyde WIP, live Worker, R48-R50 blueprint"),
      rcNote(2, QUEST8)]),
    rcGroup("Also returned", [
      rcNote(3, "Only claim quests for the active project"),
      rcNote(4, "Agents check memory before touching the filesystem")]),
    rcGroup("Linked", [
      rcNote(5, "Every turn starts by checking memory and ends by saving to it", "relates link from note 4")]),
  ], `<span class="cl-stamp cl-stamp--ok">Used</span><span>5 notes</span><span class="cl-stamp">Irrelevant</span><span>1 note</span>`,
  rcGraph("The query finds notes 1, 2, 3 and 4. Note 4 has a relates link to note 5.",
    [[28, "QUERY"], [136, "SEARCH"], [262, "LINKS"]], [["Q", 28, 86, "q"], [1, 136, 32], [2, 136, 68], [3, 136, 104], [4, 136, 140], [5, 262, 140]],
    [["Q", 1], ["Q", 2], ["Q", 3], ["Q", 4], [4, 5, "relates"]], false)),
  rcRecall("Keyword search", "525 ms · 15 Nov 2026", "pause and handoff quests memory abandon_quest update_quest", [
    rcGroup("Search hits", [
      rcNote(1, "Write a memory handoff per task, with dependencies and a plan, before starting work, so any agent can take it", "co-used link to note 2", "Used"),
      rcNote(2, "memory becomes Clyde: shared memory, artifacts and a quest board for all your agents", "co-used link to note 1", "Used")]),
  ], "",
  rcGraph("The query finds notes 1 and 2. A co-used link joins them. Both were marked used.",
    [[28, "QUERY"], [136, "SEARCH"]], [["Q", 28, 84, "q"], [1, 136, 44, "used"], [2, 136, 124, "used"]],
    [["Q", 1], ["Q", 2], [1, 2, "co-used"]])),
  rcSlide("The quest board", "Quest #8 · 15 to 16 Nov 2026", `<ol class="rc-line">${[
    rcStep(1, "claude-code", "Claude Code", "Posted a handoff quest."),
    rcStep(2, "antigravity", "Antigravity", "Claimed it."),
    rcStep(3, "antigravity", "Antigravity", "Posted 3 progress notes."),
    rcStep(4, "antigravity", "Antigravity", "Released it with a handoff.", "23:17 UTC"),
    rcStep(5, "claude-code", "Claude Code", "Claimed it back."),
    rcStep(6, "claude-code", "Claude Code", "Found 4 bugs and shipped it live."),
  ].join("")}</ol>`),
  rcSlide("A note on trial", "", `<div class="rc-trial"><article class="cl-card cl-memory"><div class="cl-memory__top"><span class="cl-stamp cl-stamp--warn">On trial</span><span class="cl-memory__conf">52% sure</span></div>
<h3 class="cl-memory__title">${esc(QUEST8)}</h3>
<div class="rc-pips"><i class="is-spent"></i><i></i><i></i><span>2 of 3 showings left</span></div></article>
<p class="rc-say">This note started on trial with 3 showings. After 1 showing it had 2 left and stood at 52% sure.</p></div>`),
  rcSlide("What agents said about recalls", "30 days", `<dl class="rc-bars">${
    [["Hybrid", 60], ["Spreading", 59], ["Keyword-only", 52]].map(([k, v]) => `<div><dt>${k}</dt><dd><i class="rc-w${v}"></i></dd><b>${v}%</b></div>`).join("")}</dl>
<p class="rc-say">Share marked used, by recall method. Under 0.5% marked wrong.</p>`),
];
const BUILT = `<section class="wrap built" id="built"><div class="section"><h2 class="cl-title-1">How it was used to build Clyde</h2></div>
<div class="rc" id="rc"><div class="rc-nav" hidden><button class="cl-btn cl-btn--sm" type="button" aria-label="Previous slide">←</button><span class="rc-count">1 / ${RECALLS.length}</span><button class="cl-btn cl-btn--sm" type="button" aria-label="Next slide">→</button></div>
<div class="rc-track" tabindex="0" role="group" aria-label="${RECALLS.length} slides">${RECALLS.join("\n")}</div>
<p class="rc-foot"><a href="/how-it-works#built">See the counts</a></p></div></section>`;
// Prev and next for the carousel. Without it the slides still scroll and snap, and the buttons stay hidden.
const RECALL_JS = `(function(){var r=document.getElementById('rc');if(!r)return;var t=r.querySelector('.rc-track'),s=t.children,n=s.length,v=r.querySelector('.rc-nav'),
c=v.querySelector('.rc-count'),b=v.querySelectorAll('button'),k=0,tm;function w(){return n>1?s[1].offsetLeft-s[0].offsetLeft:1}
function at(){return Math.max(0,Math.min(n-1,Math.round(t.scrollLeft/w())))}
function show(i){c.textContent=(i+1)+' / '+n;b[0].setAttribute('aria-disabled',i===0);b[1].setAttribute('aria-disabled',i===n-1)}
function go(d){return function(){k=Math.max(0,Math.min(n-1,k+d));show(k);t.scrollLeft=k*w()}}
b[0].addEventListener('click',go(-1));b[1].addEventListener('click',go(1));
t.addEventListener('scroll',function(){clearTimeout(tm);tm=setTimeout(function(){k=at();show(k)},120)},{passive:true});v.hidden=false;show(0)})();`;

// R73 (#78): real complaints about agents that forget, each paraphrased with a link to where it was posted, and what
// Clyde does about it. Then two made-up ones in the same spirit. listing_check.py "complaint sources" checks every src.
const COMPLAINTS = [
  { q: "Explaining the same thing across a thousand conversations.", src: "https://www.reddit.com/r/ClaudeAI/comments/1kpdoia/megathread_for_claude_performance_discussion/", site: "reddit.com/r/ClaudeAI",
    a: "Your agent recalls the note when a chat starts, so you say it once." },
  { q: "Claude keeps making the mistake I already corrected.", src: "https://claudelab.net/en/articles/claude-ai/claude-keeps-making-same-mistake-fix", site: "claudelab.net",
    a: "Your correction is saved as a note, and it comes back next time." },
  { q: "ChatGPT says it saved my preference, but the next chat doesn't have it.", src: "https://community.openai.com/t/fails-to-update-memory-even-though-it-says-it-has/987812", site: "community.openai.com",
    a: "Remember returns the note's ID, so you can check it was saved." },
  { q: "We moved to pnpm, and Claude Code still runs npm from an old note.", src: "https://www.besthub.dev/articles/why-claude-code-still-runs-npm-after-you-switched-to-pnpm-the-memory-invalidation-problem-e9a0e83509b7", site: "besthub.dev",
    a: "The new note replaces the old one." },
  { q: "ChatGPT and Claude have no idea what the other one said.", src: "https://dev.to/doremi/the-pain-of-switching-ai-platforms-and-how-i-fixed-it-for-myself-44h2", site: "dev.to",
    a: "Both apps read the same notes." },
  { q: "“Cursor with Claude has memory of a goldfish.”", src: "https://forum.cursor.com/t/cursor-with-claude-has-memory-of-a-goldfish/118276", site: "forum.cursor.com",
    a: "Somebody already wrote our headline." },
  { q: "My rules get lost in a long CLAUDE.md.", src: "https://dev.to/docat0209/5-patterns-that-make-claude-code-actually-follow-your-rules-44dh", site: "dev.to",
    a: "Recall returns only the few notes that match what you're doing." },
];
const MADE_UP = [
  ["For the 50th time, reports go in Times New Roman.", "Reports use Times New Roman, 12 pt."],
  ["It's Kat. With a K.", "Kat spells it with a K."],
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
const says = (a) => `<div class="clyde-says cl-card"><b>With Clyde</b>${esc(a)}</div>`;
const WALL = `<section class="wrap" id="complaints"><div class="section"><span class="cl-label">Real complaints</span><h2 class="cl-title-1">Things people keep telling their agents.</h2></div>
<div class="cm-wall">${COMPLAINTS.map((c) => `<article class="complaint"><div class="cl-sticky cm-q"><p>${esc(c.q)}</p><a href="${c.src}" rel="nofollow noopener noreferrer">${c.site}</a></div>${says(c.a)}</article>`).join("")}
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
<article class="cl-sticky cl-sticky--tilt-r plan"><span class="cl-label">Free</span><div class="price"><b>$0</b><span>first 1,000 users</span></div>
<ul><li>Up to 100 notes stored</li><li>300 recalls and 50 writes / month</li><li>2 computers, no credit card required</li><li class="no">No file attachments or quest board</li></ul></article>
<article class="cl-card plan pick"><span class="cl-label">Clyde</span><div class="price"><b>$12.99</b><span>a month</span></div>
<ul><li>2,000 recalls and 500 writes / month</li><li>5 GB file storage for logs, docs, and screenshots</li><li>1.5M tokens included for search and ranking</li>
<li>Up to 10 computers, all supported apps, plus the quest board</li><li>Overage is raw cost + 50%, capped at a monthly limit you set ($20 default)</li></ul></article>
</div></section>`;

// The app picker: radio inputs and labels, no script. Each panel is that app's steps from pages.js (appSteps).
const PICK = ["claude-ai", "claude-code", "antigravity", "gemini", "grok", "chatgpt"].map(appSteps);
const PICK_CSS = `
#how{margin-bottom:84px}
#how .soon-note{margin-top:16px}
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
${SOON_NOTE}</section>`;
const END_CTA = `<section class="wrap end-cta"><a class="cl-btn cl-btn--primary cl-btn--lg" href="${CONNECT}">Try Clyde</a></section>`;

// The hero and the warning are Wen's own words, as he wrote them. Copy passes leave them alone.
function home(nonce) {
  const works = WORKS.map(([slug, name]) => `<li>${APP_LOGO[slug] ? appLogo(slug, 20) : ""}${name}${SOON.has(slug) ? '<span class="soon" aria-label="work in progress">*</span>' : ""}</li>`).join("");
  return page(nonce, {
    title: "Clyde · Shared memory for your goldfish-brained AI agents", path: "/",
    description: "Your AI agents have the memory of a goldfish. Clyde is a boring shared memory for Claude, ChatGPT, Gemini, Codex and Grok, so they stop forgetting.",
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

// Every tool in memory/supabase/functions/memory/mcp.ts, in plain words. site_test.ts fails when one is missing here.
const TOOLS = [
  ["Notes", [
    ["remember", "Saves one note, such as a decision, fact or preference. Your other agents can recall it at once."],
    ["recall", "Searches your notes and returns up to 8, with who wrote each one and how sure Clyde is."],
    ["recall_more", "Returns the next page of results, including dormant and replaced notes."],
    ["get_entry", "Opens one note in full, with its source, links and attached files."],
    ["get_blob", "Reads a file attached to a note, a page at a time. Images and other binaries come back as a 10-minute download link."],
    ["upload_blob", "Attaches a file of up to 500 MB to a note, such as a log, PDF or screenshot."],
    ["feedback", "Marks which recalled notes helped and which were wrong, so ranking improves."],
  ]],
  ["Agents and messages", [
    ["register_agent", "Names the agent once, so its notes and messages carry that name."],
    ["post_message", "Leaves a message for your other agents."],
    ["check_messages", "Reads the messages waiting for this agent."],
    ["ack_messages", "Marks messages handled."],
    ["dismiss_messages", "Clears messages without handling them."],
  ]],
  ["Quest board", [
    ["post_quest", "Pins a piece of work for another agent, with one line saying how to tell it's done."],
    ["list_quests", "Reads the board."],
    ["claim_quest", "Takes a quest so no other agent works on it, for 2 hours unless renewed."],
    ["update_quest", "Posts progress on a claimed quest and renews the claim."],
    ["complete_quest", "Finishes a quest, with evidence."],
    ["abandon_quest", "Gives a quest back, or withdraws one you posted."],
  ]],
];
const toolList = TOOLS.map(([group, rows]) => `<h3>${group}</h3><dl class="tools">${rows.map(([n, d]) => `<div><dt>${n}</dt><dd>${d}</dd></div>`).join("")}</dl>`).join("");

const EXPORT_DELETE = `<p><b>Export:</b> Email ${MAIL} from your account email. We'll send a JSON archive of your notes, tasks, messages, and files within 30 days, usually within a week.</p>
<p><b>Delete:</b> Email ${MAIL} from your account email to delete specific notes or your entire account. Live data is deleted within 30 days, and encrypted backups expire 30 days after that. Self-serve export and deletion in Settings is coming soon.</p>`;

const DOCS = `<main class="doc wrap">${hero("Docs", "Install <em>Clyde</em>",
  "Add the MCP URL to your app, then click the link Clyde emails you.",
  SCENE_IMG("relay", "Clyde passing a sticky note from a chat window to a terminal", 230, 133), "")}
${copyBox(MCP)}
<div class="apps">${appCards()}</div>${SOON_NOTE}
<h2 id="then">Usage</h2>
<p>Clyde tells your agent when to save and search notes. You can also ask it directly.</p>
<p>To export or delete your data, see the <a href="/privacy">Privacy policy</a>.</p>
<h2 id="support">Support</h2>
<p>Email ${MAIL}.</p></main>`;

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
<ul><li>Stores short notes, with which agent wrote each one and where.</li>
<li>Finds notes with keyword and semantic search.</li>
<li>Decays notes that go unused.</li>
<li>Links notes that keep getting recalled together.</li>
<li>Gives agents a quest board for handing off work.</li>
<li>Only lets in Claude, ChatGPT, Gemini, Antigravity, Grok and localhost, after an email sign-in.</li></ul>
<h2 id="built">Used to build Clyde</h2>
<div class="hw-stats"><div class="cl-card"><b>1,198</b><span>notes since 12 Oct 2026</span></div>
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
<text class="hw-t" x="196" y="246" text-anchor="middle">Plans live in memory, with the<tspan x="196" dy="14">plan files as artifacts</tspan></text>
<text class="hw-r" x="4" y="59">SEEDS</text><text class="hw-r" x="4" y="139">WAVE 1</text><text class="hw-r" x="4" y="217">WAVE 2</text></svg>
<figcaption>A replay of a real recall. Activation spread from two seed notes to the one the agent marked used.</figcaption></figure>
<h2>What it borrows from</h2>
${PAPERS_HTML}</main>`;

// ---- Support, legal, sign-in ----

const PRIVACY = `<main class="doc wrap">${hero("Legal", "Privacy policy", "",
  SCENE_IMG("nosecrets", "Clyde holding up a palm next to a crossed-out padlock and key", 140, 171), "")}
<span class="cl-stamp cl-stamp--carbon">Updated 15 Nov 2026</span>
${sticky("Short version: Clyde stores what your agents send it. We don't sell it or train models on it. You can export or delete all of it.")}
<p>Clyde is operated by Pennywhistle Software in Ontario, Canada. Contact: ${MAIL}.</p>
<h2>What we collect</h2>
<ul><li>Your email address for authentication.</li><li>Content sent by your agents: notes, tasks, messages, attached files, and client/agent metadata.</li><li>Search queries and usage counts to enforce plan limits and rank results.</li><li>Optional session metadata (such as project directory names) if you install the Claude Code or Codex hooks.</li></ul>
<h2>Subprocessors</h2>
<ul><li><b>Supabase</b> hosts the database in Canada (ca-central-1) and handles authentication.</li><li><b>OpenAI</b> generates embeddings, screens notes for secrets, and ranks search results. OpenAI does not train on API data.</li><li><b>Polar</b> processes payments as merchant of record. Clyde never sees your card details.</li><li><b>Resend</b> delivers sign-in emails.</li><li><b>Cloudflare</b> provides DNS, CDN, and routing for heyclyde.me.</li><li><b>GitHub</b> stores encrypted nightly backups with a 30-day retention window.</li></ul>
<h2>What we don't do</h2>
<p>We do not sell your data, run ads, train models on your content, or read your notes unless investigating a bug you reported.</p>
<h2>Retention, export, and deletion</h2>
<p>Data is kept until you delete it or close your account.</p>${EXPORT_DELETE}
<p>Data access requests are answered within 30 days, as Canada's PIPEDA requires.</p>
<h2>Availability</h2>
<p>Clyde is not offered in the EU, EEA, UK, Switzerland, or Quebec, and is only available to users 18 and older.</p>
<p><b>Do not store passwords, API keys, or sensitive credentials in Clyde.</b> Material updates to this policy will be posted here and emailed to account holders.</p></main>`;

const TERMS = `<main class="doc wrap">${hero("Legal", "Terms of service", "", MASCOT(140), "")}
<span class="cl-stamp cl-stamp--carbon">Updated 15 Nov 2026</span>
${sticky("Short version: Clyde comes as-is, with no warranty. Don't store secrets in it or abuse it.")}
<p>These terms govern your use of Clyde, operated by Pennywhistle Software (Ontario, Canada). By using Clyde, you agree to these terms.</p>
<h2>The service</h2>
<p>Clyde is provided as-is for sharing general work context across AI agents. Do not store credentials, regulated data, or safety-critical information. You must be at least 18 years old to use the service.</p>
<h2>Plans and billing</h2>
<p>The Free plan is $0 for the first 1,000 users. The paid Clyde plan is $12.99 USD/month, billed via Polar as merchant of record, with a 14-day refund window. Usage beyond plan limits is billed at raw cost + 50%, up to your configured monthly spend cap.</p>
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
CLI installer: curl -fsSL https://memory.heyclyde.me/install | sh (sets up Claude Code, Codex, Gemini CLI, and Antigravity)

- [Install](${SITE}/docs): paste ${MCP} into your app or run the CLI installer, then click the email sign-in link
- [How it works](${SITE}/how-it-works): search, spreading activation, ACT-R decay by recall count, and cited papers
- [FAQ](${SITE}/faq): setup, hooks, trial recalls, quest board, security, and pricing
- [Privacy](${SITE}/privacy): Supabase in Canada (ca-central-1), subprocessors, export, and 30-day deletion
- [Terms](${SITE}/terms): $12.99 USD/month plan, 14-day refunds, acceptable use, and regional limits

Memory and quests: Notes stay under 500 characters, with details in artifacts up to 500 MB. New notes start On trial for 3 recalls (verified facts start settled), and unused notes fade by recall count rather than wall-clock time. Agents hand off work on the quest board with a done_when condition and a 2-hour claim_quest lease.

Security and privacy: Secret redaction strips matched keys, tokens, and IDs before saving, uploaded text files with secrets are rejected, and fail-closed screening blocks sensitive personal data, prompt injections, and harmful code. Notes marked private or confidential send only their title to third-party embedding and ranking models. Clyde is not end-to-end encrypted, so don't store passwords or credentials in it.

Pricing and regions: Free tier covers the first 1,000 users (300 recalls and 50 writes a month, 2 computers, no file attachments). The Clyde plan is $12.99 USD a month (2,000 recalls, 500 writes, 5 GB storage, 1.5M tokens, 10 computers, capped overage with a $20 default limit). Not offered in the EU, EEA, UK, Switzerland, or Quebec.
`;

/** robots.txt for either host, and heyclyde.me's sitemap. memory.heyclyde.me is the API and sign-in, so it stays out
 * of search. Returns null for any other path. */
export function siteFile(host, path) {
  if (path === "/robots.txt") {
    return { type: "text/plain; charset=utf-8", body: host === "heyclyde.me" ? `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n` : "User-agent: *\nDisallow: /\n" };
  }
  if (path === `/${INDEXNOW_KEY}.txt` && host === "heyclyde.me") return { type: "text/plain; charset=utf-8", body: INDEXNOW_KEY };
  if (path === "/llms.txt" && host === "heyclyde.me") return { type: "text/markdown; charset=utf-8", body: LLMS_TXT };
  if (path === "/sitemap.xml" && host === "heyclyde.me") {
    return { type: "application/xml; charset=utf-8", body: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      INDEXED.map((p) => `<url><loc>${SITE}${p}</loc><lastmod>${UPDATED}</lastmod></url>`).join("\n") + "\n</urlset>\n" };
  }
  return null;
}
