// Where Clyde isn't offered (#42, Wen 2026-11-02): the EU and EEA, the UK and Switzerland, to stay out of GDPR, UK GDPR and
// the FADP, and Quebec until Law 25's impact assessment and transfer agreement exist. Only this file reads the list. The
// sign-up check (oauth.ts), the tool-call refusal and checkout (billing/entitlement.ts, billing/checkout.ts) and the webhook
// check (billing/webhooks.ts) all ask isBlocked(). No provider is given it as a checkout restriction: Polar's checkout API
// takes none, so a VPN past the sign-up check is caught by the billing country at the webhook.
export type Regions = { countries: ReadonlySet<string>; regions: ReadonlySet<string> };

export const BLOCKED_REGIONS: Regions = Object.freeze({
  countries: new Set([
    // EU 27
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
    "PL", "PT", "RO", "SK", "SI", "ES", "SE",
    // EEA
    "IS", "LI", "NO",
    "GB", "CH",
  ]),
  regions: new Set(["CA-QC"]),
});

// Cloudflare's codes for an unknown country and for Tor. Neither tells where someone is, so neither gets in.
const UNKNOWN = new Set(["XX", "T1"]);

export const REFUSAL = "Clyde isn't available in your country.";

/** Whether a country (ISO 3166-1 alpha-2) and its subdivision are blocked. The subdivision may be bare (QC), or
 * prefixed (CA-QC), the way Cloudflare's CF-Region-Code and a provider's billing state each give it. A missing country
 * is not blocked: only a request that came through the proxy, or a provider's billing address, has one. `unknown` says
 * whether XX and T1 count as blocked, which they do for a proxied request. */
export function isBlocked(country: string | null | undefined, region?: string | null, unknown = false) {
  const list = BLOCKED_REGIONS;
  const c = (country ?? "").trim().toUpperCase();
  if (!c) return false;
  if (UNKNOWN.has(c)) return unknown;
  if (list.countries.has(c)) return true;
  const r = (region ?? "").trim().toUpperCase();
  if (!r) return false;
  return list.regions.has(r.includes("-") ? r : `${c}-${r}`);
}
