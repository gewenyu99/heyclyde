# Clyde design system

Use this directory when building a Clyde interface or asset. Sticky-Note Forehead Clyde is the official mascot. The system pairs desk paper and warm sticky notes with scratchy ink and ballpoint blue.

| Need | Start here |
| --- | --- |
| Voice, color, type, and illustration rules | [Brand brief](BRAND.md) and [design principles](PRINCIPLES.md) |
| Theme, typography, spacing, and motion | [Tokens](tokens.css) |
| Buttons, cards, sticky notes, stamps, and quest stubs | [Components](components.css) and the [component preview](../memory/design/design-system.html) |
| Standing mascot | [Light SVG](brand/clyde-mascot-light.svg) and [dark SVG](brand/clyde-mascot-dark.svg) |
| Head mark and wordmark together | [Light lockup](brand/clyde-lockup-light.svg) and [dark lockup](brand/clyde-lockup-dark.svg) |
| Inline mark and lockup that follow the active tokens | [SVG exports](brand.js) |
| Illustrated scenes, app icons, social preview, and doodles | [Asset guide](ASSETS.md) and [asset files](assets/) |
| Use of other companies’ logos | [App logos](APP-LOGOS.md) |

## Use in an interface

Load `tokens.css` before `components.css`. Set the surface background to `var(--cl-paper-0)`, body text to `var(--cl-ink)`, and the body font to `var(--cl-font-sans)`. The page follows the system theme by default. Set `data-theme="light"` or `data-theme="dark"` on `<html>` for a manual override. Fixed-color SVGs need the matching theme variant. Inline `LOGO_MARK` and `LOGO_LOCKUP` take their fills from the active tokens when you load the component CSS.

This example assumes the HTML file is at the repository root.

```html
<link rel="stylesheet" href="design/tokens.css">
<link rel="stylesheet" href="design/components.css">

<article class="cl-sticky">
  <span class="cl-label">Saved</span>
  <p>Your other agents can recall this note.</p>
</article>
```

[Fonts](fonts.css) loads Bricolage Grotesque, Geist, and Geist Mono from `/_clyde/fonts/`. Use that stylesheet on hosts that serve the [font files](../memory/proxy/public/_clyde/fonts/) at that URL. The token stacks include system fallbacks for hosts and chat cards that omit web fonts.

## Edit and preview

Edit the CSS, inline SVG module, or [preview sources](src/) here, then run `node design/build.mjs`. Open the [component preview](../memory/design/design-system.html), [site prototype](../memory/design/clyde-prototype.html), or [design directions](../memory/design/directions.html) in your browser from a checkout.

The build writes the Worker’s inlined CSS module, the HTML previews under `memory/design/`, and the chat cards’ bundled design module. `node memory/design/build.mjs` runs the same build. The legacy source paths under `memory/design/` resolve to these files in the checkout.

When updating a brand or scene SVG already served by the Worker, sync its matching file in [`memory/proxy/public/_clyde/`](../memory/proxy/public/_clyde/). See the [asset guide](ASSETS.md) for the separately exported store icons and social banner.

Run the design and site checks from the repository root.

```sh
deno test --allow-env --allow-read --node-modules-dir=none harness/test/memory/design_test.ts harness/test/memory/site_test.ts
```
