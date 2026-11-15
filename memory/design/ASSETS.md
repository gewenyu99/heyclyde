# Clyde Shared Asset Kit (`memory/design/assets/`)

Reusable vector (`.svg`) and raster (`.png`, `.jpg`) assets featuring **Sticky-Note Forehead Clyde** and our hand-drawn sticky-note / ballpoint-doodle visual language. Built for `heyclyde.me`, `memory.heyclyde.me`, MCP chat cards, docs, Open Graph social previews, and connector/plugin store submissions (R55–R58) across **Claude**, **Claude Code**, **ChatGPT**, **Codex**, **Gemini**, **Antigravity**, and **Grok**.

---

## 1. Brand Marks & Lockups (`memory/design/brand/` & `memory/proxy/public/_clyde/brand/`)

| File | Dimensions / ViewBox | Purpose |
|---|---|---|
| `clyde-lockup-light.svg` / `clyde-lockup-dark.svg` | `0 -74 332 92` | Primary navbar & header lockup (Sticky-Note Forehead Clyde mark + lowercase `clyde` wordmark). |
| `clyde-mark-light.svg` / `clyde-mark-dark.svg` | `0 0 128 128` | Standalone head mark for compact headers, badges, and avatars (`>= 16px`). |
| `clyde-mascot-light.svg` / `clyde-mascot-dark.svg` | `0 0 156 310` | Full standing Sticky-Note Forehead Clyde with hands in pockets (~17 KB static vector). |
| `clyde-wordmark-light.svg` / `clyde-wordmark-dark.svg` | `0 -71 240 87` | Outlined Bricolage Grotesque ExtraBold lowercase wordmark alone. |
| `favicon.svg` | `0 0 128 128` | Auto-switching `prefers-color-scheme` browser tab icon. |
| `memory/design/brand.js` | `LOGO_LOCKUP` (`<= 4.5 KB`), `LOGO_MARK` | Token-driven inline SVGs (`.p`, `.s`, `.i`, `.c`) for sandboxed MCP chat cards and artifacts. |

---

## 2. App & Connector Store Icons (`memory/design/assets/icon-*`)

Framed on `1024x1024` paper tiles with generous circle-safe and squircle-safe padding so directory listings (Claude Connectors, Claude Code Plugins, ChatGPT Apps, Codex, Gemini Connected Apps, Antigravity Marketplace, and Grok Connectors) never clip Clyde's head or sticky note:

- `assets/icon-light.svg` — Vector light app icon (`1024x1024`).
- `assets/icon-dark.svg` — Vector dark app icon (`1024x1024`).
- `assets/icon-1024.png` — `1024x1024` PNG export for app directory uploads.
- `assets/icon-512.png` — `512x512` PNG export for OAuth client metadata / manifests.
- `assets/icon-128.png` — `128x128` PNG export for plugin cards and compact listings.

---

## 3. Open Graph & Store Listing Banner (`memory/design/assets/og-banner-1200x630.*`)

- `assets/og-banner-1200x630.svg` & `assets/og-banner-1200x630.png` (`1200x630`)
- Shows Sticky-Note Forehead Clyde beside crooked sticky notes naming all seven connected agent apps (**Claude**, **Claude Code**, **ChatGPT**, **Codex**, **Gemini**, **Antigravity**, **Grok**) in plain text per [APP-LOGOS.md](APP-LOGOS.md) (no third-party trademarked logos embedded without permission), plus the `https://memory.heyclyde.me/mcp` endpoint and fair-warning sticky note.

---

## 4. Character Scene Illustrations (`memory/design/assets/scenes/` & `memory/proxy/public/_clyde/scenes/`)

Each scene ships as the high-resolution reference `.jpg` in `memory/design/assets/scenes/` plus traced, transparent-ground light & dark SVGs (`#ffffff`/`#1b1c1a` paper fills, `#fdf4c4`/`#2c2818` sticky-note fills, `#20211f`/`#f2f2ee` ink strokes, and `#2f5fd0`/`#86a6f5` ballpoint-blue strokes) in both `memory/design/assets/scenes/` and `memory/proxy/public/_clyde/scenes/`:

| Scene slug | Files | Best used for |
|---|---|---|
| `standing` | `standing.jpg`, `standing-light.svg`, `standing-dark.svg` | Hero margins, sign-in pages, general mascot presence. |
| `relay` | `relay.jpg`, `relay-light.svg`, `relay-dark.svg` | Cross-app memory handoff (`heyclyde.me/#what` Card 1, onboarding, connector docs for Claude / ChatGPT / Claude Code / Codex / Gemini / Antigravity / Grok). |
| `questboard` | `questboard.jpg`, `questboard-light.svg`, `questboard-dark.svg` | Sticky-note quest board (`heyclyde.me/#what` Card 2, empty quest board state). |
| `nosecrets` | `nosecrets.jpg`, `nosecrets-light.svg`, `nosecrets-dark.svg` | Blunt security / privacy callouts (`heyclyde.me/#honest`, `/privacy`, Connect page reminder). |
| `goldfish` | `goldfish.jpg`, `goldfish-light.svg`, `goldfish-dark.svg` | `404` ("Even Clyde doesn't remember a page here"), empty recall states, anti-amnesia callouts. |

### Theme-switching `<picture>` pattern (0 JS, CSP-safe)
```html
<picture class="cl-mascot">
  <source srcset="/_clyde/scenes/relay-dark.svg" media="(prefers-color-scheme: dark)">
  <img src="/_clyde/scenes/relay-light.svg" alt="Clyde passing a sticky note from a chat app to a terminal">
</picture>
```

---

## 5. Standalone Doodle Primitives (`memory/design/assets/doodles/`)

Lightweight hand-drawn SVG building blocks (`< 1.5 KB` each) for callouts, empty states, store screenshots, and docs:

- `sticky-yellow.svg` — Crooked warm-yellow sticky note with top adhesive strip, dog-ear fold, and ink squiggles.
- `sticky-blue.svg` — Clyde's signature blue-ballpoint-outlined sticky note with forehead squiggle.
- `sticky-tilted-pair.svg` — Overlapping yellow + carbon-wash sticky note pair.
- `arrow-right.svg` — Hand-drawn ballpoint-blue pointer arrow.
- `arrow-curve.svg` — Dashed curved ballpoint handoff arrow.
- `scribble-underline.svg` — Double-pass ballpoint scribble underline.
- `scribble-circle.svg` — Hand-looped ballpoint emphasis circle.
- `tape-strip.svg` — Torn-edge masking tape strip.
- `pushpin.svg` — Doodle bulletin-board pushpin in ink and carbon blue.
- `app-handoff.svg` — Chat window -> sticky note -> `>_` terminal diagram for store listings and docs.
