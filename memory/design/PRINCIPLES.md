# What Clyde's design learned, and from whom

Studied 2026-11-15 for Clyde's design system ([BRAND.md](BRAND.md), [tokens.css](tokens.css), [components.css](components.css)). Each page below was read live that day, and font, color and easing values come from the site's shipped CSS. Anything not seen on a live page is marked *from memory*. Each entry ends with what Clyde takes from it.

## Products with personality

### Linear
[linear.app](https://linear.app), [linear.app/method](https://linear.app/method), [linear.app/readme](https://linear.app/readme), [How we redesigned the Linear UI](https://linear.app/now/how-we-redesigned-the-linear-ui)

- Weights are off the default grid: 400, 510, 590 and 680. Body is 15px at line-height 1.6 with -0.011em tracking.
- Color is named by role (four background roles, four text roles), never by hue. Dark is `#08090a`, never `#000`.
- The redesign replaced 98 hand-set theme variables with a generator that takes a base, an accent and a contrast value.
- Motion is two named durations, 100ms and 180ms, on ease-out-quint `(.23,1,.32,1)`.

**Clyde takes:** off-grid weights (680 for the wordmark, as clyde-v2 already did; 650 and 720 for titles), color tokens named by role (`paper-0..2`, `ink`, `ink-2`, `ink-3`), and two everyday durations.

### Vercel's Geist
[vercel.com/geist/colors](https://vercel.com/geist/colors), [vercel.com/geist/typography](https://vercel.com/geist/typography)

- Every step of a color scale has a job: 100 to 300 are backgrounds, 400 to 600 borders, 700 and 800 solid fills, 900 and 1000 text.
- Type tokens are named by role and size (`heading`, `label`, `copy`, `button`), and mono sits one size below the sans beside it.

**Clyde takes:** a token's name says where it goes (`--cl-edge` is a control border, `--cl-carbon-copy` is never text). Mono labels sit a step smaller than the sans they label.

### Raycast
[raycast.com](https://www.raycast.com)

- Headlines are short complete sentences that end in a period.
- The hero illustration is the product's own input device, a keyboard with features laid on its keys.

**Clyde takes:** the illustration is Clyde's own object, a memory card and its carbon copies, never an abstract brain. Headlines are plain sentences.

### Stripe and Stripe Press
[stripe.com](https://stripe.com), [Designing accessible color systems](https://stripe.com/blog/accessible-color-systems), [press.stripe.com](https://press.stripe.com)

- Figures stand in for claims (99.999% uptime links to the status page).
- The palette was rebuilt in a perceptual space so that shades a fixed number of steps apart always pass 4.5:1.

**Clyde takes:** every memory shows its numbers (confidence, times recalled, age), and the contrast of every text token is a test in CI ([design_test.ts](../../harness/test/memory/design_test.ts)), not a hope.

### Arc
[arc.net](https://arc.net)

- The live page is now a shutdown notice. Even that is first person, admits the hard part in one sentence, then switches to numbered steps.
- *From memory:* Arc let each user color their own spaces rather than shipping one brand color.

**Clyde takes:** bad news (refused, expired, blocked) says what happened in one sentence, then the one step to take. Users' agents get their own colors (pens), so the brand color stays scarce.

### teenage engineering
[teenage.engineering](https://teenage.engineering)

- One casing rule (all lowercase) broken in exactly one deliberate place.
- Products are short model codes used everywhere: URL, box, label.

**Clyde takes:** the wordmark is always lowercase "clyde", and the only all-caps text is the mono form label. Quests have a number (Nº 41) that is used everywhere.

### Things
[culturedcode.com/things](https://culturedcode.com/things/)

- The site uses only the system font stack and `ui-monospace`. The personality comes from craft and screenshots.

**Clyde takes:** chat cards can't load external fonts, so every stack in [tokens.css](tokens.css) falls back cleanly to the system face and `ui-monospace`. Web pages self-host Bricolage Grotesque, Geist and Geist Mono ([fonts.css](fonts.css)), while Things shows the system fallback still carries the brand inside a chat card.

### Rauno Freiberg, "Invisible details of interaction design"
[rauno.me/craft/interaction-design](https://rauno.me/craft/interaction-design)

- How often a thing happens decides whether it animates. Actions done dozens of times a day should be instant.
- Things open from where they came from and close back there. Motion stays interruptible.

**Clyde takes:** the nav, filters and keyboard paths never animate. Only rare, meaningful moments move: a stamp landing on a claimed quest, a toast rising, a card lifting under the pointer.

### PostHog
[posthog.com](https://posthog.com), [brand assets](https://posthog.com/handbook/company/brand-assets)

- The ground is off-white `#EEEFE9`, and dividers are dashed.
- The hedgehog mascot has written anatomy rules: one outline weight, where expression lives, what it never does.

**Clyde takes:** dashed rules mark tear lines and perforations (a quest's stub, a card's footer). Clyde has no mascot, so the illustration rules in [BRAND.md](BRAND.md) are written down before the second drawing.

### Notion's early brand (Roman Muradov)
Read through search results on [the thinking behind Notion's brand](https://www.notion.com/blog/the-thinking-behind-our-latest-brand-campaign), not the page itself.

- Black-and-white, gestural ink line work, chosen to stand apart from flat SaaS vectors and matched to the black-on-white UI.

**Clyde takes:** illustrations use the UI's own inks (ink-3 lines, one carbon-copy fill) so they look like they belong to the page.

### Panic
[panic.com](https://panic.com)

- Headings are plain declarative sentences. Product lines are concrete and a little funny.

**Clyde takes:** dry, concrete copy. "Nothing filed yet" over "Get started with your memories".

### Are.na
[are.na/about](https://www.are.na/about)

- Its own nouns, named once (channels hold blocks). Values are published as numbers.

**Clyde takes:** four nouns, never synonyms: memory, quest, agent, app. A memory is never a note, a quest is never a task, in anything a person reads.

### Readwise Reader
[readwise.io/read](https://readwise.io/read)

- The headline names who it is for, and the screenshots show the keyboard path.

**Clyde takes:** the site says who Clyde is for in its first line: people who run agents in more than one app.

### Height
Could not be fetched (the archive is blocked for the fetch tool). *From memory:* pastel gradients and a rounded sans. Not used.

## References on type, color, space and motion

### Butterick's Practical Typography
[Summary of key rules](https://practicaltypography.com/summary-of-key-rules.html)

- Body 15 to 25px on the web, line spacing 120 to 145%, lines of 45 to 90 characters.
- All caps only for less than a line, with 5 to 12% extra letterspacing.

**Clyde takes:** reading text is 16/25 (156%, at the top of the range for a UI with short paragraphs) at 64ch. Mono labels are caps with +9% tracking (`--cl-track-label: 0.09em`) and never run longer than a few words.

### Refactoring UI
[Building your color palette](https://www.refactoringui.com/previews/building-your-color-palette)

- 8 to 10 greys from a dark grey (not black) to an off-white. Define every shade up front; never lighten or darken at runtime.

**Clyde takes:** a fixed neutral ladder with a slight green-grey bias, from clyde-v2's `#f4f4f1` paper to `#20211f` ink. No `color-mix()` or `lighten()` in components.

### Every Layout, modular scale
[every-layout.dev/rudiments/modular-scale](https://every-layout.dev/rudiments/modular-scale/)

- One ratio drives type and space. The default space equals the line height.

**Clyde takes:** a 4px grid for space (4, 8, 12, 16, 20, 24, 32, 40, 56, 80). Type steps 13, 14, 16, 17, 24, 34, 64 sit roughly on a 1.2 to 1.4 ratio, tighter at UI sizes where density matters more than drama.

### Material Design 3 motion
[Motion tokens](https://m3.material.io/styles/motion/easing-and-duration/tokens-specs), read through material-web's token file.

- Durations in 50ms steps from 50 to 1000ms. Standard easing `(0.2, 0, 0, 1)`. Enter decelerates, exit accelerates, exits are shorter.

**Clyde takes:** four durations (90, 160, 240, 420ms), one out-ease for everything that arrives, one in-ease for what leaves, and one overshoot curve reserved for the stamp.

### Apple Human Interface Guidelines
[Typography](https://developer.apple.com/design/human-interface-guidelines/typography), [Dark mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode)

- Minimum 11pt on iOS. Dark mode needs at least 4.5:1, ideally 7:1 for small text. Surfaces get lighter as they rise; dark colors are not inversions.

**Clyde takes:** nothing below 10.5px, and that size only for mono caps labels. In dark, paper steps up in lightness from page to card to well, and the pens are redrawn lighter, not inverted.

### Perceptual color: Stripe and Evil Martians
[Stripe on accessible color systems](https://stripe.com/blog/accessible-color-systems), [OKLCH in CSS](https://evilmartians.com/chronicles/oklch-in-css-why-quit-rgb-hsl)

- HSL lightness lies across hues; a perceptual space keeps equal lightness looking equal.

**Clyde takes:** the seven pens share one lightness band per theme, so no agent's name shouts louder than another's, and each clears 4.5:1 on all three papers in both themes.

## Ten rules Clyde holds itself to

1. Color by role. Paper, ink and carbon, never "blue-500" in a component.
2. One accent. Carbon blue means "Clyde's copy": links, focus, selection and the offset behind a chosen sheet.
3. Agents bring their own colors (pens). The brand never borrows them.
4. Three OFL faces on the web (Bricolage Grotesque, Geist, Geist Mono, self-hosted in [fonts.css](fonts.css)), backed by system stacks in chat cards. Personality from optical size, weight, tracking and mono labels.
5. Every text color passes 4.5:1 in both themes, checked in CI.
6. Frequent actions don't animate. Rare, meaningful ones do, once.
7. Headlines are plain sentences. Bad news says what happened, then the one step.
8. Four nouns, never synonyms: memory, quest, agent, app.
9. Numbers instead of adjectives: 93% confidence, recalled 41 times, 3 days ago.
10. Illustrations are built from Clyde's own objects, in the page's own inks.
