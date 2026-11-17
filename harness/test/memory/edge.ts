/**
 * Tier 3 support: the memory function's entry under plain deno. The Supabase runtime gives the function
 * EdgeRuntime.waitUntil for work that outlives the response, and deno has none, so /embeddings/sync would throw. Here
 * that work just runs on. The import comes after the global, since the function reads it on every call.
 */
;(globalThis as any).EdgeRuntime = { waitUntil: (p: Promise<unknown>) => void p.catch((e) => console.error('waitUntil:', e)) }
await import('../../../memory/supabase/functions/memory/index.ts')
