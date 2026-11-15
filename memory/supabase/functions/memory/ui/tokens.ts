// R67: the design tokens the cards use, as CSS custom properties. These are placeholders in R46's names (memory/proxy/pages.js)
// until the design system lands memory/design/tokens.css. Then this string becomes that file's text, word for word:
// ui.test.ts fails while the two differ, so the tokens drop in with one paste. The function can't read files outside its
// folder once deployed, which is why the CSS lives in a string here.
//
// Light is the default. The host's theme sets data-theme on <html>, and without one the system's colour scheme decides.
export const TOKENS_CSS = `:root{color-scheme:light;--bg:#f4f4f1;--bg-2:#eef0ec;--surface:#fff;--border:#e4e5e0;--text:#20211f;--muted:#777a75;
--accent:#2f5fd0;--accent-soft:#eaf1ff;--on-accent:#fff;--ok:#1f8a45;--ok-soft:#e8f6ec;--bad:#b91c1c;--bad-soft:#fde8e8;
--warn:#c86a12;--warn-soft:#fff1e2;--code:#f8f9f6;--brand:#262825;--on-brand:#fff;--shadow:0 1px 2px #1c1c1a08,0 8px 24px -14px #1c1c1a24;
--radius:12px;--radius-sm:8px;--font:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Roboto,"Helvetica Neue",Arial,sans-serif;
--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
:root[data-theme=dark]{color-scheme:dark;--bg:#171816;--bg-2:#2a2c28;--surface:#1f201e;--border:#30322e;--text:#ecece6;
--muted:#9a9d96;--accent:#7ea0f0;--accent-soft:#1f2b47;--on-accent:#11141c;--ok:#5cc486;--ok-soft:#173222;--bad:#f08a8a;
--bad-soft:#3d1c1c;--warn:#e39a52;--warn-soft:#3a2714;--code:#191a18;--brand:#ecece6;--on-brand:#1f201e;--shadow:0 1px 2px #0000004d,0 12px 32px -16px #00000099}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--bg:#171816;--bg-2:#2a2c28;--surface:#1f201e;
--border:#30322e;--text:#ecece6;--muted:#9a9d96;--accent:#7ea0f0;--accent-soft:#1f2b47;--on-accent:#11141c;--ok:#5cc486;--ok-soft:#173222;
--bad:#f08a8a;--bad-soft:#3d1c1c;--warn:#e39a52;--warn-soft:#3a2714;--code:#191a18;--brand:#ecece6;--on-brand:#1f201e;
--shadow:0 1px 2px #0000004d,0 12px 32px -16px #00000099}}
`;
