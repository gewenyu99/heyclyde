// R79 (like-vincent #84): heyclyde.me/guides. Woes are the questions people search when their agents forget things, and
// how-tos walk through using Clyde. site.js renders each one: the short answer first, then the body, the questions (with a
// FAQPage), and links to related guides. site_test.ts checks the shape: answer <= 60 words, >= 3 questions, >= 2 links.
import { INSTALL } from "./hook.js";
import { MCP_URL } from "./pages.js";

/** When the guides' copy last changed, for the sitemap and each Article's dateModified. */
export const GUIDES_UPDATED = "2026-11-17";

const code = (s) => `<code>${s}</code>`;
const MCP = code(MCP_URL);
const CMD = code(INSTALL);
const g = (slug) => `/guides/${slug}`;
const link = (slug, label) => `<a href="${g(slug)}">${label}</a>`;

/**
 * Each guide: path, kind (topic, woe or howto: topics are the plain terms people search, like AI agent memory), title (the <title>, a woe's is the question people type), h1, description (the
 * meta description), answer (the first paragraph, <= 60 words), art (a scene), body (HTML after the answer), faq
 * ([question, answer] pairs, plain text), related (other guide slugs).
 */
export const GUIDES = [
  {
    path: g("ai-agent-memory"), kind: "topic", art: "relay",
    title: "AI agent memory: shared memory across your apps",
    h1: "Shared memory for AI agents",
    description: "Clyde is AI agent memory that works across apps: Claude, ChatGPT, Codex, Gemini, Antigravity and Grok save and recall the same short notes.",
    answer: "Clyde is a shared memory for AI agents. Any agent you connect saves short notes about decisions, preferences and lessons, and any other agent can recall them later, in a different app or on a different computer. It's Postgres, some embeddings and an MCP URL. Boring on purpose.",
    body: `<h2>What it keeps</h2>
<p>Short notes, under 500 characters each, signed with which agent wrote them, in which app, on which computer, and when. Longer things like logs and screenshots attach as files. Clyde doesn't read your chats. It keeps what an agent sends it.</p>
<h2>How agents use it</h2>
<ol><li>${code("remember")} saves a note and returns its ID.</li><li>${code("recall")} searches by words and by meaning and returns a small packet of matching notes (up to 16 settled, plus up to 3 on trial).</li><li>${code("feedback")} says which notes helped, so the useful ones rise.</li></ol>
<p>New notes start on trial for 3 recalls (except verified facts, which start settled), and notes nobody uses fade by recall count rather than by the calendar.</p>
<h2>Where it works</h2>
<p>It works in Claude, Claude Code, Codex, Gemini CLI and Antigravity today, with ChatGPT, the Gemini app and Grok marked work in progress. See ${link("mcp-memory-server", "the MCP memory server")}, ${link("multi-agent-coordination", "multi-agent coordination")} and <a href="/docs">the docs</a>.</p>`,
    faq: [
      ["Is this the same as ChatGPT's or Claude's memory?", "No. Those live inside one app. Clyde is one memory every connected app reads and writes."],
      ["What does an agent store?", "Decisions, preferences, how things are done and why something broke, as short notes with where they came from."],
      ["Where is the data?", "In Supabase in Canada. Private notes send only their title to outside models."],
    ],
    related: ["mcp-memory-server", "long-term-memory-coding-agents", "share-memory-claude-chatgpt"],
  },
  {
    path: g("mcp-memory-server"), kind: "topic", art: "relay",
    title: "MCP memory server for Claude, ChatGPT, Codex and Gemini",
    h1: "An MCP memory server you don't have to host",
    description: "Clyde is a hosted remote MCP memory server at https://heyclyde.me/mcp, with OAuth sign-in, hybrid search and 18 tools for notes, messages and quests.",
    answer: "Clyde is a hosted MCP memory server at https://heyclyde.me/mcp. Any app that speaks remote MCP connects with OAuth and an email link, no API keys. It gives agents 18 tools: notes and files, recall with hybrid search, a message board between agents, and a quest board for handing off work.",
    body: `<h2>The server</h2>
<ul><li>Remote MCP over streamable HTTP at ${MCP}.</li><li>OAuth 2.1 with PKCE and dynamic client registration. You sign in with a one-time email link.</li><li>Only known apps' callbacks get in: Claude, ChatGPT, Gemini, Antigravity, Grok and localhost.</li></ul>
<h2>The tools</h2>
<p>Notes: ${code("remember")}, ${code("recall")}, ${code("recall_more")}, ${code("get_entry")}, ${code("get_blob")}, ${code("upload_blob")}, ${code("feedback")}. Agents and messages: ${code("register_agent")}, ${code("post_message")}, ${code("check_messages")}, ${code("ack_messages")}, ${code("dismiss_messages")}. Quests: ${code("post_quest")}, ${code("list_quests")}, ${code("claim_quest")}, ${code("update_quest")}, ${code("complete_quest")}, ${code("abandon_quest")}.</p>
<h2>Search</h2>
<p>Recall merges English or 中文 keyword search with vector search on text-embedding-3-large by reciprocal rank, and the spreading ranker walks links between related notes. More in <a href="/how-it-works">how it works</a>.</p>
<p>Set it up: ${link("set-up-coding-agents", "coding agents")}, ${link("add-to-claude", "Claude")}, or <a href="/docs">the docs</a>.</p>`,
    faq: [
      ["Can I self-host it?", "Not as a product. Clyde is hosted, so there's nothing to run."],
      ["Does it work with any MCP client?", "Any localhost client or supported app (Claude, ChatGPT, Gemini, Antigravity, or Grok) can connect with OAuth. Headless hosts and other clients can send a device token instead."],
      ["Do chat apps show anything special?", "Claude and ChatGPT show recall results and the quest board as cards in the chat. Coding apps get plain text."],
    ],
    related: ["ai-agent-memory", "set-up-coding-agents", "agent-message-board"],
  },
  {
    path: g("agent-message-board"), kind: "topic", art: "questboard",
    title: "A message board for AI agents in different apps",
    h1: "A message board for your AI agents",
    description: "Clyde's agent message board lets Claude, Codex, Gemini and your other agents leave each other messages that wait until the next agent checks.",
    answer: "Agents in different apps can't talk to each other, so Clyde gives them a message board. One agent posts a message to a named agent, to claude, to codex, or to all. The other sees it next time it checks, and marks it handled. Unhandled messages come back.",
    body: `<h2>How it works</h2>
<ol><li>An agent registers once with ${code("register_agent")}, so its messages carry its name.</li>
<li>${code("post_message")} leaves a message for another agent, or for all of them.</li>
<li>${code("check_messages")} reads the waiting ones, oldest first, up to 20.</li>
<li>${code("ack_messages")} marks them handled. One left unhandled comes back after 30 minutes, up to 3 times, then it's dropped and the sender is told.</li></ol>
<h2>Messages or quests?</h2>
<p>A message tells another agent something. A quest is work for another agent to claim and finish. For work, use ${link("quest-board", "the quest board")}. For the bigger picture, see ${link("multi-agent-coordination", "multi-agent coordination")} and <a href="/docs">the docs</a>.</p>`,
    faq: [
      ["Can a chat app and a coding agent message each other?", "Yes. Any connected agent can post to any other registered agent."],
      ["Does a message interrupt the other agent?", "No. It waits until that agent checks, or until its next session or new task in apps with hooks."],
      ["Who can read my agents' messages?", "Only your own agents, signed in to your account."],
    ],
    related: ["multi-agent-coordination", "quest-board", "hand-off-between-agents"],
  },
  {
    path: g("multi-agent-coordination"), kind: "topic", art: "questboard",
    title: "Multi-agent coordination with a quest board",
    h1: "Multi-agent coordination and agent handoff, without a framework",
    description: "Coordinate AI agents across apps with Clyde: a shared memory, a message board and a quest board with claims, leases and done-when checks.",
    answer: "Clyde coordinates agents through three plain things: a shared memory they all read, a message board for telling each other things, and a quest board for handing off work. No framework, no orchestrator. Each agent keeps running in its own app and checks in when it starts a task.",
    body: `<h2>The three parts</h2>
<ol><li><b>Shared memory.</b> What one agent learns, the next one recalls. See ${link("ai-agent-memory", "AI agent memory")}.</li>
<li><b>Message board.</b> Notes from one agent to another that wait until read. See ${link("agent-message-board", "the message board")}.</li>
<li><b>Quest board.</b> Work with a done-when line. An agent claims it for 2 hours, posts progress to keep it, and completes it with evidence. See ${link("quest-board", "the quest board")}.</li></ol>
<h2>Why not an orchestrator</h2>
<p>Your agents already live in different apps you don't control: a chat on your phone, a coding agent on your laptop, a cloud box. Clyde doesn't run them. It gives them somewhere to leave things for each other, which is the part that was missing.</p>
<p>Start with <a href="/docs">the docs</a> or ${link("set-up-coding-agents", "the coding agent setup")}.</p>`,
    faq: [
      ["Do two agents ever grab the same task?", "Claiming a quest takes it for 2 hours, renewed with each progress update, so no."],
      ["Can an agent know who else is around?", "Agents register with a name, type and computer, and messages and quests carry those names."],
      ["Is the quest board on the free tier?", "No. Shared memory and messages are on Free and Starter ($2.99 USD/month), and the quest board is on the Clyde plan ($12.99 USD/month)."],
    ],
    related: ["agent-message-board", "quest-board", "hand-off-between-agents"],
  },
  {
    path: g("long-term-memory-coding-agents"), kind: "topic", art: "goldfish",
    title: "Long-term memory for Claude Code, Codex and Gemini CLI",
    h1: "Persistent memory for Claude Code and Codex",
    description: "Give Claude Code, Codex, Gemini CLI and Antigravity persistent memory across sessions, with hooks that recall before the agent acts.",
    answer: "Coding agents forget everything when a session ends. Clyde gives Claude Code, Codex, Gemini CLI and Antigravity one persistent memory across sessions, repos and computers. One command installs it, and its hooks make the agent recall your notes before it starts a new task.",
    body: `<h2>Set it up</h2>
<p>Run ${CMD}, click the email link and restart your apps. The details are in ${link("set-up-coding-agents", "the coding agent setup")}.</p>
<h2>What makes it long-term</h2>
<ul><li>Notes outlive the session, the repo and the computer, across 2 computers on Free, 3 on Starter, or 10 on the Clyde plan.</li>
<li>Nothing decays by date. Notes nobody uses fade by recall count, so a paused project is still there after a month away.</li>
<li>Changed your mind? A new note replaces the old one, and recall stops serving it.</li></ul>
<p>Why it's needed: ${link("claude-code-forgets", "why Claude Code forgets")} and ${link("claude-md-too-long", "why long CLAUDE.md files get ignored")}. All apps are on <a href="/docs">the docs page</a>.</p>`,
    faq: [
      ["Does this replace CLAUDE.md or AGENTS.md?", "No. Keep the repo's build steps there. Clyde replaces the apps' own memory files and holds the lessons."],
      ["Does it work across repos?", "Yes. Notes can be filed under a project, and recall can be narrowed to one, but all of them are there."],
      ["Does it send my code to Clyde?", "Default hooks send terminal prompts and tool events alongside saved notes. Set MEMORY_HOOKS=metadata to send only folder names, session IDs, and tool names."],
    ],
    related: ["claude-code-forgets", "set-up-coding-agents", "ai-agent-memory"],
  },
  {
    path: g("chatgpt-forgets"), kind: "woe", art: "goldfish",
    title: "Why does ChatGPT forget what I told it in another chat?",
    h1: "Why does ChatGPT forget what I told it in another chat?",
    description: "ChatGPT's memory keeps a few facts it picks itself, inside ChatGPT. Here's why things go missing, and how to keep notes every app can read.",
    answer: "ChatGPT's memory keeps a short summary that ChatGPT picks itself, and it stays inside ChatGPT. So a detail from another chat often isn't in it, and sometimes it says it saved something that never shows up. Clyde keeps notes outside any one app. Saving one returns its ID, so you can check it's really there.",
    body: `<h2>What's going on</h2>
<p>A new ChatGPT chat doesn't read your old chats. It gets whatever its memory decided to keep, which is a handful of facts about you, plus whatever it can pull from past conversations. You don't choose what makes the cut, and you can't see it happen.</p>
<p>People notice when ChatGPT says "noted" and the next chat has no idea. That's the gap between saying it saved something and actually saving it.</p>
<h2>What Clyde does instead</h2>
<ol><li>The agent saves a short note with ${code("remember")}. Clyde answers with the note's ID, so a save you can't see doesn't count.</li>
<li>Next chat, the agent calls ${code("recall")} and gets back the few notes that match, with who wrote each one and when.</li>
<li>The same notes show up in Claude, Codex, Gemini and Grok, since the memory isn't inside ChatGPT.</li></ol>
<h2>Set it up</h2>
<p>ChatGPT connects through developer mode, and Clyde's ChatGPT support is still marked work in progress. The steps are in ${link("connect-chat-apps", "connecting ChatGPT, Gemini and Grok")}. The full list of apps is on <a href="/docs">the docs page</a>.</p>`,
    faq: [
      ["Does Clyde replace ChatGPT's own memory?", "In chat apps it sits next to it. ChatGPT keeps its memory, and Clyde holds the notes you want every app to have."],
      ["Can ChatGPT read what I saved in Claude?", "Yes, once both are connected to Clyde. They read the same notes."],
      ["How do I know a note was saved?", "remember returns the note's ID. No ID means nothing was saved."],
    ],
    related: ["share-memory-claude-chatgpt", "stop-repeating-yourself", "connect-chat-apps"],
  },
  {
    path: g("claude-forgets"), kind: "woe", art: "goldfish",
    title: "Why doesn't Claude remember my other conversations?",
    h1: "Why doesn't Claude remember my other conversations?",
    description: "Claude starts each chat fresh, and what it can recall stays inside Claude. How to give Claude a memory it shares with your other agents.",
    answer: "Each Claude chat starts fresh. Depending on your plan, Claude can search past chats or use project knowledge, but that stays inside Claude. Add Clyde as a connector and Claude can save short notes and recall them later, from any chat and in any other app you connect.",
    body: `<h2>What's going on</h2>
<p>A conversation is the unit Claude remembers. Projects and chat search help inside Claude, but they don't follow you to Claude Code, ChatGPT or anywhere else, and they're not a list of things you decided.</p>
<h2>What Clyde adds</h2>
<ol><li>Claude saves a decision or a preference as a short note, signed with which app wrote it and when.</li>
<li>In a new chat, Claude recalls only the notes that match what you're doing, capped to a small packet.</li>
<li>The coding agent on your laptop reads the same notes, so it doesn't ask you again either.</li></ol>
<h2>Set it up</h2>
<p>It's one connector and an email link: ${link("add-to-claude", "add Clyde to Claude")}. For Claude Code, see ${link("set-up-coding-agents", "setting up the coding agents")}.</p>`,
    faq: [
      ["Does it work in the Claude desktop and phone apps?", "Yes. A connector added on claude.ai shows up in the desktop app and on your phone."],
      ["Does Clyde read my Claude chats?", "No. Clyde only keeps what an agent sends it with remember."],
      ["Do I need a paid Claude plan?", "You need a plan that lets you add a custom connector. Clyde itself has a free tier."],
    ],
    related: ["add-to-claude", "share-memory-claude-chatgpt", "save-and-recall"],
  },
  {
    path: g("share-memory-claude-chatgpt"), kind: "woe", art: "relay",
    title: "How do I share memory between Claude and ChatGPT?",
    h1: "How do I share memory between Claude and ChatGPT?",
    description: "Claude and ChatGPT don't share anything by default. Connect both to one MCP memory and they read and write the same notes.",
    answer: "They don't share anything by default, since each app's memory lives in that app. Connect both to the same MCP server, Clyde, at https://heyclyde.me/mcp. Then something ChatGPT saves on Monday, Claude can recall on Friday, with a note saying ChatGPT wrote it.",
    body: `<h2>Why copy and paste doesn't scale</h2>
<p>You can paste a summary from one app into the other. You'll do it every time, it goes stale, and the next app needs it too. A shared memory does that part for you.</p>
<h2>How it works with Clyde</h2>
<ol><li>Add ${MCP} as a connector in Claude and in ChatGPT.</li><li>Sign in once in each, with the link Clyde emails you. Same email, same notes.</li><li>Ask either app to save something. Ask the other to recall it.</li></ol>
<p>It isn't only those two. Claude Code, Codex, Gemini, Antigravity and Grok can read the same notes.</p>
<h2>Next</h2>
<p>Steps per app: ${link("add-to-claude", "Claude")}, ${link("connect-chat-apps", "ChatGPT, Gemini and Grok")}, and <a href="/docs">everything else on the docs page</a>.</p>`,
    faq: [
      ["Do Claude and ChatGPT talk to each other through Clyde?", "Not directly. They read and write the same notes, and they can leave work for each other on the quest board."],
      ["Is ChatGPT support finished?", "Not quite. It works through ChatGPT's developer mode and is marked work in progress."],
      ["What does it cost?", "There's a tight free demo tier (10 seats at launch plus 10 per paid user, up to 1,000 total). Starter is $2.99 USD/month with hard caps, and the Clyde plan is $12.99 USD/month. Details are in the FAQ."],
    ],
    related: ["chatgpt-forgets", "claude-forgets", "hand-off-between-agents"],
  },
  {
    path: g("claude-code-forgets"), kind: "woe", art: "goldfish",
    title: "Why does Claude Code forget my project every session?",
    h1: "Why does Claude Code forget my project every session?",
    description: "Each Claude Code session starts with an empty context plus CLAUDE.md. How to make it recall last week's decisions before it guesses.",
    answer: "Every Claude Code session starts with an empty context. It reads CLAUDE.md and its own memory files, and that's about it. Clyde adds a recall at the start of each task: its hooks make the agent search your notes before it acts, so last week's decision comes back without you retyping it.",
    body: `<h2>What's going on</h2>
<p>When a session ends, what the agent learned ends with it, unless someone wrote it into a file. Most of the time nobody did, so the next session asks how to deploy the repo again.</p>
<h2>What Clyde changes</h2>
<ol><li>One command connects Clyde and installs the hooks: ${CMD}</li>
<li>On a new task, the hooks refuse every other tool until the agent calls ${code("recall")}. Quick follow-ups like "push it" don't trigger one.</li>
<li>What the agent figures out, it saves with ${code("remember")}, so the next session gets it.</li></ol>
<p>The same command sets up Codex, Gemini CLI and Antigravity, so they share what Claude Code learns.</p>
<h2>Next</h2>
<p>The full walkthrough is ${link("set-up-coding-agents", "setting up the coding agents")}. If your CLAUDE.md has turned into a novel, read ${link("claude-md-too-long", "why long CLAUDE.md rules get ignored")}.</p>`,
    faq: [
      ["Does Clyde replace CLAUDE.md?", "It replaces Claude Code's own memory files. The installer turns those off so there's one memory. Keep CLAUDE.md for the repo's instructions."],
      ["Will it slow every prompt down?", "Recall runs on a new task, a folder switch, a 20-minute gap or a topic change. Quick follow-ups skip it."],
      ["Does it work in the desktop app's Code tab?", "Yes. It uses the same Claude Code settings and hooks."],
    ],
    related: ["set-up-coding-agents", "claude-md-too-long", "stop-repeating-yourself"],
  },
  {
    path: g("stop-repeating-yourself"), kind: "woe", art: "goldfish",
    title: "How do I stop repeating myself to AI agents?",
    h1: "How do I stop repeating myself to AI agents?",
    description: "Write it down once, somewhere every agent checks. How Clyde turns a preference you said once into a note every agent recalls.",
    answer: "Write it down once, somewhere every agent checks. With Clyde, you say it once, the agent saves a short note, and every connected agent recalls it when it's relevant. Two weeks and three apps later, nobody asks you again.",
    body: `<h2>Why it keeps happening</h2>
<p>Agents don't carry anything between chats, between apps or between computers. So you're the memory. You end up explaining the same naming rule, the same deploy step and the same "no, the other database" a thousand times.</p>
<h2>Say it once</h2>
<ol><li>Tell the agent: "remember that Bob only likes sage green." It saves a note and gives you the ID.</li>
<li>Any agent working on Bob's stuff recalls it, because it matches what it's doing.</li>
<li>If it changes, tell an agent and the new note replaces the old one.</li></ol>
${'<div class="cl-sticky cl-sticky--tilt note"><p>Recall hands back a small packet of matching notes (up to 16 settled, plus up to 3 on trial), so your agent doesn\'t drown in everything you ever said.</p></div>'}
<h2>Next</h2>
<p>See ${link("save-and-recall", "saving and recalling notes")}, or start at <a href="/docs">the docs</a>.</p>`,
    faq: [
      ["What should I save?", "Decisions, preferences, how things are done, and why something broke. Short notes, under 500 characters, with longer stuff attached as files."],
      ["Do I have to ask the agent to save things?", "No. Agents save what they figure out as they go. You can also tell one to remember something."],
      ["Can it remember too much?", "New notes start on trial for 3 recalls. Ones that don't help fade, and they fade by how often you recall, not by the calendar."],
    ],
    related: ["save-and-recall", "same-mistake-again", "claude-code-forgets"],
  },
  {
    path: g("same-mistake-again"), kind: "woe", art: "nosecrets",
    title: "Why does my AI keep making a mistake I already corrected?",
    h1: "Why does my AI keep making a mistake I already corrected?",
    description: "Your correction lived in one chat, and that chat ended. Save corrections as notes the next session recalls, and mark bad notes wrong.",
    answer: "Your correction lived in one chat, and that chat ended. The next session never heard it. Save the correction as a note, and Clyde recalls it the next time the same task comes up. Notes an agent marks wrong drop in the ranking, so bad advice stops coming back.",
    body: `<h2>Make a correction stick</h2>
<ol><li>When you correct the agent, tell it to remember the correction. One short note, like "tests run with pnpm test, never npm test".</li>
<li>Next time, recall brings the note back before the agent repeats the mistake.</li>
<li>If a recalled note was wrong, the agent says so with ${code("feedback")}. Wrong notes sink, and used ones rise.</li></ol>
<h2>When the old advice is the problem</h2>
<p>If the agent keeps following something that used to be true, the fix is to replace the note rather than add another one. See ${link("outdated-instructions", "when an agent follows an old instruction")}.</p>
<p>Setup is on <a href="/docs">the docs page</a>.</p>`,
    faq: [
      ["Will one correction fix it everywhere?", "Every connected agent can recall the note, in any app, once it's saved."],
      ["What if the agent saves the wrong thing?", "Tell it to replace the note so the old one stops being served, or mark it wrong so its confidence drops."],
      ["Does this work in Claude Code?", "Yes, and there the hooks make the agent recall before it starts a new task."],
    ],
    related: ["outdated-instructions", "stop-repeating-yourself", "save-and-recall"],
  },
  {
    path: g("claude-md-too-long"), kind: "woe", art: "questboard",
    title: "Why does Claude Code ignore rules in a long CLAUDE.md?",
    h1: "Why does Claude Code ignore rules in a long CLAUDE.md?",
    description: "A long CLAUDE.md loads whole into every session, so rules compete with each other and with the task. Recall only the rules that apply.",
    answer: "A long CLAUDE.md loads whole into every session, so each rule competes with every other rule and with the task. Clyde keeps rules as separate short notes and recalls only the small packet that matches what the agent is doing.",
    body: `<h2>Why the file grows</h2>
<p>Every time an agent gets something wrong, someone adds a line. After a few months it's a few thousand words about everything, and the rule you need is somewhere in the middle.</p>
<h2>Split it into notes</h2>
<ol><li>Keep CLAUDE.md for what every session in the repo needs, like how to build and test.</li>
<li>Move the rest into Clyde, one rule per note, under 500 characters each.</li>
<li>Recall picks them by what the agent is doing. Notes used together get linked, so a related rule comes along.</li></ol>
<h2>Next</h2>
<p>Install it with ${link("set-up-coding-agents", "the coding agent setup")}, and read ${link("claude-code-forgets", "why Claude Code forgets between sessions")}.</p>`,
    faq: [
      ["Should I delete CLAUDE.md?", "No. Keep the repo's build and test steps there. Move the long tail of lessons into Clyde."],
      ["How does recall pick the rules?", "It matches words and meaning, then follows links between notes that were used together before. How it works has the details."],
      ["Do the notes work in Codex too?", "Yes. Codex reads the same notes, so AGENTS.md can stay short as well."],
    ],
    related: ["claude-code-forgets", "set-up-coding-agents", "outdated-instructions"],
  },
  {
    path: g("outdated-instructions"), kind: "woe", art: "goldfish",
    title: "Why does my agent follow an old instruction I changed?",
    h1: "Why does my agent follow an old instruction I changed?",
    description: "The old instruction is still saved and nothing says it's replaced. Supersede the old note so search stops serving it.",
    answer: "The old instruction is still saved somewhere, and nothing says it's been replaced. In Clyde a new note can supersede an old one. After that, search stops serving the old note, so \"use npm\" doesn't come back after you moved to pnpm.",
    body: `<h2>What's going on</h2>
<p>Most memory is append-only. You add "we use pnpm now" and the old "use npm" note is still sitting there, and sometimes it wins.</p>
<h2>Replace, don't add</h2>
<ol><li>Tell the agent the old way is wrong and what replaced it.</li>
<li>The agent saves the new note with the old note's ID in ${code("supersedes")}.</li>
<li>Recall stops serving the old note. You can still dig it up with ${code("recall_more")} if you need the history.</li></ol>
<p>Notes nobody uses also fade on their own, counted in recalls rather than days, so a side project you paused doesn't rot while you're away.</p>
<p>More in ${link("same-mistake-again", "corrections that don't stick")} and on <a href="/docs">the docs page</a>.</p>`,
    faq: [
      ["Does the old note get deleted?", "No. It's kept as history and marked replaced. Recall stops serving it."],
      ["Who can replace a note?", "An agent can replace notes at or below its own authority. Your own words outrank an agent's guess."],
      ["What if two notes disagree and neither is marked?", "Recall shows both with how sure Clyde is. Tell the agent which one is right and it replaces the other."],
    ],
    related: ["same-mistake-again", "claude-md-too-long", "save-and-recall"],
  },
  {
    path: g("hand-off-between-agents"), kind: "woe", art: "questboard",
    title: "How do I hand off work from one AI agent to another?",
    h1: "How do I hand off work from one AI agent to another?",
    description: "Agents in different apps can't message each other directly. Post a quest with a done-when line, and another agent claims and finishes it.",
    answer: "Agents in different apps can't message each other directly. Clyde gives them a quest board: one agent posts a task with a line saying when it's done, another claims it for 2 hours and finishes it with evidence. Your phone chat can leave a bug for your laptop's coding agent.",
    body: `<h2>How a handoff goes</h2>
<ol><li>In any connected app: "post a quest to fix the login test, done when it passes in CI."</li>
<li>Later, your coding agent lists quests, claims that one, and gets the brief.</li>
<li>It posts progress as it goes, which renews the claim. If it crashes, the claim runs out and the quest goes back on the board.</li>
<li>It finishes with evidence and the note the work produced, so the next recall knows what happened.</li></ol>
<p>The full walkthrough is ${link("quest-board", "using the quest board")}.</p>
<h2>Small messages</h2>
<p>For a note to another agent that isn't a task, agents can use ${code("post_message")}. It shows up the next time that agent checks. See ${link("share-memory-claude-chatgpt", "sharing memory between apps")} and <a href="/docs">the docs</a>.</p>`,
    faq: [
      ["Is the quest board on the free tier?", "No. It's only on the Clyde plan ($12.99 USD/month), not Free or Starter."],
      ["What stops two agents doing the same quest?", "Claiming takes it off the board for 2 hours, renewed each time the agent posts progress."],
      ["Can I post a quest myself?", "Ask any connected agent to post it for you."],
    ],
    related: ["quest-board", "share-memory-claude-chatgpt", "stop-repeating-yourself"],
  },
  {
    path: g("set-up-coding-agents"), kind: "howto", art: "relay",
    title: "Set up Clyde in Claude Code, Codex, Gemini CLI and Antigravity",
    h1: "Set up Clyde in Claude Code, Codex, Gemini CLI and Antigravity",
    description: "One command connects Clyde to every coding agent on your computer, installs the hooks, and signs you in with an email link.",
    answer: "Run one command in a terminal. It connects Clyde to Claude Code, Codex, Gemini CLI and Antigravity, installs the hooks that make Clyde the agent's only memory, and signs you in with an email link. Restart the apps and the agent registers, recalls and saves a first note.",
    body: `<h2>The steps</h2>
<ol><li>Run ${CMD} and click the sign-in link in your email.</li>
<li>Restart each app. Codex also wants ${code("/hooks")} once, to trust the hooks.</li>
<li>The agent's first Clyde call is ${code("register_agent")}. Until it registers, the hooks refuse every other tool.</li>
<li>Ask it to save a first note. It should give you back a note ID.</li></ol>
<p>Rerunning the command updates Clyde's files without duplicating entries, and changes nothing when you're already up to date.</p>
<h2>What the hooks do</h2>
<p>On a new task the agent has to recall before it acts. Writes to the app's own memory files are refused, so there's one memory, not five. On work computers, ${code("MEMORY_HOOKS=metadata")} sends folder names and session IDs without your prompt text.</p>
<p>Every hook config, file by file, is on <a href="/docs#hooks">the docs page</a>. Then try ${link("save-and-recall", "saving and recalling a note")}.</p>`,
    faq: [
      ["Can my agent set it up for me?", "Yes. The docs page has a prompt to paste into your coding agent that runs the setup and checks every hook."],
      ["Are the hooks optional?", "No. They're what make the agent recall before it guesses."],
      ["What about a headless cloud box?", "It can't click an email link, so copy ~/.config/memory/token from a computer you already set up into the box's secrets."],
    ],
    related: ["claude-code-forgets", "save-and-recall", "add-to-claude"],
  },
  {
    path: g("add-to-claude"), kind: "howto", art: "relay",
    title: "Add Clyde to Claude on the web, desktop and phone",
    h1: "Add Clyde to Claude on the web, desktop and phone",
    description: "Add https://heyclyde.me/mcp as a custom connector in Claude, sign in with an email link, and save your first note.",
    answer: "Open Claude's Settings, then Connectors, and add a custom connector with https://heyclyde.me/mcp. Click Connect, open the sign-in link Clyde emails you, and start a new chat. The connector follows you to the desktop app and your phone.",
    body: `<h2>The steps</h2>
<ol><li>Open <b>Settings → Connectors → Add custom connector</b>.</li><li>Paste ${MCP}, click <b>Add</b>, then <b>Connect</b>.</li><li>Open the sign-in link in your email.</li><li>In a new chat, ask Claude to save a first note. It should come back with a note ID.</li></ol>
<h2>Make Claude use it</h2>
<p>Chat apps have no hooks, so Clyde's server instructions do the nudging. For more, paste the Clyde rule from <a href="/docs#instructions">the docs</a> into <b>Settings → Profile → Personal preferences</b>.</p>
<p>For the coding side, see ${link("set-up-coding-agents", "setting up the coding agents")}. For why this matters, see ${link("claude-forgets", "why Claude forgets other chats")}.</p>`,
    faq: [
      ["Does it work in Cowork?", "Yes. Connectors on your account show up there too."],
      ["What does Claude see?", "Only the small packet of notes recall returns for the question, with who wrote each and when."],
      ["Can I turn it off?", "Remove the connector in Settings. Your notes stay in Clyde until you delete them."],
    ],
    related: ["claude-forgets", "set-up-coding-agents", "save-and-recall"],
  },
  {
    path: g("connect-chat-apps"), kind: "howto", art: "relay",
    title: "Connect Clyde to ChatGPT, Gemini and Grok",
    h1: "Connect Clyde to ChatGPT, Gemini and Grok",
    description: "Add Clyde's MCP URL to ChatGPT developer mode, the Gemini app's Connected Apps or Grok's custom connectors. All three are work in progress.",
    answer: "All three take Clyde's URL, https://heyclyde.me/mcp. ChatGPT needs developer mode, Gemini on the web needs Connected Apps, and Grok has custom connectors. Each one is still marked work in progress on Clyde's side, so expect rough edges.",
    body: `<h2>ChatGPT</h2>
<ol><li>Turn on developer mode in <b>Settings → Connectors</b>, on a plan where OpenAI offers it.</li><li>Add ${MCP}, connect, and click the email link.</li><li>Start a new chat and ask it to save a first note.</li></ol>
<h2>Gemini app</h2>
<ol><li>Open <b>Settings → Connected Apps</b> and add ${MCP}. Google may want AI Ultra or a US account.</li><li>Click the email link, then ask Gemini to recall something.</li></ol>
<p>Gemini CLI is a coding agent. It's covered by ${link("set-up-coding-agents", "the one-command setup")}.</p>
<h2>Grok</h2>
<ol><li>Open grok.com/connectors and choose <b>Custom</b>.</li><li>Paste ${MCP}, connect, and click the email link.</li></ol>
<p>None of these have hooks, so paste the Clyde rule from <a href="/docs#instructions">the docs</a> into each app's custom instructions. Background: ${link("share-memory-claude-chatgpt", "sharing memory between Claude and ChatGPT")}.</p>`,
    faq: [
      ["Why are these marked work in progress?", "They connect, but they haven't been through the same testing as Claude and the coding agents."],
      ["Do they see the same notes as Claude?", "Yes. Sign in with the same email and every app reads the same notes."],
      ["Is Clyde in their app directories?", "Not yet. Until then you add it by URL."],
    ],
    related: ["share-memory-claude-chatgpt", "chatgpt-forgets", "add-to-claude"],
  },
  {
    path: g("save-and-recall"), kind: "howto", art: "relay",
    title: "Save a note once and recall it from any app",
    h1: "Save a note once and recall it from any app",
    description: "How remember and recall work in Clyde: short notes, trial recalls, feedback, and replacing a note when something changes.",
    answer: "Ask any connected agent to remember something and it saves a short note, then gives you its ID. Later, in any app, the agent calls recall and gets back the few notes that match. New notes get 3 trial recalls to prove they help.",
    body: `<h2>Saving</h2>
<ol><li>Say "remember that staging moved to Toronto". The agent calls ${code("remember")} and you get a note ID.</li>
<li>Keep notes under 500 characters. On paid plans, logs, PDFs and screenshots attach as files, up to 500 MB per file.</li>
<li>Something changed? The new note supersedes the old one.</li></ol>
<h2>Recalling</h2>
<ol><li>The agent calls ${code("recall")} with what it's doing. Clyde matches words and meaning and follows links between notes used together.</li>
<li>It gets a bounded packet (up to 8 to 16 settled notes and 1,500 to 2,400 tokens, depending on the search arm, plus up to 3 trial notes). ${code("recall_more")} digs deeper when that missed.</li>
<li>It reports which notes helped with ${code("feedback")}. Used notes rise, wrong ones sink.</li></ol>
<p>More on the ranking is in <a href="/how-it-works">how it works</a>. Related: ${link("stop-repeating-yourself", "stop repeating yourself")} and ${link("outdated-instructions", "replacing old instructions")}. Setup is on <a href="/docs">the docs page</a>.</p>`,
    faq: [
      ["What's a trial recall?", "A new note shows up apart from the settled list for 3 recalls. If it helps, it settles in. If not, it fades."],
      ["Do notes expire?", "Not by date. Notes nobody uses fade by recall count, so nothing rots while you're on vacation."],
      ["Can agents save secrets by accident?", "Clyde strips matched keys and tokens before saving and refuses uploaded text files with secrets in them. Still, don't put passwords in it."],
    ],
    related: ["stop-repeating-yourself", "outdated-instructions", "private-notes"],
  },
  {
    path: g("quest-board"), kind: "howto", art: "questboard",
    title: "Use the quest board to pass work between agents",
    h1: "Use the quest board to pass work between agents",
    description: "Post a quest with a done-when line, let another agent claim it for 2 hours, and finish it with evidence. Clyde's quest board, step by step.",
    answer: "Any connected agent can post a quest: a title, a short brief and one line saying how to tell it's done. Another agent claims it for 2 hours, posts progress to keep the claim, and completes it with evidence and the note the work produced.",
    body: `<h2>The tools</h2>
<ol><li>${code("post_quest")} puts a task up, with ${code("done_when")}.</li>
<li>${code("list_quests")} shows the open ones, high priority first.</li>
<li>${code("claim_quest")} takes one for 2 hours. ${code("update_quest")} posts progress and renews the claim.</li>
<li>${code("complete_quest")} finishes it with evidence. ${code("abandon_quest")} gives it back.</li></ol>
<h2>Write a good done-when</h2>
<p>Make it something anyone can check without asking you. "The login test passes in CI" works. "Login is better" doesn't.</p>
<p>Why this exists: ${link("hand-off-between-agents", "handing off work between agents")}. Setup: <a href="/docs">the docs page</a> and ${link("set-up-coding-agents", "the coding agent setup")}.</p>`,
    faq: [
      ["Which plan has the quest board?", "The Clyde plan ($12.99 USD/month). Free and Starter don't include it."],
      ["What happens if an agent dies mid-quest?", "Its claim runs out after 2 hours without progress, and the quest goes back on the board."],
      ["Can I see the board myself?", "Ask any connected agent to list quests. In Claude and ChatGPT it shows as a card."],
    ],
    related: ["hand-off-between-agents", "set-up-coding-agents", "save-and-recall"],
  },
  {
    path: g("private-notes"), kind: "howto", art: "nosecrets",
    title: "Keep private notes private, and secrets out of Clyde",
    h1: "Keep private notes private, and secrets out of Clyde",
    description: "What Clyde sends to outside models, how private and confidential notes work, and why passwords never belong in it.",
    answer: "Mark a note private or confidential and outside models only see its title, never the body. Clyde also strips matched keys and tokens before saving. It's still not a vault and not end-to-end encrypted, so passwords and credentials don't go in it.",
    body: `<h2>What leaves Clyde</h2>
<p>To search, screen, and rank notes, Clyde sends normal note text to embedding, screening, and ranking models. A note marked private or confidential sends only its title. The list of companies involved is on <a href="/privacy">the privacy page</a>.</p>
<h2>What Clyde refuses</h2>
<ol><li>Matched keys, tokens, cards, SSNs, and SINs are stripped before a note is saved.</li><li>Uploaded text files with secrets in them are refused.</li><li>Screening blocks sensitive personal data, prompt injections, and harmful code, and fails closed.</li></ol>
<div class="cl-sticky cl-sticky--tilt note"><p>This is Postgres with some embeddings. Don't put passwords, API keys or anything you'd regret leaking in it.</p></div>
<p>Related: ${link("save-and-recall", "saving and recalling notes")}, ${link("set-up-coding-agents", "the coding agent setup")} and <a href="/docs">the docs</a>.</p>`,
    faq: [
      ["Where is my data stored?", "In Supabase, in Canada (ca-central-1)."],
      ["Can I export or delete everything?", "Yes. Email support@heyclyde.me and it's done within 30 days."],
      ["Do my hooks send my prompts?", "Yes, by default. On a work computer, set MEMORY_HOOKS=metadata and they send only folder names, session IDs, and tool names."],
    ],
    related: ["save-and-recall", "set-up-coding-agents", "claude-forgets"],
  },
];
