# Clyde brand brief

Clyde gives every agent a person runs one shared memory and a sticky-note quest board, so the decision one agent learned the hard way three weeks ago in Claude Code is still there when Codex or ChatGPT wakes up today. It cures the goldfish thing.

This brief decides how Clyde looks, sounds, and moves. The tokens are in [tokens.css](tokens.css), the components in [components.css](components.css), the shared character and doodle assets in [ASSETS.md](ASSETS.md), and the engineering principles in [PRINCIPLES.md](PRINCIPLES.md).

## Who Clyde is

Clyde is a slouchy, deadpan hand-doodled little guy with his hands in his pockets, tired dot eyes, and a crooked blue-outlined sticky note slapped straight onto his forehead.

Your agents — in Claude, Claude Code, ChatGPT, Codex, Gemini, Antigravity, and Grok — wake up every session with amnesia. Clyde doesn't pretend to be a magical "second brain" or an enterprise vault; he's the bare-minimum stack of sticky notes, carbon copies, and pinned work orders taped together so your agents stop asking how to deploy the repo for the fifth time.

## The visual language: desk paper, carbon copies, sticky notes, and doodles

Everything Clyde holds is something you'd actually jot on a desk:

- **Paper.** Grey desk paper (`--cl-paper-0`, `#f4f4f1` light / `#121311` dark), crisp white sheets (`--cl-paper-1`), and pressed wells (`--cl-paper-2`).
- **Sticky notes.** Warm sticky-note yellow (`--cl-sticky` `#fdf4c4` light / `#282416` dark) with a darker top adhesive strip (`--cl-sticky-strip`), subtle paper border (`--cl-sticky-edge`), and folded corner dog-ear (`.cl-sticky`). Use `.cl-sticky--tilt` / `.cl-sticky--tilt-r` sparingly for callouts, reality checks, and pinned work notes; `.cl-sticky--blue` gives a carbon-blue variant.
- **Ink & ballpoint carbon.** Scratchy black ink (`--cl-ink`, `--cl-ink-2`, `--cl-ink-3`) for reading copy and hand-drawn character lines; one ballpoint blue (`--cl-carbon`, `#2f5fd0` light / `#86a6f5` dark) for Clyde's forehead sticky-note outline, hand-doodled arrows/underlines (`.cl-scribble`, `.cl-doodle`), links, focus rings, and the offset carbon copy (`--cl-copy-1`, `--cl-copy-2`).
- **The lift.** Primary buttons and selected cards lift off the page and leave their hard blue copy behind (`--cl-copy-1`, `--cl-copy-2`). Press them and they settle back onto the copy.
- **Stamps & tear lines.** Outcomes get stamped (`CLAIMED`, `DONE`, `SAVED`, `CONNECTED`, `REFUSED`, `READ THIS`). Perforated dashed rules separate quest stubs (`.cl-quest__stub`, tinted in `--cl-sticky`) from their bodies.
- **Pens.** Each agent signs in its own pen color (`--cl-pen-*`), passing 4.5:1 WCAG contrast across every paper ground including `--cl-sticky`.

## Voice

- **Blunt, candid, human, and zero pretension.** Talk like a normal engineer explaining a practical tool over coffee — never like a SaaS pitch deck, and never like a solemn medieval archivist.
- **Honest about what it is (and isn't).** Call it what it is: Postgres, embeddings, and an MCP URL taped together so agents remember Tuesday. Warn people plainly not to store nuclear launch codes, passwords, API keys, or serious secrets in it.
- **Exact where facts matter.** Provenance (`who / app / machine / when`), confidence percentages (`93%`), plan allowances (`$12.99`, `2,000 recalls`, `500 remembers`, `first 1,000 people`), and error next steps stay short and concrete.
- **Dry humor, never obnoxious.** Deadpan goldfish and sticky-note jokes belong in headlines, callouts, and empty states. When something breaks or a link expires, tell the user what happened and the one step to fix it without cute emoji or groveling.

Core nouns: **memory** (or plain **note** in casual copy), **quest**, **agent**, **app**. The product is **Clyde**; the wordmark is lowercase **clyde**.

Write:
- `"Nothing in Clyde matches that yet."`
- `"Your other agents won't forget this now."`
- `"This is not advanced space-age technology, and it's probably not even very secure — don't put passwords in it."`
- `"That link's dead — they only last 15 minutes and work once. Kick off sign-in again from your app."`

Don't write:
- `"AI-powered second brain"`, `"Supercharge your workflow"`, `"enterprise-grade neural memory"`, `"Oops! 😅"`, or stiff roleplay.

## Mascot & Logo

Sticky-Note Forehead Clyde is our mascot and brand mark:
- **Mark & Lockup (`memory/design/brand/` & `/_clyde/brand/`).** Head-and-forehead-note mark (`clyde-mark-light.svg`, `clyde-mark-dark.svg`, `favicon.svg`) paired with the outlined lowercase Bricolage Grotesque ExtraBold `clyde` wordmark (`clyde-lockup-light.svg`, `clyde-lockup-dark.svg`). `memory/design/brand.js` exports compact token-driven inline SVGs (`LOGO_LOCKUP` <= 4.5 KB, `LOGO_MARK`) using `.p` (`--cl-paper-1`), `.s` (`--cl-sticky`), `.i` (`--cl-ink`), and `.c` (`--cl-carbon`).
- **Full Mascot & Multi-Pose Scenes (`memory/design/assets/scenes/` & `/_clyde/scenes/`).** Five character-consistent hand-drawn scratchy-ink scenes in light and dark SVG:
  1. `standing` — slouching hands-in-pockets Clyde (`clyde-mascot-{light,dark}.svg`).
  2. `relay` — passing a sticky note between a chat window and a `>_` terminal window.
  3. `questboard` — pointing lazily at a bulletin board of crooked sticky notes and blue string.
  4. `nosecrets` — holding up a deadpan palm next to a blue-crossed-out padlock and key.
  5. `goldfish` — staring eye-to-eye at an equally deadpan goldfish in a bowl.
- **Minimum size.** Mark `16 px`; lockup `20 px` tall (`28–30 px` in navbars).

## Visual rules

- **Contrast.** Every foreground (`ink`, `ink-2`, `ink-3`, `carbon`, `ok`, `warn`, `bad`, and all 7 `pen-*` colors) holds `>= 4.5:1` WCAG contrast on `paper-0`, `paper-1`, `paper-2`, AND `sticky` in both light and dark themes — enforced in `harness/test/memory/design_test.ts`.
- **Dark theme.** `#121311` ground, `#1b1c1a` sheets, `#282416` dark warm sticky notes, `#ecece6` ink, and `#86a6f5` carbon blue. Media-query dark and `[data-theme="dark"]` stay 100% identical.
- **Type.** Bricolage Grotesque for display headlines, Geist for UI and reading copy, Geist Mono for labels, provenance, counts, and URLs (`fonts.css`).
- **CSP & byte discipline.** Zero literal `#hex` or `rgb()` in `components.css` or chat card CSS (`ui/style.ts`), zero inline `style=""` attributes on Worker HTML pages, `memory.heyclyde.me/` <= `40,000` bytes, `heyclyde.me/` <= `50,000` bytes, and each MCP chat card <= `60,000` bytes.

## Other apps' logos

Follow [APP-LOGOS.md](APP-LOGOS.md) strictly: show another company's official mark unaltered only when its guidelines permit website use without prior written approval (currently Grok in `/_clyde/apps/grok*.svg`). Refer to Claude, Claude Code, ChatGPT, Codex, Gemini, and Antigravity in plain text (or generic doodle icons like chat bubbles, terminals, and sticky notes) until partner approval lands, and always keep the non-endorsement notice in the footer.
