import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteConnector } from "../src/connectors/sqlite.ts";
import { createRuntime } from "../src/runtime/app.ts";
import { defaultConfig } from "../src/runtime/config.ts";
import { startHttpServer } from "../src/server/http.ts";
import { MemoryStore } from "../src/store/memory-store.ts";

function normalizeVec(v: number[]): number[] {
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

function fakeEmbeddingFor(text: string): number[] {
  const low = text.toLowerCase();
  const v = [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05];
  if (/(sqlite|wal|locking|busy|journal|database)/.test(low)) v[0] += 3;
  if (/(connection|pool|timeout|backoff|retry)/.test(low)) v[1] += 3;
  if (/(redis|cache|eviction|ttl)/.test(low)) v[2] += 3;
  if (/(queue|worker|lease|quest)/.test(low)) v[3] += 3;
  if (/[\u4e00-\u9fff]/.test(text) || /中文|记忆|检索|缓存/.test(text)) v[4] += 3;
  if (/(security|secret|token|redact|auth)/.test(low)) v[5] += 3;
  if (/(graph|spreading|link|support)/.test(low)) v[6] += 3;
  if (/(deploy|docker|port|server)/.test(low)) v[7] += 3;
  return normalizeVec(v);
}

async function startFakeOpenAiServer() {
  let pushbackCause: string | null = null;
  let judgeScore = 1;
  let relevanceBoost = false;
  const calls = { embed: 0, chat: 0 };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const url = req.url ?? "/";
      if (url.endsWith("/embeddings")) {
        calls.embed++;
        const inputs = Array.isArray(body.input) ? body.input : [String(body.input ?? "")];
        const data = inputs.map((txt: unknown, index: number) => ({
          object: "embedding",
          index,
          embedding: fakeEmbeddingFor(String(txt)),
        }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data }));
        return;
      }
      if (url.endsWith("/chat/completions")) {
        calls.chat++;
        const sys = String(body.messages?.[0]?.content ?? "");
        const usr = String(body.messages?.[1]?.content ?? "");
        let content = "{}";
        if (sys.includes("sensitive_pii")) {
          content = JSON.stringify({ sensitive_pii: false, injection: false, malicious: false });
        } else if (sys.includes("Rate relevance")) {
          const indices = [...usr.matchAll(/^\[(\d+)\]\s+/gm)].map((m) => Number(m[1]));
          const scores = indices.map(() => (relevanceBoost ? 0.95 : judgeScore));
          content = JSON.stringify({ scores });
        } else if (sys.includes("pushes back")) {
          content = pushbackCause
            ? JSON.stringify({ pushback: true, p: 0.92, cause: pushbackCause })
            : JSON.stringify({ pushback: false, p: 0.1, cause: null });
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "fake-chat",
            choices: [{ index: 0, message: { role: "assistant", content } }],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    calls,
    setPushbackCause(id: string | null) {
      pushbackCause = id;
    },
    setJudgeScore(n: number, boost = false) {
      judgeScore = n;
      relevanceBoost = boost;
    },
    close: () => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

class McpClient {
  private readonly baseUrl: string;
  private readonly clientName: string;
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(baseUrl: string, clientName: string) {
    this.baseUrl = baseUrl;
    this.clientName = clientName;
  }

  async rpc(method: string, params: Record<string, unknown> = {}) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const res = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
    });
    assert.equal(res.status, 200, `RPC ${method} failed with ${res.status}`);
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    return (await res.json()) as { result?: Record<string, unknown>; error?: { code: number; message: string } };
  }

  async initialize() {
    const out = await this.rpc("initialize", {
      protocolVersion: "2025-03-26",
      clientInfo: { name: this.clientName, version: "1.0.0" },
    });
    assert.ok(this.sessionId);
    return out;
  }

  async call(name: string, args: Record<string, unknown> = {}) {
    const res = await this.rpc("tools/call", { name, arguments: args });
    assert.ok(!res.error, `JSON-RPC error on ${name}: ${JSON.stringify(res.error)}`);
    const result = res.result as { content?: { type: string; text: string }[]; isError?: boolean };
    return {
      text: result.content?.[0]?.text ?? "",
      isError: result.isError === true,
    };
  }

  async remember(args: Record<string, unknown>): Promise<string> {
    const out = await this.call("remember", args);
    assert.equal(out.isError, false, out.text);
    const m = out.text.match(/^Remembered ([^\s.]+)/);
    assert.ok(m, `Expected Remembered <id> in: ${out.text}`);
    return m[1];
  }

  get id(): string {
    assert.ok(this.sessionId);
    return this.sessionId;
  }
}

test("Live HTTP + all 18 MCP tools + hybrid/vector/spreading/feedback/learning + permissions + blobs + export/import", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clyde-mcp-e2e-"));
  const fakeAi = await startFakeOpenAiServer();

  const cfg = defaultConfig();
  cfg.server.host = "127.0.0.1";
  cfg.server.port = 0;
  cfg.server.ui = true;
  cfg.server.data_dir = dir;
  cfg.database.path = join(dir, "clyde.db");
  cfg.blobs.dir = join(dir, "blobs");
  cfg.auth.mode = "none";
  cfg.embeddings.provider = "openai-compatible";
  cfg.embeddings.base_url = fakeAi.baseUrl;
  cfg.embeddings.model = "fake-embed";
  cfg.embeddings.dimensions = 8;
  cfg.judge.provider = "openai-compatible";
  cfg.judge.base_url = fakeAi.baseUrl;
  cfg.judge.model = "fake-chat";
  cfg.judge.write_screen = "llm";
  cfg.judge.relevance_filter = "llm";

  const runtime = await createRuntime({ config: cfg });
  const httpServer = await startHttpServer(runtime);

  try {
    // 1. Healthz & UI shell
    const hz = await fetch(`${httpServer.url}/healthz`);
    assert.equal(hz.status, 200);
    const hzJson = (await hz.json()) as { ok: boolean; entries: number };
    assert.equal(hzJson.ok, true);

    const uiRes = await fetch(`${httpServer.url}/`);
    assert.equal(uiRes.status, 200);
    const uiHtml = await uiRes.text();
    assert.ok(uiHtml.includes("Clyde Local"));
    assert.equal(uiHtml.includes("style="), false);
    assert.ok(uiRes.headers.get("content-security-policy")?.includes("nonce-"));

    // 2. Initialize 3 agents across realms/projects/computers
    const alpha = new McpClient(httpServer.url, "alpha-cli");
    await alpha.initialize();
    const listOut = await alpha.rpc("tools/list");
    const tools = (listOut.result?.tools as { name: string }[]) ?? [];
    assert.equal(tools.length, 18);

    const regA = await alpha.call("register_agent", {
      name: "alpha",
      context: "work",
      surface: "cli",
      description: "Work coding agent",
      projects: ["proj-a"],
      strict_projects: true,
      computer: "host-a",
    });
    assert.equal(regA.isError, false, regA.text);
    assert.ok(regA.text.includes('Registered agent "alpha"'));

    const beta = new McpClient(httpServer.url, "beta-home");
    await beta.initialize();
    const regB = await beta.call("register_agent", {
      name: "beta",
      context: "personal",
      surface: "desktop",
      description: "Personal assistant agent",
      computer: "host-b",
    });
    assert.equal(regB.isError, false, regB.text);

    const gamma = new McpClient(httpServer.url, "gamma-work");
    await gamma.initialize();
    const regG = await gamma.call("register_agent", {
      name: "gamma",
      context: "work",
      surface: "cli",
      description: "Second work agent",
      projects: ["proj-b"],
      strict_projects: true,
      computer: "host-a",
    });
    assert.equal(regG.isError, false, regG.text);

    // 3. Remember entries (general, work+proj-a, CJK, linked neighbor, private sensitivity, refusals, idempotency)
    const walId = await alpha.remember({
      pattern: "decisions",
      kind: "observation",
      title: "Enable SQLite WAL mode with busy_timeout",
      body: "Local SQLite stores use WAL journal mode and 5000ms busy timeout to prevent lock errors.",
      evidence_kind: "assistant",
      evidence: "Tested concurrent writers against SQLite WAL mode.",
      context: "general",
      transferability: "general",
    });

    const mutexId = await alpha.remember({
      pattern: "references",
      kind: "observation",
      title: "Serialize async database transactions with a write mutex",
      body: "Queueing write transactions sequentially prevents contention during peak bursts.",
      evidence_kind: "summary",
      evidence: "Mutex benchmarked at 10 concurrent callers.",
      context: "general",
      transferability: "general",
      links: [{ type: "supports", to: walId }],
    });

    const projAId = await alpha.remember({
      pattern: "references",
      kind: "observation",
      title: "Project A cache eviction interval is 90 seconds",
      body: "Work service proj-a uses 90s eviction TTL.",
      evidence_kind: "summary",
      evidence: "Verified in proj-a config.",
      context: "work",
      transferability: "project",
      project_slug: "proj-a",
    });

    const zhId = await alpha.remember({
      pattern: "observations",
      kind: "observation",
      title: "中文记忆库与双字检索策略",
      body: "本地记忆检索同时支持中文双字索引与向量相似度合并。",
      evidence_kind: "assistant",
      evidence: "已通过双语召回验证。",
      context: "general",
      transferability: "general",
      lang: "zh",
    });

    const privId = await beta.remember({
      pattern: "preferences",
      kind: "observation",
      title: "Personal journal preference",
      body: "Keep private journal notes concise.",
      sensitivity: "private",
      evidence_kind: "assistant",
      evidence: "Owner asked to keep private journal concise.",
      context: "personal",
      transferability: "context",
    });

    // Refusal tests: agent explicit id is refused; quote backing a draft is refused
    const rBadExplicitId = await alpha.call("remember", {
      id: "explicit-agent-id",
      pattern: "observations",
      title: "Forbidden explicit id",
      body: "Agents may not pick ids.",
      evidence_kind: "assistant",
      evidence: "Testing validation.",
    });
    assert.equal(rBadExplicitId.isError, true);

    const rBadQuote = await alpha.call("remember", {
      pattern: "observations",
      title: "Invalid draft quote",
      body: "Should be refused.",
      evidence_kind: "quote",
      evidence: "Quoted text.",
    });
    assert.equal(rBadQuote.isError, true);

    // Duplicate idempotency: identical payload returns the same generated id
    const walDupId = await alpha.remember({
      pattern: "decisions",
      kind: "observation",
      title: "Enable SQLite WAL mode with busy_timeout",
      body: "Local SQLite stores use WAL journal mode and 5000ms busy timeout to prevent lock errors.",
      evidence_kind: "assistant",
      evidence: "Tested concurrent writers against SQLite WAL mode.",
      context: "general",
      transferability: "general",
    });
    assert.equal(walDupId, walId);

    // 4. Embedding sync + Recall (hybrid, spreading, bestfirst, CJK, recall_more)
    const syncRes = await fetch(`${httpServer.url}/embeddings/sync`, { method: "POST" });
    assert.equal(syncRes.status, 200);
    const syncJson = (await syncRes.json()) as { embedded: number };
    assert.ok(syncJson.embedded >= 4);
    assert.ok(fakeAi.calls.embed > 0);

    fakeAi.setJudgeScore(2, true);
    const recHybrid = await alpha.call("recall", {
      query: "sqlite wal database lock contention",
      task: "diagnose sqlite locking",
      scope: "hybrid",
      depth: "packet",
    });
    assert.equal(recHybrid.isError, false, recHybrid.text);
    assert.ok(recHybrid.text.includes(walId), recHybrid.text);
    const ridMatch = recHybrid.text.match(/retrieval_id="([^"]+)"/);
    assert.ok(ridMatch, `Expected retrieval_id in:\n${recHybrid.text}`);
    const rid1 = ridMatch[1];

    // Spreading scope walks support links
    const recSpread = await alpha.call("recall", {
      query: "sqlite wal lock",
      scope: "spreading",
      depth: "packet",
    });
    assert.equal(recSpread.isError, false, recSpread.text);
    assert.ok(recSpread.text.includes(walId));

    // Bestfirst scope
    const recBest = await alpha.call("recall", {
      query: "sqlite wal lock",
      scope: "bestfirst",
      depth: "deep",
    });
    assert.equal(recBest.isError, false, recBest.text);

    // Chinese query recall
    const recZh = await alpha.call("recall", {
      query: "中文记忆双字检索",
      task: "verify cjk",
    });
    assert.equal(recZh.isError, false, recZh.text);
    assert.ok(recZh.text.includes(zhId), recZh.text);

    // recall_more response
    const moreOut = await alpha.call("recall_more", { retrieval_id: rid1 });
    assert.equal(moreOut.isError, false, moreOut.text);

    // 5. Permission isolation checks
    // gamma is in 'work' with strict_projects=['proj-b'], so proj-a entry and personal entry are hidden
    const getProjAByGamma = await gamma.call("get_entry", { id: projAId });
    assert.equal(getProjAByGamma.isError, true);
    const getPrivByGamma = await gamma.call("get_entry", { id: privId });
    assert.equal(getPrivByGamma.isError, true);
    // alpha is in proj-a so alpha CAN read proj-a
    const getProjAByAlpha = await alpha.call("get_entry", { id: projAId });
    assert.equal(getProjAByAlpha.isError, false, getProjAByAlpha.text);
    assert.ok(getProjAByAlpha.text.includes("90 seconds"));
    // beta is in personal so beta CAN read priv-personal-note and CANNOT read work/proj-a
    const getPrivByBeta = await beta.call("get_entry", { id: privId });
    assert.equal(getPrivByBeta.isError, false, getPrivByBeta.text);
    const getProjAByBeta = await beta.call("get_entry", { id: projAId });
    assert.equal(getProjAByBeta.isError, true);

    // 6. Feedback + Learner cycle (confidence + co-use + pushback)
    const fbOk = await alpha.call("feedback", {
      retrieval_id: rid1,
      entries: [
        { entry_id: walId, verdict: "used" },
        { entry_id: mutexId, verdict: "used" },
      ],
      note: "Both SQLite notes helped fix WAL lock.",
    });
    assert.equal(fbOk.isError, false, fbOk.text);
    assert.ok(fbOk.text.startsWith("Logged"));

    // Duplicate feedback in same session is refused softly
    const fbDup = await alpha.call("feedback", { retrieval_id: rid1, nothing_useful: true });
    assert.equal(fbDup.isError, true);

    // Age retrieval creation so learn() processes immediately without waiting 30 minutes
    const confBeforeRows = await runtime.connector.query<{ confidence: number }>(
      "SELECT confidence FROM entry WHERE id = ?",
      [mutexId],
    );
    const confBefore = Number(confBeforeRows[0].confidence);
    const oldIso = new Date(Date.now() - 45 * 60_000).toISOString();
    await runtime.connector.execute("UPDATE retrieval SET created_at = ? WHERE id = ?", [oldIso, rid1]);

    // Link a second retrieval to a harness session and pushback via UserPromptSubmit hook
    const recPush = await beta.call("recall", { query: "sqlite lock", task: "pushback test" });
    const ridPushMatch = recPush.text.match(/retrieval_id="([^"]+)"/);
    assert.ok(ridPushMatch);
    const ridPush = ridPushMatch[1];
    await runtime.store.ensureSession(beta.id, "beta-home", "harness-beta-1", "/tmp/work");
    fakeAi.setPushbackCause(walId);
    await runtime.connector.execute("UPDATE retrieval SET created_at = ? WHERE id = ?", [
      new Date(Date.now() - 5_000).toISOString(),
      ridPush,
    ]);
    await fetch(`${httpServer.url}/hooks/UserPromptSubmit?agent=beta`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "harness-beta-1",
        prompt: "Stop telling me about SQLite WAL mode, that is wrong here.",
      }),
    });

    const learnRes = await fetch(`${httpServer.url}/learn`, { method: "POST" });
    assert.equal(learnRes.status, 200);
    const learnJson = (await learnRes.json()) as {
      learned: number;
      helpful: number;
      no_reaction: number;
      pushback: number;
    };
    assert.ok(learnJson.learned >= 2, JSON.stringify(learnJson));
    assert.ok(learnJson.no_reaction >= 1, JSON.stringify(learnJson));
    assert.ok(learnJson.pushback >= 1, JSON.stringify(learnJson));

    const confAfterRows = await runtime.connector.query<{ confidence: number }>(
      "SELECT confidence FROM entry WHERE id = ?",
      [mutexId],
    );
    assert.ok(Number(confAfterRows[0].confidence) > confBefore, "Expected confidence increase after used feedback");
    const coUse = await runtime.connector.query<{ weight: number }>(
      "SELECT weight FROM link WHERE type = 'co_used' AND ((src = ? AND dst = ?) OR (src = ? AND dst = ?))",
      [walId, mutexId, mutexId, walId],
    );
    assert.ok(coUse.length >= 1, "Expected co_used edge between co-helpful entries");

    // 7. Messages & Quests workflow (all 10 board tools)
    const msgPost = await alpha.call("post_message", { to: "gamma", body: "Please audit index latency." });
    assert.equal(msgPost.isError, false, msgPost.text);
    const gammaInbox = await gamma.call("check_messages");
    assert.ok(gammaInbox.text.includes("Please audit index latency."));
    const msgIdMatch = gammaInbox.text.match(/#(\d+)/);
    assert.ok(msgIdMatch);
    const ackOut = await gamma.call("ack_messages", { ids: [Number(msgIdMatch[1])] });
    assert.ok(ackOut.text.includes("Acknowledged 1"));

    const msgAll = await alpha.call("post_message", { to: "all", body: "Broadcast maintenance window" });
    assert.equal(msgAll.isError, false, msgAll.text);
    const betaInbox = await beta.call("check_messages");
    const betaMsgId = betaInbox.text.match(/#(\d+)/)?.[1];
    assert.ok(betaMsgId);
    const dismOut = await beta.call("dismiss_messages", { ids: [Number(betaMsgId)] });
    assert.ok(dismOut.text.includes("Dismissed 1"));

    const q1Post = await alpha.call("post_quest", {
      title: "Verify FTS5 query latency",
      brief: "Run 500 queries against local sqlite FTS5.",
      done_when: "p95 under 5ms",
      priority: "high",
      context: "work",
      tags: ["perf"],
    });
    assert.equal(q1Post.isError, false, q1Post.text);
    const q1Id = Number(q1Post.text.match(/#(\d+)/)?.[1]);
    assert.ok(q1Id > 0);

    const qList = await gamma.call("list_quests", { show: "open", tag: "perf" });
    assert.ok(qList.text.includes(`#${q1Id}`));

    const qClaim = await gamma.call("claim_quest", { id: q1Id, lease_minutes: 30 });
    assert.equal(qClaim.isError, false, qClaim.text);

    // Concurrent second claim by alpha is refused
    const qClaimConflict = await alpha.call("claim_quest", { id: q1Id });
    assert.equal(qClaimConflict.isError, true);

    const qUpdate = await gamma.call("update_quest", { id: q1Id, note: "50% benchmark complete." });
    assert.equal(qUpdate.isError, false, qUpdate.text);

    const qDone = await gamma.call("complete_quest", {
      id: q1Id,
      evidence: "Measured p95 = 1.4ms across 500 queries.",
      entry_id: walId,
    });
    assert.equal(qDone.isError, false, qDone.text);
    assert.ok(qDone.text.includes(`Completed quest #${q1Id}`));

    const q2Post = await alpha.call("post_quest", {
      title: "Temporary benchmark cleanup",
      brief: "Clean temporary files.",
      done_when: "Directory empty",
      context: "work",
    });
    const q2Id = Number(q2Post.text.match(/#(\d+)/)?.[1]);
    await gamma.call("claim_quest", { id: q2Id });
    const qAbandon = await gamma.call("abandon_quest", { id: q2Id, reason: "Reassigned" });
    assert.equal(qAbandon.isError, false, qAbandon.text);
    assert.ok(qAbandon.text.includes("open"));

    // 8. Blobs: upload_blob -> PUT -> remember -> get_blob (with pagination) -> HTTP /blobs/:sha -> refusal checks
    const longText = "line-".repeat(60) + "FINAL_MARKER";
    const bytes = Buffer.from(longText, "utf8");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const slot = await alpha.call("upload_blob", {
      sha256: sha,
      size: bytes.byteLength,
      media_type: "text/plain",
    });
    assert.equal(slot.isError, false, slot.text);
    const putUrl = slot.text.match(/https?:\/\/[^'\s]+/)?.[0];
    assert.ok(putUrl, `Missing PUT URL in ${slot.text}`);

    // Wrong byte size PUT fails cleanly
    const badPut = await fetch(putUrl, { method: "PUT", body: Buffer.from("short") });
    assert.equal(badPut.status, 400);

    const goodPut = await fetch(putUrl, { method: "PUT", body: bytes });
    assert.equal(goodPut.status, 200);

    const blobRem = await alpha.call("remember", {
      pattern: "references",
      kind: "observation",
      title: "Long log artifact entry",
      body: "Stores full benchmark output in blob artifact.",
      evidence_kind: "summary",
      evidence: "Log uploaded via upload_blob.",
      blobs: [{ name: "bench.log", kind: "data", media_type: "text/plain", sha256: sha }],
    });
    assert.equal(blobRem.isError, false, blobRem.text);
    assert.ok(blobRem.text.includes("1 artifact"));

    const page1 = await alpha.call("get_blob", { sha256: sha, offset: 0, limit: 20 });
    assert.equal(page1.isError, false, page1.text);
    assert.ok(page1.text.includes("Showing chars 0-20"));
    const pageEnd = await alpha.call("get_blob", { sha256: sha, offset: 280, limit: 100 });
    assert.ok(pageEnd.text.includes("FINAL_MARKER"));

    const httpBlob = await fetch(`${httpServer.url}/blobs/${sha}`);
    assert.equal(httpBlob.status, 200);
    assert.equal(await httpBlob.text(), longText);

    // 9. Workspace REST API CRUD + Hooks SessionStart + NDJSON Export/Import round-trip
    const hsStart = await fetch(`${httpServer.url}/hooks/SessionStart?agent=alpha`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "h-sess-1", cwd: "/tmp/demo" }),
    });
    assert.equal(hsStart.status, 200);
    assert.equal(hsStart.headers.get("x-clyde-registered"), "1");

    const notesApi = (await (await fetch(`${httpServer.url}/api/notes`)).json()) as {
      total: number;
      items: { id: string }[];
    };
    assert.ok(notesApi.total >= 5);

    const patchApi = await fetch(`${httpServer.url}/api/notes/${walId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authority: "approved" }),
    });
    assert.equal(patchApi.status, 200);

    const graphApi = (await (await fetch(`${httpServer.url}/api/graph`)).json()) as {
      nodes: unknown[];
      edges: unknown[];
    };
    assert.ok(graphApi.nodes.length >= 5 && graphApi.edges.length >= 1);

    const ndjsonRes = await fetch(`${httpServer.url}/export`);
    assert.equal(ndjsonRes.status, 200);
    const ndjson = await ndjsonRes.text();
    assert.ok(ndjson.includes(walId));

    const freshConn = new SqliteConnector({ path: ":memory:" });
    const freshRuntime = await createRuntime({
      config: { ...defaultConfig(), server: { ...defaultConfig().server, data_dir: join(dir, "fresh") } },
      connector: freshConn,
    });
    try {
      const imp = await freshRuntime.store.importNdjson(ndjson);
      assert.ok(imp.imported >= 5);
      const restored = await freshRuntime.store.getEntry(walId);
      assert.ok(restored && restored.includes("Enable SQLite WAL mode"));
      assert.ok(fakeAi.calls.chat > 0);
      assert.ok(freshRuntime.store instanceof MemoryStore);
    } finally {
      await freshRuntime.close();
    }
  } finally {
    await Promise.allSettled([httpServer.close(), runtime.close(), fakeAi.close()]);
    rmSync(dir, { recursive: true, force: true });
  }
});
