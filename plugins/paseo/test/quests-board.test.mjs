import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const compiled = ts.transpileModule(
  readFileSync(new URL("../client/quests.tsx", import.meta.url), "utf8"),
  { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const mod = { exports: {} };
new Function("require", "module", "exports", compiled)(
  (name) => {
    if (name === "react-native") return { Linking: {}, Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", TextInput: "TextInput", View: "View" };
    if (name === "@getpaseo/plugin/client") return { useRpc: () => () => {} };
    if (name === "@getpaseo/plugin/client/ui") return { Icon: "Icon" };
    if (name === "@tanstack/react-query") return { useQuery: () => ({}), useQueryClient: () => ({}) };
    if (name === "../shared/clyde") return {};
    if (name === "./brand.generated") return { artwork: { light: {}, dark: {} }, palette: { light: {}, dark: {} } };
    if (name === "./palette") return {};
    if (name === "./request-id") return { requestId: () => "id" };
    return require(name);
  },
  mod,
  mod.exports,
);
const { questStamp } = mod.exports;

const base = { id: 63, title: "Fix prompts", brief: "Brief", done_when: "Done", priority: "high" };

test("questStamp renders classic rubber stamps for picked-up, needs-review, done, and abandoned quests", () => {
  assert.equal(questStamp({ ...base, state: "open" }), null);
  assert.deepEqual(questStamp({ ...base, state: "claimed", claimed_by: "antigravity-paseo" }), {
    kind: "picked-up",
    label: "PICKED UP",
    detail: "antigravity-paseo",
    tone: "blue",
  });
  assert.deepEqual(questStamp({ ...base, state: "claimed", claimed_by: "claude", needs_review: true, run_status: "asking" }), {
    kind: "needs-review",
    label: "NEEDS REVIEW",
    detail: "awaiting you",
    tone: "amber",
  });
  assert.deepEqual(questStamp({ ...base, state: "needs_review", claimed_by: "sol" }), {
    kind: "needs-review",
    label: "NEEDS REVIEW",
    detail: "sol",
    tone: "amber",
  });
  assert.deepEqual(questStamp({ ...base, state: "done", claimed_by: "chatgpt-dmia" }), {
    kind: "done",
    label: "DONE",
    detail: "chatgpt-dmia",
    tone: "green",
  });
  assert.deepEqual(questStamp({ ...base, state: "abandoned" }), {
    kind: "abandoned",
    label: "ABANDONED",
    tone: "red",
  });
});
