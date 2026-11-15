// What the deployment sets. Every ranking knob lives in a parameter set (params.ts, memory.param_set), changed by data and
// not by a deploy. The v1 sets hold the values tuned on the train split only (eval/retrieval_eval.py --split train):
// hybrid held 91% on train for k 5 to 10 and vector weight 1 to 3, so they sit mid-plateau.
const env = (name: string, fallback: string) => Deno.env.get(name) ?? fallback;
const num = (name: string, fallback: number) => Number(Deno.env.get(name) ?? fallback);

export const config = {
  databaseUrl: env("SUPABASE_DB_URL", "postgresql://postgres:postgres@localhost:54322/postgres"),
  // The arms a new session draws among, each on its v1 set, while memory.allocation has no serving rows. Once it has, the
  // allocation decides and this is ignored.
  arms: env("MEMORY_ARMS", "index,hybrid").split(",").map((s) => s.trim()).filter(Boolean),
  embedModel: env("EMBED_MODEL", "text-embedding-3-large"),
  embedDim: 1024,
  // A client whose version stamp is older than this many days, and behind the server, is told to rerun the installer.
  clientCutoffDays: num("MEMORY_CLIENT_CUTOFF_DAYS", 30),
  // How long an owner's plan and access are cached per instance (R38): a revoke or refund reaches every instance within it.
  entitlementTtlMs: num("MEMORY_ENTITLEMENT_TTL_MS", 60_000),
};
