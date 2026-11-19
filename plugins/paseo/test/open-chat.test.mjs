import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import contribute from "../index.server.ts";

function makeEnv(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "clyde-open-chat-")));
  const prev = { ...process.env };
  Object.assign(process.env, { CLYDE_HOME: dir, CLYDE_CONFIG_DIR: dir, PASEO_HOME: dir });
  t.after(() => {
    for (const key of ["CLYDE_HOME", "CLYDE_CONFIG_DIR", "PASEO_HOME"]) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("clyde.open-chat resolves live origin, reattaches archived runs, falls back to worker/project chat, and handles threads", async (t) => {
  const dir = makeEnv(t);
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir, { recursive: true });
  const runs = new Map();
  const threads = [];
  const parentPosts = [];
  let return404ForParent = false;

  const daemon = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") {
      if (req.url === "/threads") return res.end(JSON.stringify(threads));
      if (req.url?.startsWith("/threads/")) {
        const id = decodeURIComponent(req.url.slice("/threads/".length));
        const th = threads.find((x) => x.id === id);
        if (!th) { res.statusCode = 404; return res.end(JSON.stringify({ error: "No thread" })); }
        return res.end(JSON.stringify(th));
      }
      if (req.url === "/runs") return res.end(JSON.stringify([...runs.values()]));
      if (req.url?.startsWith("/runs/")) {
        const id = decodeURIComponent(req.url.slice("/runs/".length));
        const r = runs.get(id);
        if (!r) { res.statusCode = 404; return res.end(JSON.stringify({ error: "No run" })); }
        return res.end(JSON.stringify(r));
      }
    }
    if (req.method === "POST" && req.url?.endsWith("/parent")) {
      const id = decodeURIComponent(req.url.split("/")[2]);
      parentPosts.push({ id, body });
      if (return404ForParent) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: "Not found" }));
      }
      const r = runs.get(id);
      if (r) r.paseoParentId = body.paseoParentId;
      return res.end(JSON.stringify(r ?? {}));
    }
    res.end("{}");
  });
  await new Promise((r) => daemon.listen(0, "127.0.0.1", r));
  t.after(() => {
    daemon.closeAllConnections();
    return new Promise((r) => daemon.close(r));
  });
  writeFileSync(join(dir, "daemon.json"), JSON.stringify({ port: daemon.address().port, token: "tok" }));

  const chatRunsFile = join(dir, "chat-runs.json");
  writeFileSync(chatRunsFile, JSON.stringify({
    "r-quest": {
      agent: "archived-origin",
      job: { quest: 7, brief: "b", criterion: "c", title: "Quest 7", cwd: repoDir },
    },
  }));

  const rpc = new Map();
  const teardown = contribute({ handle: (c, fn) => rpc.set(c.name, fn), addHook: () => {} });
  t.after(() => teardown());
  const openChat = rpc.get("clyde.open-chat");

  const timelineAppends = [];
  const createdAgents = [];
  let agentEntries = [
    { agent: { id: "origin-1", title: "Origin", provider: "claude", workspaceId: "ws-1", cwd: repoDir, updatedAt: "2026-11-19T01:00:00Z", labels: {}, metadata: {} } },
    { agent: { id: "archived-origin", title: "Gone", provider: "antigravity", workspaceId: "ws-1", cwd: repoDir, archivedAt: "2026-11-19T02:00:00Z", updatedAt: "2026-11-19T02:00:00Z", labels: {}, metadata: {} } },
    { agent: { id: "live-chat-1", title: "Older chat", provider: "codex", workspaceId: "ws-1", cwd: repoDir, updatedAt: "2026-11-19T03:00:00Z", labels: {}, metadata: {} } },
    { agent: { id: "live-chat-2", title: "Newer chat", provider: "claude", workspaceId: "ws-1", cwd: repoDir, updatedAt: "2026-11-19T04:00:00Z", labels: {}, metadata: {} } },
  ];
  let workspaces = [{ id: "ws-1", projectId: "p1", workspaceDirectory: repoDir }];
  const paseo = {
    projects: { list: async () => ({ projects: [{ projectId: "p1", projectDisplayName: "Repo", projectRootPath: repoDir, projectKind: "git" }] }) },
    workspaces: {
      list: async () => ({ entries: workspaces }),
      ref: (wsId) => ({
        agents: {
          create: async (opts) => {
            const id = "created-chat-" + (createdAgents.length + 1);
            createdAgents.push({ wsId, ...opts });
            agentEntries.push({
              agent: { id, title: opts.title, provider: "claude", workspaceId: wsId, cwd: repoDir, updatedAt: "2026-11-19T05:00:00Z", labels: {}, metadata: {} },
            });
            return { id };
          },
        },
      }),
    },
    providers: {
      snapshot: async () => ({
        entries: [{ provider: "claude", status: "ready", enabled: true, models: [{ id: "claude-sonnet-4-5", isDefault: true }] }],
      }),
    },
    agents: {
      list: async () => ({ entries: agentEntries, pageInfo: { hasMore: false } }),
      ref: (id) => ({
        timeline: {
          append: async (item) => { timelineAppends.push({ agentId: id, item }); },
        },
      }),
    },
  };

  // 1. Live originating chat: returns origin-1, appends open ask card, no /parent or agent create.
  runs.set("r-live", {
    id: "r-live",
    title: "Live task",
    status: "asking",
    repo: repoDir,
    paseoParentId: "origin-1",
    asks: [{ key: "plan:1", kind: "approve", question: "Approve this plan?" }],
    stages: [],
    createdAt: "2026-11-19T01:00:00Z",
    updatedAt: "2026-11-19T01:00:00Z",
  });
  const res1 = await openChat({ kind: "run", id: "r-live" }, { paseo });
  assert.deepEqual(res1, { agentId: "origin-1" });
  assert.equal(parentPosts.length, 0);
  assert.equal(createdAgents.length, 0);
  assert.ok(timelineAppends.some((x) => x.agentId === "origin-1" && x.item.data.kind === "approval" && x.item.data.run === "r-live"));

  // 2. Archived originating chat with open project chat: picks live-chat-2, updates chat-runs.json, posts /parent, appends ask + reattach notice.
  timelineAppends.length = 0;
  runs.set("r-archived", {
    id: "r-archived",
    title: "Archived origin task",
    status: "asking",
    repo: repoDir,
    paseoParentId: "archived-origin",
    asks: [{ key: "plan:provider:19", kind: "provider", question: "The originating Paseo agent is unavailable." }],
    stages: [],
    createdAt: "2026-11-19T02:00:00Z",
    updatedAt: "2026-11-19T02:00:00Z",
  });
  const res2 = await openChat({ kind: "run", id: "r-archived" }, { paseo });
  assert.deepEqual(res2, { agentId: "live-chat-2", created: false });
  assert.deepEqual(parentPosts.at(-1), { id: "r-archived", body: { paseoParentId: "live-chat-2" } });
  assert.equal(JSON.parse(readFileSync(chatRunsFile, "utf8"))["r-archived"].agent, "live-chat-2");
  assert.ok(timelineAppends.some((x) => x.agentId === "live-chat-2" && x.item.data.kind === "approval" && x.item.data.run === "r-archived"));
  assert.ok(timelineAppends.some((x) => x.agentId === "live-chat-2" && x.item.data.kind === "notice" && x.item.data.text.includes("Attached Clyde task r-archived")));

  // 3. Quest-owned run with archived origin AND daemon returning 404 on /parent: resolves live project chat, preserves quest origin in chat-runs.json.
  return404ForParent = true;
  runs.set("r-quest", {
    id: "r-quest",
    title: "Quest 7",
    status: "asking",
    repo: repoDir,
    paseoParentId: "archived-origin",
    asks: [{ key: "task:limit:1", kind: "limit", question: "Quota hit" }],
    stages: [],
    createdAt: "2026-11-19T02:30:00Z",
    updatedAt: "2026-11-19T02:30:00Z",
  });
  const res3 = await openChat({ kind: "run", id: "r-quest" }, { paseo });
  assert.deepEqual(res3, { agentId: "live-chat-2", created: false });
  assert.equal(JSON.parse(readFileSync(chatRunsFile, "utf8"))["r-quest"].agent, "archived-origin");
  return404ForParent = false;

  // 4. Failed run with live origin: appends Task failed notice and returns origin-1.
  timelineAppends.length = 0;
  runs.set("r-failed", {
    id: "r-failed",
    title: "Broken build",
    status: "failed",
    error: "Tests exited 1\nstack trace",
    repo: repoDir,
    paseoParentId: "origin-1",
    asks: [],
    stages: [],
    createdAt: "2026-11-19T03:00:00Z",
    updatedAt: "2026-11-19T03:00:00Z",
  });
  const res4 = await openChat({ kind: "run", id: "r-failed" }, { paseo });
  assert.deepEqual(res4, { agentId: "origin-1" });
  assert.ok(timelineAppends.some((x) => x.agentId === "origin-1" && x.item.data.kind === "notice" && x.item.data.text === "Task failed · Broken build (r-failed): Tests exited 1"));

  // 5. Archived originating chat with zero open project chats: auto-creates a chat and posts /parent.
  agentEntries = agentEntries.filter((e) => e.agent.id === "archived-origin");
  const res5 = await openChat({ kind: "run", id: "r-archived" }, { paseo });
  assert.deepEqual(res5, { agentId: "created-chat-1", created: true });
  assert.equal(createdAgents.length, 1);
  assert.deepEqual(parentPosts.at(-1), { id: "r-archived", body: { paseoParentId: "created-chat-1" } });

  // 6. Standalone thread: returns live mirrored/parent agent, otherwise falls back to project chat.
  threads.push(
    { id: "t-live", title: "Live thread", cwd: repoDir, paseoParentId: "created-chat-1", status: "idle", rung: { backend: "codex" }, turns: [], createdAt: "", updatedAt: "" },
    { id: "t-dead", title: "Fallback thread", cwd: repoDir, paseoParentId: "archived-origin", status: "failed", rung: { backend: "codex" }, turns: [], createdAt: "", updatedAt: "" },
    { id: "t-orphan", title: "Orphan thread", cwd: join(dir, "unknown-repo"), paseoParentId: "archived-origin", status: "failed", rung: { backend: "codex" }, turns: [], createdAt: "", updatedAt: "" },
  );
  assert.deepEqual(await openChat({ kind: "thread", id: "t-live" }, { paseo }), { agentId: "created-chat-1" });
  assert.deepEqual(await openChat({ kind: "thread", id: "t-dead" }, { paseo }), { agentId: "created-chat-1", created: false });

  // 7. Unmatched path with no live agent or project rejects clearly.
  await assert.rejects(
    openChat({ kind: "thread", id: "t-orphan" }, { paseo }),
    /Could not find or open a chat for this task/,
  );
});
