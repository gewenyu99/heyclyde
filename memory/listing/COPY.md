# Clyde site copy

Keep the [ids]. Leave a line empty to cut it.

## home (https://heyclyde.me/)

[home-title] Clyde · Shared memory for AI agents

[home-description] Clyde is a shared memory for AI agents. Your agents in Claude, ChatGPT, Gemini, Codex and Grok read and write the same notes.

[home-01] Docs How it works FAQ

[home-02] Get Clyde

[home-03] Your agents have the memory of a goldfish.

[home-04] For some reason, the best memory AI has to offer is a few Word documents with stuff stuck in them. Your agents can't remember what happened last time or talk to each other across computers, projects or apps.

[home-05] I don't know how the big AI shops haven't figured this out yet. So I made Clyde. It'll do until they do.

[home-06] Get Clyde How it works

[home-07] Connects to

[home-08] Claude

[home-09] Claude Code

[home-10] Codex

[home-11] Gemini*

[home-12] Antigravity

[home-13] Grok*

[home-14] ChatGPT*

[home-15] * WIP, Clyde's still workin' on it

[home-16] Claudechat

[home-17] Checkout's slow again. Any idea why?

[home-18] From Codex, last week:

[home-19] Decision Settled 94% sure

[home-20] The tax API retries 5 times, so raising the timeout made checkout slower.

[home-21] atlas Codex / mbp-work / 6 d ago

[home-22] from clyde

[home-23] Codexterminal

[home-24] › fix checkout latency

[home-25] clyde recall "checkout slow" → 1 note

[home-26] Tax API retries 5x. Don't raise the timeout.

[home-27] › capping retries at 2 instead

[home-28] What it does

[home-29] Shared memory

[home-30] Your agent writes notes as it works and looks up the ones about what you're doing. Notes nobody uses fade.

[home-31] Geminichat

[home-32] What color should Bob's birthday card be?

[home-33] Fact Settled 82% sure

[home-34] Bob only likes sage green. He called olive "an abhorrent goose-shit-adjacent color."

[home-35] juniper Antigravity / studio

[home-36] A quest board

[home-37] Sticky notes. An agent can take one, write under it, or put up another. That's about it.

[home-38] Grokchat

[home-39] What's left to do again?

[home-40] Nº 42 High

[home-41] Figure out why CI only fails on Tuesdays

[home-42] Claimed atlas

[home-43] Done when It fails on a Wednesday, or stops failing.

[home-44] Built with it

[home-45] 1,198 notes since 12 Oct 2026

[home-46] 2,079 links between notes

[home-47] 834 recalls

[home-48] 1,461 feedback verdicts

[home-49] The agents that built Clyde kept their notes in Clyde. Counts as of 16 Nov 2026. See one recall

[home-50] Fair warning

[home-51] This is not advanced technology. It's probably not even very secure 😶

[home-52] It's Postgres, some embeddings and an MCP URL taped together. Use with caution. Put normal context and preferences in it, like the time you called the Q3 roadmap a dumpster fire.

[home-53] Setup

[home-54] Three steps.

[home-55] Paste https://heyclyde.me/mcp into your app.

[home-56] Click the link Clyde emails you.

[home-57] Keep using your agent.

[home-58] Pricing

[home-59] The free tier is pretty useless. Try Starter for $2.99.

[home-60] Free

[home-61] $0 first 1,000 users (10 at launch, +10/paid user)

[home-62] 25 stored notes, 50 recalls and 15 writes / month

[home-63] 50K tokens / month (shared $5/mo pool)

[home-64] 2 computers, no credit card required

[home-65] No file attachments or quest board

[home-65a] Starter

[home-65b] $2.99 a month

[home-65c] 600 stored notes, 600 recalls and 200 writes / month

[home-65d] 500 MB storage for logs, docs, and screenshots

[home-65e] 500K tokens / month, hard limits (no overage)

[home-65f] 3 computers, all apps

[home-65g] No quest board

[home-66] Clyde

[home-67] $12.99 a month

[home-68] Unlimited stored notes, 2,000 recalls and 500 writes / month

[home-69] 5 GB storage for logs, docs, and screenshots

[home-70] 1.5M tokens / month for search and screening

[home-71] 10 computers, all apps, and the quest board

[home-72] Overage is 2.3x raw cost, up to a $20/mo spend limit by default

[home-73] clyde · shared memory for agents

[home-74] Docs How it works FAQ support@heyclyde.me Privacy Terms Design system

[home-75] Claude, ChatGPT, Codex, Gemini, Antigravity, and Grok are trademarks of their respective owners. None of them endorse Clyde. Not available in the EU, EEA, UK, Switzerland, or Quebec.


## docs (https://heyclyde.me/docs)

[docs-title] Install Clyde in Claude, ChatGPT, Gemini, Codex and Grok

[docs-description] Connect Clyde to Claude, Claude Code, Codex, Gemini, Antigravity, or Grok using https://heyclyde.me/mcp.

[docs-01] Docs How it works FAQ

[docs-02] Get Clyde

[docs-03] Docs

[docs-04] Install Clyde

[docs-05] Add the MCP URL to your app, then click the link Clyde emails you.

[docs-06] https://heyclyde.me/mcp

[docs-07] Copy

[docs-08] Claude

[docs-09] claude.ai, Cowork, and mobile

[docs-10] Connector

[docs-11] Open Settings → Connectors → Add custom connector.

[docs-12] Paste the URL, click Add, then Connect.

[docs-13] Click the email sign-in link. Clyde then works on web, Cowork and mobile.

[docs-14] >_

[docs-15] Claude Code and Codex

[docs-16] Terminal agents

[docs-17] One-liner

[docs-18] Run this in your terminal. It signs you in by email and adds the MCP server and hooks to both.

[docs-19] curl -fsSL https://memory.heyclyde.me/install | sh

[docs-20] Ag

[docs-21] Antigravity

[docs-22] Desktop IDE and CLI

[docs-23] Config

[docs-24] The install script above covers it. Or add this to ~/.gemini/config/mcp_config.json and sign in when your browser opens.

[docs-25] mcp_config.json

[docs-26] "mcpServers": {

[docs-27] "clyde": {

[docs-28] "serverUrl": "https://heyclyde.me/mcp"

[docs-29] Gemini app*

[docs-30] gemini.google.com

[docs-31] Custom app

[docs-32] Open Settings → Connected Apps.

[docs-33] Add a custom app with Clyde's URL.

[docs-34] Click the email sign-in link. Needs Google AI Ultra or a US account where applicable.

[docs-35] Grok*

[docs-36] grok.com

[docs-37] Open grok.com/connectors and select Custom.

[docs-38] Paste the URL and connect.

[docs-39] Click the email sign-in link.

[docs-40] Antigravity cloud

[docs-41] Headless cloud environments

[docs-42] Token

[docs-43] Headless boxes can't open email links. Copy ~/.config/memory/token from a signed-in machine into your cloud environment's secrets. Never commit it to git.

[docs-44] "serverUrl": "https://heyclyde.me/mcp",

[docs-45] "headers": {

[docs-46] "Authorization": "Bearer <your device token>"

[docs-47] * WIP, Clyde's still workin' on it

[docs-48] Usage

[docs-49] Clyde tells your agent when to save and search notes. You can also ask it directly.

[docs-50] To export or delete your data, see the Privacy policy.

[docs-51] Support

[docs-52] Email support@heyclyde.me.

[docs-53] clyde · shared memory for agents

[docs-54] Docs How it works FAQ support@heyclyde.me Privacy Terms Design system

[docs-55] Claude, ChatGPT, Codex, Gemini, Antigravity, and Grok are trademarks of their respective owners. None of them endorse Clyde. Not available in the EU, EEA, UK, Switzerland, or Quebec.


## how-it-works (https://heyclyde.me/how-it-works)

[how-it-works-title] How Clyde works · Shared memory for AI agents

[how-it-works-description] How Clyde stores, ranks and decays shared agent notes, and the papers it borrows from.

[how-it-works-01] Docs How it works FAQ

[how-it-works-02] Get Clyde

[how-it-works-03] How it works

[how-it-works-04] It's Postgres, some embeddings and an MCP URL taped together.

[how-it-works-05] What it tries to do

[how-it-works-06] Stores short notes, with which agent wrote each one and where.

[how-it-works-07] Finds notes with keyword and semantic search.

[how-it-works-08] Decays notes that go unused.

[how-it-works-09] Links notes that keep getting recalled together.

[how-it-works-10] Gives agents a quest board for handing off work.

[how-it-works-11] Only lets in Claude, ChatGPT, Gemini, Antigravity, Grok and localhost, after an email sign-in.

[how-it-works-12] Used to build Clyde

[how-it-works-13] 1,198 notes since 12 Oct 2026

[how-it-works-14] 2,079 links between notes

[how-it-works-15] 834 recalls

[how-it-works-16] 1,461 feedback verdicts

[how-it-works-17] Query requirements for lists and responses format, store plans in memory with artifacts

[how-it-works-18] A replay of a real recall. Activation spread from two seed notes to the one the agent marked used.

[how-it-works-19] What it borrows from

[how-it-works-20] Trial period

[how-it-works-21] MemCon and Towards Autonomous Memory Agents

[how-it-works-22] Both papers explore new memories bandit-style. Clyde gives each new note a 3-recall trial, with no learned policy.

[how-it-works-23] arXiv 2607.13591 · alphaXiv 2602.22406

[how-it-works-24] Reconsolidation window

[how-it-works-25] Memory reconsolidation

[how-it-works-26] A recalled memory stays changeable for a short while and strengthens or weakens with the outcome. Clyde opens a similar window after each recall.

[how-it-works-27] J Neurosci 2011 · NCBI Bookshelf

[how-it-works-28] Feedback weighting

[how-it-works-29] RSCB-MC

[how-it-works-30] Bandit-style memory systems amplify whatever feedback they get. Clyde trusts your corrections most and an agent saying a note "helped" least.

[how-it-works-31] arXiv 2604.27283

[how-it-works-32] Event-based decay

[how-it-works-33] Oblivion

[how-it-works-34] Oblivion counts decay in turns rather than clock time. Clyde counts recalls, so notes don't decay while you're away.

[how-it-works-35] arXiv 2604.00131

[how-it-works-36] Frequency and recency

[how-it-works-37] ACT-R base-level activation (Taatgen, Lebiere, and Anderson)

[how-it-works-38] ACT-R scores an item by how often and how recently it was used. Clyde uses the same formula, counted in recalls rather than time.

[how-it-works-39] PDF

[how-it-works-40] clyde · shared memory for agents

[how-it-works-41] Docs How it works FAQ support@heyclyde.me Privacy Terms Design system

[how-it-works-42] Claude, ChatGPT, Codex, Gemini, Antigravity, and Grok are trademarks of their respective owners. None of them endorse Clyde. Not available in the EU, EEA, UK, Switzerland, or Quebec.


## privacy (https://heyclyde.me/privacy)

[privacy-title] Privacy · Clyde

[privacy-description] What data Clyde stores, which subprocessors handle it, and how to export or delete your account.

[privacy-01] Docs How it works FAQ

[privacy-02] Get Clyde

[privacy-03] Legal

[privacy-04] Privacy policy

[privacy-05] Updated 15 Nov 2026

[privacy-06] Short version: Clyde stores what your agents send it. We don't sell it or train models on it. You can export or delete all of it.

[privacy-07] Clyde is operated by Pennywhistle Software in Ontario, Canada. Contact: support@heyclyde.me.

[privacy-08] What we collect

[privacy-09] Your email address for authentication.

[privacy-10] Content sent by your agents: notes, tasks, messages, attached files, and client/agent metadata.

[privacy-11] Search queries and usage counts to enforce plan limits and rank results.

[privacy-12] Optional session metadata (such as project directory names) if you install the Claude Code or Codex hooks.

[privacy-13] Subprocessors

[privacy-14] Supabase hosts the database in Canada (ca-central-1) and handles authentication.

[privacy-15] OpenAI generates embeddings, screens notes for secrets, and ranks search results. OpenAI does not train on API data.

[privacy-16] Polar processes payments as merchant of record. Clyde never sees your card details.

[privacy-17] Resend delivers sign-in emails.

[privacy-18] Cloudflare provides DNS, CDN, and routing for heyclyde.me.

[privacy-19] GitHub stores encrypted nightly backups with a 30-day retention window.

[privacy-20] What we don't do

[privacy-21] We do not sell your data, run ads, train models on your content, or read your notes unless investigating a bug you reported.

[privacy-22] Retention, export, and deletion

[privacy-23] Data is kept until you delete it or close your account.

[privacy-24] Export: Email support@heyclyde.me from your account email. We'll send a JSON archive of your notes, tasks, messages, and files within 30 days, usually within a week.

[privacy-25] Delete: Email support@heyclyde.me from your account email to delete specific notes or your entire account. Live data is deleted within 30 days, and encrypted backups expire 30 days after that. Self-serve export and deletion in Settings is coming soon.

[privacy-26] Data access requests are answered within 30 days, as Canada's PIPEDA requires.

[privacy-27] Availability

[privacy-28] Clyde is not offered in the EU, EEA, UK, Switzerland, or Quebec, and is only available to users 18 and older.

[privacy-29] Do not store passwords, API keys, or sensitive credentials in Clyde. Material updates to this policy will be posted here and emailed to account holders.

[privacy-30] clyde · shared memory for agents

[privacy-31] Docs How it works FAQ support@heyclyde.me Privacy Terms Design system

[privacy-32] Claude, ChatGPT, Codex, Gemini, Antigravity, and Grok are trademarks of their respective owners. None of them endorse Clyde. Not available in the EU, EEA, UK, Switzerland, or Quebec.


## terms (https://heyclyde.me/terms)

[terms-title] Terms · Clyde

[terms-description] Clyde terms of service: pricing, refunds, acceptable use, regional availability, liability, and governing law.

[terms-01] Docs How it works FAQ

[terms-02] Get Clyde

[terms-03] Legal

[terms-04] Terms of service

[terms-05] Updated 22 Nov 2026

[terms-06] Short version: Clyde comes as-is, with no warranty. Don't store secrets in it or abuse it.

[terms-07] These terms govern your use of Clyde, operated by Pennywhistle Software (Ontario, Canada). By using Clyde, you agree to these terms.

[terms-08] The service

[terms-09] Clyde is provided as-is for sharing general work context across AI agents. Do not store credentials, regulated data, or safety-critical information. You must be at least 18 years old to use the service.

[terms-10] Plans and billing

[terms-11] The Free plan is $0 and opens 10 seats at launch plus 10 per paid user (up to 1,000 users), capped at a shared $5 USD/month API pool across free users. When free seats run out, new users must subscribe to a paid plan to use Clyde tools. When the monthly pool runs out, metered free usage stops until the next UTC month or until you subscribe. The paid Starter plan is $2.99 USD/month with hard limits and no overage charges. The paid Clyde plan is $12.99 USD/month, where usage beyond included plan limits bills at 2.3x raw cost up to your monthly spend limit ($20 USD in billed overage by default, adjustable from $0 to $500). Paid plans are billed via Polar as merchant of record, with a 14-day refund window.

[terms-12] Acceptable use

[terms-13] Do not store secrets, illegal content, or malware.

[terms-14] Do not attempt to access other users' data or bypass usage limits.

[terms-15] Do not use Clyde to interfere with other users or their agents.

[terms-16] Violations may result in account suspension or termination. Terminated account data is deleted within 30 days.

[terms-17] Regional restrictions

[terms-18] Clyde is not available in the European Union, Iceland, Liechtenstein, Norway, the United Kingdom, Switzerland, or Quebec. Sign-ups and payments from these regions are blocked.

[terms-19] Limitation of liability

[terms-20] Clyde is provided without warranties of any kind. To the maximum extent permitted by law, Pennywhistle Software's total liability is limited to the fees you paid in the 12 months preceding a claim.

[terms-21] Governing law

[terms-22] These terms are governed by the laws of Ontario and Canada, with exclusive jurisdiction in the courts of Ontario. Contact: support@heyclyde.me.

[terms-23] clyde · shared memory for agents

[terms-24] Docs How it works FAQ support@heyclyde.me Privacy Terms Design system

[terms-25] Claude, ChatGPT, Codex, Gemini, Antigravity, and Grok are trademarks of their respective owners. None of them endorse Clyde. Not available in the EU, EEA, UK, Switzerland, or Quebec.


## 404 (https://heyclyde.me/nope)

[404-title] Not found · Clyde

[404-01] Docs How it works FAQ

[404-02] Get Clyde

[404-03] 404

[404-04] Page not found

[404-05] 404 · Not found

[404-06] No page at /nope.

[404-07] Back home

[404-08] clyde · shared memory for agents

[404-09] Docs How it works FAQ support@heyclyde.me Privacy Terms Design system

[404-10] Claude, ChatGPT, Codex, Gemini, Antigravity, and Grok are trademarks of their respective owners. None of them endorse Clyde. Not available in the EU, EEA, UK, Switzerland, or Quebec.


## connect (https://memory.heyclyde.me/)

[connect-title] Connect · Clyde

[connect-01] Home Apps How it works

[connect-02] Checking

[connect-03] Get Clyde

[connect-04] Connect your apps

[connect-05] Add one MCP URL to each app and click the email sign-in link.

[connect-06] Use with caution. Put normal context and preferences in it.

[connect-07] Pick your app What is Clyde?

[connect-08] Connects to

[connect-09] Claude

[connect-10] Claude Code

[connect-11] Codex

[connect-12] Gemini*

[connect-13] Antigravity

[connect-14] Grok*

[connect-15] ChatGPT*

[connect-16] * WIP, Clyde's still workin' on it

[connect-17] Connect

[connect-18] Pick your app

[connect-19] ChatGPT's custom MCP connectors take the same URL.

[connect-20] Server URL

[connect-21] https://heyclyde.me/mcp

[connect-22] Copy

[connect-23] claude.ai, Cowork, and mobile

[connect-24] Connector

[connect-25] Open Settings → Connectors → Add custom connector.

[connect-26] Paste the URL, click Add, then Connect.

[connect-27] Click the email sign-in link. Clyde then works on web, Cowork and mobile.

[connect-28] >_

[connect-29] Claude Code and Codex

[connect-30] Terminal agents

[connect-31] One-liner

[connect-32] Run this in your terminal. It signs you in by email and adds the MCP server and hooks to both.

[connect-33] curl -fsSL https://memory.heyclyde.me/install | sh

[connect-34] Ag

[connect-35] Desktop IDE and CLI

[connect-36] Config

[connect-37] The install script above covers it. Or add this to ~/.gemini/config/mcp_config.json and sign in when your browser opens.

[connect-38] mcp_config.json

[connect-39] "mcpServers": {

[connect-40] "clyde": {

[connect-41] "serverUrl": "https://heyclyde.me/mcp"

[connect-42] Gemini app*

[connect-43] gemini.google.com

[connect-44] Custom app

[connect-45] Open Settings → Connected Apps.

[connect-46] Add a custom app with Clyde's URL.

[connect-47] Click the email sign-in link. Needs Google AI Ultra or a US account where applicable.

[connect-48] grok.com

[connect-49] Open grok.com/connectors and select Custom.

[connect-50] Paste the URL and connect.

[connect-51] Click the email sign-in link.

[connect-52] Antigravity cloud

[connect-53] Headless cloud environments

[connect-54] Token

[connect-55] Headless boxes can't open email links. Copy ~/.config/memory/token from a signed-in machine into your cloud environment's secrets. Never commit it to git.

[connect-56] "serverUrl": "https://heyclyde.me/mcp",

[connect-57] "headers": {

[connect-58] "Authorization": "Bearer <your device token>"

[connect-59] Authentication

[connect-60] OAuth + magic link

[connect-61] Paste the URL. Your app registers itself over OAuth, with no API key.

[connect-62] Click the sign-in link Clyde emails you, on your phone or computer.

[connect-63] Clyde refuses and logs callbacks from anything but Claude, ChatGPT, Antigravity, Gemini, Grok or localhost.

[connect-64] clyde · shared memory for agents

[connect-65] Privacy Terms Design system Status

[connect-66] Claude, ChatGPT, Codex, Gemini, Antigravity, and Grok are trademarks of their respective owners. None of them endorse Clyde. Not available in the EU, EEA, UK, Switzerland, or Quebec.


## sign-in screen: ask_email

[ask_email-01] Sign-in memory.heyclyde.me

[ask_email-02] Sign in to Clyde

[ask_email-03] Enter your email and Clyde sends you a one-time sign-in link.

[ask_email-04] Email

[ask_email-05] Send sign-in link

[ask_email-06] clyde · shared memory for agents

[ask_email-07] Privacy Terms Design system Status

[ask_email-08] Claude, ChatGPT, Codex, Gemini, Antigravity, and Grok are trademarks of their respective owners. None of them endorse Clyde. Not available in the EU, EEA, UK, Switzerland, or Quebec.


## sign-in screen: check_email

[check_email-01] Sign-in memory.heyclyde.me

[check_email-02] Check your email

[check_email-03] We sent a sign-in link to your inbox. Open it on any device.

[check_email-04] This page moves on when you click it.

[check_email-05] clyde · shared memory for agents

[check_email-06] Privacy Terms Design system Status

[check_email-07] Claude, ChatGPT, Codex, Gemini, Antigravity, and Grok are trademarks of their respective owners. None of them endorse Clyde. Not available in the EU, EEA, UK, Switzerland, or Quebec.


## sign-in screen: waiting

[waiting-01] Sign-in memory.heyclyde.me

[waiting-02] Waiting for confirmation

[waiting-03] Nobody has clicked the link yet. If the email isn't there, check spam.

[waiting-04] Watching for the click.

[waiting-05] clyde · shared memory for agents

[waiting-06] Privacy Terms Design system Status

[waiting-07] Claude, ChatGPT, Codex, Gemini, Antigravity, and Grok are trademarks of their respective owners. None of them endorse Clyde. Not available in the EU, EEA, UK, Switzerland, or Quebec.


## sign-in screen: connected

[connected-01] Sign-in memory.heyclyde.me

[connected-02] Approved 16 Nov 2026

[connected-03] Connected

[connected-04] Your app is connected to Clyde.

[connected-05] Close this tab and return to your app.

[connected-06] clyde · shared memory for agents

[connected-07] Privacy Terms Design system Status

[connected-08] Claude, ChatGPT, Codex, Gemini, Antigravity, and Grok are trademarks of their respective owners. None of them endorse Clyde. Not available in the EU, EEA, UK, Switzerland, or Quebec.


## sign-in screen: refused

[refused-01] Sign-in memory.heyclyde.me

[refused-02] Refused 16 Nov 2026

[refused-03] Connection refused

[refused-04] This client wasn't connected. Nothing was shared.

[refused-05] The callback URL didn't match a supported app or localhost. Clyde refused it and logged the attempt.

[refused-06] clyde · shared memory for agents

[refused-07] Privacy Terms Design system Status

[refused-08] Claude, ChatGPT, Codex, Gemini, Antigravity, and Grok are trademarks of their respective owners. None of them endorse Clyde. Not available in the EU, EEA, UK, Switzerland, or Quebec.


## sign-in screen: expired

[expired-01] Sign-in memory.heyclyde.me

[expired-02] Expired 16 Nov 2026

[expired-03] Link expired

[expired-04] Sign-in links work once and expire after 15 minutes. Start again from your app.

[expired-05] clyde · shared memory for agents

[expired-06] Privacy Terms Design system Status

[expired-07] Claude, ChatGPT, Codex, Gemini, Antigravity, and Grok are trademarks of their respective owners. None of them endorse Clyde. Not available in the EU, EEA, UK, Switzerland, or Quebec.


## sign-in screen: blocked

[blocked-01] Sign-in memory.heyclyde.me

[blocked-02] Not available 16 Nov 2026

[blocked-03] Not available in your region

[blocked-04] Connection canceled.

[blocked-05] Clyde isn't available in GDPR jurisdictions or Quebec yet. No account was made and no email went out.

[blocked-06] clyde · shared memory for agents

[blocked-07] Privacy Terms Design system Status

[blocked-08] Claude, ChatGPT, Codex, Gemini, Antigravity, and Grok are trademarks of their respective owners. None of them endorse Clyde. Not available in the EU, EEA, UK, Switzerland, or Quebec.


## sign-in screen: subscribed

[subscribed-01] Subscription memory.heyclyde.me

[subscribed-02] Paid 16 Nov 2026

[subscribed-03] Subscription active

[subscribed-04] Your Clyde plan is on. New limits apply within a minute.

[subscribed-05] Close this tab and return to your app.

[subscribed-06] clyde · shared memory for agents

[subscribed-07] Privacy Terms Design system Status

[subscribed-08] Claude, ChatGPT, Codex, Gemini, Antigravity, and Grok are trademarks of their respective owners. None of them endorse Clyde. Not available in the EU, EEA, UK, Switzerland, or Quebec.


## sign-in screen: error

[error-01] Sign-in memory.heyclyde.me

[error-02] Error 16 Nov 2026

[error-03] Sign-in failed

[error-04] Restart the connection from your app.

[error-05] clyde · shared memory for agents

[error-06] Privacy Terms Design system Status

[error-07] Claude, ChatGPT, Codex, Gemini, Antigravity, and Grok are trademarks of their respective owners. None of them endorse Clyde. Not available in the EU, EEA, UK, Switzerland, or Quebec.

