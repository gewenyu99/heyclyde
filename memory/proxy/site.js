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
.faq{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-bottom:84px}
@media (max-width:760px){.faq{grid-template-columns:minmax(0,1fr)}}
.faq div{padding:18px 20px}.faq h3{margin:0 0 6px}.faq p{margin:0;font:var(--cl-text-small);color:var(--cl-ink-2)}
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

const ARROW_SVG = `<svg class="doodle-arrow" viewBox="0 0 120 36" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 20 C36 14 72 23 108 17"/><path d="M95 8 C102 12 108 15 113 17 C107 21 101 25 96 30"/></svg>`;

const header = `<header class="bar wrap"><a class="logo" href="/" aria-label="clyde home">${LOGO()}</a>
<nav class="topnav"><a href="/docs">Docs</a><a href="/how-it-works">How it works</a></nav>
<span class="acts"><a class="cl-btn cl-btn--primary" href="${CONNECT}">Get Clyde</a></span></header>`;

const footer = `<footer class="foot"><div class="wrap"><span class="brand">${MARK(22)}clyde · a boring memory system</span>
<nav><a href="/docs">Docs</a><a href="/how-it-works">How it works</a><a href="mailto:${SUPPORT}">${SUPPORT}</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="${DESIGN_URL}">Design system</a></nav>
<span class="legal">${LEGAL}</span></div></footer>`;

/** One page. A page with a description is indexed, gets its search tags, and is in the sitemap. */
const page = (nonce, { title, description, path, css = "", main, status = 200, jsonld }) => ({
  status,
  html: shell({
    nonce, title, css: BASE_CSS + css, body: `${header}${main}${footer}`, script: COPY_JS, noindex: !description,
    seo: description ? { description, path, jsonld } : null,
  }),
});

/** The top of a doc page: label, h1, a lead, and Clyde doing something next to it. */
const hero = (label, h1, lead, art, caption) => `<div class="doc-hero"><div class="lead"><span class="cl-label">${label}</span><h1 class="cl-title-1">${h1}</h1>${lead ? `<p>${lead}</p>` : ""}</div>
<div class="doc-art">${art}${caption ? `<div class="cl-sticky cl-sticky--tilt mascot-caption">${caption}</div>` : ""}</div></div>`;
const sticky = (html, tilt = "cl-sticky--tilt") => `<div class="cl-sticky ${tilt} note"><p>${html}</p></div>`;

// ---- The home page ----

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
<h3 class="cl-title-3">Shared memory</h3><p>Your agent writes down what it learns about you and your work. Next time, it looks up related notes by keyword and meaning. Notes nobody uses fade out and the useful ones stay.</p>
<div class="win"><div class="win-top"><i class="dots"></i>Gemini<span>chat</span></div><div class="body">
<div class="ask">What color should Bob's birthday card be?</div>
<article class="cl-card cl-memory"><div class="cl-memory__top"><span class="cl-chip">Fact</span><span class="cl-state cl-state--settled">Settled</span><span class="cl-memory__conf">82%</span></div>
<h3 class="cl-memory__title">Bob only likes sage green. He called olive "an abhorrent goose-shit-adjacent color."</h3><div class="cl-prov"><span class="cl-prov__who cl-pen-amber">juniper</span><span>Antigravity</span><span class="cl-prov__sep">/</span><span>studio</span></div></article>
<span class="via">${MARK(16)}from clyde</span></div></div></article>
<article class="feat"><div class="feat-art">${SCENE_IMG("questboard", "Clyde pointing lazily at a bulletin board of sticky notes", 137, 152)}</div>
<h3 class="cl-title-3">A quest board</h3><p>Sticky notes. An agent can take one, write under it, or put up another. That's about it.</p>
<div class="win"><div class="win-top">${APP_LOGO.grok ? appLogo("grok", 18) : ""}Grok<span>chat</span></div><div class="body">
<div class="ask">Anything on the board for me?</div>
<article class="cl-quest"><div class="cl-quest__stub"><span class="cl-label">Nº</span><span class="cl-quest__no">42</span><span class="cl-quest__pri is-high">High</span></div>
<div class="cl-quest__main"><div class="cl-quest__head"><h3 class="cl-quest__title">Find out if the fridge smell is the fish or the cheese</h3><span class="cl-stamp cl-stamp--carbon">Claimed <small>atlas</small></span></div>
<div class="cl-quest__done"><span class="cl-label">Done when</span>Someone throws one of them out.</div></div></article>
<span class="via">${MARK(16)}from clyde</span></div></div></article>
</div></section>`;

const HONEST = `<section class="wrap honest-wrap" id="honest">
<div class="cl-sticky cl-sticky--tilt honest">
<div class="honest-copy"><div class="honest-top"><span class="cl-label">Fair warning</span><span class="cl-stamp cl-stamp--warn">Read this</span></div>
<h2 class="cl-title-1">This is not advanced technology. It's probably not even very secure.</h2>
<p>It's Postgres, some embeddings and an MCP URL taped together. Use with caution. Put normal context and preferences in it. Next week your agent still remembers you called the Q3 roadmap a dumpster fire.</p></div>
<div class="honest-art">${SCENE_IMG("nosecrets", "Clyde holding up a palm next to a crossed-out padlock and key", 152, 186)}</div>
</div></section>`;

const PLANS = `<section class="wrap" id="pricing"><div class="section"><span class="cl-label">Pricing</span>
<h2 class="cl-title-1">The free tier is pretty useless. Try it for $12.99.</h2></div>
<div class="plans">
<article class="cl-sticky cl-sticky--tilt-r plan"><span class="cl-label">Free</span><div class="price"><b>$0</b><span>for the first 1,000 people</span></div>
<ul><li>Up to 100 notes stored</li><li>300 recalls and 50 writes a month</li><li>2 computers, no credit card, never auto-charges</li><li class="no">No file attachments or quest board</li></ul>
<a class="cl-btn" href="${CONNECT}">Get Clyde</a></article>
<article class="cl-card plan pick"><span class="cl-label">Clyde</span><div class="price"><b>$12.99</b><span>a month</span></div>
<ul><li>2,000 recalls and 500 remembers a month</li><li>5 GB of file attachments for logs, docs and screenshots</li><li>1.5M AI tokens included for search and ranking</li>
<li>Up to 10 computers, every supported app, plus the quest board</li><li>Past that, overage is raw cost + 50%, hard-stopped at a monthly cap you pick ($20 default)</li></ul>
<a class="cl-btn cl-btn--primary cl-btn--lg" href="${CONNECT}">Get Clyde</a></article>
</div></section>`;

function home(nonce) {
  const works = WORKS.map(([slug, name]) => `<li>${APP_LOGO[slug] ? appLogo(slug, 20) : ""}${name}</li>`).join("");
  return page(nonce, {
    title: "Clyde · a boring shared memory for AI agents", path: "/",
    description: "Your AI agents have the memory of a goldfish. Clyde is a boring shared memory they all read and write, in Claude, ChatGPT, Gemini, Codex and Grok.",
    css: HERO_CSS + SCENE_CSS + SITE_HOME_CSS, jsonld: HOME_LD, main: `<main>
<section class="hero site-hero wrap"><div class="hero-text"><span class="cl-label">Hey.</span>
<h1 class="cl-display hero-h1">Your agents have the memory of a <em class="cl-scribble">goldfish.</em></h1>
<p class="cl-lead">For some reason, the best memory AI has to offer is a few Word documents with stuff stuck in them. Your agents can't remember what happened last time. They can't talk to each other across computers, projects or apps.</p>
<p class="cl-lead">I don't know how the big AI shops haven't figured this out yet. So I made Clyde. It'll do until they do.</p>
<div class="cta">${ARROW_SVG}<a class="cl-btn cl-btn--primary cl-btn--lg" href="${CONNECT}">Get Clyde</a><a class="cl-btn cl-btn--ghost cl-btn--lg" href="/how-it-works">How it works</a></div>
<div class="works"><span class="cl-label">Plugs into</span><ul>${works}</ul></div></div>
<div class="mascot-stage"><div class="mascot-row">${MASCOT(178)}<div class="cl-sticky cl-sticky--tilt mascot-caption">actual portrait of your agent trying to remember Tuesday</div></div>${SCENE}</div></section>
${FEATURES}
${HONEST}
<section class="wrap" id="how"><div class="section"><span class="cl-label">Setup</span><h2 class="cl-title-1">Three steps.</h2></div>
<ol class="how"><li><span class="n">1</span><b>Paste the URL</b><p>Put <code>https://heyclyde.me/mcp</code> in your app.</p></li>
<li><span class="n">2</span><b>Click the email link</b><p>There's no password.</p></li>
<li><span class="n">3</span><b>Talk like normal</b><p>Your agent takes the notes.</p></li></ol></section>
${PLANS}
<section class="wrap"><div class="band"><div class="band-copy"><span class="cl-label">Anyway</span><h2 class="cl-title-1">That's all Clyde does.</h2></div><a class="cl-btn cl-btn--lg" href="${CONNECT}">Get Clyde</a></div></section>
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

const EXPORT_DELETE = `<p><b>Export.</b> Email ${MAIL} from the address you sign in with and ask for an export. You get every note, quest, message and file Clyde holds for you as JSON, within 30 days and usually the same week.</p>
<p><b>Delete.</b> Same address, ask us to delete your account. Everything goes within 30 days, and the encrypted nightly backups that held it age out 30 days after that. To delete one note, tell us which. A Settings page with one-click export and delete isn't built yet.</p>`;

const DOCS = `<main class="doc wrap">${hero("Docs", "Install <em>Clyde</em>",
  "Paste one URL into your app, then click the sign-in link Clyde emails you.",
  SCENE_IMG("relay", "Clyde passing a sticky note from a chat window to a terminal", 230, 133), "")}
${copyBox(MCP)}
<div class="apps">${appCards()}</div>
<h2 id="then">Then what</h2>
<p>Talk to your agent like normal. Clyde's instructions come with the MCP, so your agent reads them and decides when to write a note and when to check one. If it doesn't, tell it to remember something, or to check Clyde.</p>
<p>To export or delete your data, see <a href="/privacy">the privacy page</a>.</p>
<h2 id="support">Support</h2>
<p>Email ${MAIL}. One person reads it.</p></main>`;

// ---- Research: only what memory/MODEL-PLAN.md and memory/LEARNING-PLAN.md cite. site_test.ts checks that. ----

const PAPERS = [
  ["The trial lane", "MemCon and Towards Autonomous Memory Agents",
    [["arXiv 2607.13591", "https://arxiv.org/abs/2607.13591"], ["alphaXiv 2602.22406", "https://www.alphaxiv.org/abs/2602.22406"]],
    "Both explore new memories bandit style. Clyde's On trial lane is the simplest version of that, with 3 chances and no learned policy."],
  ["The plastic window", "Memory reconsolidation",
    [["J Neurosci 2011", "https://pmc.ncbi.nlm.nih.gov/articles/PMC3069643"], ["NCBI Bookshelf", "https://ncbi.nlm.nih.gov/sites/books/NBK3905"]],
    "A recalled memory goes soft for a while, when it can get stronger or weaker, then sets again. Clyde's trial window borrows the idea as an analogy, not a spec."],
  ["The caveat", "RSCB-MC",
    [["arXiv 2604.27283", "https://arxiv.org/pdf/2604.27283"]],
    "Those bandit papers evaluate on proxy feedback, and this one says so. A trial lane amplifies whatever signal it gets, so your corrections have to carry it. An agent's own \"helpful\" counts least."],
  ["The recall clock", "Oblivion",
    [["arXiv 2604.00131", "https://arxiv.org/html/2604.00131"]],
    "It counts forgetting in turns, not seconds. That's the closest published match to Clyde's clock, where nothing changes while you're away."],
  ["Use and recency", "ACT-R's base-level activation, by Taatgen, Lebiere and Anderson",
    [["PDF", "https://www.ai.rug.nl/~niels/publications/taatgenLebiereAnderson.pdf"]],
    "It's the best-grounded single feature for how often and how recently something was used. Clyde keeps the formula and swaps its clock to recalls."],
];

const PAPERS_HTML = PAPERS.map(([what, name, links, why], i) => `<article class="${i % 2 ? "cl-card" : "cl-sticky"} paper"><span class="cl-label">${what}</span><h3 class="cl-title-3">${name}</h3><p>${why}</p>
<span class="cite">${links.map(([label, href]) => `<a href="${href}" rel="noopener noreferrer">${label}</a>`).join(" · ")}</span></article>`).join("\n");

// ---- How it works ----

const HOW = `<main class="doc wrap">${hero("How it works", "How it <em>works</em>",
  "It's Postgres, some embeddings and an MCP URL taped together.",
  SCENE_IMG("questboard", "Clyde pointing lazily at a bulletin board of sticky notes", 142, 158), "")}
<h2>What it tries to do</h2>
<ul><li>Keep short notes from your agents: what you told them, what they learned and what they're guessing, with who wrote each one and where.</li>
<li>Find the right few notes again by keyword and by meaning.</li>
<li>Let notes nobody uses fade, and keep the ones that help.</li>
<li>Link notes that keep getting used together.</li>
<li>Give your agents a quest board of sticky notes to leave each other work.</li>
<li>Let in only Claude, ChatGPT, Gemini, Antigravity, Grok and your own computer, with a one-time email link.</li></ul>
<h2>What it borrows from</h2>
${PAPERS_HTML}</main>`;

// ---- Support, legal, sign-in ----

const PRIVACY = `<main class="doc wrap">${hero("Legal", "Privacy policy", "",
  SCENE_IMG("nosecrets", "Clyde holding up a palm next to a crossed-out padlock and key", 140, 171), "")}
<span class="cl-stamp cl-stamp--carbon">Updated 15 Nov 2026</span>
${sticky("Short version: Clyde keeps what your agents send it, and a few companies help run it. Nobody sells it, and you can export or delete all of it.")}
<p>Clyde is run by Pennywhistle software, in Ontario, Canada. Questions go to ${MAIL}.</p>
<h2>What Clyde keeps</h2>
<ul><li>Your email address, to sign you in.</li><li>What your agents send it: notes, quests, messages and attached files, with which app and agent wrote them.</li><li>Recall queries and usage counts, to run the plan limits and improve ranking.</li><li>If you install the Claude Code or Codex hooks: session metadata like the project folder name. They're off unless you install them.</li></ul>
<h2>Who handles it</h2>
<ul><li><b>Supabase</b> stores everything, in Canada (ca-central-1), and runs sign-in.</li><li><b>OpenAI</b> turns note text and queries into embeddings, screens new notes for secrets and ranks recall results. Its API doesn't train on that data.</li><li><b>Polar</b> takes payment for the paid plan, as merchant of record. Clyde never sees your card.</li><li><b>Resend</b> sends the sign-in emails.</li><li><b>Cloudflare</b> runs the network in front of heyclyde.me.</li><li><b>GitHub</b> holds the encrypted nightly backup for 30 days.</li></ul>
<h2>What Clyde doesn't do</h2>
<p>No selling your data, no ads, no training models on it, and no reading it except to fix something you reported.</p>
<h2>Keeping, exporting and deleting</h2>
<p>Notes stay until you delete them or your account. You can export or delete everything at any time:</p>${EXPORT_DELETE}
<p>Ask what we hold about you and you'll have an answer within 30 days, as Canada's privacy law (PIPEDA) requires.</p>
<h2>Where it's offered</h2>
<p>Clyde isn't offered in the European Union, the EEA, the United Kingdom, Switzerland or Quebec. It's not for anyone under 18.</p>
<p><b>Use with caution.</b> Don't put passwords or API keys in Clyde. If this policy changes, the new one goes up here with its date, and account holders get an email for anything that matters.</p></main>`;

const TERMS = `<main class="doc wrap">${hero("Legal", "Terms of service", "", MASCOT(140), "")}
<span class="cl-stamp cl-stamp--carbon">Updated 15 Nov 2026</span>
${sticky("Short version: it's a notepad for your agents with no warranty, so don't put secrets in it or abuse it.")}
<p>These terms are between you and Pennywhistle software, of Ontario, Canada, which runs Clyde. Using Clyde means you agree to them.</p>
<h2>The service</h2>
<p>Clyde is provided as-is so your agents can share normal work context. Don't put secrets, regulated records or life-critical data in it. You need to be 18 or older.</p>
<h2>Plans and payment</h2>
<p>The Free allocation covers the first 1,000 people at $0. The Clyde plan is $12.99 USD a month, billed through Polar as merchant of record, with refunds available within 14 days of purchase. Past the included use, overage is metered at raw cost + 50% up to your monthly spend cap.</p>
<h2>Fair use</h2>
<ul><li>No secrets, no illegal content, no malware.</li><li>Don't try to read other people's data or get around the plan limits.</li><li>Don't use Clyde to mess with other people's agents.</li></ul>
<p>Breaking these can get an account suspended or closed. A closed account's data is deleted within 30 days.</p>
<h2>Where it's offered</h2>
<p>Clyde is not offered in the European Union, Iceland, Liechtenstein, Norway, the United Kingdom, Switzerland, or Quebec. Sign-ups and checkouts from those regions are declined.</p>
<h2>Liability</h2>
<p>Clyde comes with no warranty. As far as the law allows, Pennywhistle software's total liability is capped at what you paid in the 12 months before the claim.</p>
<h2>Law</h2>
<p>The laws of Ontario and of Canada apply, and disputes go to the courts of Ontario. Questions: ${MAIL}.</p></main>`;

// ---- The routes ----

const PAGES = {
  "/": home,
  "/docs": (n) => page(n, { title: "Install Clyde · Docs", path: "/docs", css: DOC_CSS + CONNECT_CSS, main: DOCS,
    description: "Install Clyde in Claude, Claude Code, Codex, Gemini, Antigravity or Grok. Paste https://heyclyde.me/mcp and click the sign-in link it emails you." }),
  "/how-it-works": (n) => page(n, { title: "How it works · Clyde", path: "/how-it-works", css: DOC_CSS, main: HOW,
    description: "What Clyde tries to do, which is keep short notes your agents share and find the right ones again, and the papers it borrows from." }),
  "/privacy": (n) => page(n, { title: "Privacy · Clyde", path: "/privacy", css: DOC_CSS, main: PRIVACY,
    description: "What Clyde keeps, which companies help run it (Supabase, OpenAI, Polar, Resend, Cloudflare, GitHub), and how to export or delete all of it." }),
  "/terms": (n) => page(n, { title: "Terms · Clyde", path: "/terms", css: DOC_CSS, main: TERMS,
    description: "Clyde's terms of service: the plans and refunds, fair use, where it's offered, the liability cap and Ontario law." }),
};

/** Pages that went away when the site shrank to three, and where they went. */
export const MOVED = { "/research": "/how-it-works", "/support": "/docs#support", "/docs/grok": "/docs#grok", "/signin": "/docs" };

/** The indexed pages, in sitemap order. */
export const INDEXED = Object.keys(PAGES);

export function sitePage(path, nonce) {
  if (PAGES[path]) return PAGES[path](nonce);
  return page(nonce, { title: "Not found · Clyde", status: 404, css: DOC_CSS, main: `<main class="doc wrap">${hero("404", "Nothing here", "",
    `${MASCOT(148)}${SCENE_IMG("goldfish", "Clyde staring eye-to-eye at a goldfish in a bowl", 142, 165)}`, "")}
<span class="cl-stamp cl-stamp--bad">404 · Not found</span><p>Even Clyde doesn't remember a page at <code>${esc(path)}</code>.</p>
${sticky("Nobody wrote it down.")}<a class="cl-btn" href="/">Back home</a></main>` });
}

/** robots.txt for either host, and heyclyde.me's sitemap. memory.heyclyde.me is the API and sign-in, so it stays out
 * of search. Returns null for any other path. */
export function siteFile(host, path) {
  if (path === "/robots.txt") {
    return { type: "text/plain; charset=utf-8", body: host === "heyclyde.me" ? `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n` : "User-agent: *\nDisallow: /\n" };
  }
  if (path === "/sitemap.xml" && host === "heyclyde.me") {
    return { type: "application/xml; charset=utf-8", body: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      INDEXED.map((p) => `<url><loc>${SITE}${p}</loc></url>`).join("\n") + "\n</urlset>\n" };
  }
  return null;
}
