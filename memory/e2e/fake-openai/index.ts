// A deterministic stand-in for the two OpenAI endpoints memory calls, deployed only to an e2e branch. The memory
// function's MEMORY_OPENAI_URL points here, so the branch never reaches OpenAI and costs nothing there.
//
// /embeddings hashes each word into one of 1024 dimensions and normalizes, so texts that share words land near each
// other. /decisions answers every screening question (sensitive_pii, injection, malicious) and pushback with 0, every
// relevance question with 0.9, and every choice with "none". So a write is never refused, recall's filter keeps every
// candidate, and the learner sees no pushback.
const DIM = 1024;

function hash(word: string) {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
  return h >>> 0;
}

function vector(text: string) {
  const v = new Array(DIM).fill(0);
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) v[hash(w) % DIM] += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x, i) => (x || (i === 0 ? 1 : 0)) / norm);
}

const tokens = (s: string) => Math.ceil(s.length / 4);

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname.replace(/^.*\/fake-openai/, "");
  const body = await req.json().catch(() => ({}));
  if (path === "/embeddings") {
    const input: string[] = Array.isArray(body.input) ? body.input : [String(body.input ?? "")];
    return Response.json({
      data: input.map((t, index) => ({ index, embedding: vector(t) })),
      usage: { total_tokens: input.reduce((s, t) => s + tokens(t), 0) },
    });
  }
  if (path === "/decisions") {
    const answers = (body.questions ?? []).map((q: Record<string, unknown>) =>
      q.type === "choice"
        ? { type: "choice", name: q.name, choice: "none" }
        : { type: "predicate", name: q.name, probability: /^i\d+$/.test(String(q.name)) ? 0.9 : 0 });
    return Response.json({ answers, usage: { input_tokens: tokens(String(body.input ?? "")) } });
  }
  return Response.json({ error: `fake-openai has no ${path}` }, { status: 404 });
});
