import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findSvgIconProblem, PLUGIN_SVG_ICON_MAX_BYTES } from "@getpaseo/plugin";
import { palette } from "../client/brand.generated.ts";
import { clydeIcon } from "../client/icon.ts";
import {
  edgePalette,
  formatRpcError,
  hue,
  MIN_FONT_SIZE,
  MIN_LOCKUP_WIDTH,
  safeHttpsUrl,
  scheme,
  STATUS_LABEL,
  tones,
} from "../client/palette.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function relativeLuminance(hex) {
  const clean = hex.replace("#", "");
  assert.equal(clean.length, 6, `Expected 6-digit hex color, got ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const channel = Number.parseInt(clean.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

test("scheme resolves light and dark themes from PluginTheme surface0 and rgb colors", () => {
  assert.equal(scheme({ colors: { surface0: "#f4f4f1" } }), "light");
  assert.equal(scheme({ colors: { surface0: "rgb(244, 244, 241)" } }), "light");
  assert.equal(scheme({ colors: { surface0: "#121311" } }), "dark");
  assert.equal(scheme({ colors: { surface0: "rgb(18, 19, 17)" } }), "dark");
  assert.equal(scheme({ mode: "dark" }), "dark");
  assert.equal(scheme({ mode: "light" }), "light");
});

test("tones, edges, and root palette pairs meet WCAG AA (>= 4.5:1) in light and dark modes", () => {
  for (const mode of ["light", "dark"]) {
    const p = palette[mode];
    const theme = { colors: { surface0: p["paper-0"] } };
    const t = tones(theme);
    const surfaces = [p["paper-0"], p["paper-1"], p["paper-2"]];

    for (const [name, pair] of Object.entries(t)) {
      const washRatio = contrastRatio(pair.ink, pair.soft);
      assert.ok(washRatio >= 4.5, `${mode} tone ${name} ink ${pair.ink} on soft ${pair.soft} ratio ${washRatio.toFixed(2)} < 4.5`);
      for (const bg of surfaces) {
        const ratio = contrastRatio(pair.ink, bg);
        assert.ok(ratio >= 4.5, `${mode} tone ${name} ink ${pair.ink} on ${bg} ratio ${ratio.toFixed(2)} < 4.5`);
      }
    }

    const edges = edgePalette(theme);
    for (const [edgeName, edge] of Object.entries(edges)) {
      for (const bg of surfaces) {
        const ratio = contrastRatio(edge.color, bg);
        assert.ok(ratio >= 4.5, `${mode} edge ${edgeName} ${edge.color} on ${bg} ratio ${ratio.toFixed(2)} < 4.5`);
      }
    }

    for (const key of ["ink", "ink-2", "ink-3", "carbon", "carbon-ink", "ok", "warn", "bad"]) {
      for (const bg of surfaces) {
        const ratio = contrastRatio(p[key], bg);
        assert.ok(ratio >= 4.5, `${mode} palette.${key} (${p[key]}) on ${bg} ratio ${ratio.toFixed(2)} < 4.5`);
      }
    }

    assert.ok(contrastRatio(p.ink, p.sticky) >= 4.5, `${mode} sticky ink`);
    assert.ok(contrastRatio(p["ink-2"], p.sticky) >= 4.5, `${mode} sticky ink-2`);
    assert.ok(contrastRatio(p["carbon-ink"], p.sticky) >= 4.5, `${mode} sticky carbon-ink`);
    assert.ok(contrastRatio(p["on-carbon"], p.carbon) >= 4.5, `${mode} carbon button`);
    assert.ok(contrastRatio(p["paper-1"], p.ink) >= 4.5, `${mode} ink button`);
  }

  for (const status of Object.keys(STATUS_LABEL)) {
    const darkHue = hue(status, { mode: "dark" });
    const lightHue = hue(status, { mode: "light" });
    assert.ok(contrastRatio(darkHue.ink, darkHue.soft) >= 4.5, `dark ${status} pill`);
    assert.ok(contrastRatio(lightHue.ink, lightHue.soft) >= 4.5, `light ${status} pill`);
  }
});

test("clydeIcon passes Paseo SVG validation and includes dark/light halo stroke", () => {
  assert.equal(findSvgIconProblem(clydeIcon.svg), null);
  assert.ok(Buffer.byteLength(clydeIcon.svg, "utf8") < PLUGIN_SVG_ICON_MAX_BYTES);
  assert.match(clydeIcon.svg, /stroke="#ffffff" stroke-width="6"/);
});

test("formatRpcError and safeHttpsUrl sanitize daemon errors and PR URLs", () => {
  const err = new Error(
    "DaemonRpcError: Request failed: Choose a chat for this task. Open /clyde in that chat to start it with project memory. requestType=plugin.rpc.invoke.request code=handler_error",
  );
  assert.equal(
    formatRpcError(err),
    "Choose a chat for this task. Open /clyde in that chat to start it with project memory.",
  );
  assert.equal(formatRpcError("RpcError: Request failed: Try again code=bad_request"), "Try again");
  assert.equal(
    safeHttpsUrl("  https://github.com/gewenyu99/heyclyde/pull/42  "),
    "https://github.com/gewenyu99/heyclyde/pull/42",
  );
  assert.equal(safeHttpsUrl("http://github.com/gewenyu99/heyclyde/pull/42"), null);
  assert.equal(safeHttpsUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpsUrl("file:///etc/passwd"), null);
  assert.equal(safeHttpsUrl(""), null);
});

test("client TSX components obey typography floor, accessible controls, chat picker, inline replies, and PR links", () => {
  const clientDir = path.join(ROOT, "client");
  const tsxFiles = [
    path.join(ROOT, "index.client.tsx"),
    ...fs.readdirSync(clientDir).filter((f) => f.endsWith(".tsx")).map((f) => path.join(clientDir, f)),
  ];

  for (const file of tsxFiles) {
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file);

    for (const match of src.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)/g)) {
      const size = Number(match[1]);
      assert.ok(size >= MIN_FONT_SIZE, `${rel} has fontSize ${size} < ${MIN_FONT_SIZE}`);
    }

    assert.equal(/#20211f/i.test(src), false, `${rel} must not hardcode #20211f`);
    assert.equal(/\bPALETTE\./.test(src), false, `${rel} must use tones(theme) instead of static PALETTE`);

    for (const match of src.matchAll(/<Lockup\b[^>]*width=\{(\d+)\}/g)) {
      assert.ok(Number(match[1]) >= MIN_LOCKUP_WIDTH, `${rel} Lockup width ${match[1]} < ${MIN_LOCKUP_WIDTH}`);
    }

    for (const match of src.matchAll(/<Pressable\b([\s\S]*?)>/g)) {
      assert.match(match[1], /\baccessibilityRole\b/, `${rel} Pressable must set accessibilityRole`);
    }
  }

  const composer = fs.readFileSync(path.join(clientDir, "composer.tsx"), "utf8");
  assert.match(composer, /menu === "chat"/);
  assert.match(composer, /effectiveAgentId/);
  assert.match(composer, /New chat in /);
  assert.match(composer, /No open chats in .* yet\. Clyde will open one when you start\./);

  const task = fs.readFileSync(path.join(clientDir, "task.tsx"), "utf8");
  assert.equal(/Open decision on board/.test(task), false, "task.tsx must answer questions inline");
  assert.match(task, /Approve plan/);
  assert.match(task, /Send reply/);

  const sidecar = fs.readFileSync(path.join(clientDir, "sidecar.tsx"), "utf8");
  assert.match(sidecar, /\buseLive\(\)/);
  assert.match(sidecar, /Runs \(\$\{needsCount\}\)/);

  const runEvidence = fs.readFileSync(path.join(clientDir, "run-evidence.tsx"), "utf8");
  const home = fs.readFileSync(path.join(clientDir, "home.tsx"), "utf8");
  assert.match(runEvidence, /pullRequest/);
  assert.match(home, /pullRequest/);
});
