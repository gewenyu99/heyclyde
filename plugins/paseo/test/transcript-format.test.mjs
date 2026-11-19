import assert from "node:assert/strict";
import { test } from "node:test";
import { groupAttempts, parseInline, parseTranscriptBlocks } from "../client/transcript-format.ts";

test("parseInline splits bold and code runs cleanly", () => {
  assert.deepEqual(
    parseInline("Save **Did** and **Needs** via `clyde result` right away."),
    [
      { kind: "text", text: "Save " },
      { kind: "bold", text: "Did" },
      { kind: "text", text: " and " },
      { kind: "bold", text: "Needs" },
      { kind: "text", text: " via " },
      { kind: "code", text: "clyde result" },
      { kind: "text", text: " right away." },
    ],
  );
});

test("parseTranscriptBlocks structures headings, bullets, quotes, pretty JSON, and unclosed fences", () => {
  const sample = [
    "## Summary",
    "",
    "I wrote a 7-slice plan.",
    "It wraps cleanly.",
    "",
    "- **First:** `shape.ts` exposes outcomes",
    "1. **Second:** `task.tsx` folds earlier attempts",
    "",
    "> Keep main interactive.",
    "",
    "```json",
    '{"status":"done","slices":[{"id":"s1"},{"id":"s2"}]}',
    "```",
    "",
    "```ts",
    "const unclosed = true",
  ].join("\n");

  const blocks = parseTranscriptBlocks(sample);
  assert.equal(blocks[0].kind, "heading");
  assert.deepEqual(blocks[0], { kind: "heading", level: 2, text: "Summary" });
  assert.deepEqual(blocks[1], { kind: "paragraph", text: "I wrote a 7-slice plan. It wraps cleanly." });
  assert.deepEqual(blocks[2], { kind: "bullet", marker: "•", text: "**First:** `shape.ts` exposes outcomes" });
  assert.deepEqual(blocks[3], { kind: "bullet", marker: "1.", text: "**Second:** `task.tsx` folds earlier attempts" });
  assert.deepEqual(blocks[4], { kind: "quote", text: "Keep main interactive." });

  assert.equal(blocks[5].kind, "code");
  if (blocks[5].kind === "code") {
    assert.equal(blocks[5].isJson, true);
    assert.ok(blocks[5].lines > 4);
    assert.match(blocks[5].text, /\n  "slices": \[/);
  }

  assert.deepEqual(blocks[6], {
    kind: "code",
    lang: "ts",
    text: "const unclosed = true",
    lines: 1,
    isJson: false,
  });

  const bareJson = parseTranscriptBlocks('{"verdict":"pass","notes":"ok"}');
  assert.equal(bareJson.length, 1);
  assert.equal(bareJson[0].kind, "code");
  if (bareJson[0].kind === "code") {
    assert.equal(bareJson[0].isJson, true);
    assert.match(bareJson[0].text, /\n  "verdict": "pass"/);
  }
});

test("groupAttempts collapses repeated failures/sent-back rounds and summarizes counts", () => {
  assert.deepEqual(groupAttempts([]), { past: [], summary: "" });
  assert.deepEqual(groupAttempts([{ outcome: "Working" }]), {
    past: [],
    latest: { outcome: "Working" },
    summary: "",
  });

  const threeFailed = groupAttempts([
    { outcome: "Failed" },
    { outcome: "Failed" },
    { outcome: "Failed" },
    { outcome: "Working" },
  ]);
  assert.equal(threeFailed.past.length, 3);
  assert.deepEqual(threeFailed.latest, { outcome: "Working" });
  assert.equal(threeFailed.summary, "3 earlier attempts · 3 failed");

  const mixed = groupAttempts([
    { outcome: "Sent back" },
    { outcome: "Failed" },
    { outcome: "Interrupted", interrupted: true },
    { outcome: "Passed" },
  ]);
  assert.equal(mixed.past.length, 3);
  assert.deepEqual(mixed.latest, { outcome: "Passed" });
  assert.equal(mixed.summary, "3 earlier attempts · 1 failed, 1 sent back, 1 interrupted");
});
