import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { updateWhenIdle } from "../server/daemon.ts";

test("a deferred reload retries until current and stops polling afterwards", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const stop = updateWhenIdle(async () => ++calls === 2, 10);
  await setImmediate();
  t.mock.timers.tick(10);
  await setImmediate();
  t.mock.timers.tick(20);
  assert.equal(calls, 2);
  stop();
});

test("plugin teardown cancels a deferred retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const stop = updateWhenIdle(async () => { calls++; return false; }, 10);
  stop();
  await setImmediate();
  t.mock.timers.tick(10);
  assert.equal(calls, 1);
});
