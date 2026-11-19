import type { PluginAgentPanelProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { homeRpc, rosterRpc, taskRpc } from "../shared/clyde";
import { Composer } from "./composer";
import { Quests } from "./quests";
import { TaskScreen } from "./task";
import { Lockup,clydeTheme } from "./brand";

export function Sidecar(props: PluginAgentPanelProps | PluginWorkspacePanelProps) {
  const {workspaceId}=props, theme=clydeTheme(props.theme), c=theme.colors;
  const origin = props.context === "agent" ? props.params.agentId : undefined;
  const [chosen, setChosen] = useState(""),
    [tab, setTab] = useState<"Quests" | "New task" | "Runs">("Quests"),
    [id, setId] = useState("");
  const roster = useRpc(rosterRpc), home = useRpc(homeRpc), task = useRpc(taskRpc);
  const rows = useQuery({
    queryKey: ["clyde", "roster", workspaceId],
    queryFn: () => roster({ workspaceId }),
    refetchInterval: 20000,
  });
  const agent = origin || rows.data?.find((a) => a.id === chosen)?.id ||
    (rows.data?.length === 1 ? rows.data[0].id : undefined);
  const runs = useQuery({
    queryKey: ["clyde", "home", workspaceId],
    queryFn: () => home({ workspaceId }),
    refetchInterval: 5000,
  });
  const detail = useQuery({
    queryKey: ["clyde", "task", "run", id],
    queryFn: () => task({ kind: "run", id }),
    enabled: !!id,
    refetchInterval: 5000,
  });
  const started = (value: string) => {
    setId(value);
    setTab("Runs");
    void runs.refetch();
  };
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: 14, gap: 16 }}>
      <Lockup theme={theme} width={88}/>
      <View style={{ flexDirection: "row", gap: 4, borderBottomWidth: 1, borderColor: c.border }}>
        {(["Quests", "New task", "Runs"] as const).map((v) => (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === v }}
            key={v}
            onPress={() => {
              setTab(v);
              setId("");
            }}
            style={{
              paddingVertical: 8,
              paddingHorizontal: 9,
              borderBottomWidth: 2,
              borderBottomColor: v === tab ? c.accent : "transparent",
            }}
          >
            <Text style={{ color: v === tab ? c.foreground : c.foregroundMuted, fontWeight: "600" }}>{v}</Text>
          </Pressable>
        ))}
      </View>
      {!origin && (rows.data?.length ?? 0) > 1 && (
        <View style={{ gap: 5 }}>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Chat for approvals and feedback</Text>
          {rows.data!.map((a) => (
            <Pressable key={a.id} accessibilityRole="button" onPress={() => setChosen(a.id)}>
              <Text style={{ color: agent === a.id ? c.accent : c.foreground }}>{a.title}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {tab === "Quests"
        ? <Quests theme={theme} agent={agent} onStarted={started} />
        : tab === "New task"
        ? <Composer theme={theme} workspaceId={workspaceId} agentId={agent} onStarted={started} />
        : id
        ? (
          <View style={{ gap: 12 }}>
            <Pressable accessibilityRole="button" onPress={() => setId("")}>
              <Text style={{ color: c.accent }}>‹ Runs</Text>
            </Pressable>
            {detail.data?.data
              ? <TaskScreen theme={theme} view={detail.data.data} back={() => setId("")} />
              : (
                <Text style={{ color: c.foregroundMuted }}>
                  {detail.data?.error || detail.error?.message || "Loading run…"}
                </Text>
              )}
          </View>
        )
        : (
          <View style={{ gap: 10 }}>
            {runs.data?.error || runs.error
              ? <Text style={{ color: c.statusDanger }}>{runs.data?.error || runs.error?.message}</Text>
              : null}
            {(runs.data?.data?.tasks ?? []).concat(runs.data?.data?.failedToday ?? [], runs.data?.data?.doneToday ?? []).filter((t) => t.kind === "run")
              .map((t) => (
                <Pressable
                  key={t.id}
                  accessibilityRole="button"
                  onPress={() => setId(t.id)}
                >
                  <Text style={{ color: c.foreground, fontWeight: "600" }}>{t.name}</Text>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t.status}</Text>
                </Pressable>
              ))}
            {runs.data?.data && ![...runs.data.data.tasks,...(runs.data.data.failedToday??[]),...runs.data.data.doneToday].some(t=>t.kind==="run") && (
              <Text style={{ color: c.foregroundMuted }}>No runs in this workspace yet.</Text>
            )}
          </View>
        )}
    </ScrollView>
  );
}
