import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import contribute from "../index.server.ts";
import { activity } from "../server/activity.ts";
import { agentCall } from "../server/connection.ts";
import { call, resolveCompanionBin } from "../server/daemon.ts";
import { inferContext, projectSlug, residents } from "../server/residents.ts";
import { home, task } from "../server/shape.ts";

function makeEnv(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "clyde-q44-")));
  const prev = { ...process.env };
  Object.assign(process.env, { CLYDE_HOME: dir, CLYDE_CONFIG_DIR: dir, PASEO_HOME: dir });
  t.after(() => {
    for (const key of ["CLYDE_HOME", "CLYDE_CONFIG_DIR", "PASEO_HOME", "PATH"]) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("connection gives friendly error without config, falls back without server-id, and keys sessions by provider & context", async (t) => {
  const dir = makeEnv(t);
  await assert.rejects(
    agentCall({ id: "a-missing", project: "owner/repo", role: "Dev", provider: "codex" }, "check_messages", {}),
    /Clyde isn't connected on this machine/,
  );

  const registerCalls = [];
  let sessionSeq = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (body.method === "initialize") {
      res.setHeader("mcp-session-id", "sess-" + ++sessionSeq);
      return res.end(JSON.stringify({ result: {} }));
    }
    if (body.params?.name === "register_agent") {
      registerCalls.push(body.params.arguments);
    }
    res.end(JSON.stringify({ result: { content: [{ text: "ok" }] } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));

  const port = server.address().port;
  writeFileSync(join(dir, "url"), `http://127.0.0.1:${port}`);
  writeFileSync(join(dir, "token"), "tok-q44");
  // Intentionally omit PASEO_HOME/server-id.
  await agentCall({ id: "agent-switch", project: "owner/repo", role: "Dev", provider: "claude", context: "work" }, "check_messages", {});
  await agentCall({ id: "agent-switch", project: "owner/repo", role: "Dev", provider: "codex", context: "personal" }, "check_messages", {});
  assert.equal(registerCalls.length, 2);
  assert.deepEqual([registerCalls[0].harness, registerCalls[0].context], ["claude", "work"]);
  assert.deepEqual([registerCalls[1].harness, registerCalls[1].context], ["codex", "personal"]);
});

test("daemon resolves bundled companion binary and recovers from cold start via recover hook", async (t) => {
  const dir = makeEnv(t);
  const bin = resolveCompanionBin();
  assert.ok(bin && bin.endsWith("runtime/bin/clyde.ts"), `unexpected bin ${bin}`);

  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([]));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));

  const recovered = await call("GET", "/threads", undefined, {
    recover: async () => {
      writeFileSync(join(dir, "daemon.json"), JSON.stringify({ port: server.address().port, token: "t" }));
    },
  });
  assert.deepEqual(recovered, []);
});

test("residents skip rules on background/child agents, filter turn.after by turnId, infer slugs/contexts, and abandon failed launches", async (t) => {
  const dir = makeEnv(t);
  assert.equal(projectSlug("/tmp/---"), "local");
  assert.equal(inferContext({ role: "Home pantry planner" }), "home");
  assert.equal(inferContext({ role: "Personal journal" }), "personal");
  assert.equal(inferContext({ areas: ["music", "guitar"] }), "hobby");
  assert.equal(inferContext({ role: "Backend engineer" }), "work");

  const feedbackSent = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/mcp") {
      if (body.method === "initialize") {
        res.setHeader("mcp-session-id", "s1");
        return res.end(JSON.stringify({ result: {} }));
      }
      if (body.params?.name === "feedback") feedbackSent.push(body.params.arguments);
      return res.end(JSON.stringify({ result: { content: [{ text: "Logged." }] } }));
    }
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;
  writeFileSync(join(dir, "url"), `http://127.0.0.1:${port}`);
  writeFileSync(join(dir, "token"), "tok");
  writeFileSync(join(dir, "server-id"), "srv");

  const hooks = new Map();
  const rpc = new Map();
  const timelineAppends = [];
  const plugin = residents({
    handle: (c, fn) => rpc.set(c.name, fn),
    addHook: (name, fn) => hooks.set(name, fn),
  });
  t.after(() => plugin.close());

  // 1. agent.create.before skips rules on background / child / labeled / companion-env helpers.
  for (const cfg of [
    { internal: true, systemPrompt: "sys" },
    { background: true, systemPrompt: "sys" },
    { parentAgentId: "parent-1", systemPrompt: "sys" },
    { labels: { "clyde.run": "r-1" }, systemPrompt: "sys" },
  ]) {
    const out = await hooks.get("agent.create.before")({ request: { config: cfg, metadata: {} } });
    assert.equal(out.config.systemPrompt, "sys", `must not inject rules into ${JSON.stringify(cfg)}`);
    assert.equal(out.metadata["clyde.internal"], true);
  }
  for (const env of [{ CLYDE_THREAD_ID: "th-1" }, { CLYDE_RUN_ID: "run-1" }]) {
    const out = await hooks.get("agent.create.before")({ request: { config: { systemPrompt: "sys" }, env, metadata: {} } });
    assert.equal(out.config.systemPrompt, "sys", `must not inject rules into ${JSON.stringify(env)}`);
    assert.equal(out.metadata["clyde.internal"], true);
  }
  const mainOut = await hooks.get("agent.create.before")({ request: { config: { systemPrompt: "sys" }, metadata: {} } });
  assert.match(mainOut.config.systemPrompt, /clyde_recall/);

  // 2. agent.turn.after ignores null turnId and only reads entries matching turnId.
  const chatAgent = {
    id: "chat-turn",
    cwd: dir,
    title: "Chat",
    provider: "codex",
    status: "idle",
    workspaceId: "w1",
  };
  await hooks.get("agent.open.before")({
    request: { agentId: chatAgent.id, cwd: dir, provider: "codex", purpose: "interactive", tools: [], env: {}, background: false, labels: {}, metadata: {} },
  }, {
    paseo: {
      agents: {
        ref: () => ({
          timeline: {
            append: async (x) => timelineAppends.push(x),
            refetch: async () => ({
              entries: [
                { turnId: "t-old", item: { type: "tool_call", status: "completed", name: "mcp__clyde__feedback", detail: { retrieval_id: "r-old", entries: [{ entry_id: "e1", verdict: "used" }] } } },
                { turnId: "t-cur", item: { type: "tool_call", status: "completed", name: "mcp__clyde__feedback", detail: { retrieval_id: "r-cur", entries: [{ entry_id: "e2", verdict: "used" }] } } },
              ],
            }),
          },
        }),
      },
    },
  });
  await hooks.get("agent.turn.after")({ agent: chatAgent, turnId: null }, { paseo: { agents: { ref: () => ({ timeline: { append: async () => {} } }) } } });
  assert.equal(feedbackSent.length, 0);
  await hooks.get("agent.turn.after")({ agent: chatAgent, turnId: "t-cur" }, {
    paseo: {
      agents: {
        ref: () => ({
          timeline: {
            append: async (x) => timelineAppends.push(x),
            refetch: async () => ({
              entries: [
                { turnId: "t-old", item: { type: "tool_call", status: "completed", name: "mcp__clyde__feedback", detail: { type: "unknown", input: { retrieval_id: "r-old", entries: [{ entry_id: "e1", verdict: "used" }] }, output: "Logged." } } },
                { turnId: "t-cur", item: { type: "tool_call", status: "completed", name: "mcp__clyde__feedback", detail: { type: "unknown", input: { retrieval_id: "r-cur", entries: [{ entry_id: "e2", verdict: "used" }] }, output: "Logged." } } },
              ],
            }),
          },
        }),
      },
    },
  });
  assert.equal(timelineAppends.some((x) => x.id === "recall-r-old"), false);
  const recallUsed = JSON.parse(readFileSync(join(dir, "recall-used.json"), "utf8"));
  const usedValues = Object.values(recallUsed).flat();
  assert.ok(usedValues.includes("e2"), "turn t-cur note usage recorded in recall-used.json");
  assert.ok(!usedValues.includes("e1"), "earlier turn t-old usage must not be recorded");

  // 3. Repeated launch failures back off, abandon quest at 3 tries, and honor failedQuests high-priority cooldown.
  const abandoned = [];
  const claimed = [];
  let peeks = 0;
  writeFileSync(join(dir, "residents.json"), JSON.stringify({
    res1: {
      id: "res1",
      title: "Codex chat",
      profileVersion: 1,
      cwd: dir,
      provider: "codex",
      project: "owner/repo",
      role: "Dev",
      areas: ["backend"],
      confirmed: true,
      paused: false,
      passed: [],
      memory: "Best effort",
      offer: { id: 99, title: "Fail launch", brief: "b", done_when: "d", priority: "high", assignment: "assign-99", run: null },
    },
  }));
  // Restart plugin reading pre-seeded failing offer and pointed daemon port that returns 500 on POST /runs.
  const badDaemon = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") { res.statusCode = 404; return res.end("{}"); }
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "boom" }));
  });
  await new Promise((r) => badDaemon.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => badDaemon.close(r)));
  const questSrv = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (body.method === "initialize") {
      res.setHeader("mcp-session-id", "s2");
      return res.end(JSON.stringify({ result: {} }));
    }
    const tool = body.params?.name;
    if (tool === "dispatch_quest") {
      const action = body.params.arguments.action;
      if (action === "peek") {
        peeks++;
        const offer = abandoned.length === 0
          ? { id: 99, title: "Fail", brief: "b", done_when: "d", priority: "high", assignment: "assign-99", run: "r-assign-99" }
          : { id: 99, title: "Fail", brief: "b", done_when: "d", priority: "high", assignment: null, run: null };
        return res.end(JSON.stringify({ result: { content: [{ text: JSON.stringify(offer) }] } }));
      }
      if (action === "claim") claimed.push(body.params.arguments);
      return res.end(JSON.stringify({ result: { content: [{ text: "null" }] } }));
    }
    if (tool === "abandon_quest") abandoned.push(body.params.arguments);
    res.end(JSON.stringify({ result: { content: [{ text: "ok" }] } }));
  });
  await new Promise((r) => questSrv.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => questSrv.close(r)));
  writeFileSync(join(dir, "daemon.json"), JSON.stringify({ port: badDaemon.address().port, token: "d" }));
  writeFileSync(join(dir, "url"), `http://127.0.0.1:${questSrv.address().port}`);
  const rpc2 = new Map();
  const plugin2 = residents({ handle: (c, fn) => rpc2.set(c.name, fn), addHook: () => {} });
  t.after(() => plugin2.close());
  const mockPaseo = {
    agents: {
      list: async () => ({ entries: [{ agent: { id: "res1", cwd: dir, provider: "codex", status: "idle", labels: {}, metadata: {} } }], pageInfo: { hasMore: false } }),
      ref: () => ({ refresh: async () => {}, current: () => ({ id: "res1", cwd: dir, provider: "codex", status: "idle", labels: {}, metadata: {} }) }),
    },
  };
  await rpc2.get("clyde.roster")({}, { paseo: mockPaseo });
  // Trigger failure 1, verify immediate retry is held by exponential backoff, then advance Date clock for failures 2 and 3.
  t.mock.timers.enable({ apis: ["Date"] });
  try {
    await rpc2.get("clyde.resident")({ id: "res1", action: "resume" }, { paseo: mockPaseo });
    const after1 = JSON.parse(readFileSync(join(dir, "residents.json"), "utf8"));
    assert.equal(after1.res1.launchFailures, 1);
    const peeksBeforeHold = peeks;
    await rpc2.get("clyde.resident")({ id: "res1", action: "resume" }, { paseo: mockPaseo });
    assert.equal(peeks, peeksBeforeHold, "backoff blocks immediate spin retry");

    t.mock.timers.tick(10_000);
    await rpc2.get("clyde.resident")({ id: "res1", action: "resume" }, { paseo: mockPaseo });
    const after2 = JSON.parse(readFileSync(join(dir, "residents.json"), "utf8"));
    assert.equal(after2.res1.launchFailures, 2);

    t.mock.timers.tick(20_000);
    await rpc2.get("clyde.resident")({ id: "res1", action: "resume" }, { paseo: mockPaseo });

    const saved = JSON.parse(readFileSync(join(dir, "residents.json"), "utf8"));
    assert.equal(saved.res1.offer, undefined, "failed offer cleared after abandon");
    assert.equal(saved.res1.paused, false, "transient launch errors do not permanently pause resident");
    assert.ok(saved.res1.failedQuests["99"] > Date.now(), "failedQuests cooldown set for abandoned quest");

    t.mock.timers.tick(11_000);
    await rpc2.get("clyde.resident")({ id: "res1", action: "resume" }, { paseo: mockPaseo });
    assert.equal(claimed.length, 0, "failedQuests blocks reclaiming high-priority quest during cooldown");
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(abandoned.length, 1);
  assert.match(abandoned[0].reason, /Repeated launch failure/);
  assert.ok(peeks >= 3);

  // Optional handoff returns empty string when recall fails for background context lookups.
  const brokenUrl = `http://127.0.0.1:${badDaemon.address().port}`;
  writeFileSync(join(dir, "url"), brokenUrl);
  const optNotes = await plugin2.context("res1", "check optional handoff", mockPaseo);
  assert.equal(optNotes, "");
});

test("activity skips duplicate remember on resident-managed runs and passes project_slug on manual quests", async (t) => {
  const dir = makeEnv(t);
  const remembers = [];
  const runs = [{
    id: "r-res",
    title: "Resident run",
    status: "done",
    asks: [],
    stages: [{ summary: "done" }],
  }, {
    id: "r-manual",
    title: "Manual quest",
    status: "done",
    asks: [],
    stages: [{ summary: "done" }],
  }];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/mcp") {
      if (body.method === "initialize") { res.setHeader("mcp-session-id", "sm"); return res.end("{}"); }
      if (body.params?.name === "remember") {
        remembers.push(body.params.arguments);
        return res.end(JSON.stringify({ result: { content: [{ text: "Remembered note-1." }] } }));
      }
      if (body.params?.name === "list_quests") {
        return res.end(JSON.stringify({
          result: {
            content: [{ text: "1" }],
            _meta: { "clyde/card": { quests: [{ id: 50, title: "Manual", brief: "b", done_when: "d", priority: "normal" }] } },
          },
        }));
      }
      return res.end(JSON.stringify({ result: { content: [{ text: "OK" }] } }));
    }
    if (req.url === "/runs") return res.end(JSON.stringify(runs));
    if (req.url === "/runs/r-manual") { res.statusCode = 404; return res.end("{}"); }
    res.end(JSON.stringify(runs[1]));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;
  writeFileSync(join(dir, "url"), `http://127.0.0.1:${port}`);
  writeFileSync(join(dir, "token"), "tok");
  writeFileSync(join(dir, "server-id"), "srv");
  writeFileSync(join(dir, "daemon.json"), JSON.stringify({ port, token: "d" }));
  writeFileSync(join(dir, "chat-runs.json"), JSON.stringify({
    "r-res": { agent: "owner", managedByResident: true },
    "r-manual": { agent: "owner", job: { quest: 50, title: "Manual", brief: "b", criterion: "d", cwd: dir, confirmed: true } },
  }));
  const handlers = new Map();
  t.mock.timers.enable({ apis: ["setInterval"] });
  const act = activity(
    { handle: (c, fn) => handlers.set(c.name, fn) },
    (id) => (id === "owner" ? { id: "owner", role: "Dev", provider: "codex", project: "owner/repo", cwd: dir } : undefined),
  );
  t.after(() => act.close());
  await assert.rejects(
    handlers.get("clyde.spawn-quest")({ agent: "missing", quest: 50 }, { paseo: { agents: { ref: () => ({ timeline: { append: async () => {} } }) } } }),
    /Open the project chat/,
  );
  t.mock.timers.tick(10_000);
  t.mock.timers.reset();
  // Give the async HTTP tick a moment to finish completing r-manual and skipping r-res.
  const deadline = Date.now() + 3_000;
  while (remembers.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(remembers.length, 1, "only manual quest writes remember note; resident-managed run skipped");
  assert.equal(remembers[0].project_slug, "owner/repo");
  assert.equal(remembers[0].title, "Manual");
});

test("shape exposes pullRequest, unifies isPlanApproval, and excludes archived background threads", () => {
  const threads = [
    { id: "t-bg-live", title: "worker", status: "running", runId: "r-1", stage: "task", createdAt: "2026-11-18T00:00:00Z", updatedAt: "2026-11-18T00:01:00Z", turns: [], rung: { backend: "codex" } },
    { id: "t-bg-arch", title: "old", status: "running", archivedAt: "2026-11-18T00:02:00Z", runId: "r-1", stage: "task", createdAt: "2026-11-18T00:00:00Z", updatedAt: "2026-11-18T00:01:00Z", turns: [], rung: { backend: "codex" } },
  ];
  const runs = [{
    id: "r-1",
    flow: "ship",
    title: "Feature",
    status: "asking",
    pullRequest: "https://github.com/owner/repo/pull/42",
    asks: [{ key: "audit:1", kind: "approve", question: "Resolve these audit findings", askedAt: "2026-11-18T00:01:00Z" }],
    stages: [{ name: "task", status: "asking", startedAt: "2026-11-18T00:00:00Z", attempts: [{ n: 1, threadId: "t-bg-live", startedAt: "2026-11-18T00:00:00Z", rung: { backend: "codex" } }] }],
    createdAt: "2026-11-18T00:00:00Z",
    updatedAt: "2026-11-18T00:01:00Z",
  }];
  const h = home(threads, runs, {}, 1);
  assert.equal(h.tasks[0].pullRequest, "https://github.com/owner/repo/pull/42");
  assert.equal(h.needsYou[0].approve, false, "non-plan approve ask is false in home");
  assert.equal(h.background, 1, "archived background thread excluded from home background");
  const tv = task(runs[0], threads, {});
  assert.equal(tv.pullRequest, "https://github.com/owner/repo/pull/42");
  assert.equal(tv.approve, false, "non-plan approve ask matches home in task");
  assert.equal(tv.background, 1, "archived background thread excluded from task background");
});

test("server RPCs paginate agents, return per-project chats, and encode daemon path parameters", async (t) => {
  const dir = makeEnv(t);
  const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    res.setHeader("content-type", "application/json");
    if (req.url === "/runs" || req.url === "/threads") return res.end("[]");
    res.end(JSON.stringify({ id: "r-1", flow: "task", title: "T", status: "running", stages: [], createdAt: "2026-11-18T00:00:00Z", updatedAt: "2026-11-18T00:00:00Z" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  writeFileSync(join(dir, "daemon.json"), JSON.stringify({ port: server.address().port, token: "d" }));

  const rpc = new Map();
  const teardown = contribute({
    handle: (c, fn) => rpc.set(c.name, fn),
    addHook: () => {},
  });
  t.after(() => teardown());

  const page1 = [
    { agent: { id: "chat-1", title: "First chat", provider: "codex", workspaceId: "ws-1", cwd: dir, updatedAt: "2026-11-18T01:00:00Z", labels: {}, metadata: {} } },
    { agent: { id: "helper", title: "worker", background: true, provider: "codex", workspaceId: "ws-1", cwd: dir, updatedAt: "2026-11-18T03:00:00Z", labels: {}, metadata: {} } },
  ];
  const page2 = [
    { agent: { id: "chat-2", title: "Second chat", provider: "claude", workspaceId: "ws-1", cwd: dir, updatedAt: "2026-11-18T02:00:00Z", labels: {}, metadata: {} } },
  ];
  const paseo = {
    projects: { list: async () => ({ projects: [{ projectId: "p1", projectDisplayName: "HeyClyde", projectRootPath: dir, projectKind: "git" }] }) },
    workspaces: { list: async () => ({ entries: [{ id: "ws-1", projectId: "p1", workspaceDirectory: dir }] }) },
    agents: {
      list: async ({ page }) => ({
        entries: page?.cursor === "p2" ? page2 : page1,
        pageInfo: page?.cursor === "p2" ? { hasMore: false, nextCursor: null } : { hasMore: true, nextCursor: "p2" },
      }),
    },
  };
  const projects = await rpc.get("clyde.projects")({}, { paseo });
  assert.equal(projects.length, 1);
  assert.deepEqual(projects[0].chats.map((c) => c.id), ["chat-2", "chat-1"]);

  await rpc.get("clyde.task")({ kind: "run", id: "id/with space" }, { paseo });
  await rpc.get("clyde.stop")({ kind: "thread", id: "thr/1?x" }, { paseo });
  assert.ok(paths.includes("/runs/id%2Fwith%20space"));
  assert.ok(paths.includes("/threads/thr%2F1%3Fx/stop"));
});

test("launchRpc picks the newest chat by default, honors explicit agentId, and auto-creates a chat when none are open", async (t) => {
  const dir = makeEnv(t);
  const posted = [];
  const createdAgents = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/runs/") && req.method === "GET") {
      res.statusCode = 404;
      return res.end("{}");
    }
    if (req.url === "/runs" && req.method === "POST") {
      posted.push(body);
      return res.end(JSON.stringify({ id: "r-" + posted.length }));
    }
    if (req.url === "/mcp") {
      if (body.method === "initialize") { res.setHeader("mcp-session-id", "s-launch"); return res.end("{}"); }
      return res.end(JSON.stringify({
        result: {
          content: [{ text: "retrieval ret-1" }],
          _meta: { "clyde/card": { retrieval_id: "ret-1", items: [] } },
        },
      }));
    }
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;
  writeFileSync(join(dir, "daemon.json"), JSON.stringify({ port, token: "d" }));
  writeFileSync(join(dir, "url"), `http://127.0.0.1:${port}`);
  writeFileSync(join(dir, "token"), "tok");

  const rpc = new Map();
  const teardown = contribute({ handle: (c, fn) => rpc.set(c.name, fn), addHook: () => {} });
  t.after(() => teardown());
  const launch = rpc.get("clyde.launch");

  let projectChats = [
    { agent: { id: "older-chat", title: "Older", provider: "claude", workspaceId: "ws-1", cwd: dir, updatedAt: "2026-11-18T01:00:00Z", labels: {}, metadata: {} } },
    { agent: { id: "newer-chat", title: "Newer", provider: "codex", workspaceId: "ws-1", cwd: dir, updatedAt: "2026-11-18T03:00:00Z", labels: {}, metadata: {} } },
  ];
  let wsList = [{ id: "ws-1", projectId: "p1", workspaceDirectory: dir }];
  const agentSnapshot = (id) => ({ id, title: "Auto chat", provider: "antigravity", workspaceId: "ws-1", cwd: dir, labels: {}, metadata: {} });

  const paseo = {
    projects: { list: async () => ({ projects: [{ projectId: "p1", projectDisplayName: "HeyClyde", projectRootPath: dir, projectKind: "git" }] }) },
    workspaces: {
      list: async () => ({ entries: wsList }),
      ref: (wsId) => ({
        agents: {
          create: async (opts) => {
            const id = "ws-created-" + (createdAgents.length + 1);
            createdAgents.push({ via: "workspace", wsId, ...opts });
            projectChats.push({ agent: agentSnapshot(id) });
            return { id };
          },
        },
      }),
    },
    providers: {
      snapshot: async () => ({
        entries: [
          { provider: "claude", status: "ready", enabled: true, models: [{ id: "claude-sonnet-4-5", isDefault: true }] },
          { provider: "antigravity", status: "ready", enabled: true, models: [{ id: "gemini-pro", isDefault: true }] },
        ],
      }),
    },
    agents: {
      list: async () => ({ entries: projectChats, pageInfo: { hasMore: false } }),
      ref: (id) => {
        const snap = projectChats.find((e) => e.agent.id === id)?.agent ?? null;
        return {
          refresh: async () => ({ agent: snap }),
          current: () => snap,
          timeline: { append: async () => {} },
        };
      },
      create: async (opts) => {
        const id = "direct-created-" + (createdAgents.length + 1);
        createdAgents.push({ via: "agents", ...opts });
        projectChats.push({ agent: agentSnapshot(id) });
        return { id };
      },
    },
  };

  // (a) Omitted agentId selects newest open chat.
  await launch({
    project: "p1",
    prompt: "First run",
    flow: "task",
    worker: "auto",
    requestId: "11111111-1111-4111-8111-111111111111",
  }, { paseo });
  assert.equal(posted.at(-1).paseoParentId, "newer-chat");

  // (b) Explicit agentId selects that chat.
  await launch({
    project: "p1",
    prompt: "Second run",
    flow: "task",
    worker: "auto",
    agentId: "older-chat",
    requestId: "22222222-2222-4222-8222-222222222222",
  }, { paseo });
  assert.equal(posted.at(-1).paseoParentId, "older-chat");

  // (b2) Explicit newChat creates a fresh chat even when open chats already exist.
  await launch({
    project: "p1",
    prompt: "Fresh session with open chats",
    flow: "task",
    worker: "sol",
    newChat: true,
    requestId: "55555555-5555-4555-8555-555555555555",
  }, { paseo });
  assert.equal(createdAgents.at(-1).via, "workspace");
  assert.equal(createdAgents.at(-1).config.provider, "claude/claude-sonnet-4-5");
  assert.equal(posted.at(-1).paseoParentId, "ws-created-1");
  createdAgents.length = 0;

  // (c1) With 0 open chats and an active workspace, creates chat in workspace.agents.create.
  projectChats = [];
  await launch({
    project: "p1",
    prompt: "Review Clyde UI\nwith details",
    flow: "ship",
    worker: "neon",
    allowAntigravityFullAccess: true,
    requestId: "33333333-3333-4333-8333-333333333333",
  }, { paseo });
  assert.equal(createdAgents.length, 1);
  assert.equal(createdAgents[0].via, "workspace");
  assert.equal(createdAgents[0].config.provider, "antigravity/gemini-pro");
  assert.equal(createdAgents[0].title, "Review Clyde UI");
  assert.equal(posted.at(-1).paseoParentId, "ws-created-1");

  // (c2) With 0 open chats and no workspace, creates chat via paseo.agents.create.
  projectChats = [];
  wsList = [];
  await launch({
    project: "p1",
    prompt: "Start fresh workspace chat",
    flow: "task",
    worker: "auto",
    requestId: "44444444-4444-4444-8444-444444444444",
  }, { paseo });
  assert.equal(createdAgents.length, 2);
  assert.equal(createdAgents[1].via, "agents");
  assert.equal(createdAgents[1].cwd, dir);
  assert.equal(createdAgents[1].config.provider, "claude/claude-sonnet-4-5");
  assert.equal(posted.at(-1).paseoParentId, "direct-created-2");
});

test("plugin sources contain zero @getpaseo/client imports and CJS resolveCompanionBin falls back to PASEO_HOME/config.json", async (t) => {
  const dir = makeEnv(t);
  const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const walk = (target) => {
    const out = [];
    for (const entry of readdirSync(target)) {
      const full = join(target, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry)) out.push(full);
    }
    return out;
  };
  const checkedFiles = [
    join(pluginRoot, "index.server.ts"),
    join(pluginRoot, "index.client.tsx"),
    ...walk(join(pluginRoot, "server")),
    ...walk(join(pluginRoot, "client")),
    ...walk(join(pluginRoot, "shared")),
  ];
  for (const file of checkedFiles) {
    assert.equal(readFileSync(file, "utf8").includes("@getpaseo/client"), false, `unexpected @getpaseo/client in ${file}`);
  }

  // Simulate CJS bundle where import.meta.url is undefined and verify PASEO_HOME/config.json directory fallback.
  const cjsCopy = join(dir, "daemon-cjs.ts");
  const daemonSrc = readFileSync(join(pluginRoot, "server", "daemon.ts"), "utf8").replace("import.meta?.url", "undefined");
  writeFileSync(cjsCopy, daemonSrc);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ plugins: { clyde: { source: "directory", path: pluginRoot } } }));
  const { resolveCompanionBin: resolveCjs } = await import(`${cjsCopy}?t=${Date.now()}`);
  assert.equal(resolveCjs(), join(pluginRoot, "runtime", "bin", "clyde.ts"));
});

test("connection infers personal context when caller omits explicit context", async (t) => {
  const dir = makeEnv(t);
  const registerCalls = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (body.method === "initialize") {
      res.setHeader("mcp-session-id", "sess-personal");
      return res.end(JSON.stringify({ result: {} }));
    }
    if (body.params?.name === "register_agent") registerCalls.push(body.params.arguments);
    res.end(JSON.stringify({ result: { content: [{ text: "ok" }] } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  writeFileSync(join(dir, "url"), `http://127.0.0.1:${server.address().port}`);
  writeFileSync(join(dir, "token"), "tok-personal");

  await agentCall({ id: "agent-personal", project: "notes", role: "Personal journal", cwd: dir, provider: "claude" }, "check_messages", {});
  assert.equal(registerCalls.length, 1);
  assert.equal(registerCalls[0].context, "personal");
});

test("launchRpc waits for loading providers, uses listModels fallback, requires selectable models, and scopes workspaceId", async (t) => {
  const dir = makeEnv(t);
  const worktreeDir = join(dir, "wt-2");
  mkdirSync(worktreeDir, { recursive: true });
  const posted = [];
  const created = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/runs" && req.method === "POST") {
      posted.push(body);
      return res.end(JSON.stringify({ id: "run-" + body.assignment, repo: body.cwd }));
    }
    if (req.url?.startsWith("/runs/") && req.method === "GET") {
      res.statusCode = 404;
      return res.end("{}");
    }
    if (req.url === "/mcp") {
      if (body.method === "initialize") { res.setHeader("mcp-session-id", "s-pick"); return res.end("{}"); }
      return res.end(JSON.stringify({ result: { content: [{ text: "retrieval ret-p" }], _meta: { "clyde/card": { retrieval_id: "ret-p", items: [] } } } }));
    }
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;
  writeFileSync(join(dir, "daemon.json"), JSON.stringify({ port, token: "d" }));
  writeFileSync(join(dir, "url"), `http://127.0.0.1:${port}`);
  writeFileSync(join(dir, "token"), "tok");

  const rpc = new Map();
  const teardown = contribute({ handle: (c, fn) => rpc.set(c.name, fn), addHook: () => {} });
  t.after(() => teardown());
  const launch = rpc.get("clyde.launch");

  let waited = 0;
  const listedCalls = [];
  const agentsById = new Map([
    ["chat-ws1-only", { id: "chat-ws1-only", title: "WS1", provider: "claude", workspaceId: "ws-1", cwd: dir, updatedAt: "2026-11-18T05:00:00Z", labels: {}, metadata: {} }],
  ]);
  const paseo = {
    projects: { list: async () => ({ projects: [{ projectId: "p1", projectDisplayName: "HeyClyde", projectRootPath: dir, projectKind: "git" }] }) },
    workspaces: {
      list: async () => ({
        entries: [
          { id: "ws-1", projectId: "p1", workspaceDirectory: dir },
          { id: "ws-2", projectId: "p1", workspaceDirectory: worktreeDir },
        ],
      }),
      ref: (wsId) => ({
        agents: {
          create: async (opts) => {
            const id = "chat-ws-" + (created.length + 1);
            created.push({ wsId, ...opts });
            agentsById.set(id, { id, title: opts.title, provider: "claude", workspaceId: wsId, cwd: worktreeDir, labels: {}, metadata: {} });
            return { id };
          },
        },
      }),
    },
    providers: {
      snapshot: async () => ({
        entries: [{ provider: "claude", status: "loading", enabled: true }],
      }),
      waitForReady: async ({ cwd }) => {
        waited++;
        return {
          entries: [{ provider: "claude", status: "ready", enabled: true, models: [{ id: "deprecated", isSelectable: false }], cwd }],
        };
      },
      listModels: async (provider, opts) => {
        listedCalls.push({ provider, cwd: opts?.cwd });
        return { models: [{ id: "hidden-m", isSelectable: false }, { id: "claude-opus-4", isSelectable: true }] };
      },
    },
    agents: {
      list: async () => ({
        entries: [...agentsById.values()].map((agent) => ({ agent })),
        pageInfo: { hasMore: false },
      }),
      ref: (id) => ({ refresh: async () => ({ agent: agentsById.get(id) ?? null }), current: () => agentsById.get(id) ?? null, timeline: { append: async () => {} } }),
    },
  };

  await launch({
    project: "p1",
    workspaceId: "ws-2",
    prompt: "Check scoped workspace",
    flow: "task",
    worker: "auto",
    requestId: "66666666-6666-4666-8666-666666666666",
  }, { paseo });

  assert.equal(waited, 1, "waits via waitForReady when provider status is loading");
  assert.deepEqual(listedCalls, [{ provider: "claude", cwd: worktreeDir }]);
  assert.equal(created.length, 1);
  assert.equal(created[0].wsId, "ws-2");
  assert.equal(created[0].config.provider, "claude/claude-opus-4");
  assert.equal(posted.at(-1).cwd, worktreeDir);

  await assert.rejects(
    launch({
      project: "p1",
      workspaceId: "ws-other",
      prompt: "Wrong ws",
      flow: "task",
      worker: "auto",
      requestId: "77777777-7777-4777-8777-777777777777",
    }, { paseo }),
    /Workspace belongs to another project/,
  );

  // When providers have no selectable models anywhere, launch refuses cleanly instead of passing a bare provider string.
  const noSelectablePaseo = {
    ...paseo,
    providers: {
      snapshot: async () => ({ entries: [{ provider: "claude", status: "ready", enabled: true, models: [{ id: "off", isSelectable: false }] }] }),
      listModels: async () => ({ models: [{ id: "off", isSelectable: false }] }),
    },
  };
  await assert.rejects(
    launch({
      project: "p1",
      workspaceId: "ws-2",
      newChat: true,
      prompt: "No selectable model",
      flow: "task",
      worker: "auto",
      requestId: "88888888-8888-4888-8888-888888888888",
    }, { paseo: noSelectablePaseo }),
    /Could not open a project chat automatically/,
  );
});
