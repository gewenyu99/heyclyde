// Two versions, one for each thing that can change under a client. Both are a date and a serial, YYYYMMDD.N. No Deno
// APIs here, so the tests import this file under node.
//
// SERVER_VERSION also covers, since R67, what chat apps that render cards read: the card links, resources and HTML.
//
// CLIENT_VERSION covers the client files computers update themselves from: client/memory-hook, install.sh, the two hook
// configs, the public key, the Gemini CLI and Antigravity files (R45), and clyde-hook.sh with its gate shim, rule and
// Antigravity hooks (R78). A computer whose hook is behind it replaces them. SERVER_VERSION covers the MCP tools and
// the server instructions, which every client reads fresh at initialize, so editing a tool description needs no update
// on any computer and bumps only this one.
//
// Each is pinned to the hash of its surface: version.test.ts fails unless the surface on disk hashes to the entry for the
// current version, no two versions share a hash, and no entry that main already has changed. After a bump, add an entry
// with the hash the failing test prints. deploy.sh runs that guard before it deploys.
export const CLIENT_VERSION = "20261118.1";
export const SERVER_VERSION = "20261117.4";

/** Every client version that was released, oldest first, with the day it was. A client is expired only when it is behind
 * a version released more than the cutoff ago, so a new release can never expire a client on the day it ships.
 * Add the new CLIENT_VERSION here in the same change that bumps it. */
export const CLIENT_RELEASES: { version: string; released: string }[] = [
  { version: "20261102.1", released: "2026-11-02" },
  { version: "20261115.1", released: "2026-11-15" },
  { version: "20261117.1", released: "2026-11-17" },
  { version: "20261117.2", released: "2026-11-17" },
  { version: "20261117.3", released: "2026-11-17" },
  { version: "20261117.4", released: "2026-11-17" },
  { version: "20261117.5", released: "2026-11-17" },
  { version: "20261118.1", released: "2026-11-18" },
];

/** SHA-256 of the client files at each client version: `{ "20261102.1": "<hash>" }`. Entries are never edited or removed. */
export const CLIENT_SURFACE_HASHES: Record<string, string> = {
  "20261102.1": "70276f9bf6b6cc030f83e7e46afdc3b02abd42973615d249c433f40415ec89cb",
  "20261115.1": "e1224e98bff182a79adb223a3341793a8eabc0f980e963ba3605c5b1950b7ccb",
  "20261117.1": "28194dd98f0ec4cd38b26ccd8d1bf3d889173f3caafad014edecde5348067c5d",
  "20261117.2": "fe076057a1a60d3f33b26fc236d5ac9183dce56aa8eea7975b37e95f4db1af56",
  "20261117.3": "44f13bbd8d465614ddeb4e1fd7316a1b4af3143760411a6b8887a5bacffbc7c2",
  "20261117.4": "e635f223c07e1eadd0f5d3317c9260b8861da6dab0e124a6fac92cbfba1aaa70",
  "20261117.5": "212cf957d3730bd715f63b2957c98a96feb4370803b9f3d374dece5345bbfbf8",
  "20261118.1": "6fd89dc5e95afbb3f702637ad88705fd179be304f52798f74d3df6f8651af8d3",
};

/** SHA-256 of the MCP tools and server instructions at each server version. Entries are never edited or removed. */
export const SERVER_SURFACE_HASHES: Record<string, string> = {
  "20261102.1": "3939a99db140e32c8c8771ac7d36472cedfbd0e26ca075e709881c5e315895eb",
  "20261103.1": "f9f639d4b34c74d0d72724a7b9f5562187298de3b3dfe9d7897215ef09469e42",
  "20261103.2": "0b8f702e199b78808e19240efd80211e5621509e70be3ffef285c5c9214b542e",
  "20261103.3": "d931bc8fba6f779e8fece3ceb2936a07e243e242e96576a8f70e4b7a994993ed",
  "20261103.4": "21e4af40659e013adbc72dea2915b862646927957b1e2918260a429fa140e2d4",
  "20261103.5": "0851f7bd157b591987c9fdde99e16a88cb1a82e5d20f8f9a67b203c53cd72df9",
  "20261104.1": "3d7449c7158e88d770c8b285e50e1a596f5f496ded659e0ce852b03f1df7e92f",
  "20261115.1": "f4446bde0480e1f30931efaa9b25f111690b7ebbc7837953041177c70fb20942",
  "20261115.2": "ed27bbb75e5ec839eec8fc2a762d6e0d36ae46ea4c8024b04f004e97a236ff55",
  "20261115.3": "b20d400d5763709a2c339674f0370da85ac4a1443f802b8f0bf00326d9d6ecc8",
  "20261115.4": "5869e57299cb1b166ec967649248e34367be3c318dbd065deaf0291c614af5c9",
  "20261115.5": "23e3b0d085953ec2624f93b03e53ea085fb248ff5b074aadcb9b9abd9f1391ce",
  "20261115.6": "8106e8136005bbb28578b1c325710edb8878f54b7e41757c0790b01a6aaf61b3",
  "20261115.7": "72665030df87ec47d5cef22011f8481e247578d54f32973ecdc414995f6fe614",
  "20261116.1": "4d4f1bd495b287e7a002dccce212da147d84a2861bcb32c5ee82ee492122f352",
  "20261117.1": "e4b7811bc92dc400f89580000215d7569111eeb491c8ad710900d427f2af3ec5",
  "20261117.2": "b22f55adc013ff3cdc1dd9cb08b11340f350b6d9c7d5e176cb09053ad398d725",
  "20261117.3": "f7bfdd61b2914288d803570e7bd1f74ecf5ee38be6bda66973c33a9878db2620",
  "20261117.4": "37008ee09b9b5503bf155b0ca46f4086a17182f0d90290c30e976eab6ab26a23",
};

/** What a rerun of the installer fixes: it replaces a hook too old to update itself or one that can't, and keeps the
 * device token. */
const UPDATE_NOTE = "Clyde: the Clyde client on this computer is out of date. Rerun `curl -fsSL https://heyclyde.me/install | sh`, " +
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

/** True for a call from clyde-hook.sh: Python's urllib (copies from before 20261117.1) or clyde-hook/<version>. Old copies send
 * no version (they came from the docs, not the installer, and have no memory-hook to update them), so a missing version
 * from one of them is no reason to tell the person their client is out of date. */
export const fromClydeHook = (userAgent: string | null | undefined): boolean => /^(Python-urllib|clyde-hook)\//.test(userAgent ?? "");
