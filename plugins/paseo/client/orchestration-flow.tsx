import type { PluginTheme } from "@getpaseo/plugin";
import { useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { Phase, Piece, Status, TaskView } from "../shared/clyde";
import { edgePalette, hue, MIN_HIT_HEIGHT, STATUS_LABEL, tones, type EdgeKind } from "./palette";

const WORDS = [
  "no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];

function countWords(n: number, noun: string, capital = false): string {
  const word = WORDS[n] ?? String(n);
  const head = capital ? word[0].toUpperCase() + word.slice(1) : word;
  return `${head} ${noun}${n === 1 ? "" : "s"}`;
}

function stageDuration(from: string | undefined, to?: string, now = Date.now()): string {
  if (!from) return "";
  const m = Math.max(0, Math.round(((to ? Date.parse(to) : now) - Date.parse(from)) / 60_000));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr ${m % 60} min`;
}

export type FlowNode = {
  id: string;
  badge?: string;
  title: string;
  status?: Status;
  note?: string;
  end?: string;
  piece?: Piece;
  stage?: string;
  agentId?: string;
  observed: boolean;
  worker?: string;
  action?: string;
  meta?: string;
  handoff?: boolean;
  sentBack?: number;
  gate?: "pass" | "fail" | "pending";
  verdict?: "pass" | "fail" | "pending";
  phases?: Phase[];
};

export type FlowBand = {
  id: string;
  name: string;
  nodes: FlowNode[];
};

function pieceMeta(piece: Piece): string | undefined {
  const parts: string[] = [];
  if (piece.attempts) parts.push(`${piece.attempts} attempt${piece.attempts === 1 ? "" : "s"}`);
  if (piece.sentBack) parts.push(`sent back ${piece.sentBack}`);
  if (piece.startedAt) parts.push(stageDuration(piece.startedAt, piece.endedAt));
  return parts.length ? parts.join(" · ") : undefined;
}

function gateForPiece(piece: Piece, view: TaskView): "pass" | "fail" | "pending" {
  const checks = piece.phases.flatMap(phase => view.attempts[phase.stage]?.at(-1)?.checks ?? []);
  if (checks.length) return checks.some(c => c.code !== 0) ? "fail" : "pass";
  if (piece.status === "passed" || piece.status === "done") return "pass";
  if (piece.status === "failed") return "fail";
  return "pending";
}

export function flowEdgeKind(from: FlowNode, to: FlowNode): EdgeKind {
  if (to.status === "asking") return "ask";
  if (to.status === "running" || to.status === "sent-back") return "live";
  if (from.handoff) return "memory";
  return "order";
}

export function orchestrationNodes(view: TaskView): FlowNode[] {
  const pieces = view.steps.flatMap(step => step.pieces);
  const stageFor = (piece: Piece) =>
    piece.phases.find(phase => ["running", "asking", "sent-back", "failed"].includes(phase.status))?.stage ||
    piece.phases[0]?.stage;
  const actual = (piece: Piece, title = piece.title): FlowNode => ({
    id: piece.id,
    badge: `${piece.id} · PIECE`,
    title,
    piece,
    stage: stageFor(piece),
    agentId: piece.agentId ?? piece.phases.flatMap(phase => view.attempts[phase.stage] ?? []).reverse().find(a => a.agentId)?.agentId,
    status: piece.status,
    observed: piece.phases.some(phase => (view.attempts[phase.stage]?.length ?? 0) > 0) || piece.status !== "pending",
    worker: piece.rung,
    action: piece.progress,
    end: piece.doneWhen?.[0],
    meta: pieceMeta(piece),
    handoff: piece.handoff,
    sentBack: piece.sentBack,
    gate: gateForPiece(piece, view),
    verdict: piece.verdict,
    phases: piece.phases.length > 1 ? piece.phases : undefined,
  });
  const plan = pieces.find(piece => piece.id === "PLAN" || piece.phases.some(phase => /^plan(-\d+)?$/.test(phase.stage)));
  if (!plan) return pieces.map(piece => actual(piece));
  const builds = pieces.filter(piece => piece !== plan && !piece.phases.some(phase => phase.stage === "review"));
  const review = pieces.find(piece => piece.phases.some(phase => phase.stage === "review"));
  return [
    actual(plan, "Plan"),
    {
      id: "approval-gate",
      badge: "GATE · APPROVE",
      title: "Approve",
      observed: !!view.planApproval || view.approve,
      status: view.planApproval || (view.approve ? "asking" : undefined),
      note: view.planApproval === "passed"
        ? "Plan approved"
        : view.planApproval === "sent-back"
        ? "Changes requested"
        : view.approve
        ? "Your approval is needed"
        : "Approval gate",
      end: "Confirm scope and slices before building",
      gate: view.planApproval === "passed" ? "pass" : view.planApproval === "sent-back" ? "fail" : "pending",
      verdict: view.planApproval === "passed" ? "pass" : view.planApproval === "sent-back" ? "fail" : "pending",
    },
    ...(builds.length
      ? builds.map(piece => actual(piece, `Build · ${piece.title}`))
      : [{
          id: "future-build",
          badge: "BUILD · SLICES",
          title: "Build",
          observed: false,
          note: "Slices appear after planning",
          end: "Each slice runs works, good, and clean with judge checks",
        }]),
    review
      ? actual(review, "Review")
      : {
          id: "future-review",
          badge: "REVIEW · AUDIT",
          title: "Review",
          observed: false,
          note: "After the build",
          end: "Independent read-only audit of the whole branch",
        },
  ];
}

const MAX_ROW_PIECES = 3;

/** Group workflow nodes into classic horizontal step bands (Plan, Approve, Build slices in rows, Review). */
export function orchestrationBands(view: TaskView): FlowBand[] {
  const nodes = orchestrationNodes(view);
  if (!nodes.length) return [];
  const planNode = nodes.find(n => n.id === "PLAN");
  const approveNode = nodes.find(n => n.id === "approval-gate");
  if (!planNode && !approveNode) {
    const out: FlowBand[] = [];
    for (let i = 0; i < nodes.length; i += MAX_ROW_PIECES) {
      const slice = nodes.slice(i, i + MAX_ROW_PIECES);
      out.push({ id: `band-${i}`, name: nodes.length === 1 ? "Task" : `Step ${Math.floor(i / MAX_ROW_PIECES) + 1}`, nodes: slice });
    }
    return out;
  }
  const bands: FlowBand[] = [];
  if (planNode && approveNode) {
    bands.push({ id: "band-plan", name: "Plan & approve", nodes: [planNode, approveNode] });
  } else if (planNode) {
    bands.push({ id: "band-plan", name: "Plan", nodes: [planNode] });
  }
  const reviewNode = nodes.find(n => n.id === "REVIEW" || n.id === "future-review");
  const builds = nodes.filter(n => n !== planNode && n !== approveNode && n !== reviewNode);
  if (builds.length) {
    for (let i = 0; i < builds.length; i += MAX_ROW_PIECES) {
      const row = builds.slice(i, i + MAX_ROW_PIECES);
      const from = i + 1, to = i + row.length;
      const name = builds.length === 1 && row[0].id === "future-build"
        ? "Build slices"
        : row.length > 1
        ? `Build · Slices ${from}–${to}`
        : `Build · Slice ${from}`;
      bands.push({ id: `band-build-${i}`, name, nodes: row });
    }
  }
  if (reviewNode) {
    bands.push({ id: "band-review", name: "Verify & review", nodes: [reviewNode] });
  }
  return bands;
}

// 8px grid geometry for the classic multi-band workflows graph.
const U = 8;
const LABEL_W = 16 * U; // 128px left gutter for step band title & progress
const GAP = 3 * U;      // 24px gap between cards
const CELL_W = 30 * U;  // 240px piece card width
const CELL_H = 35 * U;  // 280px giant piece card height (fits title, agent, end/now, phases, metrics & footer)
const BAND_PAD = 2.5 * U; // 20px vertical band padding
const BAND_H = CELL_H + 2 * BAND_PAD; // 320px band height
const ROW_GAP = 5 * U;  // 40px orthogonal routing corridor between bands
const LINE = 2;

export function bandFlowLayout(bands: FlowBand[], available: number) {
  const cols = Math.max(2, ...bands.map(b => b.nodes.length));
  const minW = LABEL_W + GAP + cols * (CELL_W + GAP);
  const width = Math.max(minW, available > 0 ? available : minW);
  const height = bands.length ? bands.length * BAND_H + (bands.length - 1) * ROW_GAP : 0;
  const positions = new Map<string, { x: number; y: number }>();
  const bandRects = bands.map((band, row) => {
    const top = row * (BAND_H + ROW_GAP);
    band.nodes.forEach((node, col) => {
      positions.set(node.id, {
        x: LABEL_W + GAP + col * (CELL_W + GAP),
        y: top + BAND_PAD,
      });
    });
    return { band, row, top };
  });
  return { width, height, bandRects, positions, cellW: CELL_W, cellH: CELL_H, bandH: BAND_H, labelW: LABEL_W };
}

// Kept for responsive grid layout calculations and existing tests.
const NODE_W = 204, NODE_H = 176, GAP_X = 32, GAP_Y = 34;
export function flowLayout(count: number, available: number, compact = false) {
  const columns = Math.min(count, available >= 640 ? 4 : available >= 480 ? 3 : available >= 310 ? 2 : 1);
  const nodeHeight = compact ? 84 : NODE_H;
  const nodeWidth = Math.max(132, Math.min(NODE_W, Math.floor((available - GAP_X * (columns - 1)) / columns)));
  const positions = Array.from({ length: count }, (_, i) => {
    const row = Math.floor(i / columns), col = i % columns;
    return { x: (row % 2 ? columns - 1 - col : col) * (nodeWidth + GAP_X), y: row * (nodeHeight + GAP_Y) };
  });
  return {
    positions,
    nodeWidth,
    nodeHeight,
    width: columns * (nodeWidth + GAP_X) - GAP_X,
    height: Math.ceil(count / columns) * (nodeHeight + GAP_Y) - GAP_Y,
  };
}

function PipeSeg({ x, y, w, h, color, style }: { x: number; y: number; w: number; h: number; color: string; style: "solid" | "dashed" | "dotted" }) {
  const horizontal = h <= LINE;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: horizontal ? Math.max(LINE, w) : LINE,
        height: horizontal ? LINE : Math.max(LINE, h),
        borderColor: color,
        borderStyle: style,
        ...(horizontal ? { borderTopWidth: LINE } : { borderLeftWidth: LINE }),
      }}
    />
  );
}

function NodePhaseStrip({ phases, theme }: { phases: Phase[]; theme: PluginTheme }) {
  return (
    <View style={{ flexDirection: "row", gap: 4 }}>
      {phases.map(p => (
        <View key={p.stage} style={{ flex: 1, gap: 2 }}>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: p.status === "pending" ? theme.colors.border : hue(p.status, theme).ink }} />
          <Text numberOfLines={1} style={{ fontSize: 12, color: p.status === "pending" ? theme.colors.foregroundMuted : hue(p.status, theme).ink, fontWeight: "600" }}>
            {p.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Metric({ theme, label, value, tone }: { theme: PluginTheme; label: string; value: string; tone: Status }) {
  const ink = tone === "pending" ? theme.colors.foregroundMuted : hue(tone, theme).ink;
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{label}</Text>
      <Text numberOfLines={1} style={{ color: ink, fontSize: 12, fontWeight: "700" }}>{value}</Text>
    </View>
  );
}

function FlowLegend({ theme }: { theme: PluginTheme }) {
  const edges = edgePalette(theme);
  return (
    <View style={{ flexDirection: "row", gap: 16, flexWrap: "wrap", paddingTop: 4 }}>
      {(Object.keys(edges) as EdgeKind[]).map(kind => (
        <View key={kind} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 22, borderTopWidth: LINE, borderColor: edges[kind].color, borderStyle: edges[kind].style }} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{edges[kind].label}</Text>
        </View>
      ))}
    </View>
  );
}

const verdictStatus = (v?: "pass" | "fail" | "pending"): Status => (v === "pass" ? "passed" : v === "fail" ? "failed" : "pending");
const verdictLabel = (v?: "pass" | "fail" | "pending") => (v === "pass" ? "Pass" : v === "fail" ? "Fail" : "Pending");

export function OrchestrationFlow({ theme, view, selectedStage, onSelect, onOpenAgent }: {
  theme: PluginTheme;
  view: TaskView;
  selectedStage?: string;
  onSelect: (stage: string) => void;
  onOpenAgent?: (agentId: string) => void;
}) {
  const [width, setWidth] = useState(0);
  const bands = orchestrationBands(view);
  const flat = bands.flatMap(b => b.nodes);
  if (!flat.length) return null;
  const layout = bandFlowLayout(bands, width);
  const c = theme.colors;
  const t = tones(theme);
  const edges = edgePalette(theme);

  const pipeElements: ReactElement[] = [];
  flat.forEach((node, i) => {
    if (!i) return;
    const prev = flat[i - 1];
    const a = layout.positions.get(prev.id)!;
    const b = layout.positions.get(node.id)!;
    const kind = flowEdgeKind(prev, node);
    const edge = edges[kind];
    if (a.y === b.y) {
      const startX = a.x + CELL_W;
      const midY = a.y + CELL_H / 2;
      pipeElements.push(
        <PipeSeg key={`e-${node.id}`} x={startX} y={midY - LINE / 2} w={GAP} h={LINE} color={edge.color} style={edge.style} />,
        <Text key={`arr-${node.id}`} pointerEvents="none" style={{ position: "absolute", left: b.x - 10, top: midY - 9, color: edge.color, fontSize: 12, fontWeight: "700" }}>▸</Text>,
      );
      return;
    }
    // Down out of the last card of row R, across the corridor between bands, down into the first card of row R+1.
    const midY = a.y + CELL_H + BAND_PAD + ROW_GAP / 2;
    const ax = a.x + CELL_W / 2;
    const bx = b.x + CELL_W / 2;
    pipeElements.push(
      <PipeSeg key={`e1-${node.id}`} x={ax - LINE / 2} y={a.y + CELL_H} w={LINE} h={midY - (a.y + CELL_H)} color={edge.color} style={edge.style} />,
      <PipeSeg key={`e2-${node.id}`} x={Math.min(ax, bx) - LINE / 2} y={midY - LINE / 2} w={Math.abs(ax - bx) + LINE} h={LINE} color={edge.color} style={edge.style} />,
      <PipeSeg key={`e3-${node.id}`} x={bx - LINE / 2} y={midY} w={LINE} h={b.y - midY} color={edge.color} style={edge.style} />,
      <Text key={`arr-${node.id}`} pointerEvents="none" style={{ position: "absolute", left: bx - 5, top: b.y - 13, color: edge.color, fontSize: 12, fontWeight: "700" }}>▾</Text>,
    );
  });

  return (
    <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ gap: 10 }}>
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ width: 24, height: 24, borderRadius: 5, backgroundColor: c.surface2, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "700" }}>L1</Text>
          </View>
          <Text style={{ color: c.foregroundMuted, fontSize: 12, letterSpacing: 1, fontWeight: "700" }}>PLAN FLOW</Text>
        </View>
        <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "700" }}>
          {countWords(bands.length, "step", true)}, {countWords(flat.length, "piece")}
        </Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          Click a piece to inspect on the right. Chat ↗ opens its agent in native Paseo.
        </Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ paddingVertical: 4 }}>
        <View accessibilityLabel="Orchestration workflow" style={{ position: "relative", width: layout.width, height: layout.height }}>
          {layout.bandRects.map(({ band, row, top }) => {
            const doneCount = band.nodes.filter(n => n.status === "passed" || n.status === "done").length;
            return (
              <View key={band.id}>
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    left: 0,
                    top,
                    width: layout.width,
                    height: BAND_H,
                    borderRadius: 10,
                    backgroundColor: c.surface2,
                    borderWidth: 1,
                    borderColor: c.border,
                  }}
                />
                <View style={{ position: "absolute", left: U * 1.5, top: top + BAND_PAD, width: LABEL_W - 2 * U, gap: 4 }}>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "700", letterSpacing: 0.8 }}>
                    STEP {String(row + 1).padStart(2, "0")}
                  </Text>
                  <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "700", lineHeight: 18 }}>
                    {band.name}
                  </Text>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                    {doneCount} of {band.nodes.length} done
                  </Text>
                </View>
              </View>
            );
          })}

          {pipeElements}

          {flat.map(node => {
            const selected = !!selectedStage && !!node.piece?.phases.some(phase => phase.stage === selectedStage);
            const pos = layout.positions.get(node.id)!;
            const statusKey: Status = node.status ?? "pending";
            const statusText = node.status ? STATUS_LABEL[node.status] : "Planned";
            const statusHue = hue(statusKey, theme);
            const railColor = node.observed ? statusHue.ink : c.border;
            const endLine = node.action || node.end || node.note;
            const canOpenAgent = Boolean(node.agentId && onOpenAgent);
            const a11yLabel = [node.title, statusText, node.worker, node.meta, canOpenAgent ? "open agent chat" : undefined].filter(Boolean).join(", ");
            const cardStyle = {
              position: "absolute" as const,
              left: pos.x,
              top: pos.y,
              width: CELL_W,
              height: CELL_H,
              minHeight: MIN_HIT_HEIGHT,
              padding: 12,
              gap: 6,
              borderRadius: 8,
              borderWidth: selected ? 2 : 1,
              borderLeftWidth: 4,
              borderStyle: node.observed ? "solid" as const : "dashed" as const,
              borderColor: selected ? c.accent : c.border,
              borderLeftColor: selected ? c.accent : railColor,
              backgroundColor: node.observed ? c.surface1 : c.surface0,
              overflow: "hidden" as const,
            };
            const body = (
              <>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                  <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "700", flexShrink: 1 }}>
                    {node.badge ?? node.id}
                  </Text>
                  <View style={{ backgroundColor: statusHue.soft, borderRadius: 5, paddingVertical: 2, paddingHorizontal: 6 }}>
                    <Text style={{ color: statusHue.ink, fontSize: 12, fontWeight: "700" }}>{statusText}</Text>
                  </View>
                </View>

                <Text numberOfLines={2} style={{ color: node.observed ? c.foreground : c.foregroundMuted, fontSize: 14, lineHeight: 19, fontWeight: "700", flexShrink: 0 }}>
                  {node.title}
                </Text>

                <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, flexShrink: 0 }}>
                  Agent: {node.worker || "Not started"}
                </Text>

                {!!endLine && (
                  <Text numberOfLines={2} style={{ color: node.action ? t.blue.ink : c.foregroundMuted, fontSize: 12, lineHeight: 17, flexShrink: 0 }}>
                    <Text style={{ fontWeight: "700", color: node.action ? t.blue.ink : c.foreground }}>{node.action ? "Now: " : "End: "}</Text>
                    {endLine}
                  </Text>
                )}

                {node.phases && <NodePhaseStrip phases={node.phases} theme={theme} />}

                <View style={{ flex: 1 }} />

                <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: 6, flexDirection: "row", gap: 8, flexShrink: 0 }}>
                  <Metric theme={theme} label="Gate" value={verdictLabel(node.gate)} tone={verdictStatus(node.gate)} />
                  <Metric theme={theme} label="Judge" value={verdictLabel(node.verdict)} tone={verdictStatus(node.verdict)} />
                  <Metric theme={theme} label="Back" value={String(node.sentBack ?? 0)} tone={node.sentBack ? "sent-back" : "pending"} />
                </View>

                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 6, flexShrink: 0 }}>
                  <Text numberOfLines={1} style={{ color: node.sentBack ? t.amber.ink : c.foregroundMuted, fontSize: 12, flex: 1 }}>
                    {node.meta || (node.observed ? "Active" : "Not started")}
                  </Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    {node.handoff && (
                      <Text numberOfLines={1} style={{ color: t.green.ink, fontSize: 12, fontWeight: "700" }}>↳ mem</Text>
                    )}
                    {canOpenAgent && (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Open ${node.title} agent in Paseo`}
                        onPress={(e) => {
                          (e as { stopPropagation?: () => void })?.stopPropagation?.();
                          onOpenAgent!(node.agentId!);
                        }}
                        style={{ paddingHorizontal: 4, paddingVertical: 2 }}
                      >
                        <Text numberOfLines={1} style={{ color: c.accent, fontSize: 12, fontWeight: "700" }}>Chat ↗</Text>
                      </Pressable>
                    )}
                  </View>
                </View>
              </>
            );
            const handlePress = () => {
              if (node.stage) onSelect(node.stage);
              else if (node.agentId && onOpenAgent) onOpenAgent(node.agentId);
            };
            return node.stage || canOpenAgent ? (
              <Pressable key={node.id} accessibilityRole="button" accessibilityLabel={a11yLabel} accessibilityState={{ selected }} onPress={handlePress} style={cardStyle}>
                {body}
              </Pressable>
            ) : (
              <View key={node.id} accessibilityLabel={a11yLabel} style={cardStyle}>
                {body}
              </View>
            );
          })}
        </View>
      </ScrollView>

      <FlowLegend theme={theme} />
    </View>
  );
}
