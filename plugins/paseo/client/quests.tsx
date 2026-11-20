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
        paddingVertical: 4,
        paddingHorizontal: 9,
        transform: [{ rotate: "-3deg" }],
        shadowColor: paper.ink,
        shadowOpacity: mode === "dark" ? 0.35 : 0.1,
        shadowRadius: 2,
        shadowOffset: { width: 1, height: 1 },
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <Text style={{ color: color.ink, fontFamily: "Menlo", fontSize: 12, fontWeight: "700", letterSpacing: 1.2 }}>
          {stamp.label}
        </Text>
        {!!stamp.detail && (
          <Text numberOfLines={1} style={{ color: color.ink, fontFamily: "Menlo", fontSize: 12, fontWeight: "500", maxWidth: 140 }}>
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
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"active" | "picked" | "finished">("active");
  const [expanded, setExpanded] = useState<number | null>(null);
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
  const projects = useQuery({ queryKey: ["clyde", "projects", workspaceId ?? "all"], queryFn: () => readProjects({ workspaceId }), enabled: expanded !== null });
  const allQuests = query.data?.quests ?? [];
  const currentQuest = allQuests.find(q => q.id === expanded);
  // Match the server's canonical slug; project names and path basenames can collide.
  const targets = (projects.data ?? []).filter(p => p.eligible !== false && questProjectMatches(p.slug, currentQuest?.project));
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
  async function start(id: number) {
    if (!target || locked.current || (!existing && needsWorkspace) || (existing && (!agent || !eligible.has(id)))) return;
    locked.current = true; setBusy(true); setError("");
    const key = JSON.stringify([id, target.id, targetWorkspace ?? ""]);
    if (pending.current?.key !== key) pending.current = { key, id: requestId() };
    try {
      const run = existing
        ? await spawn({ agent: agent!, quest: id })
        : await startNew({ quest: id, project: target.id, ...(targetWorkspace ? { workspaceId: targetWorkspace } : {}), requestId: pending.current.id });
      pending.current = null;
      void cache.invalidateQueries({ queryKey: ["clyde"] });
      onStarted(run.id);
    } catch (e) { setError(formatRpcError(e)); }
    finally { locked.current = false; setBusy(false); }
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
    <View style={{ flex: 1, minHeight: 0, gap: 12 }}>
      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon icon={artwork[mode].mark} size={26} color={c.foreground} />
            <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 18, fontWeight: "700" }}>Quests</Text>
          </View>
          {button("Refresh", () => { void query.refetch(); if (expanded !== null) void projects.refetch(); if (agent) void matches.refetch(); }, busy)}
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
        contentContainerStyle={{ gap: 14, paddingTop: 4, paddingBottom: 24, paddingRight: 4 }}
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
          quests.map(q => {
            const stamp = questStamp(q);
            const finished = isFinished(q);
            const isOpen = (!q.state || q.state === "open") && !q.run_id && !q.needs_review;
            const assigned = !!q.assignee && q.assignee !== "any";
            const startDisabled = busy || !target || (existing ? !agent || !eligible.has(q.id) : needsWorkspace);
            const highPriority = ["high", "urgent"].includes(q.priority);
            const isExpanded = expanded === q.id;
            const cardBg = finished ? paper["paper-0"] : paper["paper-1"];
            const stubBg = finished ? paper["paper-2"] : paper.sticky;
            const stubStrip = finished ? paper["rule"] : paper["sticky-strip"];
            const stubEdge = finished ? paper["rule-strong"] : paper["sticky-edge"];
            const notchBg = c.surface1;

            return (
              <View
                key={q.id}
                style={{
                  position: "relative",
                  flexDirection: "row",
                  backgroundColor: cardBg,
                  borderWidth: 1,
                  borderColor: isExpanded ? c.accent : finished ? paper["rule-strong"] : stubEdge,
                  borderRadius: 10,
                  overflow: "hidden",
                  shadowColor: paper.ink,
                  shadowOpacity: mode === "dark" ? 0.35 : 0.08,
                  shadowRadius: 6,
                  shadowOffset: { width: 1, height: 3 },
                }}
              >
                {/* Sticky-note perforated left stub, matching HeyClyde's .cl-quest__stub */}
                <View
                  style={{
                    width: 74,
                    backgroundColor: stubBg,
                    borderTopWidth: 0,
                    borderBottomWidth: 0,
                    borderLeftWidth: 0,
                    borderRightWidth: 1.5,
                    borderStyle: "dashed",
                    borderRightColor: stubEdge,
                    position: "relative",
                  }}
                >
                  <View style={{ height: 7, backgroundColor: stubStrip }} />
                  <View style={{ paddingVertical: 10, paddingHorizontal: 6, alignItems: "center", gap: 4 }}>
                    <Text style={{ color: paper["ink-3"], fontFamily: "Menlo", fontSize: 12, fontWeight: "600", letterSpacing: 0.8 }}>Nº</Text>
                    <Text style={{ color: finished ? paper["ink-2"] : paper.ink, fontFamily: "Menlo", fontSize: 18, fontWeight: "700" }}>{q.id}</Text>
                    <Text style={{ color: highPriority ? paper.bad : paper["ink-3"], fontFamily: "Menlo", fontSize: 12, fontWeight: "700", letterSpacing: 0.6 }}>
                      {q.priority.toUpperCase()}
                    </Text>
                  </View>
                  {/* Ticket punch notches on the perforated edge */}
                  <View pointerEvents="none" style={{ position: "absolute", top: -6, right: -6, width: 12, height: 12, borderRadius: 6, backgroundColor: notchBg, borderWidth: 1, borderColor: paper["rule-strong"] }} />
                  <View pointerEvents="none" style={{ position: "absolute", bottom: -6, right: -6, width: 12, height: 12, borderRadius: 6, backgroundColor: notchBg, borderWidth: 1, borderColor: paper["rule-strong"] }} />
                </View>

                {/* Main sticky-note work-order sheet */}
                <View style={{ flex: 1, minWidth: 0, padding: 14, gap: 10 }}>
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
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                      <Text style={{ flex: 1, minWidth: 140, color: finished ? paper["ink-2"] : paper.ink, fontSize: 15, lineHeight: 21, fontWeight: "700" }}>
                        {q.title}
                      </Text>
                      {stamp ? (
                        <RubberStamp theme={theme} stamp={stamp} />
                      ) : (
                        <View style={{ backgroundColor: paper.sticky, borderWidth: 1, borderColor: paper["sticky-edge"], borderRadius: 4, paddingVertical: 3, paddingHorizontal: 7 }}>
                          <Text style={{ color: paper["ink-2"], fontFamily: "Menlo", fontSize: 12, fontWeight: "700", letterSpacing: 0.8 }}>OPEN</Text>
                        </View>
                      )}
                    </View>

                    {!isExpanded && !!q.brief && (
                      <Text numberOfLines={2} style={{ color: paper["ink-2"], fontSize: 13, lineHeight: 19 }}>
                        {q.brief}
                      </Text>
                    )}

                    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                      <Text style={{ color: paper["ink-3"], fontFamily: "Menlo", fontSize: 12 }}>
                        {q.claimed_by ? `Picked up by ${q.claimed_by}` : `For ${q.assignee || "any"}`}
                        {q.project ? ` · ${q.project}` : ""}
                      </Text>
                      {(q.tags ?? []).slice(0, 4).map(tag => (
                        <View key={tag} style={{ backgroundColor: paper["paper-2"], borderRadius: 4, paddingVertical: 2, paddingHorizontal: 6 }}>
                          <Text style={{ color: paper["ink-2"], fontFamily: "Menlo", fontSize: 12 }}>{tag}</Text>
                        </View>
                      ))}
                    </View>
                  </Pressable>

                  {isExpanded && (
                    <View style={{ gap: 10, borderTopWidth: 1, borderStyle: "dashed", borderTopColor: paper.rule, paddingTop: 10 }}>
                      {!!q.brief && <Text selectable style={{ color: paper.ink, fontSize: 13, lineHeight: 20 }}>{q.brief}</Text>}
                      {!!q.done_when && (
                        <View style={{ backgroundColor: paper["paper-2"], borderRadius: 6, padding: 10, gap: 3 }}>
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

                {/* Cute folded sticky-note corner curl on open/active cards */}
                {!finished && (
                  <View
                    pointerEvents="none"
                    style={{
                      position: "absolute",
                      right: 0,
                      bottom: 0,
                      width: 12,
                      height: 12,
                      backgroundColor: paper["sticky-strip"],
                      borderTopWidth: 1,
                      borderLeftWidth: 1,
                      borderColor: paper["sticky-edge"],
                      borderTopLeftRadius: 3,
                    }}
                  />
                )}
              </View>
            );
          })
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
