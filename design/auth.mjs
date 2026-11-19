// Sign-in providers on Clyde's pages: the consent page at memory.heyclyde.me/oauth/consent and the workspace sign-in at
// heyclyde.me. Each mark is the provider's own, unaltered (see APP-LOGOS.md, "Sign-in providers"). Style them with
// auth.css. The button text follows Google's and GitHub's wording: "Continue with Google", "Continue with GitHub".

/** The identity providers Clyde can offer, in the order the buttons show. Supabase Auth runs both. */
export const AUTH_PROVIDERS = ["google", "github"];

export const PROVIDER_NAME = { google: "Google", github: "GitHub" };

export const PROVIDER_MARK = {
  google: `<svg viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62Z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.33A9 9 0 0 0 9 18Z"/><path fill="#FBBC05" d="M3.97 10.71A5.4 5.4 0 0 1 3.69 9c0-.6.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.04l3.01-2.33Z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"/></svg>`,
  github: `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`,
};

/** Only the providers Clyde knows, once each, in AUTH_PROVIDERS order. Anything else in the list is dropped. */
export function knownProviders(list) {
  const want = new Set(Array.isArray(list) ? list : []);
  return AUTH_PROVIDERS.filter((p) => want.has(p));
}

/** One provider button. As a link, href must already be escaped for an attribute. Without href it's a button that
 * carries data-provider, for a page script to start the sign-in. */
export function providerButton(provider, href = "") {
  const inner = `${PROVIDER_MARK[provider]}<span>Continue with ${PROVIDER_NAME[provider]}</span>`;
  return href
    ? `<a class="cl-btn cl-btn--lg cl-btn--block cl-btn--provider" href="${href}">${inner}</a>`
    : `<button type="button" class="cl-btn cl-btn--lg cl-btn--block cl-btn--provider" data-provider="${provider}">${inner}</button>`;
}

/** The rule between the provider buttons and the email form. */
export const OR_RULE = `<div class="cl-or-rule"><span>or with email</span></div>`;

/** The providers' buttons and the rule under them that leads to the email form. Empty when none are on. */
export function providerBlock(providers, hrefFor = null) {
  const list = knownProviders(providers);
  if (!list.length) return "";
  return `<div class="cl-auth-providers">${list.map((p) => providerButton(p, hrefFor ? hrefFor(p) : "")).join("")}</div>${OR_RULE}`;
}
