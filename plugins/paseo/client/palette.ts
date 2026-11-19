import type { Status } from "../shared/clyde.ts";
import { palette } from "./brand.generated.ts";

export type { Status };
export type Scheme = "light" | "dark";
export type ThemeLike = { mode?: string; colors?: { surface0?: string } } | null | undefined;
export type Tone = { ink: string; soft: string };
export type ToneName = "blue" | "amber" | "green" | "purple" | "red" | "grey";
export type Tones = Record<ToneName, Tone>;
export type EdgeKind = "order" | "ask" | "memory" | "live";

export const MIN_FONT_SIZE = 12;
export const MIN_HIT_HEIGHT = 40;
export const MIN_LOCKUP_WIDTH = 84;

export const STATUS_LABEL: Record<Status, string> = {
  running: "Running",
  asking: "Needs you",
  passed: "Passed",
  "sent-back": "Sent back",
  failed: "Failed",
  pending: "Pending",
  skipped: "Skipped",
  done: "Done",
};

/** Resolve the Clyde color scheme ("light" or "dark") from a Paseo theme object. */
export function scheme(theme?: ThemeLike): Scheme {
  if (theme?.mode === "dark") return "dark";
  if (theme?.mode === "light") return "light";
  const color = theme?.colors?.surface0?.trim();
  if (!color) return "light";
  const hsl = /^hsla?\(\s*[\d.]+\s*[,\s]\s*[\d.]+%?\s*[,\s]\s*([\d.]+)%/i.exec(color);
  if (hsl) return Number(hsl[1]) < 50 ? "dark" : "light";
  const hex3 = /^#([a-f\d]{3})$/i.exec(color);
  const hex6or8 = /^#([a-f\d]{6})(?:[a-f\d]{2})?$/i.exec(color);
  const rgb = hex3
    ? [0, 1, 2].map((i) => parseInt(hex3[1][i] + hex3[1][i], 16))
    : hex6or8
    ? [0, 2, 4].map((i) => parseInt(hex6or8[1].slice(i, i + 2), 16))
    : (color.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  return rgb.length === 3 && rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 < 128 ? "dark" : "light";
}

/** Theme-aware high-contrast status tones aligned with Clyde's root design tokens. */
export function tones(theme?: ThemeLike): Tones {
  const s = scheme(theme);
  const p = palette[s];
  if (s === "dark") {
    return {
      blue: { ink: p["pen-blue"], soft: p["carbon-wash"] },
      amber: { ink: p["pen-amber"], soft: p["warn-wash"] },
      green: { ink: p.ok, soft: p["ok-wash"] },
      purple: { ink: p["pen-violet"], soft: "#28203c" },
      red: { ink: p.bad, soft: p["bad-wash"] },
      grey: { ink: p["ink-2"], soft: p["paper-2"] },
    };
  }
  return {
    blue: { ink: p["carbon-ink"], soft: p["carbon-wash"] },
    amber: { ink: p["pen-amber"], soft: p["warn-wash"] },
    green: { ink: p.ok, soft: p["ok-wash"] },
    purple: { ink: p["pen-violet"], soft: "#f0ebfa" },
    red: { ink: p.bad, soft: p["bad-wash"] },
    grey: { ink: p["ink-2"], soft: p["paper-2"] },
  };
}

/** Return the high-contrast ink and wash pair for a workflow/task status. */
export function hue(status: Status, theme?: ThemeLike): Tone {
  const t = tones(theme);
  if (status === "running") return t.blue;
  if (status === "asking" || status === "sent-back") return t.amber;
  if (status === "passed" || status === "done") return t.green;
  if (status === "failed") return t.red;
  return t.grey;
}

/** Return flow-diagram edge colors and line styles adapted to the active theme. */
export function edgePalette(
  theme?: ThemeLike,
): Record<EdgeKind, { color: string; style: "solid" | "dotted" | "dashed"; label: string }> {
  const s = scheme(theme);
  const t = tones(theme);
  return {
    order: { color: palette[s].ink, style: "solid", label: "Order" },
    ask: { color: t.purple.ink, style: "dotted", label: "Asks you" },
    memory: { color: t.green.ink, style: "solid", label: "Handed off through memory" },
    live: { color: t.amber.ink, style: "dashed", label: "Live work" },
  };
}

/** Strip Paseo RPC wrapper noise so UI alerts show clean actionable text. */
export function formatRpcError(err: unknown): string {
  const raw = err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string"
    ? (err as { message: string }).message
    : String(err ?? "");
  let text = raw.replace(/\s+/g, " ").trim();
  text = text.replace(/^(?:(?:Error|DaemonRpcError|RpcError):\s*)+/i, "");
  text = text.replace(/^(?:Request failed:\s*)+/i, "");
  text = text.replace(/\s+(?:requestType|code)=\S+/g, "").trim();
  return text || "Something went wrong.";
}

/** Validate and normalize external links to HTTPS URLs only. */
export function safeHttpsUrl(raw?: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}
