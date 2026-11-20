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
    if (name === "../shared/clyde") {
      return {
        questProjectMatches: (slug, project) => !project || slug.toLowerCase() === project.toLowerCase() || slug.toLowerCase().endsWith("/" + project.toLowerCase()),
      };
    }
    if (name === "./brand.generated") {
      const p = { sticky: "#fef4c7", "sticky-strip": "#f8e48c", "sticky-edge": "#e2ca6a", "paper-0": "#f4f4f1", "paper-2": "#ebece7", "rule-strong": "#ccc" };
      return { artwork: { light: {}, dark: {} }, palette: { light: p, dark: p } };
    }
    if (name === "./palette") return {};
    if (name === "./request-id") return { requestId: () => "id" };
    return require(name);
  },
  mod,
  mod.exports,
);
const { questStamp, stickyColumns, stickyVisual, distributeMasonry, resolveQuestTarget } = mod.exports;

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

test("stickyColumns and distributeMasonry pack sticky notes into multi-column masonry with varying heights and tilts", () => {
  assert.equal(stickyColumns(400), 1);
  assert.equal(stickyColumns(640), 2);
  assert.equal(stickyColumns(1100), 3);
  const items = [
    { ...base, id: 1, brief: "Short." },
    { ...base, id: 2, brief: "Long brief ".repeat(22), tags: ["paseo", "ui"] },
    { ...base, id: 3, brief: "Medium brief text here for spacing." },
    { ...base, id: 4, brief: "Another note." },
    { ...base, id: 5, brief: "Fifth note with details." },
  ];
  const cols = distributeMasonry(items, 3, null);
  assert.equal(cols.length, 3);
  assert.equal(cols.flat().length, 5);
  assert.ok(cols.every(c => c.length >= 1), "each column gets sticky notes");
  const v1 = stickyVisual(items[0], "light", false, false);
  const v2 = stickyVisual(items[1], "light", false, false);
  assert.notEqual(v1.tilt, "0deg");
  assert.ok(v2.briefLines > v1.briefLines, "longer briefs get taller sticky notes");
  assert.equal(stickyVisual(items[0], "light", false, true).tilt, "0deg", "expanded notes straighten");
});

test("resolveQuestTarget resolves unambiguous project/workspace for one-click quest accept", () => {
  const projects = [
    { id: "p-clyde", name: "heyclyde", slug: "gewenyu99/heyclyde", path: "/work/heyclyde", kind: "git", eligible: true, workspaces: [{ id: "ws-main", name: "main", path: "/work/heyclyde" }], chats: [] },
    { id: "p-docs", name: "posthog.com", slug: "posthog/posthog.com", path: "/work/posthog.com", kind: "git", eligible: true, workspaces: [{ id: "ws-docs", name: "main", path: "/work/posthog.com" }], chats: [] },
  ];
  const match = resolveQuestTarget({ ...base, project: "gewenyu99/heyclyde" }, projects);
  assert.equal(match?.project.id, "p-clyde");
  assert.equal(match?.workspaceId, "ws-main");
  assert.equal(resolveQuestTarget({ ...base, project: null }, projects), null, "ambiguous multi-project quest expands picker");
  const pinned = resolveQuestTarget({ ...base, project: null }, projects, "ws-docs");
  assert.equal(pinned?.project.id, "p-docs");
  assert.equal(pinned?.workspaceId, "ws-docs");
});
