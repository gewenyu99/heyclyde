import type { PluginAgentPanelProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { homeRpc, taskRpc, type TaskCard } from "../shared/clyde";
import { Composer } from "./composer";
import { OpenChatButton } from "./open-chat";
import { Quests } from "./quests";
import { TaskScreen } from "./task";
import { Lockup, clydeTheme } from "./brand";
import { Pill, useLive } from "./nodes";
import { formatRpcError, MIN_HIT_HEIGHT, STATUS_LABEL } from "./palette";

export function Sidecar(props: PluginAgentPanelProps | PluginWorkspacePanelProps) {
  const { workspaceId } = props, theme = clydeTheme(props.theme), c = theme.colors;
  useLive();
  const origin = props.context === "agent" ? props.params.agentId : undefined;
  const openAgent = props.navigation ? (agentId: string) => props.navigation!.openAgent({ agentId }) : undefined;
  const [tab, setTab] = useState<"Quests" | "New task" | "Runs">("Quests"),
    [id, setId] = useState("");
  const home = useRpc(homeRpc), task = useRpc(taskRpc);
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
  const homeData = runs.data?.data;
  const needsSet = new Set(homeData?.needsYou.filter((a) => a.kind === "run").map((a) => a.id) ?? []);
  const needsCount = needsSet.size;
  const orderedRuns: TaskCard[] = homeData
    ? (() => {
        const allRuns = homeData.tasks.concat(homeData.failedToday ?? [], homeData.doneToday ?? []).filter((t) => t.kind === "run");
        const seen = new Set<string>();
        const deduped = allRuns.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
        return [...deduped.filter((t) => needsSet.has(t.id)), ...deduped.filter((t) => !needsSet.has(t.id))];
      })()
    : [];
  const listError = runs.data?.error ? formatRpcError(runs.data.error) : runs.error ? formatRpcError(runs.error) : "";
  const detailError = detail.data?.error ? formatRpcError(detail.data.error) : detail.error ? formatRpcError(detail.error) : "";
  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: c.surface0, padding: 14, gap: 16 }}>
      <Lockup theme={theme} width={88} />
      <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 4, borderBottomWidth: 1, borderColor: c.border }}>
        {(["Quests", "New task", "Runs"] as const).map((v) => {
          const label = v === "Runs" && needsCount > 0 ? `Runs (${needsCount})` : v;
          return (
            <Pressable
              accessibilityRole="tab"
              accessibilityLabel={v === "Runs" && needsCount > 0 ? `Runs, ${needsCount} awaiting your reply` : v}
              accessibilityState={{ selected: tab === v }}
              key={v}
              onPress={() => {
                setTab(v);
                setId("");
              }}
              style={{
                minHeight: MIN_HIT_HEIGHT,
                justifyContent: "center",
                paddingHorizontal: 9,
                borderBottomWidth: 2,
                borderBottomColor: v === tab ? c.accent : "transparent",
              }}
            >
              <Text style={{ color: v === tab ? c.foreground : c.foregroundMuted, fontSize: 13, fontWeight: "600" }}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
      {tab === "Quests"
        ? <Quests theme={theme} workspaceId={workspaceId} agent={origin} onStarted={started} />
        : (
        <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ gap: 16, paddingBottom: 16 }}>
        {tab === "New task"
        ? <Composer theme={theme} workspaceId={workspaceId} agentId={origin} onStarted={started} />
        : id
        ? (
          <View style={{ gap: 12 }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setId("")}
              style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
            >
              <Text style={{ color: c.accent, fontSize: 13, fontWeight: "600" }}>‹ Runs</Text>
            </Pressable>
            {detail.data?.data
              ? <TaskScreen theme={theme} view={detail.data.data} back={() => setId("")} openAgent={openAgent} />
              : (
                <Text accessibilityRole={detailError ? "alert" : undefined} style={{ color: detailError ? c.statusDanger : c.foregroundMuted, fontSize: 13 }}>
                  {detailError || "Loading run…"}
                </Text>
              )}
          </View>
        )
        : (
          <View style={{ gap: 10 }}>
            {listError
              ? <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13 }}>{listError}</Text>
              : null}
            {orderedRuns.map((t) => (
              <View
                key={t.id}
                style={{
                  padding: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: c.border,
                  backgroundColor: c.surface1,
                  gap: 8,
                }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${t.name}, ${STATUS_LABEL[t.status]}`}
                  onPress={() => setId(t.id)}
                  style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", gap: 6 }}
                >
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <Text numberOfLines={2} style={{ color: c.foreground, fontWeight: "600", fontSize: 13, flexShrink: 1 }}>{t.name}</Text>
                    <Pill theme={theme} status={t.status} />
                  </View>
                  {!!t.current && <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12 }}>{t.current}</Text>}
                </Pressable>
                {(t.status === "asking" || t.status === "failed") && openAgent ? (
                  <OpenChatButton theme={theme} kind={t.kind} id={t.id} openAgent={openAgent} />
                ) : null}
              </View>
            ))}
            {homeData && orderedRuns.length === 0 && (
              <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>No runs in this workspace yet.</Text>
            )}
          </View>
        )}
        </ScrollView>
        )}
    </View>
  );
}
