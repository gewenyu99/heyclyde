import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Linking, Pressable, Text, TextInput, View } from "react-native";
import { boardRpc, newQuestRpc, projectsRpc, questProjectMatches, sharedBoardRpc, spawnQuestRpc } from "../shared/clyde";
import { formatRpcError, MIN_HIT_HEIGHT } from "./palette";
import { requestId } from "./request-id";

export function Quests({ theme, agent: activeAgent, workspaceId, onStarted }: {
  theme: PluginTheme; agent?: string; workspaceId?: string; onStarted: (id: string) => void;
}) {
  const c = theme.colors;
  const [search, setSearch] = useState("");
  const [showFinished, setShowFinished] = useState(false);
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
  const currentQuest = query.data?.quests.find(q => q.id === expanded);
  // Match the server's canonical slug; project names and path basenames can collide.
  const targets = (projects.data ?? []).filter(p => p.eligible !== false && questProjectMatches(p.slug, currentQuest?.project));
  const target = targets.find(p => p.id === project) ?? (targets.length === 1 ? targets[0] : undefined);
  const workspaces = target?.workspaces ?? [];
  const targetWorkspace = workspaceId || workspaces.find(w => w.id === workspace)?.id || (workspaces.length === 1 ? workspaces[0].id : undefined);
  const needsWorkspace = !targetWorkspace && workspaces.length > 1;
  const chats = target?.chats ?? [];
  const agent = chats.find(chat => chat.id === chosen)?.id || chats.find(chat => chat.id === activeAgent)?.id;
  const matches = useQuery({ queryKey: ["clyde", "eligible-quests", agent], queryFn: () => scoped({ agent: agent! }), enabled: existing && !!agent, refetchInterval: 30000, retry: false });
  const eligible = new Set(matches.data?.map(q => q.id) ?? []);
  const term = search.trim().toLowerCase().replace(/^#/, "");
  const quests = (query.data?.quests ?? []).filter(q =>
    (showFinished ? q.state === "done" || q.state === "abandoned" : !q.state || q.state === "open" || q.state === "claimed") &&
    (!term || [String(q.id), q.title, q.project, ...(q.tags ?? [])].some(field => field?.toLowerCase().includes(term)))
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
  const button = (label: string, onPress: () => void, disabled = false, primary = false) => <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", alignSelf: "flex-start", backgroundColor: primary && !disabled ? c.accent : "transparent", borderRadius: 6, paddingHorizontal: primary ? 12 : 0 }}>
    <Text style={{ color: disabled ? c.foregroundMuted : primary ? c.accentForeground : c.accent, fontSize: 13, fontWeight: "600" }}>{label}</Text>
  </Pressable>;
  return <View style={{ gap: 12 }}>
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
      <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 18, fontWeight: "700" }}>Quests</Text>
      {button("Refresh", () => { void query.refetch(); if (expanded !== null) void projects.refetch(); if (agent) void matches.refetch(); }, busy)}
    </View>
    <TextInput accessibilityLabel="Find a quest" placeholder="Find a quest…" placeholderTextColor={c.foregroundMuted} value={search} onChangeText={setSearch} style={{ color: c.foreground, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 10, minHeight: MIN_HIT_HEIGHT, fontSize: 14 }} />
    <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 18 }}>
      {["Active", "Finished"].map((label, index) => <Pressable key={label} accessibilityRole="tab" accessibilityState={{ selected: showFinished === !!index }} onPress={() => setShowFinished(!!index)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
        <Text style={{ color: showFinished === !!index ? c.foreground : c.foregroundMuted, fontSize: 13, fontWeight: "600" }}>{label}</Text>
      </Pressable>)}
    </View>
    {query.isPending ? <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Loading quests…</Text>
      : query.error ? <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13 }}>{formatRpcError(query.error)}</Text>
      : !quests.length ? <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{term ? "No matching quests." : showFinished ? "No finished quests." : "No active quests."}</Text>
      : quests.map(q => {
        const isOpen = !q.state || q.state === "open";
        const assigned = !!q.assignee && q.assignee !== "any";
        const startDisabled = busy || !target || (existing ? !agent || !eligible.has(q.id) : needsWorkspace);
        return <View key={q.id} style={{ borderBottomWidth: 1, borderColor: c.border, paddingBottom: 12, gap: 8 }}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: expanded === q.id, disabled: busy }} disabled={busy} onPress={() => {
            setExpanded(expanded === q.id ? null : q.id); setProject(""); setWorkspace(""); setChosen(""); setExisting(assigned); setMenu(null); setError("");
          }} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", gap: 4 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>#{q.id}{["high", "urgent"].includes(q.priority) ? ` · ${q.priority} priority` : ""}{q.project ? ` · ${q.project}` : ""}{!isOpen ? ` · ${q.state}` : ""}</Text>
            <Text style={{ color: c.foreground, fontSize: 15, lineHeight: 21, fontWeight: "600" }}>{q.title}</Text>
          </Pressable>
          {expanded === q.id && <View style={{ gap: 8 }}>
            {!!q.brief && <Text style={{ color: c.foreground, fontSize: 13, lineHeight: 20 }}>{q.brief}</Text>}
            {!!q.done_when && <Text style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 20 }}>Done when: {q.done_when}</Text>}
            {isOpen ? <>
              {assigned && <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Assigned to {q.assignee}</Text>}
              {button((target?.name || "Choose a project") + " ▾", () => setMenu(menu === "project" ? null : "project"), busy || projects.isPending)}
              {menu === "project" && <View style={{ paddingLeft: 10 }}>
                {targets.map(p => <Pressable key={p.id} accessibilityRole="button" accessibilityState={{ selected: target?.id === p.id, disabled: busy }} disabled={busy} onPress={() => { setProject(p.id); setWorkspace(""); setChosen(""); setMenu(null); setError(""); }} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
                  <Text style={{ color: target?.id === p.id ? c.accent : c.foreground, fontSize: 13 }}>{p.name}</Text>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{p.path}</Text>
                </Pressable>)}
              </View>}
              {!target && !projects.isPending && <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{targets.length ? "Choose where this quest should run." : currentQuest?.project ? "Open the quest’s project in Paseo to start it." : "Open a Git project in Paseo to start this quest."}</Text>}
              {!existing && !workspaceId && target && workspaces.length > 1 && <View>
                {button((workspaces.find(w => w.id === targetWorkspace)?.name || "Choose a workspace") + " ▾", () => setMenu(menu === "workspace" ? null : "workspace"), busy)}
                {menu === "workspace" && workspaces.map(w => <Pressable key={w.id} accessibilityRole="button" accessibilityState={{ selected: targetWorkspace === w.id, disabled: busy }} disabled={busy} onPress={() => { setWorkspace(w.id); setMenu(null); setError(""); }} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingLeft: 10 }}>
                  <Text style={{ color: targetWorkspace === w.id ? c.accent : c.foreground, fontSize: 13 }}>{w.name}</Text>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{w.path}</Text>
                </Pressable>)}
              </View>}
              {!existing ? button(busy ? "Starting…" : "Start with new orchestrator", () => void start(q.id), startDisabled, true) : <View style={{ gap: 4 }}>
                {button((chats.find(chat => chat.id === agent)?.title || "Choose an existing chat") + " ▾", () => setMenu(menu === "chat" ? null : "chat"), busy || !target)}
                {menu === "chat" && chats.map(chat => <Pressable key={chat.id} accessibilityRole="button" accessibilityState={{ selected: agent === chat.id, disabled: busy }} disabled={busy} onPress={() => { setChosen(chat.id); setMenu(null); setError(""); }} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingLeft: 10 }}>
                  <Text style={{ color: agent === chat.id ? c.accent : c.foreground, fontSize: 13 }}>{chat.title}</Text>
                </Pressable>)}
                {agent && matches.isPending && <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Checking chat…</Text>}
                {agent && matches.isSuccess && !eligible.has(q.id) && <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>This chat is not eligible for this quest.</Text>}
                {!chats.length && target && <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>No existing chats in this project. Start with a new orchestrator.</Text>}
                {button(busy ? "Starting…" : "Start in selected chat", () => void start(q.id), startDisabled)}
              </View>}
              {!assigned && button(existing ? "Use a new orchestrator instead" : "Use an existing chat instead", () => { setExisting(!existing); setMenu(null); setError(""); }, busy)}
              {!!error && <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13 }}>{error}</Text>}
              {(projects.error || (existing && matches.error)) && <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13 }}>{formatRpcError(projects.error || matches.error)}</Text>}
            </> : q.state === "claimed" && <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Claimed by {q.claimed_by || "another agent"}</Text>}
          </View>}
        </View>;
      })}
    {query.data?.legacy && <Pressable accessibilityRole="link" onPress={() => void Linking.openURL("https://heyclyde.me/quests")} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
      <Text style={{ color: c.accent, fontSize: 13 }}>Full account history ↗</Text>
    </Pressable>}

  </View>;
}
