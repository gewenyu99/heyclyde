import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { residents } from "../server/residents.ts";

test("the roster lists current project chats and migrates only generated responsibilities", async t => {
  const dir = mkdtempSync(join(tmpdir(), "clyde-roster-"));
  const oldHome = process.env.CLYDE_HOME;
  const oldConfig = process.env.CLYDE_CONFIG_DIR;
  process.env.CLYDE_HOME = process.env.CLYDE_CONFIG_DIR = dir;
  t.after(() => {
    if (oldHome === undefined) delete process.env.CLYDE_HOME;
    else process.env.CLYDE_HOME = oldHome;
    if (oldConfig === undefined) delete process.env.CLYDE_CONFIG_DIR;
    else process.env.CLYDE_CONFIG_DIR = oldConfig;
    rmSync(dir, { recursive: true, force: true });
  });
  const prompt = "Hey so look at Clyde's project and design the next part of C";
  const old = {
    title: prompt, role: prompt, areas: ["hey", "look", "clyde", "project", "and", "design", "the", "next"],
    cwd: dir, provider: "codex", project: "owner/repo", confirmed: false, paused: true, passed: [7], memory: "Best effort",
  };
  const original = [
    { ...old, id: "main-001" },
    { ...old, id: "confirmed", confirmed: true },
    { ...old, id: "proposed", role: "Accessibility reviews", areas: ["ui", "accessibility"] },
    { ...old, id: "custom-tags", areas: ["design"] },
    { ...old, id: "restored", archived: true },
    { ...old, id: "stale", title: "Branch name generator" },
  ];
  const file = join(dir, "residents.json");
  writeFileSync(file, JSON.stringify(Object.fromEntries(original.map(row => [row.id, row]))));

  const rpc = new Map(), hooks = new Map();
  const plugin = residents({
    handle: (ref, fn) => rpc.set(ref.name, fn), addHook: (name, fn) => hooks.set(name, fn),
  });
  t.after(() => plugin.close());
  function chat(id, extra = {}) {
    return { id, cwd: dir, title: prompt, provider: "codex", model: "gpt-6.2-astra", status: "idle", workspaceId: "w1", ...extra };
  }
  const first = [
    chat("main-001", { status: "running" }), chat("confirmed"), chat("proposed"), chat("custom-tags"),
    chat("internal", { internal: true }), chat("helper", { title: "Branch name generator" }),
    chat("archived", { archivedAt: new Date().toISOString() }), chat("hidden", { background: true }),
    chat("child", { labels: { "paseo.parent-agent-id": "main-001" } }), chat("run", { labels: { "clyde.run": "r-test" } }),
    chat("mirror", { labels: { "clyde-thread": "t-123" } }), chat("point-man", { labels: { clyde: "point-man" } }),
  ];
  const second = [
    chat("restored", { pendingPermissions: [{}] }), chat("new", { workspaceId: "w2" }),
  ];
  const paseo = { agents: { list: async ({ page }) => ({
    entries: (page.cursor ? second : first).map(agent => ({ agent })),
    pageInfo: page.cursor ? { hasMore: false, nextCursor: null } : { hasMore: true, nextCursor: "page-2" },
  }) } };
  const roster = args => rpc.get("clyde.roster")(args, { paseo });
  const all = await roster({});
  assert.deepEqual(all.map(row => row.id), ["main-001", "confirmed", "proposed", "custom-tags", "restored", "new"]);
  assert.deepEqual((await roster({ workspaceId: "w2" })).map(row => row.id), ["new"]);
  const [main, confirmed, proposed, customTags, restored, fresh] = all;
  assert.equal(main.title, "Codex chat · main-001");
  assert.equal(fresh.title, "Codex chat");
  assert.deepEqual([main.project, main.model, main.status], ["owner/repo", "gpt-6.2-astra", "running"]);
  assert.equal(restored.archived, undefined);
  assert.equal(restored.status, "Waiting for approval");
  assert.deepEqual([main.role, main.areas, main.passed], ["Project chat", [], [7]]);
  assert.deepEqual([fresh.role, fresh.areas], ["Project chat", []]);
  assert.deepEqual([confirmed.role, confirmed.areas, confirmed.confirmed], [old.role, old.areas, true]);
  assert.deepEqual([proposed.role, proposed.areas], ["Accessibility reviews", ["ui", "accessibility"]]);
  assert.deepEqual([customTags.role, customTags.areas], [prompt, ["design"]]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8"))[main.id].areas, []);

  const helper = chat("transient", { title: "Branch name generator" });
  const open = await hooks.get("agent.open.before")({ request: { ...helper, agentId: helper.id, purpose: "interactive" } }, { paseo });
  assert.equal(open, undefined);
  await hooks.get("agent.turn.before")({ agent: helper }, { paseo });
  assert.equal(JSON.parse(readFileSync(file, "utf8"))[helper.id], undefined);
  const create = await hooks.get("agent.create.before")({ request: { config: { internal: true }, metadata: { kept: true } } });
  assert.equal(create.metadata.kept, true);
  const openChat = agent => hooks.get("agent.open.before")({
    request: { tools: [], env: {}, ...agent, agentId: agent.id, purpose: "interactive" },
  }, { paseo });
  assert.equal(await openChat(chat("another-helper", { metadata: create.metadata })), undefined);
  const bg = await openChat(chat("background", { background: true, labels: { "clyde.run": "r-test", "clyde.thread": "t-1" } }));
  assert.ok(bg.tools.some(t => t.name === "clyde_recall"), "background workers receive Paseo built-in Clyde memory tools");
  assert.ok(bg.tools.some(t => t.name === "clyde_get_entry"));
  assert.ok(bg.tools.some(t => t.name === "clyde_list_quests"));
  assert.equal(bg.tools.some(t => t.name === "clyde_delegate"), false, "background workers do not receive interactive delegate tool");
  assert.equal(JSON.parse(readFileSync(file, "utf8"))["background"], undefined, "background workers are not added to resident roster");
  const pointMan = chat("point-man", { labels: { clyde: "point-man" } });
  const lead = await openChat(pointMan);
  assert.ok(lead.tools.some(t => t.name === "clyde_recall"));
  assert.ok(lead.tools.some(t => t.name === "clyde_delegate"));
  const tool = lead.tools.find(t => t.name === "clyde_suggest_role");
  await tool.execute({ role: "Coordinate release", areas: ["release"] }, { agent: pointMan });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8"))[pointMan.id].areas, ["release"]);
});
