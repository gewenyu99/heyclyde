// The knobs. Ranking values were tuned on the train split only (eval/retrieval_eval.py --split train). hybrid held 91%
// on train for k 5 to 10 and vector weight 1 to 3, so these sit mid-plateau. Demoting drafts cost hybrid a hit, so only
// index does it.
const env = (name: string, fallback: string) => Deno.env.get(name) ?? fallback;
const num = (name: string, fallback: number) => Number(Deno.env.get(name) ?? fallback);

export const config = {
  databaseUrl: env("SUPABASE_DB_URL", "postgresql://postgres:postgres@localhost:54322/postgres"),
  // Arms a new session can draw. Phase 0 serves index and hybrid. spreading and hindsight join in Phase 1.
  arms: env("MEMORY_ARMS", "index,hybrid").split(",").map((s) => s.trim()).filter(Boolean),
  embedModel: env("EMBED_MODEL", "text-embedding-3-large"),
  embedDim: 1024,
  packetItems: 8,
  packetTokens: 1500,
  candidates: 50,
  rrfK: num("MEMORY_RRF_K", 10),
  vecWeight: num("MEMORY_VEC_WEIGHT", 1.5),
  indexDraftFactor: num("MEMORY_INDEX_DRAFT_FACTOR", 0.5),
  // A scoped recall multiplies its own scope's scores by this, so a run's handoff notes lead the packet.
  scopeBoost: num("MEMORY_SCOPE_BOOST", 3),
};
