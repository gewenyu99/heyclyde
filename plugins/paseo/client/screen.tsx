import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { homeRpc, taskRpc } from "../shared/clyde";
import { Composer } from "./composer";
import { Roster } from "./roster";
import { HomeView } from "./home";
import { useLive } from "./nodes";
import { TaskScreen } from "./task";
import {Lockup,clydeTheme} from "./brand";

function Panel({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 12,
        padding: 20,
        gap: 6,
      }}
    >
      {children}
    </View>
  );
}

function Board(
  { theme: hostTheme, layout, navigation, workspaceId, initialTask = "" }:
    & Pick<PluginScreenProps, "theme" | "layout" | "navigation">
    & { workspaceId?: string; initialTask?: string },
) {
  const theme=clydeTheme(hostTheme);
  useLive();
  const readHome = useRpc(homeRpc), readTask = useRpc(taskRpc);
  const [picked, setPicked] = useState(initialTask),
    [width, setWidth] = useState(0),
    [tab, setTab] = useState<"board" | "agents">("board");
  const c = theme.colors, wide = width >= 760, inset = width >= 650 ? 28 : 14;
  const home = useQuery({
    queryKey: ["clyde", "home", workspaceId ?? "all"],
    queryFn: () => readHome({ workspaceId }),
    refetchInterval: 10000,
  });
  const [kind, id] = picked.split(":");
  const task = useQuery({
    queryKey: ["clyde", "task", kind, id],
    queryFn: () => readTask({ kind: kind as "run" | "thread", id }),
    enabled: !!id,
    refetchInterval: 5000,
  });
  const data = home.data?.data;
  const error = home.data?.error || home.error?.message;
  const nav = (value: "board" | "agents", label: string) => (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: tab === value }}
      onPress={() => {
        setPicked("");
        setTab(value);
      }}
      style={{
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 6,
        backgroundColor: tab === value ? c.surface1 : "transparent",
      }}
    >
      <Text
        style={{
          fontWeight: tab === value ? "700" : "500",
          fontSize: 13,
          color: tab === value ? c.foreground : c.foregroundMuted,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
  const queue = <Panel theme={theme}>{data ? <HomeView theme={theme} home={data} open={(k,i)=>setPicked(k+":"+i)}/> :
    <Text style={{color:error?c.statusDanger:c.foregroundMuted}}>{error||"Loading tasks…"}</Text>}</Panel>;
  const workToReview = !!(data?.needsYou.length || data?.failedToday?.length || data?.doneToday.length || data?.running);
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      contentContainerStyle={{ alignItems: "center", padding: inset }}
    >
      <View style={{ width: "100%", maxWidth: 1180, gap: 18 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 10,
            borderBottomWidth: 1,
            borderColor: c.border,
            paddingBottom: 16,
          }}
        >
          <Lockup theme={theme} width={104}/>
          <View
            style={{
              flexDirection: "row",
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: 8,
              padding: 2,
              backgroundColor: c.surface2,
            }}
          >
            {nav("board", "Board")}
            {nav("agents", "Agents")}
          </View>
        </View>
        {picked && id
          ? (
            <Panel theme={theme}>
              <Pressable accessibilityRole="button" onPress={() => setPicked("")}>
                <Text style={{ color: c.accent }}>‹ Back to board</Text>
              </Pressable>
              {task.data?.data
                ? (
                  <TaskScreen
                    theme={theme}
                    view={task.data.data}
                    back={() => setPicked("")}
                    openAgent={navigation ? (agentId) => navigation.openAgent({ agentId }) : undefined}
                  />
                )
                : (
                  <Text style={{ color: c.foregroundMuted }}>
                    {task.error?.message || task.data?.error || "Opening task…"}
                  </Text>
                )}
            </Panel>
          )
          : tab === "agents"
          ? (
            <Panel theme={theme}>
              <Roster theme={theme} workspaceId={workspaceId} />
            </Panel>
          )
          : (
            <View style={{ flexDirection: wide ? "row" : "column", alignItems: "stretch", gap: 16 }}>
              <View style={{ flex: wide ? 2 : undefined, minWidth: 0, gap: 14 }}>
                {workToReview && queue}
                <Panel theme={theme}>
                  <Composer theme={theme} workspaceId={workspaceId} onStarted={(run) => setPicked("run:" + run)} />
                </Panel>
                {!workToReview && queue}
              </View>
              {wide && (
                <View style={{ flex: 1, minWidth: 220 }}>
                  <Panel theme={theme}>
                    <Roster theme={theme} workspaceId={workspaceId} />
                  </Panel>
                </View>
              )}
            </View>
          )}
      </View>
    </ScrollView>
  );
}
export function ClydeScreen(props: PluginScreenProps) {
  return <Board {...props} initialTask={props.params.task} />;
}
