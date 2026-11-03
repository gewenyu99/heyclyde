// Two versions, one for each thing that can change under a client. Both are a date and a serial, YYYYMMDD.N. No Deno
// APIs here, so the tests import this file under node.
//
// CLIENT_VERSION covers the client files computers update themselves from: client/memory-hook, install.sh, the two hook
// configs and the public key. A computer whose hook is behind it replaces them. SERVER_VERSION covers the MCP tools and
// the server instructions, which every client reads fresh at initialize, so editing a tool description needs no update
// on any computer and bumps only this one.
//
// Each is pinned to the hash of its surface: version.test.ts fails unless the surface on disk hashes to the entry for the
// current version, no two versions share a hash, and no entry that main already has changed. After a bump, add an entry
// with the hash the failing test prints. deploy.sh runs that guard before it deploys.
export const CLIENT_VERSION = "20261102.1";
export const SERVER_VERSION = "20261103.1";

/** Every client version that was released, oldest first, with the day it was. A client is expired only when it is behind
 * a version released more than the cutoff ago, so a new release can never expire a client on the day it ships.
 * Add the new CLIENT_VERSION here in the same change that bumps it. */
export const CLIENT_RELEASES: { version: string; released: string }[] = [
  { version: "20261102.1", released: "2026-11-02" },
];

/** SHA-256 of the client files at each client version: `{ "20261102.1": "<hash>" }`. Entries are never edited or removed. */
export const CLIENT_SURFACE_HASHES: Record<string, string> = {
  "20261102.1": "70276f9bf6b6cc030f83e7e46afdc3b02abd42973615d249c433f40415ec89cb",
};

/** SHA-256 of the MCP tools and server instructions at each server version. Entries are never edited or removed. */
export const SERVER_SURFACE_HASHES: Record<string, string> = {
  "20261102.1": "3939a99db140e32c8c8771ac7d36472cedfbd0e26ca075e709881c5e315895eb",
  "20261103.1": "f9f639d4b34c74d0d72724a7b9f5562187298de3b3dfe9d7897215ef09469e42",
};

/** What a rerun of the installer fixes: it replaces a hook too old to update itself or one that can't, and keeps the
 * device token. */
const UPDATE_NOTE = "memory: this computer's client is out of date. Rerun `curl -fsSL https://memory.heyclyde.me/install | sh`, " +
  "which needs no new sign-in.";

// current: at the newest client version or newer, or a checkout's unstamped "dev". behind: older, but not by a release
// past the cutoff, so it updates itself. expired: behind a version released more than the cutoff ago. unknown: sent no
// version, or a bad one.
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

/** Where a client stands. A client is expired when some release newer than it came out more than cutoffDays ago, which
 * is a measure of how long it has had to update, not of how old its own stamp is. */
export function clientStatus(
  client: string | null | undefined,
  cutoffDays: number,
  now = new Date(),
  releases = CLIENT_RELEASES,
  latest = CLIENT_VERSION,
): ClientStatus {
  if (client === "dev") return "current";
  if (!parseVersion(client)) return "unknown";
  if (compareVersions(client!, latest) >= 0) return "current";
  const stale = releases.some((r) =>
    compareVersions(r.version, client!) > 0 && (now.getTime() - Date.parse(`${r.released}T00:00:00Z`)) / DAY_MS > cutoffDays
  );
  return stale ? "expired" : "behind";
}

/** The rerun-the-installer line for a client, or "". It goes to a client that sent no version (a hook from before
 * self-update, which can't print its own line or fix itself), and to one that is expired and reports its update failed.
 * An expired client whose update hasn't failed may yet update on its own, so it hears nothing. */
export function installerNote(status: ClientStatus, updateFailed: boolean): string {
  return status === "unknown" || (status === "expired" && updateFailed) ? UPDATE_NOTE : "";
}
