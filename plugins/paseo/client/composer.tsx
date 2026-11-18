import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { launchRpc, projectsRpc } from "../shared/clyde";

type Worker = "auto" | "sol" | "sonnet" | "opus" | "astra";
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
  const c = theme.colors, read = useRpc(projectsRpc), launch = useRpc(launchRpc), cache = useQueryClient();
  const projects = useQuery({
    queryKey: ["clyde", "projects", workspaceId ?? "all"],
    queryFn: () => read({ workspaceId }),
  });
  const [project, setProject] = useState(""),
    [text, setText] = useState(""),
    [flow, setFlow] = useState<"task" | "ship">("task");
  const [worker, setWorker] = useState<Worker>("auto"), [menu, setMenu] = useState<"project" | "worker" | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef<{ key: string; id: string } | null>(null);
  const locked = useRef(false);
  const selected = projects.data?.find((p) => p.id === project) ?? projects.data?.[0];
  const submit = async () => {
    if (!selected || !text.trim() || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    const key = JSON.stringify([selected.id, text, flow, worker]);
    if (pending.current?.key !== key) pending.current = { key, id: requestId() };
    try {
      const run = await launch({
        project: selected.id,
        prompt: text,
        flow,
        worker,
        agentId,
        requestId: pending.current.id,
      });
      pending.current = null;
      setText("");
      void cache.invalidateQueries({ queryKey: ["clyde", "home"] });
      onStarted(run.id);
    } catch (e) {
      setError(String(e));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const control = (label: string, click: () => void, active = false) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      onPress={click}
      disabled={busy}
      style={{
        paddingVertical: 7,
        paddingHorizontal: 10,
        backgroundColor: active ? c.foreground : c.surface2,
        borderColor: active ? c.foreground : c.border,
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
        <View style={{ flexDirection: "row", gap: 5 }}>
          {control("Quick task", () => setFlow("task"), flow === "task")}
          {control("Plan a feature", () => setFlow("ship"), flow === "ship")}
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
          borderColor: c.border,
          borderWidth: 1,
          borderRadius: 9,
        }}
      />
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {control((selected?.name || "Select project") + " ▾", () => setMenu(menu === "project" ? null : "project"))}
        {control(
          "Worker · " + (worker === "auto" ? "Auto" : worker) + " ▾",
          () => setMenu(menu === "worker" ? null : "worker"),
        )}
        <View style={{ flexGrow: 1 }} />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: inactive }}
          disabled={inactive}
          onPress={() => void submit()}
          style={{
            paddingVertical: 9,
            paddingHorizontal: 16,
            borderRadius: 7,
            backgroundColor: c.accent,
            opacity: inactive ? 0.6 : 1,
          }}
        >
          <Text style={{ color: c.accentForeground, fontWeight: "700" }}>
            {busy ? "Starting…" : flow === "ship" ? "Start planning" : "Start task"}
          </Text>
        </Pressable>
      </View>
      {menu === "project" && (
        <View style={{ gap: 5 }}>
          {projects.data?.map((p) => (
            <Pressable
              key={p.id}
              accessibilityRole="button"
              onPress={() => {
                setProject(p.id);
                setMenu(null);
              }}
              style={{ padding: 8 }}
            >
              <Text style={{ color: c.foreground, fontWeight: "600" }}>{p.name}</Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{p.path}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {menu === "worker" && (
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          {(["auto", "sol", "sonnet", "opus", "astra"] as const).map((w) =>
            control(w, () => {
              setWorker(w);
              setMenu(null);
            }, worker === w)
          )}
        </View>
      )}
      {projects.isSuccess && !selected && (
        <Text style={{ color: c.foregroundMuted }}>Open a Git project in Paseo to start a task here.</Text>
      )}
      {(error || projects.error) && <Text style={{ color: c.statusDanger }}>{error || String(projects.error)}</Text>}
    </View>
  );
}
