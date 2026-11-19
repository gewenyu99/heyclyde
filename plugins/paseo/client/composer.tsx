import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { launchRpc, projectsRpc, workerModels } from "../shared/clyde";
import { palette } from "./brand.generated";
import { formatRpcError, MIN_HIT_HEIGHT, scheme } from "./palette";

type Worker = typeof workerModels[number];
const workerLabel = (worker: Worker) => worker[0].toUpperCase() + worker.slice(1);
function requestId() {
  // This is an idempotency key, not a credential. Some native clients lack crypto.randomUUID.
  return globalThis.crypto?.randomUUID?.() ?? "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const n = Math.floor(Math.random() * 16);
    return (c === "x" ? n : (n & 3) | 8).toString(16);
  });
}
export function Composer(
  { theme, onStarted, workspaceId, agentId }: {
    theme: PluginTheme;
    workspaceId?: string;
    agentId?: string;
    onStarted: (id: string) => void;
  },
) {
  const c = theme.colors, edge = palette[scheme(theme)].edge, read = useRpc(projectsRpc), launch = useRpc(launchRpc), cache = useQueryClient();
  const projects = useQuery({
    queryKey: ["clyde", "projects", workspaceId ?? "all"],
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
  const selected = projects.data?.find((p) => p.id === project) ?? projects.data?.find((p) => p.chats.length > 0) ?? projects.data?.[0];
  const chats = selected?.chats ?? [];
  const wantsNewChat = !agentId && (chatId === "__new__" || chats.length === 0);
  const selectedChat = wantsNewChat ? undefined : (chats.find((ch) => ch.id === chatId) ?? chats[0]);
  const effectiveAgentId = agentId || selectedChat?.id || "";
  const submit = async () => {
    if (!selected || !text.trim() || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    const criteria = doneWhen.split("\n").map((line) => line.trim()).filter(Boolean);
    const key = JSON.stringify([selected.id, workspaceId ?? "", effectiveAgentId || "__new__", text, flow, worker, criteria, allowNeon]);
    if (pending.current?.key !== key) pending.current = { key, id: requestId() };
    try {
      const run = await launch({
        project: selected.id,
        ...(workspaceId ? { workspaceId } : {}),
        prompt: text,
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
      setText("");
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
  const inactive = busy || !selected || !text.trim();
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
        onChangeText={setText}
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
        {control((selected?.name || "Select project") + " ▾", () => setMenu(menu === "project" ? null : "project"), false, { expanded: menu === "project" })}
        {!agentId && selected && control(
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
          onPress={() => void submit()}
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
            {busy ? "Starting…" : flow === "ship" ? "Start planning" : "Start task"}
          </Text>
        </Pressable>
      </View>
      {flow === "ship" && worker !== "auto" && (
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          Plans with Opus or Astra, builds with {workerLabel(worker)}, and audits with Carbon.
        </Text>
      )}
      {worker==="neon" && <Pressable accessibilityRole="checkbox" accessibilityState={{checked:allowNeon,disabled:busy}} disabled={busy} onPress={()=>setAllowNeon(!allowNeon)} style={{minHeight:MIN_HIT_HEIGHT,justifyContent:"center"}}>
        <Text style={{color:c.foreground,fontSize:13}}>{allowNeon?"☑":"☐"} Allow full access for this run</Text>
        <Text style={{color:c.foregroundMuted,fontSize:12}}>Paseo’s Neon worker can use files, shell commands and the network without further permission prompts.</Text>
      </Pressable>}
      {menu === "project" && (
        <View style={{ gap: 5 }}>
          {projects.data?.map((p) => (
            <Pressable
              key={p.id}
              accessibilityRole="button"
              accessibilityState={{ selected: selected?.id === p.id }}
              onPress={() => {
                setProject(p.id);
                setChatId("");
                setMenu(null);
              }}
              style={{ padding: 8, minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
            >
              <Text style={{ color: selected?.id === p.id ? c.accent : c.foreground, fontWeight: "600", fontSize: 13 }}>{p.name}</Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                {p.path} · {p.chats.length} open {p.chats.length === 1 ? "chat" : "chats"}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {menu === "chat" && (
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
      {!agentId && selected && chats.length === 0 && (
        <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
          No open chats in {selected.name} yet. Clyde will open one when you start.
        </Text>
      )}
      {projects.isSuccess && !selected && (
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
