import {RemoveTask} from "./remove-task";
import { RunEvidence } from "./run-evidence";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import { Pressable, TextInput, ScrollView, Text, View } from "react-native";
import { answerRpc,steerRpc, stopRpc, transcriptRpc, type AttemptView, type Phase, type Piece, type Status, type TaskView } from "../shared/clyde";
import { ago, count, duration, edgePalette, Eyebrow, formatRpcError, hue, Ladder, MIN_HIT_HEIGHT, Pill, STATUS_LABEL, tones } from "./nodes";
import { groupAttempts, parseInline, parseTranscriptBlocks, type TranscriptBlock } from "./transcript-format";

// Everything on the 8px grid: a gutter for the row label, fixed piece cells, fixed gaps, one band per row.
const U = 8;
const LABEL_W = 14 * U;
const GAP = 3 * U;
const CELL_W = 28 * U;
const CELL_H = 21 * U;
const BAND_PAD = 2 * U;
const BAND_H = CELL_H + 2 * BAND_PAD;
const ROW_GAP = 5 * U;
const LINE = 2;
// A running task that has been silent this long gets flagged, the way CI flags a stuck job.
const QUIET_MS = 10 * 60_000;

type Edge = "order" | "ask" | "memory" | "live";

/** Into a live piece the edge is live, into an asking one it asks Wen, after a piece that wrote to memory it's a hand-off. */
function edgeBetween(from: Piece, to: Piece): Edge {
  if (to.status === "asking") return "ask";
  if (to.status === "running" || to.status === "sent-back") return "live";
  if (from.handoff) return "memory";
  return "order";
}

/** One orthogonal segment. A horizontal segment draws with a top border, a vertical one with a left border. */
function Seg({ theme, x, y, w, h, kind }: { theme: PluginTheme; x: number; y: number; w: number; h: number; kind: Edge }) {
  const e = edgePalette(theme)[kind];
  const horizontal = h <= LINE;
  return (
    <View pointerEvents="none" style={{
      position: "absolute", left: x, top: y, width: horizontal ? w : LINE, height: horizontal ? LINE : h,
      borderColor: e.color, borderStyle: e.style, ...(horizontal ? { borderTopWidth: LINE } : { borderLeftWidth: LINE }),
    }} />
  );
}

const GLYPH: Record<Status, string> = { passed: "✓", done: "✓", failed: "✕", running: "●", "sent-back": "↺", asking: "?", pending: "○", skipped: "–" };

/** The phases a piece goes through, as a segmented bar with the phase names under it. */
function PhaseBar({ phases, theme }: { phases: Phase[]; theme: PluginTheme }) {
  if (phases.length < 2) return null;
  return (
    <View style={{ flexDirection: "row", gap: 4 }}>
      {phases.map((p) => (
        <View key={p.stage} style={{ flex: 1, gap: 3 }}>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: p.status === "pending" ? theme.colors.border : hue(p.status, theme).ink }} />
          <Text numberOfLines={1} style={{ fontSize: 12, color: p.status === "pending" ? theme.colors.foregroundMuted : hue(p.status, theme).ink, fontWeight: "600" }}>{p.label}</Text>
        </View>
      ))}
    </View>
  );
}

function footer(p: Piece): string {
  const parts: string[] = [];
  if (p.attempts) parts.push(`${p.attempts} attempt${p.attempts === 1 ? "" : "s"}`);
  if (p.sentBack) parts.push(`sent back ${p.sentBack}`);
  if (p.startedAt) parts.push(duration(p.startedAt, p.endedAt));
  return parts.join(" · ") || "Not started";
}

function Cell({ theme, p, x, y, selected, onPress }: { theme: PluginTheme; p: Piece; x: number; y: number; selected: boolean; onPress: () => void }) {
  const t = tones(theme);
  const h = hue(p.status, theme);
  const pending = p.status === "pending";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${p.id} ${p.title}`}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        position: "absolute", left: x, top: y, width: CELL_W, height: CELL_H, padding: 12, borderRadius: 8,
        borderWidth: selected ? 2 : 1, borderColor: selected ? t.blue.ink : theme.colors.border,
        backgroundColor: pending ? theme.colors.surface2 : theme.colors.surface1, gap: 6,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700", letterSpacing: 0.4 }}>{p.id}</Text>
        <Text style={{ color: h.ink, fontSize: 12, fontWeight: "700" }}>{GLYPH[p.status]}</Text>
      </View>
      <Text numberOfLines={3} style={{ color: pending ? theme.colors.foregroundMuted : theme.colors.foreground, fontWeight: "600", fontSize: 12, lineHeight: 16 }}>{p.title}</Text>
      <View style={{ flex: 1 }} />
      <PhaseBar theme={theme} phases={p.phases} />
      <Text numberOfLines={1} style={{ color: p.sentBack ? t.amber.ink : theme.colors.foregroundMuted, fontSize: 12 }}>{footer(p)}</Text>
    </Pressable>
  );
}

/** L1: rows in hand-off order, pieces left to right, and every edge runs straight across or straight down. */
function FlowDiagram({ theme, view, selected, select }: { theme: PluginTheme; view: TaskView; selected?: string; select: (id: string) => void }) {
  const cols = Math.max(1, ...view.steps.map((s) => s.pieces.length));
  const width = LABEL_W + GAP + cols * (CELL_W + GAP);
  const height = view.steps.length * BAND_H + (view.steps.length - 1) * ROW_GAP;
  const pos = new Map<string, { x: number; y: number }>();
  const bands: ReactElement[] = [];
  const cells: ReactElement[] = [];
  const segs: ReactElement[] = [];
  view.steps.forEach((step, row) => {
    const top = row * (BAND_H + ROW_GAP);
    const done = step.pieces.filter((p) => p.status === "passed").length;
    bands.push(
      <View key={`band-${row}`} style={{ position: "absolute", left: 0, top, width, height: BAND_H, borderRadius: 8, backgroundColor: theme.colors.surface2, borderWidth: 1, borderColor: theme.colors.border }} />,
      <View key={`label-${row}`} style={{ position: "absolute", left: U * 1.5, top: top + BAND_PAD, width: LABEL_W - 2 * U }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "700" }}>{step.name}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 4 }}>{done} of {step.pieces.length} done</Text>
      </View>,
    );
    step.pieces.forEach((p, col) => {
      const x = LABEL_W + GAP + col * (CELL_W + GAP);
      const y = top + BAND_PAD;
      pos.set(p.id, { x, y });
      cells.push(<Cell key={p.id} theme={theme} p={p} x={x} y={y} selected={p.id === selected} onPress={() => select(p.id)} />);
    });
  });
  const flat = view.steps.flatMap((s) => s.pieces);
  flat.forEach((p, i) => {
    if (!i) return;
    const a = pos.get(flat[i - 1].id)!;
    const b = pos.get(p.id)!;
    const kind = edgeBetween(flat[i - 1], p);
    if (a.y === b.y) {
      segs.push(<Seg key={`e-${p.id}`} theme={theme} x={a.x + CELL_W} y={a.y + CELL_H / 2 - LINE / 2} w={GAP} h={LINE} kind={kind} />);
      return;
    }
    // Down out of the last piece, across the gap between rows, down into the first piece of the next row.
    const midY = a.y + CELL_H + BAND_PAD + ROW_GAP / 2;
    const ax = a.x + CELL_W / 2;
    const bx = b.x + CELL_W / 2;
    segs.push(
      <Seg key={`e1-${p.id}`} theme={theme} x={ax - LINE / 2} y={a.y + CELL_H} w={LINE} h={midY - (a.y + CELL_H)} kind={kind} />,
      <Seg key={`e2-${p.id}`} theme={theme} x={Math.min(ax, bx) - LINE / 2} y={midY - LINE / 2} w={Math.abs(ax - bx) + LINE} h={LINE} kind={kind} />,
      <Seg key={`e3-${p.id}`} theme={theme} x={bx - LINE / 2} y={midY} w={LINE} h={b.y - midY} kind={kind} />,
    );
  });
  return (
    <ScrollView horizontal contentContainerStyle={{ paddingVertical: 8 }}>
      <View style={{ width, height }}>{bands}{segs}{cells}</View>
    </ScrollView>
  );
}

function Legend({ theme }: { theme: PluginTheme }) {
  const edges = edgePalette(theme);
  return (
    <View style={{ flexDirection: "row", gap: 16, marginTop: 12, flexWrap: "wrap" }}>
      {(Object.keys(edges) as Edge[]).map((k) => (
        <View key={k} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 24, borderTopWidth: LINE, borderColor: edges[k].color, borderStyle: edges[k].style }} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{edges[k].label}</Text>
        </View>
      ))}
    </View>
  );
}

/** One attempt as a single line, with only what went wrong under it unless compacted under history. */
function AttemptRow({ theme, a, compact = false }: { theme: PluginTheme; a: AttemptView; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const fails = a.criteria.filter((c) => c.result === "fail");
  const badChecks = a.checks.filter((c) => c.code !== 0);
  const tone: Status = a.interrupted ? "pending" : /passed|done/i.test(a.outcome) ? "passed" : /sent back|failed/i.test(a.outcome) ? "sent-back" : "running";
  const t = tones(theme);
  const toneHue = hue(tone, theme);
  const showDetails = open || !compact;
  return (
    <View style={{ borderLeftWidth: 2, borderLeftColor: toneHue.ink, paddingLeft: 10, paddingVertical: 4, marginTop: 4, opacity: a.interrupted ? 0.55 : 1 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, minHeight: MIN_HIT_HEIGHT }}
      >
        <Text style={{ color: theme.colors.foreground, fontSize: 12, flexShrink: 1 }}>
          <Text style={{ fontWeight: "700" }}>#{a.n}</Text>  {a.rung ?? ""}  ·  {duration(a.startedAt, a.endedAt)}
        </Text>
        <Text style={{ color: toneHue.ink, fontSize: 12, fontWeight: "700" }}>{a.outcome}</Text>
      </Pressable>
      {showDetails && fails.map((c, i) => (
        <View key={i} style={{ marginTop: 6 }}>
          <Text style={{ color: t.red.ink, fontSize: 12, fontWeight: "600" }}>✕ {c.criterion}</Text>
          {c.evidence ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 2, lineHeight: 18 }}>{c.evidence}</Text> : null}
        </View>
      ))}
      {showDetails && badChecks.map((c, i) => (
        <Text key={i} style={{ fontFamily: "Menlo", fontSize: 12, color: t.red.ink, marginTop: 4 }}>$ {c.cmd} → exit {c.code}</Text>
      ))}
      {open ? (
        <View style={{ marginTop: 6, gap: 4 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700", letterSpacing: 0.4 }}>WORKER SAID</Text>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 18 }}>{a.evidence}</Text>
          {a.criteria.filter((c) => c.result === "pass").map((c, i) => (
            <Text key={i} style={{ color: t.green.ink, fontSize: 12 }}>✓ {c.criterion}</Text>
          ))}
          {a.judgeRung ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Judged by {a.judgeRung}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function PhaseAttempts({ theme, tries }: { theme: PluginTheme; tries: AttemptView[] }) {
  const [showPast, setShowPast] = useState(false);
  const { past, latest, summary } = groupAttempts(tries);
  if (!latest) return null;
  return (
    <View>
      {past.length > 0 && (
        <View style={{ marginTop: 6 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showPast }}
            onPress={() => setShowPast(!showPast)}
            style={{
              minHeight: MIN_HIT_HEIGHT,
              justifyContent: "center",
              paddingHorizontal: 10,
              borderRadius: 6,
              backgroundColor: theme.colors.surface2,
              borderWidth: 1,
              borderColor: theme.colors.border,
            }}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>
              {showPast ? "▾" : "▸"} {summary}
            </Text>
          </Pressable>
          {showPast ? past.map((a) => <AttemptRow key={a.n} theme={theme} a={a} compact />) : null}
        </View>
      )}
      <AttemptRow theme={theme} a={latest} />
    </View>
  );
}

function PieceDetail({ theme, view, piece }: { theme: PluginTheme; view: TaskView; piece: Piece }) {
  const t = tones(theme);
  return (
    <View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginTop: 10, gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "700", flexShrink: 1 }}>{piece.id} · {piece.title}</Text>
        <Pill theme={theme} status={piece.status} label={`${STATUS_LABEL[piece.status].toUpperCase()}${piece.sentBack ? ` · SENT BACK ${piece.sentBack}` : ""}`} />
      </View>
      {piece.progress ? <Text style={{ color: t.blue.ink, fontSize: 13, marginTop: 6 }}>Now: {piece.progress}</Text> : null}
      {piece.doneWhen.length ? (
        <View style={{ marginTop: 12 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700", letterSpacing: 0.4 }}>DONE WHEN THESE PASS</Text>
          {piece.doneWhen.map((c, i) => (
            <Text key={i} numberOfLines={2} style={{ fontFamily: "Menlo", fontSize: 12, color: theme.colors.foreground, marginTop: 4 }}>$ {c}</Text>
          ))}
        </View>
      ) : null}
      {piece.phases.map((ph) => {
        const tries = view.attempts[ph.stage] ?? [];
        const first = tries[0];
        const last = tries[tries.length - 1];
        return (
          <View key={ph.stage} style={{ marginTop: 16 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ color: hue(ph.status, theme).ink, fontWeight: "700", fontSize: 13 }}>{GLYPH[ph.status]}</Text>
              <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "700" }}>{ph.label}</Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                {tries.length ? `${STATUS_LABEL[ph.status].toLowerCase()} · ${duration(first.startedAt, ph.status === "passed" ? last.endedAt : undefined)}` : "not started"}
              </Text>
            </View>
            <PhaseAttempts theme={theme} tries={tries} />
          </View>
        );
      })}
    </View>
  );
}

function InlineText({ theme, text, baseStyle }: { theme: PluginTheme; text: string; baseStyle: { color: string; fontSize: number; lineHeight: number; fontWeight?: "400" | "600" | "700" } }) {
  const runs = parseInline(text);
  return (
    <Text selectable style={baseStyle}>
      {runs.map((run, idx) =>
        run.kind === "bold" ? (
          <Text key={idx} style={{ fontWeight: "700" }}>{run.text}</Text>
        ) : run.kind === "code" ? (
          <Text key={idx} style={{ fontFamily: "Menlo", fontSize: 12, backgroundColor: theme.colors.surface2 }}>{` ${run.text} `}</Text>
        ) : (
          <Text key={idx}>{run.text}</Text>
        ),
      )}
    </Text>
  );
}

function CodeBlock({ theme, block }: { theme: PluginTheme; block: Extract<TranscriptBlock, { kind: "code" }> }) {
  const collapsible = (block.isJson && block.lines > 14) || block.lines > 24;
  const [expanded, setExpanded] = useState(!collapsible);
  const label = block.isJson ? "JSON" : block.lang || "Code";
  return (
    <View style={{ backgroundColor: theme.colors.surface2, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 10, borderBottomWidth: expanded ? 1 : 0, borderBottomColor: theme.colors.border }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600", fontFamily: "Menlo" }}>
          {label} · {block.lines} lines
        </Text>
        {collapsible ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            onPress={() => setExpanded(!expanded)}
            style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingLeft: 10 }}
          >
            <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
              {expanded ? `Hide ${label} ▴` : `Show ${label} ▾`}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {expanded ? (
        <Text selectable style={{ fontFamily: "Menlo", fontSize: 12, lineHeight: 18, color: theme.colors.foreground, padding: 10 }}>
          {block.text}
        </Text>
      ) : null}
    </View>
  );
}

function FormattedBody({ theme, text }: { theme: PluginTheme; text: string }) {
  const blocks = parseTranscriptBlocks(text);
  const t = tones(theme);
  if (!blocks.length) {
    return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>(no text yet)</Text>;
  }
  return (
    <View style={{ gap: 8 }}>
      {blocks.map((b, i) => {
        if (b.kind === "heading") {
          const fontSize = b.level === 1 ? 16 : b.level === 2 ? 15 : 14;
          return (
            <InlineText
              key={i}
              theme={theme}
              text={b.text}
              baseStyle={{ color: theme.colors.foreground, fontSize, lineHeight: fontSize + 6, fontWeight: "700" }}
            />
          );
        }
        if (b.kind === "bullet") {
          return (
            <View key={i} style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20, fontWeight: "700" }}>{b.marker}</Text>
              <View style={{ flex: 1 }}>
                <InlineText theme={theme} text={b.text} baseStyle={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 20 }} />
              </View>
            </View>
          );
        }
        if (b.kind === "quote") {
          return (
            <View key={i} style={{ borderLeftWidth: 2, borderLeftColor: t.blue.ink, paddingLeft: 10 }}>
              <InlineText theme={theme} text={b.text} baseStyle={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 }} />
            </View>
          );
        }
        if (b.kind === "code") {
          return <CodeBlock key={i} theme={theme} block={b} />;
        }
        return (
          <InlineText key={i} theme={theme} text={b.text} baseStyle={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 20 }} />
        );
      })}
    </View>
  );
}

function TurnCard({ theme, turn, rungLabel }: { theme: PluginTheme; turn: { n: number; at: string; prompt: string; text: string }; rungLabel?: string }) {
  const [showPrompt, setShowPrompt] = useState(false);
  return (
    <View style={{ backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 12, gap: 10 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700" }}>
          Turn {turn.n} · {timeAgo(turn.at)}
        </Text>
        {rungLabel ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{rungLabel}</Text> : null}
      </View>
      {turn.prompt.trim() ? (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showPrompt }}
            onPress={() => setShowPrompt(!showPrompt)}
            style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
          >
            <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
              {showPrompt ? "Hide prompt ▴" : "Show prompt ▾"}
            </Text>
          </Pressable>
          {showPrompt ? (
            <Text selectable style={{ color: theme.colors.foregroundMuted, fontFamily: "Menlo", fontSize: 12, lineHeight: 18, backgroundColor: theme.colors.surface2, padding: 8, borderRadius: 6 }}>
              {turn.prompt}
            </Text>
          ) : null}
        </View>
      ) : null}
      <FormattedBody theme={theme} text={turn.text} />
    </View>
  );
}

function Transcript({ theme, threadId, tries = [] }: { theme: PluginTheme; threadId: string; tries?: AttemptView[] }) {
  const [pickedThread, setPickedThread] = useState<string | undefined>();
  const activeThread = tries.some((a) => a.threadId === pickedThread) ? pickedThread! : threadId;
  const read = useRpc(transcriptRpc);
  const q = useQuery({ queryKey: ["clyde", "transcript", activeThread], queryFn: () => read({ threadId: activeThread }) });
  const t = q.data?.data;
  const pal = tones(theme);
  return (
    <View style={{ padding: 12, gap: 10, backgroundColor: theme.colors.surface2 }}>
      {tries.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {[...tries].reverse().map((a, idx) => {
            const selected = a.threadId === activeThread;
            return (
              <Pressable
                key={a.threadId}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => setPickedThread(a.threadId)}
                style={{
                  minHeight: MIN_HIT_HEIGHT,
                  justifyContent: "center",
                  paddingHorizontal: 10,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: selected ? theme.colors.accent : theme.colors.border,
                  backgroundColor: selected ? theme.colors.surface1 : "transparent",
                }}
              >
                <Text style={{ color: selected ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: 12, fontWeight: selected ? "700" : "500" }}>
                  #{a.n}{idx === 0 ? " (latest)" : ""} · {a.outcome}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {q.isPending ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Reading…</Text>
      ) : !t ? (
        <Text accessibilityRole="alert" style={{ color: pal.red.ink, fontSize: 13 }}>{formatRpcError(q.data?.error ?? q.error ?? "No transcript.")}</Text>
      ) : (
        <>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{t.threadId} · {t.rung}</Text>
          {t.turns.map((turn) => (
            <TurnCard key={turn.n} theme={theme} turn={turn} rungLabel={t.rung} />
          ))}
        </>
      )}
    </View>
  );
}

function timeAgo(iso:string){const age=ago(iso);return age==="just now"?age:age+" ago";}

function Meta({ theme, view }: { theme: PluginTheme; view: TaskView }) {
  const quiet = view.status === "running" && view.lastActivity && Date.now() - Date.parse(view.lastActivity) > QUIET_MS;
  const bits = [`Started ${timeAgo(view.startedAt)}`, `${view.passed} of ${view.total} pieces passed`];
  if (view.diff) bits.push(`${view.diff.commits} commit${view.diff.commits === 1 ? "" : "s"} · ${view.diff.files} files +${view.diff.insertions} −${view.diff.deletions}`);
  if (view.background) bits.push(`${view.background} agent${view.background === 1 ? "" : "s"} working`);
  const t = tones(theme);
  return (
    <View style={{ marginTop: 6, gap: 4 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{bits.join("  ·  ")}</Text>
      {view.lastActivity ? (
        <Text style={{ color: quiet ? t.amber.ink : theme.colors.foregroundMuted, fontSize: 12, fontWeight: quiet ? "700" : "400" }}>
          {quiet ? `Quiet for ${ago(view.lastActivity)}. It may be stuck.` : `Last activity ${timeAgo(view.lastActivity)}`}{view.branch ? `  ·  ${view.branch}` : ""}
        </Text>
      ) : null}
    </View>
  );
}

function Steering({id,theme}:{id:string;theme:PluginTheme}) {
  const send=useRpc(steerRpc);
  const [note,setNote]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function submit() {
    setBusy(true);
    try { await send({id,text:note}); setNote(""); setError(""); }
    catch(e) { setError(formatRpcError(e)); } finally { setBusy(false); }
  }
  return <View style={{marginTop:10,gap:6}}>
    <TextInput
      accessibilityLabel="Steer this run"
      placeholder="Steer this run"
      placeholderTextColor={theme.colors.foregroundMuted}
      style={{
        color:theme.colors.foreground,
        backgroundColor:theme.colors.surface1,
        borderWidth:1,
        borderColor:theme.colors.border,
        borderRadius:6,
        paddingHorizontal:10,
        paddingVertical:8,
        minHeight:MIN_HIT_HEIGHT,
        fontSize:14,
      }}
      value={note}
      onChangeText={setNote}
    />
    {note.trim() && (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={()=>void submit()}
        style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
      >
        <Text style={{color:theme.colors.accent, fontSize:13, fontWeight:"600"}}>{busy ? "Sending…" : "Send instruction"}</Text>
      </Pressable>
    )}
    {error && <Text accessibilityRole="alert" style={{color:theme.colors.statusDanger, fontSize:13}}>{error}</Text>}
  </View>;
}

function StopButton({ theme, view }: { theme: PluginTheme; view: TaskView }) {
  const stop = useRpc(stopRpc);
  const client = useQueryClient();
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const t = tones(theme);
  const press = async () => {
    if (!armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 5000);
      return;
    }
    setArmed(false);
    const r = await stop({ kind: view.kind, id: view.id }).catch((err: Error) => ({ ok: false, error: formatRpcError(err) }));
    if (!r.ok) setError(r.error ? formatRpcError(r.error) : "Clyde didn't stop it.");
    void client.invalidateQueries({ queryKey: ["clyde"] });
  };
  return (
    <View style={{ alignItems: "flex-end" }}>
      <Pressable accessibilityRole="button" onPress={press} style={{
        borderWidth: 1, borderColor: armed ? t.red.ink : theme.colors.border, backgroundColor: armed ? t.red.soft : "transparent",
        borderRadius: 6, minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingHorizontal: 12,
      }}>
        <Text style={{ color: armed ? t.red.ink : theme.colors.foregroundMuted, fontSize: 12, fontWeight: armed ? "700" : "400" }}>{armed ? "Press again to stop" : "Stop"}</Text>
      </Pressable>
      {error ? <Text accessibilityRole="alert" style={{ color: t.red.ink, fontSize: 12, marginTop: 4 }}>{error}</Text> : null}
    </View>
  );
}

export function TaskScreen({ theme, view, back, openAgent }: { theme: PluginTheme; view: TaskView; back: () => void; openAgent?: (id: string) => void }) {
  const answer=useRpc(answerRpc), cache=useQueryClient();
  const [reply,setReply]=useState(""),[retryError,setRetryError]=useState(""),[retrying,setRetrying]=useState(false);
  const t = tones(theme);
  async function sendAnswer(text: string, allowFullAccess?: boolean){
    setRetrying(true);
    try{const r=await answer({kind:view.kind,id:view.id,text,askKey:view.askKey,...(allowFullAccess?{allowAntigravityFullAccess:true}:{})});if(!r.ok)throw Error(r.error);setReply("");setRetryError("");await cache.invalidateQueries({queryKey:["clyde"]});}
    catch(e){setRetryError(formatRpcError(e));}finally{setRetrying(false);}
  }
  const [picked, setPicked] = useState<string | undefined>();
  const [details, setDetails] = useState(false);
  const [showRouting,setShowRouting]=useState(false);
  const all = view.steps.flatMap((s) => s.pieces);
  const piece = all.find((p) => p.id === (picked ?? view.selected)) ?? all[0];
  const tries = piece ? piece.phases.flatMap((ph) => view.attempts[ph.stage] ?? []) : [];
  const lastThread = tries[tries.length - 1]?.threadId;
  return (
    <View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
        <View style={{ flexShrink: 1 }}>
          <Pressable accessibilityRole="button" onPress={back} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}><Eyebrow theme={theme}>{`Clyde / Task / ${STATUS_LABEL[view.status]}`}</Eyebrow></Pressable>
          <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 23, fontWeight: "700", marginTop: 4 }}>{view.name}</Text>
          <Meta theme={theme} view={view} />
        </View>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <RemoveTask theme={theme} kind={view.kind} id={view.id} name={view.name} active={["running","asking","sent-back"].includes(view.status)} onRemoved={back}/>
          {view.status === "running" || view.status === "asking" ? <StopButton theme={theme} view={view} /> : null}
          <Pressable accessibilityRole="button" onPress={back} style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingHorizontal: 12 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>Home</Text>
          </Pressable>
        </View>
      </View>

      <View style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.border, paddingVertical: 20 }}>

        {view.goal ? <Text style={{ color: theme.colors.foreground, marginTop: 10, lineHeight: 20, fontSize: 14, fontWeight: "500" }}>{view.goal}</Text> : null}
        <Text style={{ color: theme.colors.foregroundMuted, marginTop: 6, lineHeight: 20, fontSize: 13 }}>{view.summary}</Text>
        {view.kind === "run" && view.status === "running" && <Steering id={view.id} theme={theme}/>}
        <RunEvidence view={view} theme={theme}/>
        {!!view.routing?.length && <Pressable accessibilityRole="button" accessibilityState={{expanded:showRouting}} onPress={()=>setShowRouting(!showRouting)} style={{marginTop:12, minHeight: MIN_HIT_HEIGHT, justifyContent: "center"}}>
          <Text style={{color:theme.colors.accent,fontSize:13, fontWeight:"600"}}>Why these agents? {showRouting?"▴":"▾"}</Text>
        </Pressable>}
        {showRouting && view.routing?.map(line => <Text key={line} style={{color:theme.colors.foregroundMuted, fontSize:13}}>{line}</Text>)}
        {view.question ? (
          <View style={{ borderLeftWidth: 2, borderLeftColor: t.amber.ink, paddingLeft: 12, marginTop: 12, gap: 8 }}>
            <Text style={{ color: theme.colors.foreground, fontWeight: "500", fontSize: 14 }}>{view.question}</Text>
            {view.retryable ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: retrying }}
                disabled={retrying}
                onPress={()=>void sendAnswer("retry",view.fullAccess)}
                style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
              >
                <Text style={{color:theme.colors.accent,fontWeight:"700",fontSize:13}}>
                  {retrying ? "Retrying…" : view.fullAccess ? "Allow full access for this run and retry" : "Retry"}
                </Text>
              </Pressable>
            ) : (
              <View style={{ gap: 8 }}>
                <TextInput
                  accessibilityLabel={view.approve ? "Request a change" : "Reply to question"}
                  placeholder={view.approve ? "Request a change…" : "Reply…"}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  value={reply}
                  onChangeText={setReply}
                  style={{
                    color: theme.colors.foreground,
                    backgroundColor: theme.colors.surface1,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    borderRadius: 6,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    minHeight: MIN_HIT_HEIGHT,
                    fontSize: 14,
                  }}
                />
                <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  {view.approve && (() => {
                    const approveDisabled = retrying || !!reply.trim();
                    return (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ disabled: approveDisabled }}
                        disabled={approveDisabled}
                        onPress={() => void sendAnswer("yes")}
                        style={{
                          backgroundColor: approveDisabled ? theme.colors.surface2 : theme.colors.accent,
                          borderWidth: approveDisabled ? 1 : 0,
                          borderColor: theme.colors.border,
                          borderRadius: 6,
                          paddingHorizontal: 14,
                          minHeight: MIN_HIT_HEIGHT,
                          justifyContent: "center",
                        }}
                      >
                        <Text style={{ color: approveDisabled ? theme.colors.foregroundMuted : theme.colors.accentForeground, fontWeight: "700", fontSize: 13 }}>Approve plan</Text>
                      </Pressable>
                    );
                  })()}
                  {(() => {
                    const replyDisabled = retrying || !reply.trim();
                    const primary = !view.approve;
                    return (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ disabled: replyDisabled }}
                        disabled={replyDisabled}
                        onPress={() => void sendAnswer(reply.trim())}
                        style={{
                          backgroundColor: primary && !replyDisabled ? theme.colors.accent : theme.colors.surface2,
                          borderWidth: primary && !replyDisabled ? 0 : 1,
                          borderColor: theme.colors.border,
                          borderRadius: 6,
                          paddingHorizontal: 14,
                          minHeight: MIN_HIT_HEIGHT,
                          justifyContent: "center",
                        }}
                      >
                        <Text style={{ color: replyDisabled ? theme.colors.foregroundMuted : primary ? theme.colors.accentForeground : theme.colors.foreground, fontWeight: "600", fontSize: 13 }}>
                          {retrying ? "Sending…" : view.approve ? "Request changes" : "Send reply"}
                        </Text>
                      </Pressable>
                    );
                  })()}
                </View>
              </View>
            )}
            {!!retryError && <Text accessibilityRole="alert" style={{color:theme.colors.statusDanger, fontSize:13}}>{retryError}</Text>}
          </View>
        ) : null}
      </View>

      <View style={{ paddingVertical: 20 }}>
        <Text accessibilityRole="header" style={{color:theme.colors.foreground,fontSize:17,fontWeight:"700"}}>Plan</Text>
        <Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "700", marginTop: 10 }}>
          {count(view.total, "piece", true)} in {count(view.steps.length, "row")}
        </Text>
        <FlowDiagram theme={theme} view={view} selected={piece?.id} select={setPicked} />
        <Legend theme={theme} />
      </View>

      {piece ? (
        <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingVertical: 20 }}>
          <Ladder theme={theme} level="L2" label="Selected piece" />
          <PieceDetail theme={theme} view={view} piece={piece} />
        </View>
      ) : null}

      <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingVertical: 20 }}>
        <Ladder theme={theme} level="L3" label="Details" />
        <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, marginTop: 10, overflow: "hidden" }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: details }}
            onPress={() => setDetails(!details)}
            style={{ paddingHorizontal: 12, minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "700" }}>
              {details ? "▾" : "▸"} Transcript of the agent on this piece
            </Text>
          </Pressable>
          {details && lastThread ? <Transcript theme={theme} threadId={lastThread} tries={tries} /> : null}
        </View>
        {view.agentId && openAgent ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => openAgent(view.agentId!)}
            style={{ marginTop: 8, minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
          >
            <Text style={{ color: t.blue.ink, fontSize: 13, fontWeight: "700" }}>Open this task's conversation in Paseo</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
