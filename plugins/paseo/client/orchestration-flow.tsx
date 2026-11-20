import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { Phase, Piece, Status, TaskView } from "../shared/clyde";
import { edgePalette, hue, MIN_HIT_HEIGHT, STATUS_LABEL, tones, type EdgeKind } from "./palette";

function stageDuration(from: string | undefined, to?: string, now = Date.now()): string {
  if (!from) return "";
  const m = Math.max(0, Math.round(((to ? Date.parse(to) : now) - Date.parse(from)) / 60_000));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr ${m % 60} min`;
}

const GLYPH: Record<Status, string> = {
  passed: "✓",
  done: "✓",
  failed: "✕",
  running: "●",
  "sent-back": "↺",
  asking: "?",
  pending: "○",
  skipped: "–",
};

export type FlowNode = {
  id: string;
  title: string;
  status?: Status;
  note?: string;
  piece?: Piece;
  stage?: string;
  observed: boolean;
  worker?: string;
  action?: string;
  meta?: string;
  handoff?: boolean;
  sentBack?: number;
  phases?: Phase[];
};

function pieceMeta(piece: Piece): string | undefined {
  const parts: string[] = [];
  if (piece.attempts) parts.push(`${piece.attempts} attempt${piece.attempts === 1 ? "" : "s"}`);
  if (piece.sentBack) parts.push(`sent back ${piece.sentBack}`);
  if (piece.startedAt) parts.push(stageDuration(piece.startedAt, piece.endedAt));
  return parts.length ? parts.join(" · ") : undefined;
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
    title,
    piece,
    stage: stageFor(piece),
    status: piece.status,
    observed: piece.phases.some(phase => (view.attempts[phase.stage]?.length ?? 0) > 0) || piece.status !== "pending",
    worker: piece.rung,
    action: piece.progress,
    meta: pieceMeta(piece),
    handoff: piece.handoff,
    sentBack: piece.sentBack,
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
    },
    ...(builds.length
      ? builds.map(piece => actual(piece, `Build · ${piece.title}`))
      : [{ id: "future-build", title: "Build", observed: false, note: "Slices appear after planning" }]),
    review ? actual(review, "Review") : { id: "future-review", title: "Review", observed: false, note: "After the build" },
  ];
}

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

function FlowLegend({ theme }: { theme: PluginTheme }) {
  const edges = edgePalette(theme);
  return (
    <View style={{ flexDirection: "row", gap: 14, flexWrap: "wrap", paddingTop: 2 }}>
      {(Object.keys(edges) as EdgeKind[]).map(kind => (
        <View key={kind} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 20, borderTopWidth: 2, borderColor: edges[kind].color, borderStyle: edges[kind].style }} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{edges[kind].label}</Text>
        </View>
      ))}
    </View>
  );
}

export function OrchestrationFlow({ theme, view, selectedStage, onSelect }: {
  theme: PluginTheme;
  view: TaskView;
  selectedStage?: string;
  onSelect: (stage: string) => void;
}) {
  const [width, setWidth] = useState(620);
  const nodes = orchestrationNodes(view);
  const compact = nodes.length === 1 && !nodes[0]?.note && !nodes[0]?.worker && !nodes[0]?.action && !nodes[0]?.phases;
  const layout = flowLayout(nodes.length, width, compact);
  const c = theme.colors;
  const t = tones(theme);
  const edges = edgePalette(theme);
  if (!nodes.length) return null;
  return (
    <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ gap: 8 }}>
      <ScrollView horizontal contentContainerStyle={{ paddingVertical: 2 }}>
        <View accessibilityLabel="Orchestration workflow" style={{ position: "relative", width: layout.width, height: layout.height }}>
          {nodes.slice(1).map((node, i) => {
            const fromNode = nodes[i];
            const from = layout.positions[i], to = layout.positions[i + 1], horizontal = from.y === to.y;
            const kind = flowEdgeKind(fromNode, node);
            const edge = edges[kind];
            const x = horizontal ? Math.min(from.x, to.x) + layout.nodeWidth : from.x + layout.nodeWidth / 2;
            const y = horizontal ? from.y + layout.nodeHeight / 2 : from.y + layout.nodeHeight;
            return (
              <View
                key={"edge-" + node.id}
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: x,
                  top: y,
                  width: horizontal ? GAP_X : 2,
                  height: horizontal ? 2 : GAP_Y,
                  borderTopWidth: horizontal ? 2 : 0,
                  borderLeftWidth: horizontal ? 0 : 2,
                  borderStyle: edge.style,
                  borderColor: edge.color,
                }}
              >
                <Text style={{ position: "absolute", left: horizontal ? GAP_X / 2 - 6 : -7, top: horizontal ? -10 : GAP_Y / 2 - 9, color: edge.color, fontSize: 12, fontWeight: "700", backgroundColor: c.surface1 }}>
                  {horizontal ? (to.x > from.x ? "→" : "←") : "↓"}
                </Text>
              </View>
            );
          })}
          {nodes.map((node, i) => {
            const selected = !!selectedStage && !!node.piece?.phases.some(phase => phase.stage === selectedStage);
            const position = layout.positions[i];
            const status = node.status ? STATUS_LABEL[node.status] : "Planned";
            const glyph = node.status ? GLYPH[node.status] : "○";
            const ink = node.status === "failed"
              ? c.statusDanger
              : node.status === "asking" || node.status === "sent-back"
              ? t.amber.ink
              : node.status === "running"
              ? c.accent
              : node.status === "passed" || node.status === "done"
              ? t.green.ink
              : c.foregroundMuted;
            const detail = node.action || node.note;
            const body = (
              <>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                  <Text numberOfLines={1} style={{ color: ink, fontSize: 12, fontWeight: "700", flexShrink: 1 }}>
                    {glyph} {status}
                  </Text>
                  {node.handoff && (
                    <Text numberOfLines={1} style={{ color: t.green.ink, fontSize: 12, fontWeight: "600" }}>↳ mem</Text>
                  )}
                </View>
                <Text numberOfLines={2} style={{ color: c.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>
                  {node.title}
                </Text>
                {!!node.worker && (
                  <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12 }}>
                    {node.worker}
                  </Text>
                )}
                {!!detail && (
                  <Text numberOfLines={1} style={{ color: node.action ? t.blue.ink : c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>
                    {detail}
                  </Text>
                )}
                <View style={{ flex: 1 }} />
                {node.phases && <NodePhaseStrip phases={node.phases} theme={theme} />}
                {!!node.meta && (
                  <Text numberOfLines={1} style={{ color: node.sentBack ? t.amber.ink : c.foregroundMuted, fontSize: 12 }}>
                    {node.meta}
                  </Text>
                )}
              </>
            );
            const style = {
              position: "absolute" as const,
              left: position.x,
              top: position.y,
              width: layout.nodeWidth,
              height: layout.nodeHeight,
              minHeight: MIN_HIT_HEIGHT,
              padding: 10,
              gap: 3,
              overflow: "hidden" as const,
              borderRadius: 8,
              borderWidth: selected ? 2 : 1,
              borderStyle: node.observed ? "solid" as const : "dashed" as const,
              borderColor: selected ? c.accent : c.border,
              backgroundColor: selected ? c.surface2 : c.surface1,
            };
            const a11yLabel = [node.title, status, node.worker, node.meta].filter(Boolean).join(", ");
            return node.stage ? (
              <Pressable key={node.id} accessibilityRole="button" accessibilityLabel={a11yLabel} accessibilityState={{ selected }} onPress={() => onSelect(node.stage!)} style={style}>
                {body}
              </Pressable>
            ) : (
              <View key={node.id} accessibilityLabel={a11yLabel} style={style}>
                {body}
              </View>
            );
          })}
        </View>
      </ScrollView>
      {nodes.length > 1 && <FlowLegend theme={theme} />}
    </View>
  );
}
