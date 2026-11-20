import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { boardRpc, newQuestRpc, projectsRpc, questProjectMatches, sharedBoardRpc, spawnQuestRpc, type BoardQuest } from "../shared/clyde";
import { artwork, palette } from "./brand.generated";
import { formatRpcError, MIN_HIT_HEIGHT, scheme, tones } from "./palette";
import { requestId } from "./request-id";

export type QuestStampKind = "picked-up" | "needs-review" | "done" | "abandoned";
export type QuestStampSpec = { kind: QuestStampKind; label: string; detail?: string; tone: "blue" | "amber" | "green" | "red" };

/** Resolve the classic rubber stamp for a quest's current state (open quests stay unstamped). */
export function questStamp(q: BoardQuest): QuestStampSpec | null {
  const state = (q.state || "open").toLowerCase();
  if (state === "done") {
    return { kind: "done", label: "DONE", detail: q.claimed_by || undefined, tone: "green" };
  }
  if (state === "abandoned") {
    return { kind: "abandoned", label: "ABANDONED", tone: "red" };
  }
  if (q.needs_review || ["review", "needs_review", "in_review"].includes(state)) {
    const detail = q.run_status === "asking" ? "awaiting you" : q.claimed_by || undefined;
    return { kind: "needs-review", label: "NEEDS REVIEW", detail, tone: "amber" };
  }
  if (state === "claimed" || q.run_id) {
    return { kind: "picked-up", label: "PICKED UP", detail: q.claimed_by || undefined, tone: "blue" };
  }
  return null;
}

export function stickyColumns(width: number): number {
  if (width >= 920) return 3;
  if (width >= 540) return 2;
  return 1;
}

type StickyPaper = {
  bg: string;
  strip: string;
  edge: string;
  tape: string;
  tilt: string;
  tapeTilt: string;
  offsetY: number;
  briefLines: number;
};

const LIGHT_NOTES = [
  { bg: "#fef4c7", strip: "#f8e48c", edge: "#e2ca6a", tape: "rgba(255,255,255,0.68)" }, // butter yellow
  { bg: "#e3f2fd", strip: "#c5e1fa", edge: "#9fc5e8", tape: "rgba(255,255,255,0.72)" }, // soft sky
  { bg: "#e4f7e7", strip: "#c4eccb", edge: "#95cf9f", tape: "rgba(255,255,255,0.72)" }, // pale mint
  { bg: "#ffedd8", strip: "#fad8b3", edge: "#e4b887", tape: "rgba(255,255,255,0.70)" }, // warm peach
  { bg: "#f9f1df", strip: "#efe0be", edge: "#d8c499", tape: "rgba(255,255,255,0.68)" }, // warm cream
];

const DARK_NOTES = [
  { bg: "#2b2615", strip: "#38311a", edge: "#574c29", tape: "rgba(255,255,255,0.12)" }, // warm ochre
  { bg: "#17222e", strip: "#1e2e3f", edge: "#324c68", tape: "rgba(255,255,255,0.12)" }, // slate sky
  { bg: "#16261d", strip: "#1d3326", edge: "#315440", tape: "rgba(255,255,255,0.12)" }, // pine mint
  { bg: "#2b1f18", strip: "#3a2a20", edge: "#5c4232", tape: "rgba(255,255,255,0.12)" }, // warm umber
  { bg: "#24231d", strip: "#302f27", edge: "#4d4b3f", tape: "rgba(255,255,255,0.12)" }, // parchment
];

const TILTS = ["-1.8deg", "1.3deg", "-0.9deg", "1.9deg", "-1.4deg", "0.7deg", "-2.1deg", "1.5deg"];
const TAPE_TILTS = ["2.5deg", "-3deg", "1.8deg", "-2.2deg", "3.2deg", "-1.5deg"];
const OFFSETS = [0, 8, 2, 12, 4, 10];

export function stickyVisual(q: BoardQuest, mode: "light" | "dark", finished: boolean, expanded: boolean): StickyPaper {
  const paper = palette[mode];
  const hash = Math.abs((q.id * 2654435761) >>> 0);
  const swatch = finished
    ? { bg: paper["paper-0"], strip: paper["paper-2"], edge: paper["rule-strong"], tape: mode === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)" }
    : q.id % 5 === 0
    ? { bg: paper.sticky, strip: paper["sticky-strip"], edge: paper["sticky-edge"], tape: mode === "dark" ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.70)" }
    : (mode === "dark" ? DARK_NOTES : LIGHT_NOTES)[hash % LIGHT_NOTES.length];
  const briefLen = (q.brief || "").trim().length;
  const briefLines = briefLen > 180 ? 5 : briefLen > 110 ? 4 : briefLen > 50 ? 3 : 2;
  return {
    ...swatch,
    tilt: expanded || finished ? "0deg" : TILTS[hash % TILTS.length],
    tapeTilt: TAPE_TILTS[hash % TAPE_TILTS.length],
    offsetY: expanded ? 0 : OFFSETS[hash % OFFSETS.length],
    briefLines,
  };
}

/** Pack sticky notes into masonry columns by estimated visual height so cards naturally stagger. */
export function distributeMasonry<T extends BoardQuest>(items: T[], cols: number, expandedId: number | null): T[][] {
  const count = Math.max(1, cols);
  const columns: T[][] = Array.from({ length: count }, () => []);
  const heights = Array.from({ length: count }, () => 0);
  for (const item of items) {
    let shortest = 0;
    for (let i = 1; i < count; i++) {
      if (heights[i] < heights[shortest]) shortest = i;
    }
    columns[shortest].push(item);
    const est = 120 + Math.min(180, (item.title?.length ?? 0) * 1.1 + (item.brief?.length ?? 0) * 0.55) +
      ((item.tags?.length ?? 0) > 0 ? 28 : 0) +
      (item.id === expandedId ? 240 : 0);
    heights[shortest] += est;
  }
  return columns;
}

export type QuestProjectOption = {
  id: string;
  name: string;
  slug: string;
  path: string;
  kind: string;
  eligible: boolean;
  workspaces: { id: string; name: string; path: string }[];
  chats: { id: string; title: string; provider: string; updatedAt: string }[];
};

/** Resolve an unambiguous project and workspace for one-click quest acceptance. */
export function resolveQuestTarget(
  quest: BoardQuest,
  projects: readonly QuestProjectOption[] | undefined,
  pinnedWorkspaceId?: string,
): { project: QuestProjectOption; workspaceId?: string } | null {
  if (!projects?.length) return null;
  const matching = projects.filter(p => p.eligible !== false && questProjectMatches(p.slug, quest.project));
  if (pinnedWorkspaceId) {
    const pinned = matching.find(p => p.workspaces.some(w => w.id === pinnedWorkspaceId)) ?? (matching.length === 1 ? matching[0] : undefined);
    return pinned ? { project: pinned, workspaceId: pinnedWorkspaceId } : null;
  }
  if (matching.length !== 1) return null;
  const project = matching[0];
  if (project.kind !== "git") {
    const rootWs = project.workspaces.find(w => w.path === project.path);
    return { project, workspaceId: rootWs?.id };
  }
  if (project.workspaces.length === 0) return { project };
  if (project.workspaces.length === 1) return { project, workspaceId: project.workspaces[0].id };
  const primary = project.workspaces.find(w => w.path === project.path) ?? project.workspaces[0];
  return { project, workspaceId: primary?.id };
}

function RubberStamp({ theme, stamp }: { theme: PluginTheme; stamp: QuestStampSpec }) {
  const t = tones(theme);
  const mode = scheme(theme);
  const paper = palette[mode];
  const color = t[stamp.tone];
  return (
    <View
      accessibilityLabel={`${stamp.label}${stamp.detail ? `, ${stamp.detail}` : ""}`}
      style={{
        alignSelf: "flex-start",
        borderWidth: 2,
        borderColor: color.ink,
        backgroundColor: color.soft,
        borderRadius: 4,
        paddingVertical: 3,
        paddingHorizontal: 8,
        transform: [{ rotate: "-4deg" }],
        shadowColor: paper.ink,
        shadowOpacity: mode === "dark" ? 0.35 : 0.12,
        shadowRadius: 2,
        shadowOffset: { width: 1, height: 1 },
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <Text style={{ color: color.ink, fontFamily: "Menlo", fontSize: 12, fontWeight: "700", letterSpacing: 1.1 }}>
          {stamp.label}
        </Text>
        {!!stamp.detail && (
          <Text numberOfLines={1} style={{ color: color.ink, fontFamily: "Menlo", fontSize: 12, fontWeight: "500", maxWidth: 130 }}>
            {stamp.detail}
          </Text>
        )}
      </View>
    </View>
  );
}

export function Quests({ theme, agent: activeAgent, workspaceId, onStarted }: {
  theme: PluginTheme;
  agent?: string;
  workspaceId?: string;
  onStarted: (id: string) => void;
}) {
  const c = theme.colors;
  const mode = scheme(theme);
  const paper = palette[mode];
  const t = tones(theme);
  const [boardWidth, setBoardWidth] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"active" | "picked" | "finished">("active");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [startingId, setStartingId] = useState<number | null>(null);
  const [project, setProject] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [existing, setExisting] = useState(false);
  const [chosen, setChosen] = useState("");
  const [menu, setMenu] = useState<"project" | "workspace" | "chat" | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const locked = useRef(false);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const read = useRpc(sharedBoardRpc), readProjects = useRpc(projectsRpc), scoped = useRpc(boardRpc);
  const startNew = useRpc(newQuestRpc), spawn = useRpc(spawnQuestRpc), cache = useQueryClient();
  const query = useQuery({ queryKey: ["clyde", "shared-quests"], queryFn: () => read({}), refetchInterval: 30000, retry: false });
  // Load projects eagerly so clicking Accept on any sticky note starts an orchestrated task in one click.
  const projects = useQuery({ queryKey: ["clyde", "projects", workspaceId ?? "all"], queryFn: () => readProjects({ workspaceId }) });
  const projectList = Array.isArray(projects.data) ? projects.data : [];
  const allQuests = query.data?.quests ?? [];
  const currentQuest = allQuests.find(q => q.id === expanded);
  // Match the server's canonical slug; project names and path basenames can collide.
  const targets = projectList.filter(p => p.eligible !== false && questProjectMatches(p.slug, currentQuest?.project));
  const target = targets.find(p => p.id === project) ?? (targets.length === 1 ? targets[0] : undefined);
  const workspaces = target?.workspaces ?? [];
  const targetWorkspace = workspaceId || workspaces.find(w => w.id === workspace)?.id || (target?.kind === "git" && workspaces.length === 1 ? workspaces[0].id : undefined);
  const needsWorkspace = target?.kind === "git" && !targetWorkspace && workspaces.length > 1;
  const chats = target?.chats ?? [];
  const agent = chats.find(chat => chat.id === chosen)?.id || chats.find(chat => chat.id === activeAgent)?.id;
  const matches = useQuery({ queryKey: ["clyde", "eligible-quests", agent], queryFn: () => scoped({ agent: agent! }), enabled: existing && !!agent, refetchInterval: 30000, retry: false });
  const eligible = new Set(matches.data?.map(q => q.id) ?? []);
  const term = search.trim().toLowerCase().replace(/^#/, "");
  const isFinished = (q: BoardQuest) => q.state === "done" || q.state === "abandoned";
  const isPickedOrReview = (q: BoardQuest) => !isFinished(q) && (q.state === "claimed" || q.needs_review || !!q.run_id || ["review", "needs_review", "in_review"].includes((q.state || "").toLowerCase()));
  const activeCount = allQuests.filter(q => !isFinished(q)).length;
  const pickedCount = allQuests.filter(isPickedOrReview).length;
  const finishedCount = allQuests.filter(isFinished).length;
  const quests = allQuests.filter(q =>
    (filter === "finished" ? isFinished(q) : filter === "picked" ? isPickedOrReview(q) : !isFinished(q)) &&
    (!term || [String(q.id), q.title, q.project, q.claimed_by, ...(q.tags ?? [])].some(field => field?.toLowerCase().includes(term)))
  );
  const colCount = stickyColumns(boardWidth);
  const columns = distributeMasonry(quests, colCount, expanded);

  async function launchQuest(id: number, target: { id: string }, targetWorkspace?: string, useExistingAgentId?: string) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setStartingId(id);
    setError("");
    const key = JSON.stringify([id, target.id, targetWorkspace ?? ""]);
    if (pending.current?.key !== key) pending.current = { key, id: requestId() };
    try {
      const run = useExistingAgentId
        ? await spawn({ agent: useExistingAgentId, quest: id })
        : await startNew({ quest: id, project: target.id, ...(targetWorkspace ? { workspaceId: targetWorkspace } : {}), requestId: pending.current.id });
      pending.current = null;
      void cache.invalidateQueries({ queryKey: ["clyde"] });
      onStarted(run.id);
    } catch (e) {
      setExpanded(id);
      setError(formatRpcError(e));
    } finally {
      locked.current = false;
      setBusy(false);
      setStartingId(null);
    }
  }

  async function start(id: number) {
    if (!target || locked.current || (!existing && needsWorkspace) || (existing && (!agent || !eligible.has(id)))) return;
    await launchQuest(id, target, targetWorkspace, existing ? agent : undefined);
  }

  async function quickAccept(q: BoardQuest) {
    if (locked.current || busy) return;
    const assigned = !!q.assignee && q.assignee !== "any";
    if (!assigned) {
      const resolved = resolveQuestTarget(q, projectList as QuestProjectOption[], workspaceId);
      if (resolved) {
        await launchQuest(q.id, resolved.project, resolved.workspaceId);
        return;
      }
    }
    // Fall back to expanding the sticky note inline when a project/chat choice is required.
    setExpanded(q.id);
    setProject("");
    setWorkspace("");
    setChosen("");
    setExisting(assigned);
    setMenu(assigned ? "chat" : "project");
    setError("");
  }

  const button = (label: string, onPress: () => void, disabled = false, primary = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: MIN_HIT_HEIGHT,
        justifyContent: "center",
        alignSelf: "flex-start",
        backgroundColor: primary && !disabled ? c.accent : "transparent",
        borderRadius: 6,
        paddingHorizontal: primary ? 14 : 0,
      }}
    >
      <Text style={{ color: disabled ? c.foregroundMuted : primary ? c.accentForeground : c.accent, fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );

  const tabs: { id: "active" | "picked" | "finished"; label: string; count: number }[] = [
    { id: "active", label: "Active", count: activeCount },
    { id: "picked", label: "Picked up", count: pickedCount },
    { id: "finished", label: "Finished", count: finishedCount },
  ];

  return (
    <View
      onLayout={(e) => setBoardWidth(e.nativeEvent.layout.width)}
      style={{ flex: 1, minHeight: 0, gap: 12 }}
    >
      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon icon={artwork[mode].mark} size={26} color={c.foreground} />
            <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 18, fontWeight: "700" }}>Quests</Text>
          </View>
          {button("Refresh", () => { void query.refetch(); void projects.refetch(); if (agent) void matches.refetch(); }, busy)}
        </View>
        <TextInput
          accessibilityLabel="Find a quest"
          placeholder="Find a quest…"
          placeholderTextColor={c.foregroundMuted}
          value={search}
          onChangeText={setSearch}
          style={{ color: c.foreground, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 10, minHeight: MIN_HIT_HEIGHT, fontSize: 14 }}
        />
        <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
          {tabs.map(tab => {
            const selected = filter === tab.id;
            return (
              <Pressable
                key={tab.id}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                onPress={() => setFilter(tab.id)}
                style={{
                  minHeight: MIN_HIT_HEIGHT,
                  justifyContent: "center",
                  paddingHorizontal: 10,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: selected ? paper["rule-strong"] : "transparent",
                  backgroundColor: selected ? c.surface2 : "transparent",
                }}
              >
                <Text style={{ color: selected ? c.foreground : c.foregroundMuted, fontSize: 13, fontWeight: "600" }}>
                  {tab.label} ({tab.count})
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <ScrollView
        accessibilityLabel="Quest board"
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ gap: 16, paddingTop: 10, paddingBottom: 28, paddingHorizontal: 4 }}
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        {query.isPending ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Loading quests…</Text>
        ) : query.error ? (
          <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13 }}>{formatRpcError(query.error)}</Text>
        ) : !quests.length ? (
          <View style={{ borderWidth: 1, borderStyle: "dashed", borderColor: paper["rule-strong"], borderRadius: 10, padding: 24, alignItems: "center", gap: 8 }}>
            <Icon icon={artwork[mode].mark} size={36} color={c.foreground} />
            <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
              {term ? "No matching quests." : filter === "finished" ? "No finished quests." : filter === "picked" ? "No picked-up quests right now." : "No active quests."}
            </Text>
          </View>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 16 }}>
            {columns.map((col, colIdx) => (
              <View key={colIdx} style={{ flex: 1, minWidth: 0, gap: 18, paddingTop: colCount > 1 ? (colIdx % 2 === 1 ? 10 : 0) : 0 }}>
                {col.map(q => {
                  const stamp = questStamp(q);
                  const finished = isFinished(q);
                  const isOpen = (!q.state || q.state === "open") && !q.run_id && !q.needs_review;
                  const assigned = !!q.assignee && q.assignee !== "any";
                  const startDisabled = busy || !target || (existing ? !agent || !eligible.has(q.id) : needsWorkspace);
                  const highPriority = ["high", "urgent"].includes(q.priority);
                  const isExpanded = expanded === q.id;
                  const isStartingThis = startingId === q.id;
                  const note = stickyVisual(q, mode, finished, isExpanded);

                  return (
                    <View
                      key={q.id}
                      style={{
                        position: "relative",
                        marginTop: colCount > 1 ? note.offsetY : 0,
                        backgroundColor: note.bg,
                        borderWidth: 1,
                        borderColor: isExpanded ? c.accent : note.edge,
                        borderRadius: 4,
                        transform: [{ rotate: note.tilt }],
                        shadowColor: paper.ink,
                        shadowOpacity: mode === "dark" ? 0.45 : 0.14,
                        shadowRadius: 8,
                        shadowOffset: { width: 2, height: 4 },
                      }}
                    >
                      {/* Little translucent masking-tape tab pinned on top */}
                      <View
                        pointerEvents="none"
                        style={{
                          position: "absolute",
                          top: -8,
                          alignSelf: "center",
                          width: 48,
                          height: 15,
                          borderRadius: 2,
                          backgroundColor: note.tape,
                          borderWidth: 1,
                          borderColor: note.edge,
                          transform: [{ rotate: note.tapeTilt }],
                          zIndex: 2,
                        }}
                      />

                      {/* Sticky-note top adhesive header strip */}
                      <View
                        style={{
                          backgroundColor: note.strip,
                          borderBottomWidth: 1,
                          borderStyle: "dashed",
                          borderBottomColor: note.edge,
                          paddingHorizontal: 12,
                          paddingVertical: 8,
                          flexDirection: "row",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                        }}
                      >
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                          <Icon icon={artwork[mode].mark} size={16} color={paper.ink} />
                          <Text style={{ color: finished ? paper["ink-2"] : paper.ink, fontFamily: "Menlo", fontSize: 13, fontWeight: "700" }}>
                            #{q.id}
                          </Text>
                        </View>
                        <Text style={{ color: highPriority ? paper.bad : paper["ink-3"], fontFamily: "Menlo", fontSize: 12, fontWeight: "700", letterSpacing: 0.6 }}>
                          {q.priority.toUpperCase()}
                        </Text>
                      </View>

                      {/* Sticky-note body */}
                      <View style={{ padding: 13, gap: 10 }}>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Quest #${q.id} ${q.title}${stamp ? `, ${stamp.label}` : ", open"}`}
                          accessibilityState={{ expanded: isExpanded, disabled: busy }}
                          disabled={busy}
                          onPress={() => {
                            setExpanded(isExpanded ? null : q.id);
                            setProject("");
                            setWorkspace("");
                            setChosen("");
                            setExisting(assigned);
                            setMenu(null);
                            setError("");
                          }}
                          style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", gap: 8 }}
                        >
                          <Text style={{ color: finished ? paper["ink-2"] : paper.ink, fontSize: 15, lineHeight: 21, fontWeight: "700" }}>
                            {q.title}
                          </Text>

                          {stamp && <RubberStamp theme={theme} stamp={stamp} />}

                          {!isExpanded && !!q.brief && (
                            <Text numberOfLines={note.briefLines} style={{ color: paper["ink-2"], fontSize: 13, lineHeight: 19 }}>
                              {q.brief}
                            </Text>
                          )}

                          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                            <Text style={{ color: paper["ink-3"], fontFamily: "Menlo", fontSize: 12 }}>
                              {q.claimed_by ? `Picked up by ${q.claimed_by}` : `For ${q.assignee || "any"}`}
                              {q.project ? ` · ${q.project}` : ""}
                            </Text>
                            {(q.tags ?? []).slice(0, 4).map(tag => (
                              <View key={tag} style={{ backgroundColor: note.strip, borderRadius: 4, paddingVertical: 2, paddingHorizontal: 6 }}>
                                <Text style={{ color: paper["ink-2"], fontFamily: "Menlo", fontSize: 12 }}>{tag}</Text>
                              </View>
                            ))}
                          </View>
                        </Pressable>

                        {/* One-click Accept / Open action right on the sticky note */}
                        {isOpen && !isExpanded && (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Accept quest #${q.id} and open orchestrated task`}
                            accessibilityState={{ disabled: busy }}
                            disabled={busy}
                            onPress={() => void quickAccept(q)}
                            style={{
                              minHeight: MIN_HIT_HEIGHT,
                              justifyContent: "center",
                              alignItems: "center",
                              backgroundColor: busy ? note.strip : c.accent,
                              borderRadius: 6,
                              paddingHorizontal: 12,
                            }}
                          >
                            <Text style={{ color: busy ? c.foregroundMuted : c.accentForeground, fontSize: 13, fontWeight: "700" }}>
                              {isStartingThis ? "Opening task…" : "Accept quest →"}
                            </Text>
                          </Pressable>
                        )}

                        {!isOpen && q.run_id && !isExpanded && (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Open active run for quest #${q.id}`}
                            onPress={() => onStarted(q.run_id!)}
                            style={{
                              minHeight: MIN_HIT_HEIGHT,
                              justifyContent: "center",
                              alignItems: "center",
                              backgroundColor: t.blue.soft,
                              borderWidth: 1,
                              borderColor: t.blue.ink,
                              borderRadius: 6,
                              paddingHorizontal: 12,
                            }}
                          >
                            <Text style={{ color: t.blue.ink, fontSize: 13, fontWeight: "700" }}>Open active run ↗</Text>
                          </Pressable>
                        )}

                        {isExpanded && (
                          <View style={{ gap: 10, borderTopWidth: 1, borderStyle: "dashed", borderTopColor: note.edge, paddingTop: 10 }}>
                            {!!q.brief && <Text selectable style={{ color: paper.ink, fontSize: 13, lineHeight: 20 }}>{q.brief}</Text>}
                            {!!q.done_when && (
                              <View style={{ backgroundColor: note.strip, borderRadius: 6, padding: 10, gap: 3 }}>
                                <Text style={{ color: paper["ink-3"], fontFamily: "Menlo", fontSize: 12, fontWeight: "700", letterSpacing: 0.8 }}>DONE WHEN</Text>
                                <Text selectable style={{ color: paper.ink, fontSize: 13, lineHeight: 19 }}>{q.done_when}</Text>
                              </View>
                            )}
                            {q.run_id && (
                              <Pressable
                                accessibilityRole="button"
                                onPress={() => onStarted(q.run_id!)}
                                style={{
                                  minHeight: MIN_HIT_HEIGHT,
                                  justifyContent: "center",
                                  alignSelf: "flex-start",
                                  backgroundColor: t.blue.soft,
                                  borderWidth: 1,
                                  borderColor: t.blue.ink,
                                  borderRadius: 6,
                                  paddingHorizontal: 12,
                                }}
                              >
                                <Text style={{ color: t.blue.ink, fontSize: 13, fontWeight: "700" }}>Open active run ↗</Text>
                              </Pressable>
                            )}
                            {isOpen ? (
                              <>
                                {assigned && <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Assigned to {q.assignee}</Text>}
                                {button((target?.name || "Choose a project") + " ▾", () => setMenu(menu === "project" ? null : "project"), busy || projects.isPending)}
                                {menu === "project" && (
                                  <View style={{ paddingLeft: 10 }}>
                                    {targets.map(p => (
                                      <Pressable key={p.id} accessibilityRole="button" accessibilityState={{ selected: target?.id === p.id, disabled: busy }} disabled={busy} onPress={() => { setProject(p.id); setWorkspace(""); setChosen(""); setMenu(null); setError(""); }} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
                                        <Text style={{ color: target?.id === p.id ? c.accent : c.foreground, fontSize: 13 }}>{p.name}</Text>
                                        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{p.path}</Text>
                                      </Pressable>
                                    ))}
                                  </View>
                                )}
                                {!target && !projects.isPending && (
                                  <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
                                    {targets.length ? "Choose where this quest should run." : currentQuest?.project ? "Open the quest’s project in Paseo to start it." : "Open a project in Paseo to start this quest."}
                                  </Text>
                                )}
                                {!existing && !workspaceId && target && workspaces.length > 0 && (target.kind !== "git" || workspaces.length > 1) && (
                                  <View>
                                    {button((workspaces.find(w => w.id === targetWorkspace)?.name || (target.kind === "git" ? "Choose a workspace" : "Project folder")) + " ▾", () => setMenu(menu === "workspace" ? null : "workspace"), busy)}
                                    {menu === "workspace" && target.kind !== "git" && button("Use project folder", () => { setWorkspace(""); setMenu(null); }, busy)}
                                    {menu === "workspace" && workspaces.map(w => (
                                      <Pressable key={w.id} accessibilityRole="button" accessibilityState={{ selected: targetWorkspace === w.id, disabled: busy }} disabled={busy} onPress={() => { setWorkspace(w.id); setMenu(null); setError(""); }} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingLeft: 10 }}>
                                        <Text style={{ color: targetWorkspace === w.id ? c.accent : c.foreground, fontSize: 13 }}>{w.name}</Text>
                                        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{w.path}</Text>
                                      </Pressable>
                                    ))}
                                  </View>
                                )}
                                {!existing ? (
                                  button(busy ? "Starting…" : "Start with new orchestrator", () => void start(q.id), startDisabled, true)
                                ) : (
                                  <View style={{ gap: 4 }}>
                                    {button((chats.find(chat => chat.id === agent)?.title || "Choose an existing chat") + " ▾", () => setMenu(menu === "chat" ? null : "chat"), busy || !target)}
                                    {menu === "chat" && chats.map(chat => (
                                      <Pressable key={chat.id} accessibilityRole="button" accessibilityState={{ selected: agent === chat.id, disabled: busy }} disabled={busy} onPress={() => { setChosen(chat.id); setMenu(null); setError(""); }} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingLeft: 10 }}>
                                        <Text style={{ color: agent === chat.id ? c.accent : c.foreground, fontSize: 13 }}>{chat.title}</Text>
                                      </Pressable>
                                    ))}
                                    {agent && matches.isPending && <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Checking chat…</Text>}
                                    {agent && matches.isSuccess && !eligible.has(q.id) && <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>This chat is not eligible for this quest.</Text>}
                                    {!chats.length && target && <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>No existing chats in this project. Start with a new orchestrator.</Text>}
                                    {button(busy ? "Starting…" : "Start in selected chat", () => void start(q.id), startDisabled)}
                                  </View>
                                )}
                                {!assigned && button(existing ? "Use a new orchestrator instead" : "Use an existing chat instead", () => { setExisting(!existing); setMenu(null); setError(""); }, busy)}
                                {!!error && <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13 }}>{error}</Text>}
                                {(projects.error || (existing && matches.error)) && <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13 }}>{formatRpcError(projects.error || matches.error)}</Text>}
                              </>
                            ) : q.state === "claimed" && (
                              <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Picked up by {q.claimed_by || "another agent"}</Text>
                            )}
                          </View>
                        )}
                      </View>

                      {/* Dog-ear folded sticky-note corner curl */}
                      {!finished && (
                        <View
                          pointerEvents="none"
                          style={{
                            position: "absolute",
                            right: 0,
                            bottom: 0,
                            width: 14,
                            height: 14,
                            backgroundColor: note.strip,
                            borderTopWidth: 1,
                            borderLeftWidth: 1,
                            borderColor: note.edge,
                            borderTopLeftRadius: 4,
                          }}
                        />
                      )}
                    </View>
                  );
                })}
              </View>
            ))}
          </View>
        )}

        {query.data?.legacy && (
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL("https://heyclyde.me/quests")} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
            <Text style={{ color: c.accent, fontSize: 13 }}>Full account history ↗</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}
