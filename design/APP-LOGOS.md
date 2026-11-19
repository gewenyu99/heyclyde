# App logos on Clyde's pages: official sources and rules

What ships (2026-11-15): only Grok's official logomark, unaltered, from x.ai's logo zip
(`memory/proxy/public/_clyde/apps/grok.svg` for light backgrounds, `grok-dark.svg` for dark). The other six apps
appear as plain-text names until their owners approve logo use, because their guidelines below require approval for
a third-party website. The official files for those six are kept outside the repo (the side-session notes folder,
`app-logos-pending-permission/`) so they aren't redistributed. To add one after approval: copy its file into
`memory/proxy/public/_clyde/apps/<slug>.svg`, add it to `APP_LOGO` in `memory/proxy/pages.js`, and add the notice
its owner requires. The row is labelled "Connects to", not "Works with", per OpenAI's wording rules.

**Sign-in providers.** The consent page and the workspace sign-in show Google's multicolor "G" and GitHub's mark beside
"Continue with Google" and "Continue with GitHub" ([auth.mjs](auth.mjs)). Both are the providers' own marks, unaltered,
on a light or dark neutral button, which is how Google's Sign in with Google branding guidelines and GitHub's logo
guidelines allow a sign-in button to use them. Keep the Google button at least as prominent as GitHub's.

Research notes follow, as gathered.

Collected 2026-11-15. All files come from each company's own domain or CDN. No logo was redrawn, and no third-party source (Wikipedia, Simple Icons, LobeHub, svgrepo, toolradar and so on) was used. Paths are relative to this folder.

Verdict key: **OK** = OK to show the official mark on a compatibility page. **Text** = OK only as text. **Permission** = needs permission before showing the mark.

| App | Mark to use | Verdict |
|---|---|---|
| Claude | `claude/.../3 Claude Spark/SVG/Claude Spark - Clay.svg` | Permission (text OK now) |
| Claude Code | `claude-code/press-kit/Claude Spark - Clay.svg` (no separate symbol) | Permission (text OK now) |
| ChatGPT | `chatgpt/chatgpt-favicon.svg` (OpenAI Blossom) | Permission (text OK now) |
| Codex | `codex/codex-page-favicon-openai-blossom.svg` (same Blossom) | Permission (text OK now) |
| Gemini | `gemini/gemini_sparkle_aurora.svg` | Permission (text OK now) |
| Antigravity | `antigravity/antigravity-icon__full-color.svg` | Permission (text OK now) |
| Grok | `grok/Grok_Logomark_Dark.svg` / `Grok_Logomark_Light.svg` | OK, within xAI's usage terms |

---

## 1. Claude (Anthropic)

**Files saved** (unzipped from the official press kit, `claude/press-kit/Anthropic media resources/Anthropic logos/`):
- `Claude logos/3 Claude Spark/SVG/Claude Spark - Clay.svg` and `PNG/Claude Spark - Clay.png` (937x937). This is the Claude symbol on its own, in the brand's clay orange. It is the file to use on a Connect page.
- `Claude logos/4 Claude icon/SVG/ClaudeIcon-Rounded.svg`, `ClaudeIcon-Square.svg` and PNGs (1280x1280). These are the app-icon tile versions.
- `Claude logos/1 Claude logo/{SVG,PNG}/Claude logo - Slate | Ivory | One-color`. These are the symbol plus wordmark. Slate is the dark version for light backgrounds, and Ivory is the light version for dark backgrounds.
- `Anthropic logos/...` holds the Anthropic company logo and symbol, also in Slate and Ivory.
- `claude/anthropic-press-kit.zip` is the original download, kept as is. Executive headshots and bios were left zipped and not extracted.

**Source URLs:**
- Download: https://www.anthropic.com/press-kit, which redirects with a 307 to https://www-cdn.anthropic.com/ae59ca4ca194dac9c9dc3bc78c5829468cb0e8af.zip (26 MB). It is linked as "Download press kit" under "Media assets" on https://www.anthropic.com/news.

**Guideline URL:** https://www.anthropic.com/legal/trademark-guidelines

**Rules:**
- **Third-party use:** Anthropic's marks may be used "only in materials we approve beforehand" and only as Anthropic permits. Anthropic may withdraw permission at any time. If you have an existing business relationship and want to use the marks on a website, the contact is marketing@anthropic.com.
- **Endorsement:** The use must not suggest Anthropic sponsors or endorses you, or that you are affiliated with Anthropic, unless Anthropic has authorized it.
- **Colors:** "No alterations of our trademarks", which covers color, font and proportion. Use the supplied variants exactly as they are: Clay spark, Slate, Ivory, One-color.
- **Clear space:** Leave a "reasonable space" around every side. No number is given.
- **Minimum size:** None is published.
- **Background:** Do not use a background that hurts the mark's readability.
- **Other:** Do not add a ™ symbol.
- **Symbol without wordmark:** The kit ships the Spark on its own as a standard asset. No rule forbids using it alone.

**Verdict: needs permission.** Until approval comes, write "Claude" as plain text.

## 2. Claude Code (Anthropic)

**Files saved** (copied from the same official press kit):
- `claude-code/press-kit/Claude Code logo - Slate | Ivory | One-color .svg/.png` (PNG is 3638x500). This is the Spark plus the "Claude Code" wordmark.
- `claude-code/press-kit/Claude Spark - Clay.svg` and `.png`.

**Own mark?** Claude Code has no symbol of its own. The official Claude Code logo is the Claude Spark next to the words "Claude Code". For an icon-sized tile, the file that stands for Claude Code is `Claude Spark - Clay.svg`, with "Claude Code" written beside it as text.

**Source URL:** the same press kit as Claude, https://www.anthropic.com/press-kit, in its folder `Claude logos/2 Claude Code logo/`.

**Guideline URLs:**
- https://code.claude.com/docs/en/legal-and-compliance, section "Using the Claude Code name and logo"
- https://www.anthropic.com/legal/trademark-guidelines

**Rules:**
- You may say in plain text, accurately, that your product runs Claude Code.
- You may not use the Claude Code or Anthropic names or logos in your own product name or logo.
- You may not use them in a way that suggests Anthropic built, endorses or partners with your product.
- Any other use of the logos falls under the Trademark Guidelines and needs Anthropic's written permission.
- The Agent SDK branding notes (https://code.claude.com/docs/en/agent-sdk/overview) also forbid visuals that mimic Claude Code.
- Colors, clear space and background follow the Claude rules above.

**Verdict: needs permission.** Plain-text "Claude Code" is explicitly allowed now.

## 3. ChatGPT (OpenAI)

**Files saved:**
- `chatgpt/chatgpt-favicon.svg`: the Blossom, served as ChatGPT's own icon. It uses an internal CSS `prefers-color-scheme` rule, so it renders black on light systems and white on dark ones.
- `chatgpt/chatgpt-icon-512x512.png`: the black Blossom on white, 512x512, from ChatGPT's web app manifest.
- `chatgpt/openai-blossom-dark.svg` and `openai-blossom-light.svg`: the two Blossom images shown in the Blossom section of the brand page. Each sits on a 1183x719 canvas with padding, so they are not tightly cropped.

**Source URLs:**
- https://chatgpt.com/unauth-mweb/images/favicon.svg
- https://chatgpt.com/unauth-mweb/images/chatgpt-icon-512x512.png
- https://images.ctfassets.net/kftzwdyauwt9/3M8rPrJsENQL5tjaDzo6SL/f0f85c8e27090123c767ac3c8237b401/Blossom_Dark.svg
- https://images.ctfassets.net/kftzwdyauwt9/3hUGLn3ypllZ0oa01qOYVq/28e8188e6f11b84c3e876569d492734f/Blossom_Light.svg (OpenAI's own Contentful CDN, embedded on openai.com/brand)

**Not downloaded:**
- The official logo package is https://cdn.openai.com/brand/openai-logos.zip. On https://openai.com/brand/ it sits behind a checkbox, "By using our logos, you agree to our Marks usage terms". I did not tick the box or fetch the zip, because that would accept OpenAI's terms on Wen's behalf. Wen has to tick it and download the package himself.
- The partnership templates are at https://cdn.openai.com/brand/OpenAI-Partnership-Templates-2025.zip. They were not needed.
- The full design guidelines at brand.openai.com require a login.

**Guideline URL:** https://openai.com/brand/ (sections Logo, Blossom, How to use our Logos, Non-partnerships, API Developers, Usage terms)

**Rules:**
- **Allowed use:** Use the logo only where it directly relates to OpenAI services. Use it exactly as provided, and acknowledge that OpenAI owns it.
- **Permission:** The page says not to use the logo "without permission or outside OpenAI's terms". Permission requests go to partnercomms@openai.com. Co-branded material must be approved by both brands.
- **Endorsement and prominence:**
  - Do not imply endorsement or sponsorship.
  - Do not show OpenAI's marks more prominently than your own.
  - Your product's own name, logo and tagline must stay free of OpenAI brands.
- **Wording:**
  - Non-partners may not say "collaborated with", "worked with" or "partnered with".
  - "Building on OpenAI" is the example the page approves.
  - "Works with ChatGPT" is not listed either way, but it reads close to the forbidden phrasing. Prefer "Connect ChatGPT" or "Use with ChatGPT".
- **Colors:** Do not add colors to the Blossom. The official variants are black and white only.
- **Clear space:** Use the prescribed spacing and lots of open space. The exact value is in the gated package.
- **Minimum size:** Not stated on the public page.
- **Background:** Do not place the Blossom over a busy image.
- **Symbol without wordmark:** The Blossom may appear alone, but not as "primary branding". The wordmark must not be used together with the Blossom.
- **Revocation:** OpenAI may withdraw permission at any time.

**Verdict: needs permission** for the mark, because the page says "Don't use the logo without permission". Plain-text "ChatGPT" is OK now.

## 4. Codex (OpenAI)

**Files saved:** `codex/codex-page-favicon-openai-blossom.svg`. It is byte-identical to ChatGPT's favicon, the OpenAI Blossom.

**Source URL:** https://chatgpt.com/cdn/assets/favicon-c80e01a96037.svg, the icon of https://chatgpt.com/codex.

**Own mark?** OpenAI publishes no separate Codex logo. Both https://openai.com/codex/ and https://chatgpt.com/codex show the Blossom, with the alt text "ChatGPT logo". A Codex desktop app icon exists, but I found no official download for it. Only third-party copies turned up (toolradar, LobeHub, cdnlogo), and I did not download those. The file that stands for Codex is therefore the Blossom, with "Codex" written beside it as text.

**Guideline URL:** https://openai.com/brand/

**Rules:** Same as ChatGPT. Also note that the brand page bans model names in app titles. This does not affect a Connect list.

**Verdict: needs permission** for the mark. Plain-text "Codex" is OK now.

## 5. Gemini app (Google)

**Files saved:**
- `gemini/gemini_sparkle_aurora.svg`: the full-color Gemini spark, vector, 192 viewBox.
- `gemini/gemini_sparkle_4g_512_lt.png`: the same spark, 512x512, for light backgrounds.

**Source URLs:** both are served as gemini.google.com's own icons.
- https://www.gstatic.com/lamda/images/gemini_sparkle_aurora_33f86dc0c0257da337c63.svg
- https://www.gstatic.com/lamda/images/gemini_sparkle_4g_512_lt_f94943af3be039176192d.png. This is the site's `<link rel=icon>` and apple-touch-icon.

**No public press kit:**
- Gemini's brand guidelines and assets are at https://partnermarketinghub.withgoogle.com/brands/google-gemini/brand-introduction/, which needs an approved partner login.
- The Google Workspace branding ZIP that includes a Gemini icon is licensed for internal company communications only, so I did not download it.

**Guideline URLs:**
- https://partnermarketinghub.withgoogle.com/brands/google/trademarks-and-terms/ (general rules)
- https://partnermarketinghub.withgoogle.com/brands/google/trademarks-and-terms/terms-and-conditions/
- https://partnermarketinghub.withgoogle.com/support/faq/

**Rules:**
- **Permission:** The FAQ lists websites among the uses that need permission. Request it at support.google.com/contact/partner_brand_approval.
- **Notice:** Approved uses must carry a notice that the marks are "trademarks or distinctive brand features of Google LLC."
- **Endorsement and prominence:**
  - The use must not imply a relationship with Google, or Google's sponsorship or endorsement.
  - A Google mark must not be the most prominent element on your page.
- **Colors:** Use only Google-approved artwork, with no changes.
- **Clear space:** Follows Google's clear-space guidelines, which are behind the login.
- **Minimum size:** Not public.
- **Background:** Not stated publicly.
- **Symbol without wordmark:** Not stated publicly. The spark is the app's own icon.

**Verdict: needs permission.** Plain-text "Gemini" is OK now.

## 6. Antigravity (Google)

**Files saved** in `antigravity/`, each as SVG and PNG:
- Icon: `antigravity-icon__full-color` (540x540 PNG), `antigravity-icon__one-color` (fill #202124, for light backgrounds), `antigravity-icon__white` (for dark backgrounds)
- Lockups: `antigravity_product_lockup_full_color` (for light backgrounds) and `antigravity_product_lockup_full_color_reverse` (for dark backgrounds)
- Wordmark: `antigravity_wordmark_horz__full-color-white-text`
- `Google-Antigravity-Press-Kit.zip`: the official bundle, holding the same 12 files. It was kept zipped, since the loose files above are identical.

**Source URLs:**
- Press page: https://antigravity.google/press
- Individual files: `https://antigravity.google/assets/image/brand/<name>.svg|.png`
- Zip: https://antigravity.google/assets/image/brand/Google-Antigravity-Press-Kit.zip

**Guideline URL:**
- The press page offers files only, with no usage text, even though the site's nav calls it "Press Guidelines".
- Google's general rules therefore apply: https://partnermarketinghub.withgoogle.com/brands/google/trademarks-and-terms/ and the FAQ above.

**Rules:**
- Same as Gemini: permission is needed for website use, approved artwork only, no alteration, no implied endorsement, not the most prominent element, and the Google LLC trademark notice.
- Light and dark variants are supplied, so pick the one that matches the background rather than recoloring.
- No clear-space or minimum-size figure is published.

**Verdict: needs permission.** Plain-text "Antigravity" is OK now.

## 7. Grok (xAI, now SpaceXSI)

**Files saved:**
- `grok/Grok_Logomark_Dark.svg`: fill #0A0A0A, for light backgrounds.
- `grok/Grok_Logomark_Light.svg`: white, for dark backgrounds.
- Both were extracted unchanged from the official zip, with SHA-256 checked against the archive copy.
- The zip also contains Grok wordmarks, full lockups and SpaceXSI logos, which were not extracted.

**Source URL:**
- https://data.x.ai/logos/SpaceXAI_Grok_Assets.zip, linked as "Download Logos" on the guidelines page.
- data.x.ai blocks curl with a 403, so the zip was fetched through the browser and only the two logomark SVGs were saved.

**Guideline URL:** https://x.ai/legal/brand-guidelines (dated February 14, 2025, branded SpaceXSI)

**Rules:**
- **Allowed use:** You may use the marks to accurately refer to xAI or Grok, as long as you follow the guidelines and make any changes xAI asks for after a review.
- **Logos:** Logos must be used "exactly as provided at the download link", with no alteration.
- **Forbidden:**
  - Implying endorsement, approval or sponsorship.
  - Using the marks in an app title, domain or product name.
  - Using them in or as part of your own marks.
  - Putting anything so close to the mark that it looks like a new mark. Keep the "Grok" label clearly separate.
- **Revocation:** xAI may revoke permission at any time.
- **Press:** Contact legal@x.ai before mentioning xAI in press materials.
- **Colors:** Only the supplied black and white variants exist.
- **Clear space and minimum size:** Not stated.
- **Background:** Use Dark on light backgrounds and Light on dark ones.
- **Symbol without wordmark:** Allowed. The logomark is supplied as its own file.

**Verdict: OK to show the official mark** on a compatibility page, unaltered, under the usage terms. The page must not imply that xAI endorses Clyde.

## Decision, 2026-11-16

Wen chose to show every app's official mark on Clyde's pages: Claude Spark (Claude and Claude Code), the OpenAI Blossom
favicon (ChatGPT and Codex, it switches light and dark itself), the Gemini sparkle, the Antigravity icon and Grok's
logomark, unaltered, from the files listed above. If an owner asks for removal, take its file out of
`memory/proxy/public/_clyde/apps/` and its entry out of `APP_LOGO`, and the row falls back to the name alone.
