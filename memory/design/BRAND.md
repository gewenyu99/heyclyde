# Clyde brand brief

Clyde gives every agent a person runs one shared memory and a quest board, so the decision one agent made three weeks ago in Claude Code is still there when Codex picks the work up today. It fixes agent amnesia.

This brief decides how Clyde looks, sounds and moves. The tokens are in [tokens.css](tokens.css), the components in [components.css](components.css), and the reasons in [PRINCIPLES.md](PRINCIPLES.md).

## Who Clyde is

Clyde is the guild's clerk. Your agents are the guild: a coding agent on the work laptop, a researcher in claude.ai, a reviewer in Antigravity. They come and go, and they forget. Clyde stays, keeps the book every agent writes in, files a copy for every member, and pins the work orders to the board.

A good clerk is exact, unhurried and on your side: writes down who said what, where and when, doesn't editorialize, doesn't gush, and doesn't lose things.

## The idea: carbon copy

Everything Clyde files is a carbon copy. One agent writes a memory, and every other agent gets the copy. That's the product, and it's the look:

- **Paper.** Grey desk paper (`paper-0`, clyde-v2's `#f4f4f1`), white sheets on it (`paper-1`), and wells pressed into them (`paper-2`).
- **Ink.** Black ink for what people read (`ink`, `ink-2`, `ink-3`).
- **Carbon.** One ballpoint blue (`carbon`, clyde-v2's `#2f5fd0`) for what Clyde copied: links, focus, selection, and the offset copy that shows behind a chosen sheet.
- **The lift.** The one chosen thing on a screen (the current page in the nav, the primary button, the memory you opened) lifts off the page and leaves its blue copy behind it (`--cl-copy-1`, `--cl-copy-2`). Press it and it goes back down onto the copy. This is Clyde's signature. Use it for one thing per view, never for every card.
- **Forms.** Field labels are printed captions: small mono caps (`label`), like the boxes on a work order.
- **Stamps.** Outcomes get stamped: a quest is CLAIMED in carbon, DONE in green; a sign-in is CONNECTED, REFUSED or EXPIRED. A stamp is the only thing in Clyde that's tilted.
- **Pens.** Each agent signs in its own pen color (`pen-*`), so you can tell atlas's memories from quill's at a glance. The brand never borrows a pen.
- **Tear lines.** Dashed rules mark the perforation between a quest's stub and its body, and the fold above a card's footer.

## Voice

- **Plain and exact.** Who, what, where, when. "atlas filed this from Claude Code on mbp-work, 3 days ago."
- **Short sentences.** Lead with the claim. One idea a sentence.
- **Numbers over adjectives.** "Recalled 41 times", not "frequently used". "93% confidence", not "high confidence".
- **Calm about bad news.** Say what happened, then the one step to take. "That link expired. Links last 15 minutes and work once. Start again from the app."
- **Second person for the reader, names for agents.** "Your agents", "atlas claimed Nº 38". Clyde is always third person: "Clyde emailed you a link."
- **Dry, not cute.** A little wit is fine in an empty state. Never a joke in an error.

Four nouns, never synonyms: **memory** (never note, entry or fact card), **quest** (never task or ticket), **agent** (never bot or assistant), **app** (the thing the agent runs in: Claude, Codex, Gemini). The product is always **Clyde**, the wordmark always lowercase **clyde**. "Memory" is Clyde's memory, a feature, never the brand.

Verbs: agents **remember** and **recall**; people **prune**, **supersede** and **delete**; agents **post**, **claim** and **complete** quests.

Write: "Nothing filed yet." "Clyde emailed you a sign-in link." "atlas claimed this 12 minutes ago." "Superseded by Nº 412."
Don't write: "Oops!", "Magic", "AI-powered", "Supercharge", "your second brain", "Let's get started 🚀", exclamation marks, emoji.

## Mood

Calm, precise, warm under the precision. An archive that's been well kept, not a museum and not a hacker terminal. The page should feel like a clean desk with the right papers on it.

## What Clyde is not

- **Not a brain.** No neurons, synapses, glowing nodes or sparkles. Memory here is paper, filed and findable.
- **Not a chatbot.** Clyde has no face, no avatar and no chat bubble. Clyde is the clerk behind the counter, not the one talking.
- **Not a game.** Quests are work orders with a done-when line. No XP, levels, loot or confetti.
- **Not a hacker console.** No black screens of green mono, no fake terminal chrome.
- **Not a notes app.** People don't write in Clyde; their agents do. People review, prune and point.
- **Not loud.** No gradients, no neon, no purple-to-blue, no glassmorphism.

## Visual rules

**Color.** Neutrals carry 90% of every screen. `carbon` is the only accent and it means "Clyde's copy". State colors (`ok`, `warn`, `bad`) appear only with a word or a glyph. Pens appear only next to an agent's name or square. Text colors pass 4.5:1 on every paper in both themes, which `harness/test/memory/design_test.ts` checks.

**Dark.** Dark is the carbon sheet: `#121311` ground, papers getting lighter as they rise, ink `#ecece6`, carbon and pens redrawn lighter. The logo switches to its dark files (ink `#ecece6`, carbon `#86a6f5`).

**Type.** Bricolage Grotesque for display and titles with tight tracking (`--cl-track-title`, `--cl-track-display`), Geist for everything else a person reads, Geist Mono for labels, provenance, ids, numbers and code. Reading text 16/25 at most 64ch; UI text 14/21. Nothing smaller than 10.5px, and that size is only for mono caps labels.

**Space.** A 4px grid: 4, 8, 12, 16, 20, 24, 32, 40, 56, 80. Cards pad 16. Sections sit 32 to 56 apart.

**Corners.** Paper has small corners: 3 for stamps and pen squares, 5 for chips and inputs, 7 for buttons, 10 for cards, 14 for sheets. Only the mark is soft (29%).

**Shadows.** `shadow-1` for a sheet resting on the page, `shadow-2` for a sheet held up (a dialog, the sign-in card). The carbon offset (`copy-1`, `copy-2`) only for the chosen thing.

**Motion.** 90ms press, 160ms hover, 240ms enter, 420ms stamp. Out-ease for arrivals, in-ease for exits. The stamp's overshoot (`--cl-ease-stamp`) is used by the stamp and nothing else. Nav, filters and keyboard actions don't animate. Everything respects reduced motion (the tokens drop to 0ms).

## Logo

Wen asked for a real logo on 2026-11-15, which replaces the clyde-v2 placeholder mark. The mark is an ink square with
its carbon copy offset behind it, and a lowercase c cut through the square so you see the blue copy through it: the
product's idea in one shape. The wordmark is lowercase "clyde" in Bricolage Grotesque ExtraBold (optical size 96),
outlined to paths so it renders the same everywhere. Six options were drawn; the rest and why they lost are on the
design system page.

- **Files.** `memory/design/brand/` (and the copy the Worker serves at `/_clyde/brand/`): `clyde-mark-*.svg`,
  `clyde-wordmark-*.svg`, `clyde-lockup-*.svg` in light and dark, and `favicon.svg`, which switches with the system
  theme. `memory/design/brand.js` has the same logo as inline SVG whose colors come from the tokens (`.cl-logo`).
- **Colors.** Ink (`#20211f`, dark `#ecece6`) and carbon (`#2f5fd0`, dark `#86a6f5`). Nothing else.
- **Clear space.** The copy offset (a sixth of the mark) on every side.
- **Minimum size.** Mark 16 px; lockup 20 px tall.
- **Never** rotate, recolor, stretch, outline, animate it, or set it on a pattern. Never redraw it in a font.

## Typefaces

Bricolage Grotesque (display: headlines, the hero, big numbers), Geist (text and UI), Geist Mono (labels, provenance,
ids, numbers). All OFL. memory.heyclyde.me self-hosts them (`memory/design/fonts.css`, files in
`memory/proxy/public/_clyde/fonts`); artifacts load them from Google Fonts; every stack falls back to the system face.

## Other apps' logos

Show another company's logo only when its own guidelines allow it without approval, unaltered, from its official
assets. Today that's Grok. Every other app appears as its name in plain text until its owner approves
(`memory/design/APP-LOGOS.md` has the sources, rules and contacts). Label the row "Connects to", and keep the footer
line saying a listed app doesn't mean its maker endorses Clyde.

## Illustration

Clyde draws only its own objects: index cards, their carbon copies, stamps, and the dashed thread that links two memories. Rules:

- 1.5px strokes in `ink-3`, round caps. Sheets filled `paper-1`. One fill of `carbon-copy` per drawing, for the copy.
- Flat, front-on, no perspective, no shading, no gradients.
- No people, robots, brains, faces, hands, sparkles or stars.
- At most 120px wide, inside an empty state or a hero, never as wallpaper.

## Iconography

Line icons on a 24 grid drawn at 16 or 20px, 1.5px stroke (2px at 16px only if they blur), round caps and joins, `currentColor`, in the style of [Lucide](https://lucide.dev). Icons sit beside a word; an icon alone needs an `aria-label`. No emoji anywhere, no filled icon sets, no colored icons except a state glyph in its state color.

## Do and don't

| Do | Don't |
|---|---|
| Lift the one primary button with its carbon copy | Put the carbon offset on every card in a grid |
| Show who filed a memory in a mono provenance line under it | Hide provenance in a tooltip |
| Stamp CLAIMED on a quest in carbon, tilted 3° | Tilt anything else, or stamp more than one thing per card |
| Give each agent a pen and use it for its name and square | Color a whole card by its agent |
| Write "Nothing filed yet. The first thing an agent remembers lands here." | Write "No data" or "Get started!" |
| Use `ink-3` for meta text on any paper | Use opacity to make grey text |
| Say "Refused. Nothing was shared." then the next step | Apologize, or blame the user |
| Use the logo files or `brand.js` as they are | Rebuild the logo in a font, or recolor it |
| Use mono caps for field labels only | Set headings or buttons in all caps |
