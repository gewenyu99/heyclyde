// heyclyde.me, Clyde's public home (R69, #74): the home page, sign-in, the privacy and terms pages, and a 404.
// Served by the same Worker as memory.heyclyde.me, in Sticky-Note Forehead Clyde's doodle & sticky-note design system.
// Pricing matches memory.plan (memory/supabase/migrations/20261115120000_billing.sql); site_test.ts checks it.
import { appLogo, APP_LOGO, COPY_JS, DESIGN_URL, esc, HOME_CSS, LOGO, MARK, MASCOT, SCENE, SCENE_CSS, SCENE_IMG, shell, WORKS } from "./pages.js";

const CONNECT = "https://memory.heyclyde.me/";

const SITE_CSS = `
.bar .acts{display:flex;align-items:center;gap:10px}
.topnav{margin-left:auto}
@media (max-width:720px){.bar .acts .cl-btn--ghost{display:none}}
.site-hero{grid-template-columns:minmax(0,1.12fr) minmax(0,.88fr);gap:44px}
@media (max-width:960px){.site-hero{grid-template-columns:minmax(0,1fr);gap:32px}}
.hero-h1{font-size:clamp(33px,4.2vw,54px);line-height:1.06;max-width:19ch}
.doodle-arrow{width:54px;height:20px;color:var(--cl-carbon);flex:none}
@media (max-width:560px){.doodle-arrow{display:none}}
.mascot-stage{display:grid;gap:18px;align-content:start}
.mascot-row{display:flex;align-items:flex-end;gap:16px}
.mascot-row picture img{height:178px;width:auto}
.mascot-caption{padding:11px 14px;max-width:210px;font:var(--cl-text-mono);font-size:11.5px;line-height:1.45}
@media (max-width:520px){.mascot-row{flex-direction:column;align-items:flex-start}.mascot-row picture img{height:148px}}
.two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-bottom:76px}
@media (max-width:860px){.two{grid-template-columns:minmax(0,1fr)}}
.feat{display:grid;gap:16px;align-content:start;padding:24px;border:1px solid var(--cl-rule);border-radius:var(--cl-radius-xl);background:var(--cl-paper-1)}
.feat h3{margin:0}
.feat p{margin:0;color:var(--cl-ink-2)}
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
.doc{flex:1;max-width:760px;display:grid;gap:18px;padding-block:28px 48px;align-content:start}
.doc h1{margin:0}
.doc p{margin:0;font:var(--cl-text-body-l);color:var(--cl-ink-2);max-width:64ch}
.doc .cl-stamp,.doc .cl-btn{justify-self:start}
.doc-art{display:flex;align-items:flex-end;gap:20px;flex-wrap:wrap;padding-block:6px}
.doc-art img{height:164px;width:auto}
`;

const ARROW_SVG = `<svg class="doodle-arrow" viewBox="0 0 120 36" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 20 C36 14 72 23 108 17"/><path d="M95 8 C102 12 108 15 113 17 C107 21 101 25 96 30"/></svg>`;

const header = `<header class="bar wrap"><a class="logo" href="/" aria-label="clyde home">${LOGO()}</a>
<nav class="topnav"><a href="/#what">What it does</a><a href="/#honest">Fine print</a><a href="/#pricing">Pricing</a><a href="${CONNECT}">Apps</a></nav>
<span class="acts"><a class="cl-btn cl-btn--ghost" href="/signin">Sign in</a><a class="cl-btn cl-btn--primary" href="${CONNECT}">Get Clyde</a></span></header>`;

const footer = `<footer class="foot"><div class="wrap"><span class="brand">${MARK(22)}clyde · bare-minimum memory for forgetful agents</span>
<nav><a href="${CONNECT}">Connect your apps</a><a href="/signin">Sign in</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="${DESIGN_URL}">Design system</a></nav>
<span class="legal">Claude, ChatGPT, Codex, Gemini, Antigravity, and Grok belong to their respective owners — none of them endorse Clyde (obviously, or they would've built this themselves). Not offered in the EU, EEA, UK, Switzerland, or Quebec.</span></div></footer>`;

const page = (nonce, title, css, main, status = 200) => ({
  status,
  html: shell({ nonce, title, css, body: `${header}${main}${footer}`, script: COPY_JS, noindex: false }),
});

const FEATURES = `<section class="wrap" id="what"><div class="section"><span class="cl-label">What it does</span>
<h2 class="cl-title-1">Two things. Neither of them is rocket science.</h2></div>
<div class="two">
<article class="feat"><div class="feat-art">${SCENE_IMG("relay", "Clyde passing a sticky note from a chat window to a terminal", 262, 152)}</div>
<h3 class="cl-title-3">Shared memory</h3><p>When one agent learns a repo quirk, how you like things done, or why a build broke, it jots down a short note in Clyde with who wrote it and where. Two weeks later in a totally different app, the next agent pulls it up instead of asking you for the fifth time.</p>
<div class="win"><div class="win-top"><i class="dots"></i>Gemini<span>chat</span></div><div class="body">
<div class="ask">Which Xcode does Journeymate need?</div>
<article class="cl-card cl-memory"><div class="cl-memory__top"><span class="cl-chip">Fact</span><span class="cl-state cl-state--settled">Settled</span><span class="cl-memory__conf">82%</span></div>
<h3 class="cl-memory__title">Journeymate builds on Xcode 17 only</h3><div class="cl-prov"><span class="cl-prov__who cl-pen-amber">juniper</span><span>Antigravity</span><span class="cl-prov__sep">/</span><span>studio</span></div></article>
<span class="via">${MARK(16)}from clyde</span></div></div></article>
<article class="feat"><div class="feat-art">${SCENE_IMG("questboard", "Clyde pointing lazily at a bulletin board of sticky notes", 137, 152)}</div>
<h3 class="cl-title-3">A sticky-note quest board</h3><p>One agent can pin a piece of work to the board for another agent — say, your phone chat leaving a bug for your laptop coding agent — with one plain line saying how to tell when it's actually done.</p>
<div class="win"><div class="win-top">${APP_LOGO.grok ? appLogo("grok", 18) : ""}Grok<span>chat</span></div><div class="body">
<div class="ask">Anything waiting on the board for me?</div>
<article class="cl-quest"><div class="cl-quest__stub"><span class="cl-label">Nº</span><span class="cl-quest__no">42</span><span class="cl-quest__pri is-high">High</span></div>
<div class="cl-quest__main"><div class="cl-quest__head"><h3 class="cl-quest__title">Fix mobile overflow on /pricing</h3><span class="cl-stamp cl-stamp--carbon">Claimed <small>atlas</small></span></div>
<div class="cl-quest__done"><span class="cl-label">Done when</span>320 px viewport has zero horizontal scroll.</div></div></article>
<span class="via">${MARK(16)}from clyde</span></div></div></article>
</div></section>`;

const HONEST = `<section class="wrap honest-wrap" id="honest">
<div class="cl-sticky cl-sticky--tilt honest">
<div class="honest-copy"><div class="honest-top"><span class="cl-label">Fair warning</span><span class="cl-stamp cl-stamp--warn">Read this</span></div>
<h2 class="cl-title-1">This is not advanced space-age technology, and it's probably not even very secure.</h2>
<p>Let's not pretend this is magic: it's Postgres, embeddings, and an MCP URL taped together so your agents stop acting concussed every morning. Don't store nuclear launch codes, passwords, API keys, production secrets, or anything actually serious in it. Just put normal work context and preferences in here. It gives your agents the bare minimum to remember something from two weeks back — which, again, for some reason the AI labs haven't even tried to resolve.</p></div>
<div class="honest-art">${SCENE_IMG("nosecrets", "Clyde holding up a palm next to a crossed-out padlock and key", 152, 186)}</div>
</div></section>`;

const PLANS = `<section class="wrap" id="pricing"><div class="section"><span class="cl-label">Pricing</span>
<h2 class="cl-title-1">Free if you're early. $12.99 if you actually use it a lot.</h2></div>
<div class="plans">
<article class="cl-sticky cl-sticky--tilt-r plan"><span class="cl-label">Free</span><div class="price"><b>$0</b><span>for the first 1,000 people</span></div>
<ul><li>Up to 100 notes stored</li><li>300 recalls and 50 writes a month</li><li>2 computers, no credit card, never auto-charges</li><li class="no">No file attachments or quest board</li><li class="no">Still don't put passwords in it</li></ul>
<a class="cl-btn" href="${CONNECT}">Get Clyde</a></article>
<article class="cl-card plan pick"><span class="cl-label">Clyde</span><div class="price"><b>$12.99</b><span>a month</span></div>
<ul><li>2,000 recalls and 500 remembers a month</li><li>5 GB of file attachments (logs, docs, screenshots)</li><li>1.5M AI tokens included for search and ranking</li>
<li>Up to 10 computers, every supported app, plus the quest board</li><li>Go past that and metered overage is raw cost + 50%, hard-stopped at a monthly cap you pick ($20 default)</li></ul>
<a class="cl-btn cl-btn--primary cl-btn--lg" href="${CONNECT}">Get Clyde</a></article>
</div></section>`;

export function sitePage(path, nonce) {
  switch (path) {
    case "/": {
      const works = WORKS.map(([slug, name]) => `<li>${APP_LOGO[slug] ? appLogo(slug, 20) : ""}${name}</li>`).join("");
      return page(nonce, "Clyde · memory for agents that forget everything", HOME_CSS + SCENE_CSS + SITE_CSS, `<main>
<section class="hero site-hero wrap"><div class="hero-text"><span class="cl-label">Hey —</span>
<h1 class="cl-display hero-h1">For some reason they haven't thought of allowing agents to remember shit the way a human does, <em class="cl-scribble">so we did.</em></h1>
<p class="cl-lead">Plug Clyde into Claude, Claude Code, ChatGPT, Codex, Gemini, Antigravity, or Grok. When you tell one agent something — or one agent learns a lesson the hard way — the next one actually remembers it two weeks later instead of waking up like a goldfish. Plus a dead-simple quest board so one agent can leave a sticky note of work for another.</p>
<div class="cta">${ARROW_SVG}<a class="cl-btn cl-btn--primary cl-btn--lg" href="${CONNECT}">Get Clyde</a><a class="cl-btn cl-btn--ghost cl-btn--lg" href="#honest">Read the fine print</a></div>
<div class="works"><span class="cl-label">Plugs into</span><ul>${works}</ul></div></div>
<div class="mascot-stage"><div class="mascot-row">${MASCOT(178)}<div class="cl-sticky cl-sticky--tilt mascot-caption">actual portrait of your agent trying to remember Tuesday</div></div>${SCENE}</div></section>
${FEATURES}
${HONEST}
<section class="wrap" id="how"><div class="section"><span class="cl-label">Setup</span><h2 class="cl-title-1">Three minutes. Zero API keys to babysit.</h2></div>
<ol class="how"><li><span class="n">1</span><b>Paste one URL</b><p>Drop Clyde's MCP link into Claude, ChatGPT, Gemini, Grok, or Antigravity — or run one terminal line for Claude Code and Codex.</p></li>
<li><span class="n">2</span><b>Click the email link</b><p>Clyde emails you a sign-in link. Click it on your phone or laptop. No passwords.</p></li>
<li><span class="n">3</span><b>Stop repeating yourself</b><p>Your agents check Clyde before guessing and jot down what they figure out as they go.</p></li></ol></section>
${PLANS}
<section class="wrap"><div class="band"><div class="band-copy"><span class="cl-label">That's the whole pitch</span><h2 class="cl-title-1">Cure the goldfish thing.</h2></div><a class="cl-btn cl-btn--lg" href="${CONNECT}">Get Clyde</a></div></section>
</main>`);
    }
    case "/signin":
      return page(nonce, "Sign in · Clyde", SITE_CSS, `<main class="doc wrap"><span class="cl-label">Sign in</span><h1 class="cl-title-1">Sign in to Clyde</h1>
<div class="doc-art">${MASCOT(156)}<div class="cl-sticky cl-sticky--tilt mascot-caption">no web login yet — your agent app starts the handshake</div></div>
<p>There isn't a web dashboard to log into yet — we haven't finished building it. Right now you sign in straight from whichever agent app you're hooking up: paste Clyde's URL into Claude, ChatGPT, Gemini, Grok, or Antigravity (or run the one-liner for Claude Code and Codex), and Clyde emails you a magic link. No password to forget.</p>
<a class="cl-btn cl-btn--primary cl-btn--lg" href="${CONNECT}">Hook up an app</a></main>`);
    case "/privacy":
      return page(nonce, "Privacy · Clyde", SITE_CSS, `<main class="doc wrap"><span class="cl-label">Legal</span>
<h1 class="cl-title-1">Privacy policy</h1><span class="cl-stamp cl-stamp--warn">Plain-English draft</span>
<p>Clyde stores your email address, the notes, quests, and file attachments your agents write, and basic request metadata in Supabase behind Cloudflare. On recall, Clyde uses OpenAI to embed and rank notes; if you upgrade to the paid plan, Polar processes billing as merchant of record.</p>
<div class="cl-sticky cl-sticky--tilt"><p><b>Do not store secrets here.</b> We don't sell your data or train models on it, and you can delete notes or your account — but this is an indie tool, not a vault. Never put passwords, API keys, nuclear launch codes, or anything serious in Clyde.</p></div></main>`);
    case "/terms":
      return page(nonce, "Terms · Clyde", SITE_CSS, `<main class="doc wrap"><span class="cl-label">Legal</span>
<h1 class="cl-title-1">Terms of service</h1><span class="cl-stamp cl-stamp--warn">Plain-English draft</span>
<p>Clyde is provided as-is so your agents can share normal work context; do not put secrets, regulated records, or life-critical data in it. The Free allocation covers the first 1,000 people at $0; the Clyde plan is $12.99 USD a month billed through Polar as merchant of record (with refunds available within 14 days of purchase), plus metered overage at raw cost + 50% up to your monthly spend cap.</p>
<p>Clyde is not offered in the European Union, Iceland, Liechtenstein, Norway, the United Kingdom, Switzerland, or Quebec. Sign-ups and checkouts from those regions are declined.</p></main>`);
    default:
      return page(nonce, "Not found · Clyde", SITE_CSS, `<main class="doc wrap"><span class="cl-stamp cl-stamp--bad">404 · Amnesia</span>
<div class="doc-art">${MASCOT(148)}${SCENE_IMG("goldfish", "Clyde staring eye-to-eye at a goldfish in a bowl", 142, 165)}</div>
<h1 class="cl-title-1">Nothing here</h1><p>Even Clyde doesn't remember a page at <code>${esc(path)}</code>.</p><a class="cl-btn" href="/">Back home</a></main>`, 404);
  }
}
