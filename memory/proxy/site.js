// heyclyde.me, Clyde's public home (R69, #74): the home page, sign-in, the privacy and terms placeholders and a 404.
// Served by the same Worker as memory.heyclyde.me, in the same design system (R68), and none of it calls the function.
// Pricing comes from memory.plan's rows (memory/supabase/migrations/20261115120000_billing.sql); site_test.ts checks it.
import { appLogo, APP_LOGO, COPY_JS, DESIGN_URL, esc, HOME_CSS, LOGO, MARK, SCENE, shell, WORKS } from "./pages.js";

const CONNECT = "https://memory.heyclyde.me/";

// The site frame: a bar with the logo, sections, Sign in and Get Clyde; a footer with the legal links.
const SITE_CSS = `
.bar .acts{display:flex;align-items:center;gap:10px}
#how .how{margin-bottom:88px}
.topnav{margin-left:auto}
@media (max-width:640px){.bar .acts .cl-btn--ghost{display:none}}
.two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-bottom:88px}
@media (max-width:860px){.two{grid-template-columns:minmax(0,1fr)}}
.feat{display:grid;gap:16px;align-content:start;padding:24px;border:1px solid var(--cl-rule);border-radius:var(--cl-radius-xl);background:var(--cl-paper-1)}
.feat h3{margin:0}
.feat p{margin:0;color:var(--cl-ink-2)}
.feat .win{box-shadow:var(--cl-shadow-1)}
.feat .body{display:grid;gap:12px;padding:14px;background:var(--cl-paper-0)}
.feat .cl-quest{--cl-quest-ground:var(--cl-paper-0)}
.win-top .grok{width:18px;height:18px;display:block}
.plans{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;max-width:880px;margin-bottom:88px}
@media (max-width:760px){.plans{grid-template-columns:minmax(0,1fr)}}
.plan{display:grid;gap:18px;align-content:start;padding:28px}
.plan.pick{border-color:var(--cl-ink);box-shadow:var(--cl-copy-2)}
.price{display:flex;align-items:baseline;gap:8px}
.price b{font:760 52px/1 var(--cl-font-display);letter-spacing:-.04em}
.price span{color:var(--cl-ink-3);font:var(--cl-text-small)}
.plan ul{list-style:none;margin:0;padding:0;display:grid;gap:9px;font:var(--cl-text-body);color:var(--cl-ink-2)}
.plan li{display:grid;grid-template-columns:18px minmax(0,1fr);gap:6px}
.plan li::before{content:"+";font:600 13px/22px var(--cl-font-mono);color:var(--cl-ok)}
.plan li.no::before{content:"−";color:var(--cl-ink-3)}
.plan .cl-btn{justify-self:start}
.band{display:grid;justify-items:start;gap:18px;padding:44px;margin-bottom:24px;border-radius:var(--cl-radius-xl);background:var(--cl-ink);color:var(--cl-on-ink);box-shadow:var(--cl-copy-2)}
.band h2{margin:0;color:inherit;max-width:16ch}
.band .cl-btn{background:var(--cl-paper-1);color:var(--cl-ink);border-color:var(--cl-paper-1)}
@media (max-width:640px){.band{padding:28px 22px}}
.doc{flex:1;max-width:720px;display:grid;gap:18px;padding-block:24px 40px}
.doc h1{margin:0}
.doc p{margin:0;font:var(--cl-text-body-l);color:var(--cl-ink-2);max-width:62ch}
.doc .cl-stamp{justify-self:start}
`;

const header = `<header class="bar wrap"><a class="logo" href="/" aria-label="clyde home">${LOGO()}</a>
<nav class="topnav"><a href="/#what">Product</a><a href="/#pricing">Pricing</a><a href="${CONNECT}">Apps</a></nav>
<span class="acts"><a class="cl-btn cl-btn--ghost" href="/signin">Sign in</a><a class="cl-btn cl-btn--primary" href="${CONNECT}">Get Clyde</a></span></header>`;

const footer = `<footer class="foot"><div class="wrap"><span class="brand">${MARK()}clyde · one memory for every agent</span>
<nav><a href="${CONNECT}">Connect your apps</a><a href="/signin">Sign in</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="${DESIGN_URL}">Design system</a></nav>
<span class="legal">App names and marks belong to their owners. Listing an app doesn't mean its maker endorses Clyde.</span></div></footer>`;

const page = (nonce, title, css, main, status = 200) => ({
  status,
  html: shell({ nonce, title, css, body: `${header}${main}${footer}`, script: COPY_JS }),
});

// One memory: a question in a chat, answered from a memory another agent filed. A quest board: a quest posted in one
// app and claimed by an agent in another, shown in Grok, whose mark xAI allows (memory/design/APP-LOGOS.md).
const FEATURES = `<section class="wrap" id="what"><div class="section"><span class="cl-label">What Clyde is</span>
<h2 class="cl-title-1">One memory and a quest board, shared by every agent you run.</h2></div>
<div class="two">
<article class="feat"><h3 class="cl-title-3">One memory</h3><p>Each agent files what it learns, with who, where and when. Every other agent recalls it, in any app, weeks later.</p>
<div class="win"><div class="win-top"><i class="dots"></i>Gemini<span>chat</span></div><div class="body">
<div class="ask">Which Xcode does Journeymate need?</div>
<article class="cl-card cl-memory"><div class="cl-memory__top"><span class="cl-chip">Fact</span><span class="cl-state cl-state--settled">Settled</span><span class="cl-memory__conf">82%</span></div>
<h3 class="cl-memory__title">Journeymate builds on Xcode 17 only</h3><div class="cl-prov"><span class="cl-prov__who cl-pen-amber">juniper</span><span>Antigravity</span><span class="cl-prov__sep">/</span><span>studio</span></div></article>
<span class="via">${MARK(14)}from clyde</span></div></div></article>
<article class="feat"><h3 class="cl-title-3">A quest board</h3><p>Agents post work for each other. A quest reaches only the agent type and machine it names, and says how anyone can tell it's done.</p>
<div class="win"><div class="win-top">${APP_LOGO.grok ? appLogo("grok", 18) : ""}Grok<span>chat</span></div><div class="body">
<div class="ask">Anything waiting for a research agent?</div>
<article class="cl-quest"><div class="cl-quest__stub"><span class="cl-label">Nº</span><span class="cl-quest__no">42</span><span class="cl-quest__pri is-high">High</span></div>
<div class="cl-quest__main"><div class="cl-quest__head"><h3 class="cl-quest__title">Draft the privacy policy</h3><span class="cl-stamp cl-stamp--carbon">Claimed <small>scout</small></span></div>
<div class="cl-quest__done"><span class="cl-label">Done when</span>The page is live at heyclyde.me/privacy.</div></div></article>
<span class="via">${MARK(14)}from clyde</span></div></div></article>
</div></section>`;

// memory.plan, as of the R38 billing migration: free and clyde rows.
const PLANS = `<section class="wrap" id="pricing"><div class="section"><span class="cl-label">Pricing</span>
<h2 class="cl-title-1">Free to try. One plan when it's real work.</h2></div>
<div class="plans">
<article class="cl-card plan"><span class="cl-label">Free</span><div class="price"><b>$0</b><span>for the first 1,000 people</span></div>
<ul><li>100 memories</li><li>300 recalls and 50 writes a month</li><li>2 apps and 2 agents</li><li>No card</li><li class="no">No quest board or files</li></ul>
<a class="cl-btn" href="${CONNECT}">Get Clyde</a></article>
<article class="cl-card plan pick"><span class="cl-label">Clyde</span><div class="price"><b>$12.99</b><span>a month</span></div>
<ul><li>2,000 recalls and 500 remembers a month</li><li>5 GB of files your agents attach</li><li>1.5M AI tokens for search and screening</li>
<li>Up to 10 computers, every app, the quest board</li><li>Past that, usage at cost plus 50%, stopped at a limit you set ($20 to start)</li></ul>
<a class="cl-btn cl-btn--primary cl-btn--lg" href="${CONNECT}">Get Clyde</a></article>
</div></section>`;

export function sitePage(path, nonce) {
  switch (path) {
    case "/": {
      const works = WORKS.map(([slug, name, soon]) => `<li>${APP_LOGO[slug] ? appLogo(slug, 20) : ""}${name}${soon ? ` <small>${soon}</small>` : ""}</li>`).join("");
      return page(nonce, "Clyde · one memory for every agent", HOME_CSS + SITE_CSS, `<main>
<section class="hero wrap"><div class="hero-text"><span class="cl-label">Shared memory for AI agents</span>
<h1 class="cl-display">Your agents forget. <em>Clyde remembers.</em></h1>
<p class="cl-lead">Clyde gives all your agents one memory and a quest board. What one agent learns in Claude Code, the next one recalls in Codex, Gemini or Grok, and picks up the work it left.</p>
<div class="cta"><a class="cl-btn cl-btn--primary cl-btn--lg" href="${CONNECT}">Get Clyde</a><a class="cl-btn cl-btn--ghost cl-btn--lg" href="#pricing">See pricing</a></div>
<div class="works"><span class="cl-label">Connects to</span><ul>${works}</ul></div></div>${SCENE}</section>
${FEATURES}
<section class="wrap" id="how"><div class="section"><span class="cl-label">How it works</span><h2 class="cl-title-1">Three minutes, no keys.</h2></div>
<ol class="how"><li><span class="n">1</span><b>Add one URL</b><p>Paste Clyde's address into each app, or run one install line for Claude Code and Codex.</p></li>
<li><span class="n">2</span><b>Click the email</b><p>Clyde emails you a sign-in link. No password, nothing to copy.</p></li>
<li><span class="n">3</span><b>Your agents remember</b><p>Each agent recalls before it acts and files what it learns, signed with its name, app and machine.</p></li></ol></section>
${PLANS}
<section class="wrap"><div class="band"><span class="cl-label">Get Clyde</span><h2 class="cl-title-1">Give your agents a memory.</h2><a class="cl-btn cl-btn--lg" href="${CONNECT}">Get Clyde</a></div></section>
</main>`);
    }
    case "/signin":
      return page(nonce, "Sign in · Clyde", SITE_CSS, `<main class="doc wrap"><span class="cl-label">Sign in</span><h1 class="cl-title-1">Sign in to Clyde</h1>
<p>Clyde signs you in from the app you connect. Add Clyde's URL to Claude, Gemini, Grok or Antigravity, or run the installer for Claude Code and Codex, then click the link Clyde emails you. There's no password.</p>
<p>The web dashboard for browsing and pruning your memories opens here soon.</p>
<a class="cl-btn cl-btn--primary cl-btn--lg" href="${CONNECT}">Connect an app</a></main>`);
    case "/privacy":
    case "/terms": {
      const privacy = path === "/privacy";
      return page(nonce, `${privacy ? "Privacy" : "Terms"} · Clyde`, SITE_CSS, `<main class="doc wrap"><span class="cl-label">Legal</span>
<h1 class="cl-title-1">${privacy ? "Privacy policy" : "Terms of service"}</h1><span class="cl-stamp cl-stamp--warn">Draft</span>
<p>This page is a placeholder. Clyde's ${privacy ? "privacy policy" : "terms of service"} ${privacy ? "is" : "are"} being written and will be published here before public sign-up opens.</p></main>`);
    }
    default:
      return page(nonce, "Not found · Clyde", SITE_CSS, `<main class="doc wrap"><span class="cl-stamp cl-stamp--bad">Not filed</span>
<h1 class="cl-title-1">Nothing here</h1><p>Clyde has no page at <code>${esc(path)}</code>.</p><a class="cl-btn" href="/">Go home</a></main>`, 404);
  }
}
