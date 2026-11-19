import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { launchRpc, projectsRpc, suggestProjectRpc, workerModels } from "../shared/clyde";
import { palette } from "./brand.generated";
import { formatRpcError, MIN_HIT_HEIGHT, scheme } from "./palette";
import { requestId } from "./request-id";

type Worker = typeof workerModels[number];
const workerLabel = (worker: Worker) => worker[0].toUpperCase() + worker.slice(1);
function catalogueOf(projects: readonly { id:string; slug?:string; path:string }[] | undefined) {
  return JSON.stringify((projects ?? []).map(project => [project.id, project.slug, project.path]).sort((a,b) => a[0]!.localeCompare(b[0]!)));
}
export function Composer(
  { theme, onStarted, workspaceId, agentId, board = false }: {
    theme: PluginTheme;
    workspaceId?: string;
    agentId?: string;
    board?: boolean;
    onStarted: (id: string) => void;
  },
) {
  const c = theme.colors, edge = palette[scheme(theme)].edge, read = useRpc(projectsRpc), launch = useRpc(launchRpc), suggest = useRpc(suggestProjectRpc), cache = useQueryClient();
  const projectKey = ["clyde", "projects", workspaceId ?? "all"];
  const projects = useQuery({
    queryKey: projectKey,
    queryFn: () => read({ workspaceId }),
  });
  const [project, setProject] = useState(""),
    [chatId, setChatId] = useState(""),
    [text, setText] = useState(""),
    [flow, setFlow] = useState<"task" | "ship">("task");
  const [worker, setWorker] = useState<Worker>("auto"), [menu, setMenu] = useState<"project" | "chat" | "worker" | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [doneWhen, setDoneWhen] = useState("");
  const [showCriteria, setShowCriteria] = useState(false);
  const [allowNeon, setAllowNeon] = useState(false);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const locked = useRef(false);
  const routingLocked = useRef(false);
  const autoAvailable = board && !workspaceId;
  const [mode, setMode] = useState<"auto" | "manual">(autoAvailable ? "auto" : "manual");
  const [routingBusy, setRoutingBusy] = useState(false), [routingNote, setRoutingNote] = useState("");
  const [suggestion, setSuggestion] = useState<{ projectId:string; reason:string; prompt:string; revision:number; catalogue:string }>();
  const revision = useRef(0), draft = useRef(text), modeRef = useRef(mode), projectRef = useRef(project);
  // Progress events can refetch projects without changing the routing candidates.
  const catalogue = catalogueOf(projects.data), previousCatalogue = useRef(catalogue);
  useEffect(() => {
    if (catalogue === previousCatalogue.current) return;
    previousCatalogue.current = catalogue; revision.current++; routingLocked.current = false;
    setSuggestion(undefined); setRoutingBusy(false);
  }, [catalogue]);
  function changeDraft(value:string) {
    draft.current = value; revision.current++; routingLocked.current = false;
    setText(value); setSuggestion(undefined); setRoutingBusy(false); setRoutingNote("");
  }
  function chooseProject(id:string) {
    if (locked.current) return;
    routingLocked.current = false; revision.current++; modeRef.current = "manual"; projectRef.current = id;
    setMode("manual"); setProject(id); setSuggestion(undefined); setRoutingBusy(false); setRoutingNote(""); setError("");
    setChatId(""); setMenu(null);
  }
  function chooseAuto() {
    if (locked.current) return;
    routingLocked.current = false; revision.current++; modeRef.current = "auto"; projectRef.current = "";
    setMode("auto"); setProject(""); setSuggestion(undefined); setRoutingBusy(false); setRoutingNote(""); setError(""); setMenu(null);
  }
  function currentTarget() {
    const state = cache.getQueryState<NonNullable<typeof projects.data>>(projectKey);
    if (!state?.data) return;
    if (workspaceId) return state.data.length === 1 ? state.data[0] : undefined;
    if (modeRef.current === "manual") return state.data.find(p => p.id === projectRef.current);
    if (!suggestion || suggestion.prompt !== draft.current || suggestion.revision !== revision.current || suggestion.catalogue !== catalogueOf(state.data)) return;
    return state.data.find(p => p.id === suggestion.projectId);
  }
  const selected = currentTarget();
  async function chooseFromTask() {
    if (!autoAvailable || modeRef.current !== "auto" || !draft.current.trim() || routingLocked.current || locked.current) return;
    const state = cache.getQueryState<NonNullable<typeof projects.data>>(projectKey);
    if (!state?.data?.length) return;
    const requestRevision = ++revision.current, prompt = draft.current, requestCatalogue = catalogueOf(state.data);
    routingLocked.current = true; setRoutingBusy(true); setRoutingNote(""); setError("");
    try {
      const result = await suggest({ prompt });
      const latest = cache.getQueryState<NonNullable<typeof projects.data>>(projectKey);
      if (requestRevision !== revision.current || draft.current !== prompt || modeRef.current !== "auto" || catalogueOf(latest?.data) !== requestCatalogue) return;
      if (!result.projectId || !latest?.data?.some(p => p.id === result.projectId)) {
        modeRef.current = "manual"; projectRef.current = "";
        setMode("manual"); setProject(""); setSuggestion(undefined);
        setRoutingNote(result.reason || "Choose a project manually."); setMenu("project");
        return;
      }
      setSuggestion({ projectId:result.projectId, reason:result.reason, prompt, revision:requestRevision, catalogue:requestCatalogue });
    } catch {
      if (requestRevision !== revision.current || modeRef.current !== "auto" || catalogueOf(cache.getQueryState<NonNullable<typeof projects.data>>(projectKey)?.data) !== requestCatalogue) return;
      modeRef.current = "manual"; projectRef.current = "";
      setMode("manual"); setProject(""); setSuggestion(undefined); setMenu("project");
      setRoutingNote("Couldn’t choose a project. Select one manually.");
    } finally { if (requestRevision === revision.current) { routingLocked.current = false; setRoutingBusy(false); } }
  }
  const chats = selected?.chats ?? [];
  const wantsNewChat = !agentId && (board || chatId === "__new__" || chats.length === 0);
  const selectedChat = wantsNewChat ? undefined : (chats.find((ch) => ch.id === chatId) ?? chats[0]);
  const effectiveAgentId = agentId || selectedChat?.id || "";
  const submit = async () => {
    const target = currentTarget();
    if (!target || !draft.current.trim() || locked.current || routingBusy) return;
    locked.current = true;
    setBusy(true);
    setError("");
    const prompt = draft.current;
    const criteria = doneWhen.split("\n").map((line) => line.trim()).filter(Boolean);
    const key = JSON.stringify([target.id, workspaceId ?? "", effectiveAgentId || "__new__", prompt, flow, worker, criteria, allowNeon]);
    if (pending.current?.key !== key) pending.current = { key, id: requestId() };
    try {
      const run = await launch({
        project: target.id,
        ...(workspaceId ? { workspaceId } : {}),
        prompt,
        criteria,
        allowAntigravityFullAccess: worker === "neon" && allowNeon,
        flow,
        worker,
        agentId: effectiveAgentId || undefined,
        ...(wantsNewChat ? { newChat: true } : {}),
        requestId: pending.current.id,
      });
      pending.current = null;
      setAllowNeon(false);
      changeDraft("");
      setDoneWhen("");
      setShowCriteria(false);
      void cache.invalidateQueries({ queryKey: ["clyde"] });
      onStarted(run.id);
    } catch (e) {
      setError(formatRpcError(e));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const control = (label: string, click: () => void, active = false, extra?: { expanded?: boolean; selected?: boolean }) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy, ...(extra?.expanded !== undefined ? { expanded: extra.expanded } : {}), ...(extra?.selected !== undefined ? { selected: extra.selected } : {}) }}
      onPress={click}
      disabled={busy}
      style={{
        minHeight: MIN_HIT_HEIGHT,
        justifyContent: "center",
        paddingHorizontal: 12,
        backgroundColor: active ? c.foreground : c.surface2,
        borderColor: active ? c.foreground : edge,
        borderWidth: 1,
        borderRadius: 7,
      }}
    >
      <Text style={{ fontSize: 13, fontWeight: "600", color: active ? c.surface1 : c.foreground }}>{label}</Text>
    </Pressable>
  );
  const needsRouting = autoAvailable && mode === "auto" && !selected;
  const inactive = busy || routingBusy || !text.trim() || (!selected && !needsRouting) || !projects.data?.length;
  return (
    <View style={{ gap: 16 }}>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <Text accessibilityRole="header" style={{ fontWeight: "700", fontSize: 21, color: c.foreground }}>
          New task
        </Text>
        <View style={{ flexDirection: "row", gap: 6 }}>
          {control("Quick task", () => setFlow("task"), flow === "task", { selected: flow === "task" })}
          {control("Plan a feature", () => setFlow("ship"), flow === "ship", { selected: flow === "ship" })}
        </View>
      </View>
      <TextInput
        accessibilityLabel="Task instructions"
        multiline
        value={text}
        onChangeText={changeDraft}
        editable={!busy}
        placeholder={flow === "ship"
          ? "Describe the feature you want to plan…"
          : "What should Clyde do in this project?"}
        placeholderTextColor={c.foregroundMuted}
        style={{
          minHeight: 104,
          textAlignVertical: "top",
          padding: 14,
          fontSize: 16,
          lineHeight: 23,
          color: c.foreground,
          backgroundColor: c.surface0,
          borderColor: edge,
          borderWidth: 1,
          borderRadius: 9,
        }}
      />
      {showCriteria ? <View style={{gap:5}}>
        <Text style={{color:c.foreground,fontWeight:"600",fontSize:13}}>Done when</Text>
        <TextInput accessibilityLabel="Completion criteria" multiline editable={!busy} maxLength={4000}
          value={doneWhen} onChangeText={setDoneWhen} placeholder="One observable outcome per line" placeholderTextColor={c.foregroundMuted}
          style={{padding:10,minHeight:58,fontSize:14,color:c.foreground,backgroundColor:c.surface0,borderColor:edge,borderWidth:1,borderRadius:6}}/>
      </View> : <Pressable accessibilityRole="button" onPress={()=>setShowCriteria(true)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
        <Text style={{color:c.accent,fontSize:13,fontWeight:"600"}}>+ Add completion criteria</Text>
      </Pressable>}

      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {workspaceId && selected ? <Text style={{ color: c.foreground, fontSize: 13 }}>{selected.name}</Text> : control((selected?.name || (autoAvailable && mode === "auto" ? "Project · Auto" : "Choose a project")) + " ▾", () => setMenu(menu === "project" ? null : "project"), false, { expanded: menu === "project" })}
        {!board && !agentId && selected && control(
          "Chat · " + (wantsNewChat ? "New chat (auto)" : selectedChat!.title) + " ▾",
          () => setMenu(menu === "chat" ? null : "chat"),
          false,
          { expanded: menu === "chat" },
        )}
        {control(
          "Worker · " + workerLabel(worker) + " ▾",
          () => setMenu(menu === "worker" ? null : "worker"),
          false,
          { expanded: menu === "worker" },
        )}
        <View style={{ flexGrow: 1 }} />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: inactive }}
          disabled={inactive}
          onPress={() => { if (needsRouting) void chooseFromTask(); else void submit(); }}
          style={{
            minHeight: MIN_HIT_HEIGHT,
            justifyContent: "center",
            paddingHorizontal: 16,
            borderRadius: 7,
            backgroundColor: inactive ? c.surface2 : c.accent,
            borderWidth: inactive ? 1 : 0,
            borderColor: edge,
          }}
        >
          <Text style={{ color: inactive ? c.foregroundMuted : c.accentForeground, fontWeight: "700", fontSize: 13 }}>
            {busy ? "Starting…" : routingBusy ? "Choosing project…" : needsRouting ? "Choose project" : flow === "ship" ? "Start planning" : "Start task"}
          </Text>
        </Pressable>
      </View>
      {autoAvailable && mode === "auto" && selected && suggestion && <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 20 }}>Auto chose {selected.name}. {suggestion.reason}</Text>}
      {!!routingNote && <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 20 }}>{routingNote}</Text>}
      {flow === "ship" && worker !== "auto" && (
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          Implementation worker: {workerLabel(worker)}.
        </Text>
      )}
      {worker==="neon" && <Pressable accessibilityRole="checkbox" accessibilityState={{checked:allowNeon,disabled:busy}} disabled={busy} onPress={()=>setAllowNeon(!allowNeon)} style={{minHeight:MIN_HIT_HEIGHT,justifyContent:"center"}}>
        <Text style={{color:c.foreground,fontSize:13}}>{allowNeon?"☑":"☐"} Allow full access for this run</Text>
        <Text style={{color:c.foregroundMuted,fontSize:12}}>Paseo’s Neon worker can use files, shell commands and the network without further permission prompts.</Text>
      </Pressable>}
      {menu === "project" && (
        <View style={{ gap: 5 }}>
          {autoAvailable && <Pressable accessibilityRole="button" accessibilityState={{ selected: mode === "auto", disabled: busy }} disabled={busy} onPress={chooseAuto} style={{ padding: 8, minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
            <Text style={{ color: mode === "auto" ? c.accent : c.foreground, fontSize: 13, fontWeight: "600" }}>Auto · choose from this task</Text>
          </Pressable>}
          {projects.data?.map((p) => (
            <Pressable
              key={p.id}
              accessibilityRole="button"
              accessibilityState={{ selected: mode === "manual" && selected?.id === p.id, disabled: busy }}
              disabled={busy}
              onPress={() => chooseProject(p.id)}
              style={{ padding: 8, minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
            >
              <Text style={{ color: mode === "manual" && selected?.id === p.id ? c.accent : c.foreground, fontWeight: "600", fontSize: 13 }}>{p.name}</Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                {p.path}{!board ? ` · ${p.chats.length} open ${p.chats.length === 1 ? "chat" : "chats"}` : ""}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {!board && menu === "chat" && (
        <View style={{ gap: 5 }}>
          {chats.map((ch) => (
            <Pressable
              key={ch.id}
              accessibilityRole="button"
              accessibilityState={{ selected: effectiveAgentId === ch.id }}
              onPress={() => {
                setChatId(ch.id);
                setMenu(null);
              }}
              style={{ padding: 8, minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
            >
              <Text style={{ color: effectiveAgentId === ch.id ? c.accent : c.foreground, fontWeight: "600", fontSize: 13 }}>
                {effectiveAgentId === ch.id ? "✓ " : ""}{ch.title}
              </Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{ch.provider}</Text>
            </Pressable>
          ))}
          <Pressable
            key="__new__"
            accessibilityRole="button"
            accessibilityState={{ selected: wantsNewChat }}
            onPress={() => {
              setChatId("__new__");
              setMenu(null);
            }}
            style={{ padding: 8, minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
          >
            <Text style={{ color: wantsNewChat ? c.accent : c.foreground, fontWeight: "600", fontSize: 13 }}>
              {wantsNewChat ? "✓ " : "+ "}New chat in {selected?.name ?? "project"}
            </Text>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Open a fresh chat automatically when you start</Text>
          </Pressable>
        </View>
      )}
      {menu === "worker" && (
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          {workerModels.map((w) =>
            control(workerLabel(w), () => {
              setAllowNeon(false); setWorker(w);
              setMenu(null);
            }, worker === w, { selected: worker === w })
          )}
        </View>
      )}
      {!board && !agentId && selected && chats.length === 0 && (
        <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
          No open chats in {selected.name} yet. Clyde will open one when you start.
        </Text>
      )}
      {projects.isSuccess && !projects.data.length && (
        <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Open a Git project in Paseo to start a task here.</Text>
      )}
      {(error || projects.error) && (
        <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13 }}>
          {error || formatRpcError(projects.error)}
        </Text>
      )}
    </View>
  );
}
