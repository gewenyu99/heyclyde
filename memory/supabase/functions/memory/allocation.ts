// Which parameter set serves whom (R34). A unit is hashed with a salt into one of 1000 buckets, and the buckets are laid out
// along the serving sets' weights. The unit is the scope's run id or else device, client and UTC day, never an MCP
// session, since newer protocol versions drop those. The same unit always lands on the same set, and every recall logs the
// set and its propensity (its share), so an off-policy estimate can weight it later.
import { config } from "./config.ts";
import type { Sql } from "./db.ts";
import { sha256 } from "./embed.ts";
import { type ParamSet, paramSet } from "./params.ts";

export type Role = "off" | "shadow" | "live" | "default";
export type Slot = { param_set: string; role: Role; weight: number };
export const BUCKETS = 1000;

/** The sets that take traffic, in a fixed order. off and shadow serve no one, and neither does a weight of 0. */
export const serving = (slots: Slot[]) =>
  slots.filter((s) => (s.role === "live" || s.role === "default") && s.weight > 0).sort((a, b) => (a.param_set < b.param_set ? -1 : 1));

/** What the assignment hashes: a run scope's id, or else the device, the client and the UTC day. */
export function unitOf(scope: string | null, principal: string, client: string | null, now = new Date()) {
  return scope?.startsWith("run:") ? scope : `${principal}|${client ?? ""}|${now.toISOString().slice(0, 10)}`;
}

/** 0 to 999 from the salt and the unit alone. */
export async function bucket(salt: string, unit: string) {
  return parseInt((await sha256(`${salt}\0${unit}`)).slice(0, 8), 16) % BUCKETS;
}

/** The set a unit is served and its propensity, the set's weight over the serving total. null when nothing serves. */
export async function assign(salt: string, unit: string, slots: Slot[]) {
  const live = serving(slots);
  const total = live.reduce((sum, s) => sum + s.weight, 0);
  if (!total) return null;
  const at = await bucket(salt, unit);
  let upto = 0;
  for (const s of live) {
    upto += s.weight;
    if (at < upto / total * BUCKETS) return { param_set: s.param_set, propensity: s.weight / total };
  }
  const last = live.at(-1)!;
  return { param_set: last.param_set, propensity: last.weight / total };
}

/** The allocation table and the salt. With no serving rows, MEMORY_ARMS stands in: each arm on its v1, an equal share each,
 * which is how arms were drawn before parameter sets. `explicit` says the table spoke. */
export async function allocation(db: Sql) {
  const [rows, salt] = await Promise.all([
    db`select param_set, role, weight from memory.allocation order by param_set`,
    db`select value from memory.setting where name = 'allocation_salt'`,
  ]);
  const slots = rows as unknown as Slot[];
  const explicit = serving(slots).length > 0;
  return {
    salt: (salt[0]?.value as string | undefined) ?? "", explicit,
    slots: explicit ? slots : config.arms.map((arm): Slot => ({ param_set: `${arm}.v1`, role: "default", weight: 1 })),
  };
}

/** The arms that serve now, for the health check and the console. */
export async function servingArms(db: Sql): Promise<string[]> {
  const { slots } = await allocation(db);
  const arms = new Set<string>();
  for (const s of serving(slots)) arms.add((await paramSet(db, s.param_set)).arm);
  return [...arms];
}

/** The set a session is served and the propensity of the draw that chose it. The unit is the sticky key, not the session
 * row: an unscoped HTTP recall shares one row across every device and day. The row holds a draw only for the unit it was
 * drawn for, so another unit, a new day or a row from before units draws afresh, and the row keeps the latest draw. Even
 * for its own unit, a draw stops serving once the allocation table names serving sets and its set is not among them: a
 * set set to off or 0 stops at once. */
export async function sessionSet(db: Sql, session: string, unit: string, client: string | null): Promise<{ set: ParamSet; propensity: number | null }> {
  const { salt, slots, explicit } = await allocation(db);
  const [stored] = await db`select arm, param_set, propensity, unit from memory.mcp_session where id = ${session}`;
  if (stored?.unit === unit) {
    const id = (stored.param_set as string | null) ?? `${stored.arm}.v1`;
    if (!explicit || serving(slots).some((s) => s.param_set === id)) return { set: await paramSet(db, id), propensity: stored.propensity };
  }
  const drawn = (await assign(salt, unit, slots))!;
  const set = await paramSet(db, drawn.param_set);
  await db`insert into memory.mcp_session (id, arm, client, param_set, propensity, unit)
    values (${session}, ${set.arm}, ${client}, ${set.id}, ${drawn.propensity}, ${unit})
    on conflict (id) do update set arm = excluded.arm, param_set = excluded.param_set, propensity = excluded.propensity,
      unit = excluded.unit`;
  return { set, propensity: drawn.propensity };
}
