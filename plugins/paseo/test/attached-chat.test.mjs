import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const compiled = ts.transpileModule(
  readFileSync(new URL("../client/attached-chat.tsx", import.meta.url), "utf8"),
  { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const mod = { exports: {} };
new Function("require", "module", "exports", compiled)(
  (name) => {
    if (name === "react-native") return { Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", TextInput: "TextInput", View: "View" };
    if (name === "@getpaseo/plugin/client") return { usePaseo: () => null };
    if (name === "@getpaseo/plugin/client/ui") return { Markdown: "Markdown" };
    if (name === "./palette") return { formatRpcError: (e) => String(e), MIN_HIT_HEIGHT: 40, tones: () => ({}) };
    if (name === "./worker-permissions") return { WorkerPermissions: "WorkerPermissions" };
    return require(name);
  },
  mod,
  mod.exports,
);

const {
  mergeStreamText,
  applyTimelineEvent,
  normalizeTimeline,
  reasoningHeadline,
  groupTimelineBlocks,
  formatToolSummary,
} = mod.exports;

test("mergeStreamText appends incremental deltas and accepts cumulative snapshots without truncation", () => {
  assert.equal(mergeStreamText("Reading src", "/store.ts (readJsonDir), p"), "Reading src/store.ts (readJsonDir), p");
  assert.equal(mergeStreamText("Reading src", "Reading src/store.ts (readJsonDir)"), "Reading src/store.ts (readJsonDir)");
  assert.equal(mergeStreamText("Full text already streamed in full here", "Full text already streamed in full"), "Full text already streamed in full here");
  assert.equal(mergeStreamText("", "hello"), "hello");
});

test("applyTimelineEvent and normalizeTimeline coalesce streaming deltas and consecutive reasoning blocks", () => {
  let state = [];
  state = applyTimelineEvent(state, { type: "timeline", turnId: "t1", item: { type: "reasoning", text: "Checking " } });
  state = applyTimelineEvent(state, { type: "timeline", turnId: "t1", item: { type: "reasoning", text: "residents.ts and routes." } });
  state = applyTimelineEvent(state, { type: "timeline", turnId: "t1", item: { type: "reasoning", text: " Next checking tests." } });
  assert.equal(state.length, 1, "consecutive reasoning deltas collapse into one block");
  assert.equal(state[0].item.text, "Checking residents.ts and routes. Next checking tests.");

  state = applyTimelineEvent(state, { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "Checked src" } });
  state = applyTimelineEvent(state, { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "/store.ts (readJsonDir), plan ready." } });
  assert.equal(state.length, 2);
  assert.equal(state[1].item.text, "Checked src/store.ts (readJsonDir), plan ready.");

  const stored = normalizeTimeline([
    { turnId: "t1", item: { type: "reasoning", text: "First thought" } },
    { turnId: "t1", item: { type: "reasoning", text: "Second thought" } },
    { turnId: "t1", item: { type: "reasoning", text: "Third thought" } },
    { turnId: "t1", item: { type: "tool_call", callId: "c1", name: "Bash", status: "completed", detail: {} } },
  ]);
  assert.equal(stored.length, 2);
  assert.equal(stored[0].item.type, "reasoning");
  assert.match(stored[0].item.text, /First thought[\s\S]*Second thought[\s\S]*Third thought/);
});

test("reasoningHeadline, groupTimelineBlocks, and formatToolSummary produce clean compact output", () => {
  assert.equal(reasoningHeadline("## **Inspecting** `residents.ts` for hooks.\nMore detail."), "Inspecting `residents.ts` for hooks.");

  const entries = [
    { turnId: "t1", item: { type: "user_message", text: "Fix bugs" } },
    { turnId: "t1", item: { type: "reasoning", text: "Checking store.ts" } },
    { turnId: "t1", item: { type: "tool_call", callId: "c1", name: "mcp__memory__feedback", status: "completed", detail: {} } },
    { turnId: "t1", item: { type: "assistant_message", text: "Done." } },
    { turnId: "t2", item: { type: "reasoning", text: "Verifying tests" } },
  ];
  const blocks = groupTimelineBlocks(entries, true);
  assert.deepEqual(blocks.map((b) => [b.kind, b.live ?? false]), [
    ["message", false],
    ["activity", false],
    ["message", false],
    ["activity", true],
  ]);

  const bash = formatToolSummary({
    type: "tool_call",
    name: "Bash",
    detail: { type: "shell", command: "cd /Users/vincent/.clyde/worktrees/r-123 && grep -n export src/store.ts", output: "1: export" },
  });
  assert.equal(bash.line, "$ grep -n export src/store.ts");
  assert.match(bash.body, /worktrees\/r-123/);

  assert.equal(formatToolSummary({ type: "tool_call", name: "mcp__memory__feedback", detail: {} }).line, "memory · feedback");
  assert.equal(formatToolSummary({ type: "tool_call", name: "mcp__paseo__clyde_recall", detail: {} }).line, "clyde · recall");
});
