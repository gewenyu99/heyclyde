import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pickWranglerProvider, wrangler } from "../server/wrangler.ts";

test("wrangler picks Hydrogen/Sonnet, launches in full-access mode, injects DAG + wrangling tools, and scopes messaging to the run", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "clyde-wrangler-")));
  const prevHome = process.env.CLYDE_HOME;
  process.env.CLYDE_HOME = dir;
  t.after(() => {
    if (prevHome === undefined) delete process.env.CLYDE_HOME;
    else process.env.CLYDE_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  });

  const posts = [];
  const run = {
    id: "r-aaaa1111",
    title: "Refactor memory hooks",
    flow: "ship",
    status: "running",
    cwd: dir,
    repo: dir,
    branch: "clyde/r-aaaa1111",
    paseoParentId: "lead-agent-1",
    plan: { intent: "Refactor hooks cleanly", slices: [{ id: "s1", title: "Update hooks" }] },
    stages: [{ name: "plan", status: "running", attempts: [{ n: 1, threadId: "t-worker-1", rung: { backend: "claude" } }] }],
  };
  const threads = [
    { id: "t-worker-1", runId: run.id, stage: "plan", title: "Plan worker", status: "running", rung: { backend: "claude" }, paseoAgentId: "worker-agent-1", progress: "Reading files" },
  ];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === `/runs/${run.id}`) return res.end(JSON.stringify(run));
    if (req.method === "GET" && req.url === "/threads") return res.end(JSON.stringify(threads));
    if (req.method === "POST") {
      posts.push({ url: req.url, body });
      return res.end(JSON.stringify({ ok: true }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  writeFileSync(join(dir, "daemon.json"), JSON.stringify({ port: server.address().port, token: "tok" }));

  const rpc = new Map();
  const hooks = new Map();
  wrangler({ handle: (def, fn) => rpc.set(def.name, fn), addHook: (name, fn) => hooks.set(name, fn) });

  const created = [];
  const sentMessages = [];
  const existingAgents = [];
  const paseo = {
    providers: {
      snapshot: async () => ({
        entries: [
          { provider: "antigravity", status: "ready", enabled: true, models: [{ id: "gemini-4-neon-high" }, { id: "gemini-4-hydrogen-medium" }] },
          { provider: "claude", status: "ready", enabled: true, models: [{ id: "claude-sonnet-5-5" }] },
        ],
      }),
    },
    workspaces: {
      list: async () => ({ entries: [{ id: "ws-1", workspaceDirectory: dir }] }),
      ref: () => ({
        agents: {
          create: async (opts) => {
            const id = "wrangler-agent-1";
            created.push(opts);
            existingAgents.push({ id, provider: "antigravity", model: "gemini-4-hydrogen-medium", labels: opts.labels, cwd: dir });
            return { id };
          },
        },
      }),
    },
    agents: {
      list: async () => ({ entries: existingAgents.map((agent) => ({ agent })), pageInfo: { hasMore: false } }),
      ref: (id) => ({
        send: async (text) => { sentMessages.push({ id, text }); },
        timeline: {
          refetch: async () => ({
            entries: [
              { item: { type: "user_message", text: "Check hooks" } },
              { item: { type: "assistant_message", text: "Inspecting residents.ts" } },
            ],
          }),
        },
      }),
    },
  };

  assert.equal(await pickWranglerProvider(paseo, dir), "antigravity/gemini-4-hydrogen-medium");

  const first = await rpc.get("clyde.wrangler")({ runId: run.id }, { paseo });
  assert.deepEqual(first, { agentId: "wrangler-agent-1", model: "antigravity/gemini-4-hydrogen-medium", created: true });
  assert.equal(created[0].config.modeId, "full-access");
  assert.equal(created[0].labels["clyde.wrangler"], run.id);

  // Second call reuses the live wrangler agent instead of creating another one.
  const second = await rpc.get("clyde.wrangler")({ runId: run.id }, { paseo });
  assert.equal(second.agentId, "wrangler-agent-1");
  assert.equal(second.created, false);
  assert.equal(created.length, 1);

  // agent.open.before injects the 6 wrangling tools for wrangler agents and skips non-wranglers.
  const openHook = hooks.get("agent.open.before");
  assert.equal(await openHook({ request: { purpose: "interactive", labels: {}, tools: [] } }), undefined);
  const opened = await openHook({ request: { purpose: "interactive", labels: { "clyde.wrangler": run.id }, tools: [] } });
  const toolMap = new Map(opened.tools.map((tool) => [tool.name, tool]));
  assert.ok(toolMap.has("clyde_run_snapshot"));
  assert.ok(toolMap.has("clyde_steer_run"));
  assert.ok(toolMap.has("clyde_message_agent"));
  assert.ok(toolMap.has("clyde_edit_plan"));

  const ctx = { agent: { labels: { "clyde.wrangler": run.id } }, paseo };
  const snap = JSON.parse((await toolMap.get("clyde_run_snapshot").execute({}, ctx)).text);
  assert.equal(snap.run.id, run.id);
  assert.equal(snap.activeWorkerChat.agentId, "worker-agent-1");
  assert.equal(snap.activeWorkerChat.recent[1].text, "Inspecting residents.ts");
  assert.equal(snap.leadChat.agentId, "lead-agent-1");

  await toolMap.get("clyde_steer_run").execute({ text: "Focus on unit tests first" }, ctx);
  assert.deepEqual(posts.at(-1), { url: `/runs/${run.id}/steer`, body: { text: "Focus on unit tests first" } });

  await toolMap.get("clyde_message_agent").execute({ text: "Skip linting for now" }, ctx);
  assert.deepEqual(sentMessages.at(-1), { id: "worker-agent-1", text: "Skip linting for now" });

  await assert.rejects(
    toolMap.get("clyde_message_agent").execute({ agentId: "foreign-agent", text: "nope" }, ctx),
    /does not belong to this run/,
  );
});
