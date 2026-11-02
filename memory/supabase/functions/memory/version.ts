// The one version everything a client can see answers to: the MCP tools and instructions, and the files memory-hook
// self-updates from (client/). It's a date and a serial, YYYYMMDD.N. Bump it in the same change as any client-visible
// edit; harness/test/memory/version.test.ts fails when SURFACE_HASH no longer matches those, so a change can't ship
// under the old number. No Deno APIs here, so the tests import this file under node.
export const SERVER_VERSION = "20261102.1";

// SHA-256 of the tools, instructions and client files at SERVER_VERSION. After a bump, set it to what
// `deno run -A harness/test/memory/surface.ts` prints.
export const SURFACE_HASH = "3c327afeb3e9e4986b9a065ffe35f8d891fe9dbc5b192828b555bb261f5a0567";

/** What a rerun of the installer fixes: it replaces a hook too old to update itself, and keeps the device token. */
export const UPDATE_NOTE = "memory: this computer's client is out of date. Rerun `curl -fsSL https://memory.heyclyde.me/install | sh`, " +
  "which needs no new sign-in.";

// current: at the server's version or newer, or a checkout's unstamped "dev". behind: older, still inside the cutoff, so
// it updates itself. expired: older than the cutoff by its date stamp. unknown: sent no version, or a bad one.
export type ClientStatus = "current" | "behind" | "expired" | "unknown";

const VERSION = /^(\d{4})(\d{2})(\d{2})\.(\d{1,5})$/;
const DAY_MS = 86_400_000;

/** The version's date (UTC midnight) and serial, or null when it isn't YYYYMMDD.N with a real date. */
export function parseVersion(v: unknown): { date: Date; serial: number } | null {
  const m = typeof v === "string" ? VERSION.exec(v) : null;
  if (!m) return null;
  const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return date.getUTCMonth() === +m[2] - 1 && date.getUTCDate() === +m[3] ? { date, serial: +m[4] } : null;
}

/** A client header worth keeping: a real version, or the literal "dev" from a checkout's unstamped memory-hook. */
export const reportable = (v: unknown): v is string => v === "dev" || parseVersion(v) !== null;

/** Negative when a is older than b, 0 when equal, positive when newer. Both must parse. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)!, y = parseVersion(b)!;
  return x.date.getTime() - y.date.getTime() || x.serial - y.serial;
}

export function clientStatus(client: string | null | undefined, cutoffDays: number, now = new Date()): ClientStatus {
  if (client === "dev") return "current";
  const c = parseVersion(client);
  if (!c) return "unknown";
  if (compareVersions(client!, SERVER_VERSION) >= 0) return "current";
  return (now.getTime() - c.date.getTime()) / DAY_MS > cutoffDays ? "expired" : "behind";
}

/** True for a status that only a rerun of the installer can fix: the client sent no version, or it's past the cutoff. */
export const needsInstaller = (s: ClientStatus) => s === "unknown" || s === "expired";
