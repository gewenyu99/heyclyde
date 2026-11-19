import { RunEvidence } from "./run-evidence";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import { Pressable, TextInput, ScrollView, Text, View } from "react-native";
import { steerRpc, stopRpc, transcriptRpc, type AttemptView, type Phase, type Piece, type Status, type TaskView } from "../shared/clyde";
import { ago, count, duration, Eyebrow, hue, Ladder, PALETTE, Pill, STATUS_LABEL } from "./nodes";

// Everything on the 8px grid: a gutter for the row label, fixed piece cells, fixed gaps, one band per row.
const U = 8;
const LABEL_W = 13 * U;
const GAP = 3 * U;
const CELL_W = 26 * U;
const CELL_H = 19 * U;
const BAND_PAD = 2 * U;
const BAND_H = CELL_H + 2 * BAND_PAD;
const ROW_GAP = 5 * U;
const LINE = 2;
// A running task that has been silent this long gets flagged, the way CI flags a stuck job.
const QUIET_MS = 10 * 60_000;

type Edge = "order" | "ask" | "memory" | "live";
const EDGE: Record<Edge, { color: string; style: "solid" | "dashed" | "dotted"; label: string }> = {
  order: { color: "#20211f", style: "solid", label: "Order" },
  ask: { color: PALETTE.purple.ink, style: "dotted", label: "Asks you" },
  memory: { color: PALETTE.green.ink, style: "solid", label: "Handed off through memory" },
  live: { color: PALETTE.amber.ink, style: "dashed", label: "Live work" },
};

/** Into a live piece the edge is live, into an asking one it asks Wen, after a piece that wrote to memory it's a hand-off. */
function edgeBetween(from: Piece, to: Piece): Edge {
  if (to.status === "asking") return "ask";
  if (to.status === "running" || to.status === "sent-back") return "live";
  if (from.handoff) return "memory";
  return "order";
}

/** One orthogonal segment. A horizontal segment draws with a top border, a vertical one with a left border. */
function Seg({ x, y, w, h, kind }: { x: number; y: number; w: number; h: number; kind: Edge }) {
  const e = EDGE[kind];
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
function PhaseBar({ phases,theme }: { phases: Phase[];theme:PluginTheme }) {
  if (phases.length < 2) return null;
  return (
    <View style={{ flexDirection: "row", gap: 4 }}>
      {phases.map((p) => (
        <View key={p.stage} style={{ flex: 1, gap: 3 }}>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: p.status === "pending" ? theme.colors.border : hue(p.status).ink }} />
          <Text numberOfLines={1} style={{ fontSize: 9, color: p.status === "pending" ? theme.colors.foregroundMuted : hue(p.status).ink, fontWeight: "600" }}>{p.label}</Text>
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
  const h = hue(p.status);
  const pending = p.status === "pending";
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${p.id} ${p.title}`} onPress={onPress} style={{
      position: "absolute", left: x, top: y, width: CELL_W, height: CELL_H, padding: 12, borderRadius: 8,
      borderWidth: selected ? 2 : 1, borderColor: selected ? PALETTE.blue.ink : theme.colors.border,
      backgroundColor: pending ? theme.colors.surface2 : theme.colors.surface1, gap: 6,
    }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "700", letterSpacing: 0.6 }}>{p.id}</Text>
        <Text style={{ color: h.ink, fontSize: 12, fontWeight: "700" }}>{GLYPH[p.status]}</Text>
      </View>
      <Text numberOfLines={3} style={{ color: pending ? theme.colors.foregroundMuted : theme.colors.foreground, fontWeight: "600", fontSize: 12, lineHeight: 16 }}>{p.title}</Text>
      <View style={{ flex: 1 }} />
      <PhaseBar theme={theme} phases={p.phases} />
      <Text numberOfLines={1} style={{ color: p.sentBack ? PALETTE.amber.ink : theme.colors.foregroundMuted, fontSize: 10 }}>{footer(p)}</Text>
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
        <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "700" }}>{step.name}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, marginTop: 4 }}>{done} of {step.pieces.length} done</Text>
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
      segs.push(<Seg key={`e-${p.id}`} x={a.x + CELL_W} y={a.y + CELL_H / 2 - LINE / 2} w={GAP} h={LINE} kind={kind} />);
      return;
    }
    // Down out of the last piece, across the gap between rows, down into the first piece of the next row.
    const midY = a.y + CELL_H + BAND_PAD + ROW_GAP / 2;
    const ax = a.x + CELL_W / 2;
    const bx = b.x + CELL_W / 2;
    segs.push(
      <Seg key={`e1-${p.id}`} x={ax - LINE / 2} y={a.y + CELL_H} w={LINE} h={midY - (a.y + CELL_H)} kind={kind} />,
      <Seg key={`e2-${p.id}`} x={Math.min(ax, bx) - LINE / 2} y={midY - LINE / 2} w={Math.abs(ax - bx) + LINE} h={LINE} kind={kind} />,
      <Seg key={`e3-${p.id}`} x={bx - LINE / 2} y={midY} w={LINE} h={b.y - midY} kind={kind} />,
    );
  });
  return (
    <ScrollView horizontal contentContainerStyle={{ paddingVertical: 8 }}>
      <View style={{ width, height }}>{bands}{segs}{cells}</View>
    </ScrollView>
  );
}

function Legend({ theme }: { theme: PluginTheme }) {
  return (
    <View style={{ flexDirection: "row", gap: 16, marginTop: 12, flexWrap: "wrap" }}>
      {(Object.keys(EDGE) as Edge[]).map((k) => (
        <View key={k} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 24, borderTopWidth: LINE, borderColor: EDGE[k].color, borderStyle: EDGE[k].style }} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{EDGE[k].label}</Text>
        </View>
      ))}
    </View>
  );
}

/** One attempt as a single line, with only what went wrong under it. Passing criteria aren't news. */
function AttemptRow({ theme, a }: { theme: PluginTheme; a: AttemptView }) {
  const [open, setOpen] = useState(false);
  const fails = a.criteria.filter((c) => c.result === "fail");
  const tone: Status = a.interrupted ? "pending" : /passed|done/i.test(a.outcome) ? "passed" : /sent back|failed/i.test(a.outcome) ? "sent-back" : "running";
  return (
    <View style={{ borderLeftWidth: 2, borderLeftColor: hue(tone).ink, paddingLeft: 10, paddingVertical: 6, marginTop: 4, opacity: a.interrupted ? 0.55 : 1 }}>
      <Pressable onPress={() => setOpen(!open)} style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 11, flexShrink: 1 }}>
          <Text style={{ fontWeight: "700" }}>#{a.n}</Text>  {a.rung ?? ""}  ·  {duration(a.startedAt, a.endedAt)}
        </Text>
        <Text style={{ color: hue(tone).ink, fontSize: 11, fontWeight: "700" }}>{a.outcome}</Text>
      </Pressable>
      {fails.map((c, i) => (
        <View key={i} style={{ marginTop: 6 }}>
          <Text style={{ color: PALETTE.red.ink, fontSize: 11, fontWeight: "600" }}>✕ {c.criterion}</Text>
          {c.evidence ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, marginTop: 2, lineHeight: 16 }}>{c.evidence}</Text> : null}
        </View>
      ))}
      {a.checks.filter((c) => c.code !== 0).map((c, i) => (
        <Text key={i} style={{ fontFamily: "Menlo", fontSize: 10, color: PALETTE.red.ink, marginTop: 4 }}>$ {c.cmd} → exit {c.code}</Text>
      ))}
      {open ? (
        <View style={{ marginTop: 6, gap: 4 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9, fontWeight: "700", letterSpacing: 0.6 }}>WORKER SAID</Text>
          <Text style={{ color: theme.colors.foreground, fontSize: 11, lineHeight: 16 }}>{a.evidence}</Text>
          {a.criteria.filter((c) => c.result === "pass").map((c, i) => (
            <Text key={i} style={{ color: PALETTE.green.ink, fontSize: 11 }}>✓ {c.criterion}</Text>
          ))}
          {a.judgeRung ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>Judged by {a.judgeRung}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function PieceDetail({ theme, view, piece }: { theme: PluginTheme; view: TaskView; piece: Piece }) {
  return (
    <View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginTop: 10, gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "700", flexShrink: 1 }}>{piece.id} · {piece.title}</Text>
        <Pill status={piece.status} label={`${STATUS_LABEL[piece.status].toUpperCase()}${piece.sentBack ? ` · SENT BACK ${piece.sentBack}` : ""}`} />
      </View>
      {piece.progress ? <Text style={{ color: PALETTE.blue.ink, fontSize: 12, marginTop: 6 }}>Now: {piece.progress}</Text> : null}
      {piece.doneWhen.length ? (
        <View style={{ marginTop: 12 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9, fontWeight: "700", letterSpacing: 0.6 }}>DONE WHEN THESE PASS</Text>
          {piece.doneWhen.map((c, i) => (
            <Text key={i} numberOfLines={2} style={{ fontFamily: "Menlo", fontSize: 10, color: theme.colors.foreground, marginTop: 4 }}>$ {c}</Text>
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
              <Text style={{ color: hue(ph.status).ink, fontWeight: "700" }}>{GLYPH[ph.status]}</Text>
              <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "700" }}>{ph.label}</Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                {tries.length ? `${STATUS_LABEL[ph.status].toLowerCase()} · ${duration(first.startedAt, ph.status === "passed" ? last.endedAt : undefined)}` : "not started"}
              </Text>
            </View>
            {tries.map((a) => <AttemptRow key={a.n} theme={theme} a={a} />)}
          </View>
        );
      })}
    </View>
  );
}

function Transcript({ theme, threadId }: { theme: PluginTheme; threadId: string }) {
  const read = useRpc(transcriptRpc);
  const q = useQuery({ queryKey: ["clyde", "transcript", threadId], queryFn: () => read({ threadId }) });
  const t = q.data?.data;
  if (q.isPending) return <Text style={{ color: theme.colors.foregroundMuted, padding: 12 }}>Reading…</Text>;
  if (!t) return <Text style={{ color: PALETTE.red.ink, padding: 12 }}>{q.data?.error ?? "No transcript."}</Text>;
  return (
    <View style={{ padding: 12, gap: 10, backgroundColor: theme.colors.surface2 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{t.threadId} · {t.rung}</Text>
      {t.turns.map((turn) => (
        <View key={turn.n}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "700" }}>TURN {turn.n} · {ago(turn.at)} ago</Text>
          <Text style={{ fontFamily: "Menlo", fontSize: 10, color: theme.colors.foreground, marginTop: 4 }}>{turn.text || "(no text yet)"}</Text>
        </View>
      ))}
    </View>
  );
}

function Meta({ theme, view }: { theme: PluginTheme; view: TaskView }) {
  const quiet = view.status === "running" && view.lastActivity && Date.now() - Date.parse(view.lastActivity) > QUIET_MS;
  const bits = [`Started ${ago(view.startedAt)} ago`, `${view.passed} of ${view.total} pieces passed`];
  if (view.diff) bits.push(`${view.diff.commits} commit${view.diff.commits === 1 ? "" : "s"} · ${view.diff.files} files +${view.diff.insertions} −${view.diff.deletions}`);
  if (view.background) bits.push(`${view.background} agent${view.background === 1 ? "" : "s"} working`);
  return (
    <View style={{ marginTop: 6, gap: 4 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{bits.join("  ·  ")}</Text>
      {view.lastActivity ? (
        <Text style={{ color: quiet ? PALETTE.amber.ink : theme.colors.foregroundMuted, fontSize: 11, fontWeight: quiet ? "700" : "400" }}>
          {quiet ? `Quiet for ${ago(view.lastActivity)}. It may be stuck.` : `Last activity ${ago(view.lastActivity)} ago`}{view.branch ? `  ·  ${view.branch}` : ""}
        </Text>
      ) : null}
    </View>
  );
}

/** Stop takes two presses: the first arms it, the second stops the task. It disarms after five seconds. */
function Steering({id,theme}:{id:string;theme:PluginTheme}) {
  const send=useRpc(steerRpc);
  const [note,setNote]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function submit() {
    setBusy(true);
    try { await send({id,text:note}); setNote(""); setError(""); }
    catch(e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <View style={{marginTop:10,gap:4}}>
    <TextInput accessibilityLabel="Steer this run" placeholder="Steer this run" style={{color:theme.colors.foreground}} value={note} onChangeText={setNote}/>
    {note.trim() && <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void submit()}><Text style={{color:theme.colors.accent}}>Send instruction</Text></Pressable>}
    {error && <Text style={{color:theme.colors.statusDanger}}>{error}</Text>}
  </View>;
}

function StopButton({ theme, view }: { theme: PluginTheme; view: TaskView }) {
  const stop = useRpc(stopRpc);
  const client = useQueryClient();
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const press = async () => {
    if (!armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 5000);
      return;
    }
    setArmed(false);
    const r = await stop({ kind: view.kind, id: view.id }).catch((err: Error) => ({ ok: false, error: err.message }));
    if (!r.ok) setError(r.error ?? "Clyde didn't stop it.");
    void client.invalidateQueries({ queryKey: ["clyde"] });
  };
  return (
    <View style={{ alignItems: "flex-end" }}>
      <Pressable accessibilityRole="button" onPress={press} style={{
        borderWidth: 1, borderColor: armed ? PALETTE.red.ink : theme.colors.border, backgroundColor: armed ? PALETTE.red.soft : "transparent",
        borderRadius: 6, paddingVertical: 7, paddingHorizontal: 10,
      }}>
        <Text style={{ color: armed ? PALETTE.red.ink : theme.colors.foregroundMuted, fontSize: 11, fontWeight: armed ? "700" : "400" }}>{armed ? "Press again to stop" : "Stop"}</Text>
      </Pressable>
      {error ? <Text style={{ color: PALETTE.red.ink, fontSize: 10, marginTop: 4 }}>{error}</Text> : null}
    </View>
  );
}

export function TaskScreen({ theme, view, back, openAgent }: { theme: PluginTheme; view: TaskView; back: () => void; openAgent?: (id: string) => void }) {
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
          <Pressable onPress={back}><Eyebrow theme={theme}>{`Clyde / Task / ${STATUS_LABEL[view.status]}`}</Eyebrow></Pressable>
          <Text style={{ color: theme.colors.foreground, fontSize: 23, fontWeight: "700", marginTop: 6 }}>{view.name}</Text>
          <Meta theme={theme} view={view} />
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {view.status === "running" || view.status === "asking" ? <StopButton theme={theme} view={view} /> : null}
          <Pressable onPress={back} style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, paddingVertical: 7, paddingHorizontal: 10 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Home</Text>
          </Pressable>
        </View>
      </View>

      <View style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.border, paddingVertical: 20 }}>

        {view.goal ? <Text style={{ color: theme.colors.foreground, marginTop: 10, lineHeight: 20, fontWeight: "500" }}>{view.goal}</Text> : null}
        <Text style={{ color: theme.colors.foregroundMuted, marginTop: 6, lineHeight: 20 }}>{view.summary}</Text>
        {view.kind === "run" && view.status === "running" && <Steering id={view.id} theme={theme}/>}
        <RunEvidence view={view} theme={theme}/>
        {!!view.routing?.length && <Pressable accessibilityRole="button" accessibilityState={{expanded:showRouting}} onPress={()=>setShowRouting(!showRouting)} style={{marginTop:12}}>
          <Text style={{color:theme.colors.accent,fontSize:12}}>Why these agents? {showRouting?"▴":"▾"}</Text>
        </Pressable>}
        {showRouting && view.routing?.map(line => <Text key={line} style={{color:theme.colors.foregroundMuted}}>{line}</Text>)}
        {view.question ? (
          <View style={{ borderLeftWidth: 2, borderLeftColor: PALETTE.amber.ink, paddingLeft: 10, marginTop: 12 }}>
            <Text style={{ color: theme.colors.foreground, fontWeight: "500" }}>{view.question}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, marginTop: 4 }}>Answer it from Home.</Text>
          </View>
        ) : null}
      </View>

      <View style={{ paddingVertical: 20 }}>
        <Text style={{color:theme.colors.foreground,fontSize:17,fontWeight:"700"}}>Plan</Text>
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
          <Pressable onPress={() => setDetails(!details)} style={{ padding: 12 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "700" }}>
              {details ? "▾" : "▸"} Transcript of the agent on this piece
            </Text>
          </Pressable>
          {details && lastThread ? <Transcript theme={theme} threadId={lastThread} /> : null}
        </View>
        {view.agentId && openAgent ? (
          <Pressable onPress={() => openAgent(view.agentId!)} style={{ marginTop: 12 }}>
            <Text style={{ color: PALETTE.blue.ink, fontSize: 11, fontWeight: "700" }}>Open this task's conversation in Paseo</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
