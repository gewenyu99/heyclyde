import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps, PluginWorkspacePanelProps, PluginTab } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { homeRpc, taskRpc } from "../shared/clyde";
import {Quests} from "./quests";
import { Composer } from "./composer";
import { Roster } from "./roster";
import { HomeView } from "./home";
import { useLive } from "./nodes";
import { formatRpcError, MIN_HIT_HEIGHT } from "./palette";
import { SupervisorChat } from "./supervisor-chat";
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
        padding: 16,
        gap: 6,
      }}
    >
      {children}
    </View>
  );
}

// Screens remount on navigation. Workspace tabs also carry Paseo-persisted state.
const lastTask = new Map<string, string>();

function Board(
  { theme: hostTheme, layout, navigation, workspaceId, initialTask, selectionKey, panelTab }:
    & Pick<PluginScreenProps, "theme" | "layout" | "navigation">
    & { workspaceId?: string; initialTask?: string; selectionKey: string; panelTab?: PluginTab },
) {
  const theme=clydeTheme(hostTheme);
  useLive();
  const openAgent=navigation ? (agentId:string)=>navigation.openAgent({agentId}):undefined;
  const readHome = useRpc(homeRpc), readTask = useRpc(taskRpc);
  const [picked, setSelected] = useState(() => {
    if (initialTask) return initialTask;
    if (typeof panelTab?.state === "string") return panelTab.state;
    return lastTask.get(selectionKey) ?? "";
  }),
    [width, setWidth] = useState(0),
    [newTask, setNewTask] = useState(false),
    [mobilePane, setMobilePane] = useState<"task" | "chat">("task"),
    [tab, setTab] = useState<"board" | "agents" | "quests">("board");
  useEffect(() => {
    if (initialTask) lastTask.set(selectionKey, initialTask);
  }, [initialTask, selectionKey]);
  function setPicked(next: string) {
    setSelected(next);
    lastTask.set(selectionKey, next);
    panelTab?.setState(next);
  }
  const c = theme.colors, wide = width >= 860, inset = width >= 650 ? 20 : 12;
  const home = useQuery({
    queryKey: ["clyde", "home", workspaceId ?? "all"],
    queryFn: () => readHome({ workspaceId }),
    refetchInterval: 10000,
  });
  const [kind, id] = picked.split(":");
  useEffect(() => { setMobilePane("task"); }, [picked]);
  const selectedTask = !!id && (kind === "run" || kind === "thread");
  const task = useQuery({
    queryKey: ["clyde", "task", kind, id],
    queryFn: () => readTask({ kind: kind as "run" | "thread", id }),
    enabled: selectedTask,
    refetchInterval: 5000,
  });
  const data = home.data?.data;
  const rawError = home.data?.error || (home.error ? formatRpcError(home.error) : "");
  const error = rawError ? formatRpcError(rawError) : "";
  const nav = (value: "board" | "agents" | "quests", label: string) => (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected: tab === value }}
      onPress={() => {
        setPicked("");
        setTab(value);
      }}
      style={{
        minHeight: MIN_HIT_HEIGHT,
        justifyContent: "center",
        paddingHorizontal: 14,
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
  const queue = <Panel theme={theme}>{data ? <HomeView theme={theme} home={data} open={(k,i)=>setPicked(k+":"+i)} openAgent={openAgent}/> :
    <Text accessibilityRole={error ? "alert" : undefined} style={{color:error?c.statusDanger:c.foregroundMuted,fontSize:13}}>{error||"Loading tasks…"}</Text>}</Panel>;
  const workToReview = !!(data?.needsYou.length || data?.failedToday?.length || data?.running || data?.tasks.length);
  return (
    <View
      style={{ flex: 1, minHeight: 0, backgroundColor: c.surface0, padding: inset, gap: 12 }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 10,
            borderBottomWidth: 1,
            borderColor: c.border,
            paddingBottom: 8,
          }}
        >
          <Lockup theme={theme} width={104}/>
          <View
            accessibilityRole="tablist"
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
            {nav("quests","Quests")}{nav("agents", "Agents")}
          </View>
        </View>
        {selectedTask
          ? (
            <View style={{ flex: 1, minHeight: 0, gap: 10 }}>
              {!wide && kind === "run" && <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 8 }}>
                {(["task", "chat"] as const).map(pane => <Pressable key={pane} accessibilityRole="tab" accessibilityState={{ selected: mobilePane === pane }} onPress={() => setMobilePane(pane)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingHorizontal: 14, backgroundColor: mobilePane === pane ? c.surface1 : "transparent", borderRadius: 6 }}>
                  <Text style={{ color: mobilePane === pane ? c.foreground : c.foregroundMuted, fontSize: 14, fontWeight: "600" }}>{pane === "task" ? "Task" : "Chat"}</Text>
                </Pressable>)}
              </View>}
              <View style={{ flex: 1, minHeight: 0, flexDirection: wide ? "row" : "column", gap: 12 }}>
              <ScrollView key={picked} style={{ display: !wide && kind === "run" && mobilePane === "chat" ? "none" : "flex", flex: kind === "run" ? (wide ? 3 : 1) : 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: 16 }}>
                <Panel theme={theme}>
                  {(kind === "run" || !task.data?.data) && <Pressable accessibilityRole="button" onPress={() => setPicked("")} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
                    <Text style={{ color: c.accent, fontSize: 14, fontWeight: "600" }}>‹ Back to board</Text>
                  </Pressable>}
                  {task.data?.data ? (
                    <TaskScreen key={picked} theme={theme} view={task.data.data} back={() => setPicked("")} openAgent={openAgent} embeddedSupervisor={kind === "run"} />
                  ) : (
                    <Text accessibilityRole={task.error || task.data?.error ? "alert" : undefined} style={{ color: task.error || task.data?.error ? c.statusDanger : c.foregroundMuted, fontSize: 13 }}>
                      {task.error ? formatRpcError(task.error) : task.data?.error ? formatRpcError(task.data.error) : "Opening task…"}
                    </Text>
                  )}
                </Panel>
              </ScrollView>
              {kind === "run" && <View style={{ display: !wide && mobilePane === "task" ? "none" : "flex", flex: wide ? 2 : 1, minWidth: wide ? 320 : 0, minHeight: 0, borderWidth: 1, borderColor: c.border, borderRadius: 12, overflow: "hidden", backgroundColor: c.surface1 }}>
                <SupervisorChat key={id} theme={theme} runId={id} />
              </View>}
              </View>
            </View>
          )
          : <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: 20 }}>
          {tab === "quests" ? <Panel theme={theme}><Quests theme={theme} onStarted={run=>setPicked("run:"+run)}/></Panel> : tab === "agents"
          ? (
            <Panel theme={theme}>
              <Roster theme={theme} workspaceId={workspaceId} openAgent={openAgent} />
            </Panel>
          )
          : (
            <View style={{ gap: 14 }}>
              {workToReview && queue}
              {workToReview && <Pressable accessibilityRole="button" accessibilityState={{ expanded: newTask }} onPress={() => setNewTask(!newTask)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
                <Text style={{ color: c.accent, fontSize: 14, fontWeight: "600" }}>{newTask ? "Close new task" : "+ New task"}</Text>
              </Pressable>}
              {(!workToReview || newTask) && <Panel theme={theme}>
                <Composer board theme={theme} workspaceId={workspaceId} onStarted={(run) => { setNewTask(false); setPicked("run:" + run); }} />
              </Panel>}
              {!workToReview && queue}
            </View>
          )}</ScrollView>}
    </View>
  );
}
export function ClydeScreen(props: PluginScreenProps) {
  const key = JSON.stringify([props.host.id, "screen"]);
  return <Board key={key + (props.params.task ?? "")} {...props} initialTask={props.params.task} selectionKey={key} />;
}

export function ClydeWorkspacePanel(props: PluginWorkspacePanelProps) {
  const key = JSON.stringify([props.host.id, "workspace", props.workspaceId]);
  return <Board key={key} {...props} panelTab={props.tab} selectionKey={key} />;
}
