// Parameter sets (R32). Every ranking knob lives in a memory.param_set row, and recall reads the row of the set it serves.
// A set is immutable, so "hybrid.v1" always means the same ranking, and every set carries every knob: a child names only
// what it changes, and the API fills in the rest from its parent. The v1 sets hold the constants the code used to.
import type { Sql } from "./db.ts";
import {
  ParamError,
  type Params as CoreParams,
  type ParamSet as CoreParamSet,
  resolveParams as resolveCoreParams,
  SPREAD,
  spreadKnobs,
} from "./core/params.ts";

export type Params = Omit<CoreParams, "tempOwnerConfirm"> & { tempWenConfirm?: number; tempOwnerConfirm?: number };
export type ParamSet = { id: string; arm: string; params: Params };
export { ParamError, SPREAD, spreadKnobs };

/** `overrides` laid over `base`, or on their own when there's no base, then checked: every knob present, a number in its
 * range, and nothing that isn't a knob. */
export function resolveParams(base: Params | null, overrides: unknown): Params {
  const out = resolveCoreParams(base as CoreParams | null, overrides, { confirmKey: "tempWenConfirm" }) as Record<string, unknown>;
  const raw = overrides as Record<string, unknown> | null;
  if (raw && typeof raw === "object" && !("tempOwnerConfirm" in raw) && !(base && "tempOwnerConfirm" in base)) {
    delete out.tempOwnerConfirm;
  }
  return out as Params;
}

// A set never changes, so an isolate keeps each one it has read for good.
const known = new Map<string, ParamSet>();

/** Drop a cached set. Only an import that restores a backup over a migration-seeded set changes one. */
export const forgetParamSet = (id: string) => void known.delete(id);

/** The set with this id. Throws ParamError when there is none. */
export async function paramSet(db: Sql, id: string): Promise<ParamSet> {
  const hit = known.get(id);
  if (hit) return hit;
  const [row] = await db`select id, arm, params from memory.param_set where id = ${id}`;
  if (!row) throw new ParamError(`No parameter set ${id}.`);
  const set = { id: row.id as string, arm: row.arm as string, params: row.params as Params };
  known.set(id, set);
  return set;
}
