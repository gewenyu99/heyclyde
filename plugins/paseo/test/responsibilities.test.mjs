import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { residents } from "../server/residents.ts";

test("responsibilities save while quest pickup is still waiting", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "clyde-responsibilities-"));
  const oldHome = process.env.CLYDE_HOME;
  process.env.CLYDE_HOME = dir;
  t.after(() => {
    if (oldHome === undefined) delete process.env.CLYDE_HOME;
    else process.env.CLYDE_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  });
  const file = join(dir, "residents.json");
  const agent = {
    id: "owner", title: "Repo work", role: "Suggested role", areas: ["repo"],
    provider: "codex", project: "test/repo", cwd: dir, confirmed: false,
    paused: true, passed: [], memory: "Best effort", error: "fetch failed",
  };
  writeFileSync(file, JSON.stringify({ [agent.id]: agent }));
  const handlers = new Map();
  const plugin = residents({ addHook() {}, handle: (rpc, fn) => handlers.set(rpc.name, fn) });
  const refresh = Promise.withResolvers();
  t.after(() => { plugin.close(); refresh.resolve(); });
  const paseo = { agents: { ref: () => ({ refresh: () => refresh.promise, current: () => null }) } };

  const confirmation = handlers.get("clyde.resident")({
    id: agent.id, action: "confirm", role: "Design systems", areas: ["Design"],
  }, { paseo });
  const result = await Promise.race([confirmation, Promise.resolve().then(() => "still waiting")]);
  assert.deepEqual(result, { ok: true });
  const saved = JSON.parse(readFileSync(file, "utf8"))[agent.id];
  assert.equal(saved.role, "Design systems");
  assert.deepEqual(saved.areas, ["design"]);
  assert.equal(saved.confirmed, true);
  assert.equal(saved.pickupError, undefined);
  refresh.resolve();
});
