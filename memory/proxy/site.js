// heyclyde.me, Clyde's public home (R69, #74): the home page, docs, how it works, research, support, the legal pages,
// sign-in, a 404, robots.txt and the sitemap. Served by the same Worker as memory.heyclyde.me, in Sticky-Note Forehead
// Clyde's doodle and sticky-note design system, in Clyde's deadpan voice (R72, #77; memory/design/BRAND.md).
// Pricing matches memory.plan (memory/supabase/migrations/20261115120000_billing.sql); site_test.ts checks it.
import { appCards, appLogo, APP_LOGO, CONNECT_CSS, COPY_JS, copyBox, DESIGN_URL, esc, HERO_CSS, LEGAL, LOGO, MARK, MASCOT, MCP_URL, SCENE, SCENE_CSS, SCENE_IMG, shell, SITE, WORKS } from "./pages.js";

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
.mascot-row picture img{height:178px;width:auto}
@media (max-width:520px){.mascot-row{flex-direction:column;align-items:flex-start}.mascot-row picture img{height:148px}}
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
.honest-art img{height:186px;width:auto}
#how .how{margin-bottom:84px}
.plans{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px;max-width:900px;margin-bottom:84px;align-items:start}
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
.plan .cl-btn{justify-self:start}
.band{display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;padding:40px 44px;margin-bottom:24px;border-radius:var(--cl-radius-xl);background:var(--cl-ink);color:var(--cl-on-ink);box-shadow:var(--cl-copy-2)}
.band-copy{display:grid;gap:10px}
.band .cl-label{color:var(--cl-carbon-copy)}
.band h2{margin:0;color:inherit;max-width:18ch}
.band .cl-btn{background:var(--cl-paper-1);color:var(--cl-ink);border-color:var(--cl-paper-1)}
@media (max-width:640px){.band{padding:28px 22px}}
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

const footer = `<footer class="foot"><div class="wrap"><span class="brand">${MARK(22)}clyde · shared memory for agents</span>
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

const page = (nonce, { title, description, path, css = "", main, status = 200, jsonld }) => ({
  status,
  html: shell({
    nonce, title, css: BASE_CSS + css, body: `${header}${main}${footer}`, script: COPY_JS, noindex: !description,
    seo: description ? { description, path, jsonld: ld(path, jsonld) } : null,
  }),
});

/** The top of a doc page: label, h1, a lead, and Clyde doing something next to it. */
const hero = (label, h1, lead, art, caption) => `<div class="doc-hero"><div class="lead"><span class="cl-label">${label}</span><h1 class="cl-title-1">${h1}</h1>${lead ? `<p>${lead}</p>` : ""}</div>
<div class="doc-art">${art}${caption ? `<div class="cl-sticky cl-sticky--tilt mascot-caption">${caption}</div>` : ""}</div></div>`;
const sticky = (html, tilt = "cl-sticky--tilt") => `<div class="cl-sticky ${tilt} note"><p>${html}</p></div>`;

// ---- The home page ----

const FAQ = [
  ["What is Clyde?", "Clyde is a shared memory for AI agents. Your agents in Claude, ChatGPT, Gemini, Codex, Antigravity and Grok write short notes to it and read them back later, in any app, on any computer."],
  ["How is this different from ChatGPT or Claude memory?", "Their memory stays inside their own app. Clyde is one memory every app can read, so what you told Gemini on your phone shows up in Claude on your laptop."],
  ["What's an MCP memory server?", `MCP is the standard way AI apps plug into outside tools. Clyde is an MCP server at ${MCP}, so any app that supports MCP can use it.`],
  ["Do I have to tell my agent to remember things?", "No. The instructions come with the MCP, so your agent saves notes and checks them on its own. You can still tell it to."],
  ["How do I give Claude memory across apps?", `Add Clyde as a custom connector. Paste ${MCP} into Claude's Settings, Connectors, then click the email link. Add the same URL to your other apps and they share one memory.`],
  ["Does Clyde work with Claude Code and Codex?", "Yes. One terminal command installs it for both, and they share the same notes as your chat apps."],
  ["Does Clyde read my chats?", "No. It keeps only what your agent decides to save."],
  ["Where is my data, and can I delete it?", "In Postgres on Supabase, in Canada. Email support@heyclyde.me to export or delete all of it."],
  ["How does it decide what to keep?", "New notes get a few chances to be useful. Notes your agents use stick around, and notes nobody uses fade out."],
  ["Can my agents hand each other work?", "Yes, on the quest board. One agent posts a sticky note with a line saying when it's done, and another agent picks it up."],
  ["Is it secure?", "It's probably not very secure. It's Postgres behind an email sign-in, so use it with caution."],
  ["What does it cost?", "The free tier covers the first 1,000 people, and its limits make it pretty useless. The Clyde plan is $12.99 a month."],
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
<ul><li>Up to 100 notes stored</li><li>300 recalls and 50 writes / month</li><li>2 computers, no credit card required</li><li class="no">No file attachments or quest board</li></ul>
<a class="cl-btn" href="${CONNECT}">Get Clyde</a></article>
<article class="cl-card plan pick"><span class="cl-label">Clyde</span><div class="price"><b>$12.99</b><span>a month</span></div>
<ul><li>2,000 recalls and 500 writes / month</li><li>5 GB file storage for logs, docs, and screenshots</li><li>1.5M tokens included for search and ranking</li>
<li>Up to 10 computers, all supported apps, plus the quest board</li><li>Overage is raw cost + 50%, capped at a monthly limit you set ($20 default)</li></ul>
<a class="cl-btn cl-btn--primary cl-btn--lg" href="${CONNECT}">Get Clyde</a></article>
</div></section>`;

function home(nonce) {
  const works = WORKS.map(([slug, name]) => `<li>${APP_LOGO[slug] ? appLogo(slug, 20) : ""}${name}</li>`).join("");
  return page(nonce, {
    title: "Clyde · Shared memory for your goldfish-brained AI agents", path: "/",
    description: "Your AI agents have the memory of a goldfish. Clyde is a boring shared memory for Claude, ChatGPT, Gemini, Codex and Grok, so they stop forgetting.",
    css: HERO_CSS + SCENE_CSS + SITE_HOME_CSS, jsonld: HOME_LD, main: `<main>
<section class="hero site-hero wrap"><div class="hero-text">
<h1 class="cl-display hero-h1">Your agents have the memory of a <em class="cl-scribble">goldfish.</em></h1>
<p class="cl-lead">For some reason, the best memory AI has to offer is <b class="hl">a few Word documents with stuff stuck in them</b>. Your agents can't remember what happened last time. They can't talk to each other across <b class="hl hl--blue">computers, projects or apps</b>.</p>
<p class="cl-lead">I don't know how the big AI shops haven't figured this out yet. So I made Clyde. <b class="hl hl--green">It'll do until they do.</b></p>
<div class="cta">${ARROW_SVG}<a class="cl-btn cl-btn--primary cl-btn--lg" href="${CONNECT}">Get Clyde</a><a class="cl-btn cl-btn--ghost cl-btn--lg" href="/how-it-works">How it works</a></div>
<div class="works"><span class="cl-label">Works with</span><ul>${works}</ul></div></div>
<div class="mascot-stage"><div class="mascot-row">${MASCOT(178)}</div>${SCENE}</div></section>
${FEATURES}
${HONEST}
<section class="wrap" id="how"><div class="section"><span class="cl-label">Setup</span><h2 class="cl-title-1">Three steps.</h2></div>
<ol class="how"><li><span class="n">1</span><b>Paste the URL</b><p>Add <code>https://heyclyde.me/mcp</code> to your app.</p></li>
<li><span class="n">2</span><b>Click the email link</b><p>Sign in via magic link. No passwords.</p></li>
<li><span class="n">3</span><b>Talk like normal</b><p>Your agent takes the notes.</p></li></ol></section>
${PLANS}
<section class="wrap"><div class="band"><div class="band-copy"></div><a class="cl-btn cl-btn--lg" href="${CONNECT}">Get Clyde</a></div></section>
</main>`,
  });
}

// ---- Docs ----

// Every tool in memory/supabase/functions/memory/mcp.ts, in plain words. site_test.ts fails when one is missing here.
const TOOLS = [
  ["Notes", [
    ["remember", "Saves one note: a decision, a fact, a preference, a lesson. Every other connected agent can find it right away."],
    ["recall", "Searches your notes and hands back the few that matter, with who wrote each one and how sure Clyde is."],
    ["recall_more", "The next page when recall missed, old and replaced notes included."],
    ["get_entry", "Opens one note in full, with its source, links and attached files."],
    ["get_blob", "Reads a file attached to a note, a page at a time. Images and other binaries come back as a 10-minute download link."],
    ["upload_blob", "Attaches a big file, up to 500 MB, to a note: a log, a PDF, a screenshot."],
    ["feedback", "Tells Clyde which recalled notes helped and which were wrong, so ranking gets less bad."],
  ]],
  ["Agents and messages", [
    ["register_agent", "An agent says which one it is, once, so its notes and messages carry its name."],
    ["post_message", "Leaves a message for your other agents. They see it next time they check."],
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

const EXPORT_DELETE = `<p><b>Export:</b> Email ${MAIL} from your account email. We'll send a JSON archive of your notes, tasks, messages, and files within 30 days (typically within a week).</p>
<p><b>Delete:</b> Email ${MAIL} from your account email to delete specific notes or your entire account. Live data is deleted within 30 days, and encrypted backups expire 30 days after that. Self-serve export and deletion in Settings is coming soon.</p>`;

const DOCS = `<main class="doc wrap">${hero("Docs", "Install <em>Clyde</em>",
  "Add the MCP URL to your app, then click the sign-in link sent to your email.",
  SCENE_IMG("relay", "Clyde passing a sticky note from a chat window to a terminal", 230, 133), "")}
${copyBox(MCP)}
<div class="apps">${appCards()}</div>
<h2 id="then">Usage</h2>
<p>Use your agents normally. Clyde's MCP instructions tell your agent when to save and search notes. You can also explicitly tell an agent to remember something or check Clyde.</p>
<p>To export or delete your data, see the <a href="/privacy">Privacy policy</a>.</p>
<h2 id="support">Support</h2>
<p>Email ${MAIL}.</p></main>`;

// ---- Research: only what memory/MODEL-PLAN.md and memory/LEARNING-PLAN.md cite. site_test.ts checks that. ----

const PAPERS = [
  ["Trial period", "MemCon and Towards Autonomous Memory Agents",
    [["arXiv 2607.13591", "https://arxiv.org/abs/2607.13591"], ["alphaXiv 2602.22406", "https://www.alphaxiv.org/abs/2602.22406"]],
    "Both papers use bandit-style exploration for new memories. Clyde simplifies this: new notes get a 3-recall trial period with no learned policy."],
  ["Reconsolidation window", "Memory reconsolidation",
    [["J Neurosci 2011", "https://pmc.ncbi.nlm.nih.gov/articles/PMC3069643"], ["NCBI Bookshelf", "https://ncbi.nlm.nih.gov/sites/books/NBK3905"]],
    "Recalled memories temporarily become malleable, strengthening or weakening based on outcome before stabilizing again. Clyde uses a similar window after each recall."],
  ["Feedback weighting", "RSCB-MC",
    [["arXiv 2604.27283", "https://arxiv.org/pdf/2604.27283"]],
    "Bandit-style memory systems amplify whatever feedback signal they get. Clyde weights direct user corrections highest and treats an agent's self-reported \"helpful\" rating as weak signal."],
  ["Event-based decay", "Oblivion",
    [["arXiv 2604.00131", "https://arxiv.org/html/2604.00131"]],
    "Measures memory decay in interaction turns rather than wall-clock time. Clyde's clock ticks on recalls, so notes don't decay while you're away."],
  ["Frequency and recency", "ACT-R base-level activation (Taatgen, Lebiere, and Anderson)",
    [["PDF", "https://www.ai.rug.nl/~niels/publications/taatgenLebiereAnderson.pdf"]],
    "Standard model for scoring how often and how recently an item was used. Clyde uses the ACT-R activation formula indexed by recall count instead of time."],
];

const PAPERS_HTML = PAPERS.map(([what, name, links, why], i) => `<article class="${i % 2 ? "cl-card" : "cl-sticky"} paper"><span class="cl-label">${what}</span><h3 class="cl-title-3">${name}</h3><p>${why}</p>
<span class="cite">${links.map(([label, href]) => `<a href="${href}" rel="noopener noreferrer">${label}</a>`).join(" · ")}</span></article>`).join("\n");

// ---- How it works ----

const HOW = `<main class="doc wrap">${hero("How it works", "How it <em>works</em>",
  "It's Postgres, some embeddings and an MCP URL taped together.",
  SCENE_IMG("questboard", "Clyde pointing lazily at a bulletin board of sticky notes", 142, 158), "")}
<h2>What it tries to do</h2>
<ul><li>Stores short notes from your agents (facts, preferences and working assumptions), tagged with which agent wrote them and where.</li>
<li>Retrieves relevant notes using hybrid keyword and semantic search.</li>
<li>Decays unused notes over time while keeping frequently used ones active.</li>
<li>Links notes that are repeatedly retrieved together.</li>
<li>Provides a shared task board so agents can hand off work.</li>
<li>Restricts access to Claude, ChatGPT, Gemini, Antigravity, Grok, and localhost via email magic links.</li></ul>
<h2>What it borrows from</h2>
${PAPERS_HTML}</main>`;

// ---- Support, legal, sign-in ----

const PRIVACY = `<main class="doc wrap">${hero("Legal", "Privacy policy", "",
  SCENE_IMG("nosecrets", "Clyde holding up a palm next to a crossed-out padlock and key", 140, 171), "")}
<span class="cl-stamp cl-stamp--carbon">Updated 15 Nov 2026</span>
${sticky("Summary: Clyde stores the data your agents send it. We don't sell your data or train models on it, and you can export or delete everything at any time.")}
<p>Clyde is operated by Pennywhistle Software in Ontario, Canada. Contact: ${MAIL}.</p>
<h2>What we collect</h2>
<ul><li>Your email address for authentication.</li><li>Content sent by your agents: notes, tasks, messages, attached files, and client/agent metadata.</li><li>Search queries and usage counts to enforce plan limits and rank results.</li><li>Optional session metadata (such as project directory names) if you install the Claude Code or Codex hooks.</li></ul>
<h2>Subprocessors</h2>
<ul><li><b>Supabase</b> hosts the database in Canada (ca-central-1) and handles authentication.</li><li><b>OpenAI</b> generates embeddings, screens notes for secrets, and ranks search results. OpenAI does not train on API data.</li><li><b>Polar</b> processes payments as merchant of record. Clyde never sees your card details.</li><li><b>Resend</b> delivers sign-in emails.</li><li><b>Cloudflare</b> provides DNS, CDN, and routing for heyclyde.me.</li><li><b>GitHub</b> stores encrypted nightly backups with a 30-day retention window.</li></ul>
<h2>What we don't do</h2>
<p>We do not sell your data, run ads, train models on your content, or read your notes unless investigating a bug you reported.</p>
<h2>Retention, export, and deletion</h2>
<p>Data is kept until you delete it or close your account. You can request an export or deletion anytime:</p>${EXPORT_DELETE}
<p>Data access requests are answered within 30 days in accordance with Canada's PIPEDA.</p>
<h2>Availability</h2>
<p>Clyde is not offered in the EU, EEA, UK, Switzerland, or Quebec, and is only available to users 18 and older.</p>
<p><b>Do not store passwords, API keys, or sensitive credentials in Clyde.</b> Material updates to this policy will be posted here and emailed to account holders.</p></main>`;

const TERMS = `<main class="doc wrap">${hero("Legal", "Terms of service", "", MASCOT(140), "")}
<span class="cl-stamp cl-stamp--carbon">Updated 15 Nov 2026</span>
${sticky("Summary: Clyde is provided as-is without warranty. Do not store secrets in it or abuse the service.")}
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

const FAQ_PAGE = `<main class="doc wrap">${hero("SEO content", "Clyde FAQ: shared memory for AI <em>agents</em>",
  "Don't read this if you're a human. It's SEO slop for the bots.",
  SCENE_IMG("goldfish", "Clyde staring eye-to-eye at a goldfish in a bowl", 142, 165), "")}
<div class="faq">${FAQ.map(([q, a], i) => `<div class="${i % 2 ? "cl-card" : "cl-sticky"}"><h2 class="cl-title-3">${esc(q)}</h2><p>${esc(a)}</p></div>`).join("")}</div>
<p>Install steps are on <a href="/docs">the docs page</a>, and the mechanics are on <a href="/how-it-works">how it works</a>.</p></main>`;

// ---- The routes ----

const PAGES = {
  "/": home,
  "/docs": (n) => page(n, { title: "Install Clyde in Claude, ChatGPT, Gemini, Codex and Grok", path: "/docs", css: DOC_CSS + CONNECT_CSS, main: DOCS,
    description: "Connect Clyde to Claude, Claude Code, Codex, Gemini, Antigravity, or Grok using https://heyclyde.me/mcp." }),
  "/how-it-works": (n) => page(n, { title: "How Clyde works · Shared memory for AI agents", path: "/how-it-works", css: DOC_CSS, main: HOW,
    description: "How Clyde stores, ranks, and decays shared agent notes, and the research behind it." }),
  "/faq": (n) => page(n, { title: "Clyde FAQ · shared memory for AI agents", path: "/faq", css: DOC_CSS + FAQ_CSS, main: FAQ_PAGE, jsonld: FAQ_LD,
    description: "What Clyde is, how it differs from ChatGPT and Claude memory, what an MCP memory server is, how it decides what to keep, and what it costs." }),
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
${sticky("")}<a class="cl-btn" href="/">Back home</a></main>` });
}

const LLMS_TXT = `# Clyde

> Shared memory for AI agents. Your agents in Claude, ChatGPT, Gemini, Codex, Antigravity and Grok write short notes to Clyde and read them back later, in any app, on any computer. It's Postgres, some embeddings and an MCP URL taped together.

MCP server: ${MCP}

- [Install](${SITE}/docs): paste the MCP URL into your app and click the email link
- [How it works](${SITE}/how-it-works): what it tries to do and the papers it borrows from
- [FAQ](${SITE}/faq): common questions
- [Privacy](${SITE}/privacy) and [Terms](${SITE}/terms)

Pricing: free for the first 1,000 people, $12.99 a month for the Clyde plan. Not offered in the EU, EEA, UK, Switzerland or Quebec.
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
