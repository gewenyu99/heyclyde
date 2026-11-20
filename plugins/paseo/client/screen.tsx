import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps, PluginWorkspacePanelProps, PluginTab } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { homeRpc, taskRpc, wranglerRpc } from "../shared/clyde";
import {Quests} from "./quests";
import { Composer } from "./composer";
import { useBoardState, type ComposerDraft } from "./board-state";
import { Roster } from "./roster";
import { HomeView } from "./home";
import { useLive } from "./nodes";
import { formatRpcError, MIN_HIT_HEIGHT, tones } from "./palette";
import { AttachedChat } from "./attached-chat";
import { resolveSelectedStage, Steering, TaskInspector, TaskScreen } from "./task";
import { WorkerPermissions } from "./worker-permissions";
import {Lockup,clydeTheme} from "./brand";

function Panel({ theme, children, fill = false }: { theme: PluginTheme; children: ReactNode; fill?: boolean }) {
  return (
    <View
      style={{
        ...(fill ? { flex: 1, minHeight: 0 } : {}),
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

function Board(
  { theme: hostTheme, layout, navigation, workspaceId, initialTask, selectionKey, panelTab }:
    & Pick<PluginScreenProps, "theme" | "layout" | "navigation">
    & { workspaceId?: string; initialTask?: string; selectionKey: string; panelTab?: PluginTab },
) {
  const theme=clydeTheme(hostTheme);
  useLive();
  const openAgent=navigation ? (agentId:string)=>navigation.openAgent({agentId}):undefined;
  const readHome = useRpc(homeRpc), readTask = useRpc(taskRpc), openWrangler = useRpc(wranglerRpc);
  const persisted=useBoardState(selectionKey,!workspaceId,panelTab,initialTask);
  const {picked,newTask,mobilePane,tab}=persisted.value;
  const [width,setWidth]=useState(0);
  const [pendingPermissionFor,setPendingPermissionFor]=useState<string|null|undefined>(undefined);
  const [chatMode,setChatMode]=useState<"details"|"attached"|"wrangler">("details");
  const [attachedTarget,setAttachedTarget]=useState<"worker"|"parent">("worker");
  const [selectedStage,setSelectedStage]=useState<string|undefined>(undefined);
  function setPicked(picked:string){setPendingPermissionFor(undefined);setChatMode("details");setAttachedTarget("worker");setSelectedStage(undefined);persisted.set({picked,mobilePane:"task"});}
  const setNewTask=(newTask:boolean)=>persisted.set({newTask});
  const setMobilePane=(mobilePane:"task"|"chat")=>persisted.set({mobilePane});
  const setTab=(tab:"board"|"agents"|"quests")=>persisted.set({tab});
  function saveComposer(update:ComposerDraft|((previous:ComposerDraft)=>ComposerDraft)){
    persisted.set(previous=>{const composer=typeof update==="function"?update(previous.composer):update;return {...previous,composer,newTask:previous.newTask || !!composer.text || !!composer.doneWhen};});
  }
  const c = theme.colors, wide = width >= 860, inset = width >= 650 ? 20 : 12;
  const home = useQuery({
    queryKey: ["clyde", "home", workspaceId ?? "all"],
    queryFn: () => readHome({ workspaceId }),
    refetchInterval: 10000,
  });
  const [kind, id] = picked.split(":");
  const selectedTask = !!id && (kind === "run" || kind === "thread");
  const task = useQuery({
    queryKey: ["clyde", "task", kind, id],
    queryFn: () => readTask({ kind: kind as "run" | "thread", id }),
    enabled: persisted.ready && selectedTask,
    refetchInterval: 5000,
  });
  const wranglerQuery = useQuery({
    queryKey: ["clyde", "wrangler", id],
    queryFn: () => openWrangler({ runId: id }),
    enabled: persisted.ready && kind === "run" && !!id && chatMode === "wrangler",
    staleTime: 60_000,
    retry: false,
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
  if(!persisted.ready)return <View style={{flex:1,padding:inset,backgroundColor:c.surface0,gap:8}}>
    <Text accessibilityLiveRegion="polite" style={{color:c.foregroundMuted,fontSize:13}}>{persisted.error || "Restoring Clyde…"}</Text>
    {!!persisted.error && <Pressable accessibilityRole="button" onPress={()=>void persisted.retry()} style={{minHeight:MIN_HIT_HEIGHT,justifyContent:"center"}}><Text style={{color:c.accent,fontSize:13}}>Retry restoring</Text></Pressable>}
  </View>;
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
        {!!persisted.error && <View style={{gap:4}}>
          <Text accessibilityRole="alert" style={{color:c.statusDanger,fontSize:13}}>{persisted.error}</Text>
          <Pressable accessibilityRole="button" onPress={()=>void persisted.retry()} style={{minHeight:MIN_HIT_HEIGHT,justifyContent:"center"}}><Text style={{color:c.accent,fontSize:13}}>Retry saving</Text></Pressable>
        </View>}
        {selectedTask
          ? (
            <View style={{ flex: 1, minHeight: 0, gap: 10 }}>
              {!wide && kind === "run" && <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 8 }}>
                {(["task", "chat"] as const).map(pane => <Pressable key={pane} accessibilityRole="tab" accessibilityState={{ selected: mobilePane === pane }} onPress={() => setMobilePane(pane)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingHorizontal: 14, backgroundColor: mobilePane === pane ? c.surface1 : "transparent", borderRadius: 6 }}>
                  <Text style={{ color: mobilePane === pane ? c.foreground : c.foregroundMuted, fontSize: 14, fontWeight: "600" }}>{pane === "task" ? "Task" : pendingPermissionFor ? "Chat · Permission" : "Chat"}</Text>
                </Pressable>)}
              </View>}
              <View style={{ flex: 1, minHeight: 0, flexDirection: wide ? "row" : "column", gap: 12 }}>
              <ScrollView key={picked} style={{ display: !wide && kind === "run" && mobilePane === "chat" ? "none" : "flex", flex: kind === "run" ? (wide ? 3 : 1) : 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: 16 }}>
                <Panel theme={theme}>
                  {!task.data?.data && <Pressable accessibilityRole="button" onPress={() => setPicked("")} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
                    <Text style={{ color: c.accent, fontSize: 14, fontWeight: "600" }}>‹ Back to board</Text>
                  </Pressable>}
                  {task.data?.data ? (
                    <TaskScreen
                      key={picked}
                      theme={theme}
                      view={task.data.data}
                      back={() => setPicked("")}
                      openAgent={openAgent}
                      embeddedSupervisor={kind === "run"}
                      externalPendingFor={pendingPermissionFor}
                      selectedStage={selectedStage}
                      onSelectStage={(stage) => {
                        setSelectedStage(stage);
                        if (!wide) setMobilePane("chat");
                      }}
                    />
                  ) : (
                    <Text accessibilityRole={task.error || task.data?.error ? "alert" : undefined} style={{ color: task.error || task.data?.error ? c.statusDanger : c.foregroundMuted, fontSize: 13 }}>
                      {task.error ? formatRpcError(task.error) : task.data?.error ? formatRpcError(task.data.error) : "Opening task…"}
                    </Text>
                  )}
                </Panel>
              </ScrollView>
              {kind === "run" && (() => {
                const view = task.data?.data;
                const t = tones(theme);
                const selected = view ? resolveSelectedStage(view, selectedStage) : undefined;
                const selectedNodeAgentId = selected
                  ? (selected.piece.agentId ?? selected.piece.phases.flatMap((phase) => view?.attempts[phase.stage] ?? []).reverse().find((a) => a.agentId)?.agentId)
                  : undefined;
                const workerId = selectedNodeAgentId || view?.agentId;
                const parentId = view?.parentAgentId;
                const activeAttachedId = attachedTarget === "parent" ? (parentId || workerId) : (workerId || parentId);
                const activeTab = chatMode === "attached" && !activeAttachedId ? "details" : chatMode;
                const activeLabel = activeAttachedId === parentId && parentId !== workerId ? "Orchestrator" : "Worker";
                const showPerms = !!view && ["running", "asking", "sent-back"].includes(view.status);
                const expectedPerm = !!view?.runActivity?.permissionAgentId;
                const wranglerAgentId = wranglerQuery.data?.agentId;
                return (
                  <View style={{ display: !wide && mobilePane === "task" ? "none" : "flex", flex: wide ? 2 : 1, minWidth: wide ? 340 : 0, minHeight: 0, borderWidth: 1, borderColor: c.border, borderRadius: 12, overflow: "hidden", backgroundColor: c.surface1 }}>
                    <View accessibilityRole="tablist" style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6, flexWrap: "wrap", paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.surface2 }}>
                      <View style={{ flexDirection: "row", gap: 4, flexWrap: "wrap" }}>
                        <Pressable
                          accessibilityRole="tab"
                          accessibilityState={{ selected: activeTab === "details" }}
                          onPress={() => setChatMode("details")}
                          style={{ minHeight: MIN_HIT_HEIGHT, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, borderRadius: 6, backgroundColor: activeTab === "details" ? c.surface1 : "transparent" }}
                        >
                          <Text style={{ color: activeTab === "details" ? c.foreground : c.foregroundMuted, fontSize: 13, fontWeight: "700" }}>Details</Text>
                          {!!selected?.piece.id && (
                            <View style={{ backgroundColor: t.blue.soft, borderRadius: 4, paddingVertical: 2, paddingHorizontal: 6 }}>
                              <Text style={{ color: t.blue.ink, fontSize: 12, fontWeight: "700" }}>{selected.piece.id}</Text>
                            </View>
                          )}
                        </Pressable>
                        {!!activeAttachedId && (
                          <Pressable
                            accessibilityRole="tab"
                            accessibilityState={{ selected: activeTab === "attached" }}
                            onPress={() => setChatMode("attached")}
                            style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingHorizontal: 10, borderRadius: 6, backgroundColor: activeTab === "attached" ? c.surface1 : "transparent" }}
                          >
                            <Text style={{ color: activeTab === "attached" ? c.foreground : c.foregroundMuted, fontSize: 13, fontWeight: "700" }}>Paseo chat</Text>
                          </Pressable>
                        )}
                        <Pressable
                          accessibilityRole="tab"
                          accessibilityState={{ selected: activeTab === "wrangler" }}
                          onPress={() => setChatMode("wrangler")}
                          style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingHorizontal: 10, borderRadius: 6, backgroundColor: activeTab === "wrangler" ? c.surface1 : "transparent" }}
                        >
                          <Text style={{ color: activeTab === "wrangler" ? c.foreground : c.foregroundMuted, fontSize: 13, fontWeight: "700" }}>Wrangler</Text>
                        </Pressable>
                      </View>
                      {activeTab === "attached" && workerId && parentId && workerId !== parentId ? (
                        <View style={{ flexDirection: "row", gap: 4 }}>
                          {(["worker", "parent"] as const).map(targetKey => {
                            const sel = (targetKey === "parent" ? parentId : workerId) === activeAttachedId;
                            return (
                              <Pressable
                                key={targetKey}
                                accessibilityRole="button"
                                accessibilityState={{ selected: sel }}
                                onPress={() => setAttachedTarget(targetKey)}
                                style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingHorizontal: 8, borderRadius: 5, borderWidth: 1, borderColor: sel ? c.accent : c.border, backgroundColor: sel ? c.surface1 : "transparent" }}
                              >
                                <Text style={{ color: sel ? c.accent : c.foregroundMuted, fontSize: 12, fontWeight: "600" }}>
                                  {targetKey === "worker" ? "Worker" : "Lead"}
                                </Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      ) : activeTab === "details" && activeAttachedId && openAgent ? (
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => openAgent(activeAttachedId)}
                          style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingHorizontal: 6 }}
                        >
                          <Text style={{ color: c.accent, fontSize: 12, fontWeight: "600" }}>Open in Paseo ↗</Text>
                        </Pressable>
                      ) : null}
                    </View>
                    {activeTab === "details" ? (
                      <View style={{ flex: 1, minHeight: 0 }}>
                        {showPerms && (
                          <View style={{ paddingHorizontal: 12, paddingTop: 10 }}>
                            <WorkerPermissions key={id} theme={theme} runId={id} openAgent={openAgent} onPending={setPendingPermissionFor} expected={expectedPerm} variant="chat" />
                          </View>
                        )}
                        <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 14, paddingBottom: 18 }}>
                          {view ? (
                            <TaskInspector
                              theme={theme}
                              view={view}
                              selectedStage={selected?.stage}
                              onSelectStage={setSelectedStage}
                              stacked
                            />
                          ) : (
                            <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Loading piece details…</Text>
                          )}
                        </ScrollView>
                        {view?.status === "running" && (
                          <View style={{ paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface2 }}>
                            <Steering id={id} theme={theme} compact />
                          </View>
                        )}
                      </View>
                    ) : activeTab === "attached" ? (
                      <View style={{ flex: 1, minHeight: 0, padding: 12 }}>
                        <AttachedChat
                          key={activeAttachedId}
                          theme={theme}
                          runId={id}
                          agentId={activeAttachedId!}
                          agentLabel={activeLabel}
                          openAgent={openAgent}
                          showPermissions={showPerms}
                          expectedPermission={expectedPerm}
                          onPendingPermission={setPendingPermissionFor}
                        />
                      </View>
                    ) : wranglerAgentId ? (
                      <View style={{ flex: 1, minHeight: 0, padding: 12 }}>
                        <AttachedChat
                          key={wranglerAgentId}
                          theme={theme}
                          runId={id}
                          agentId={wranglerAgentId}
                          agentLabel="Wrangler"
                          placeholder="Ask Wrangler to inspect the DAG or steer/message other agents…"
                          emptyHint="Wrangler sees the full DAG and main chat. Ask it to check status, adjust the plan, or steer/message another agent."
                          openAgent={openAgent}
                          showPermissions={showPerms}
                          expectedPermission={expectedPerm}
                          onPendingPermission={setPendingPermissionFor}
                        />
                      </View>
                    ) : (
                      <View style={{ flex: 1, minHeight: 0, padding: 14, gap: 8 }}>
                        <Text accessibilityRole={wranglerQuery.error ? "alert" : undefined} style={{ color: wranglerQuery.error ? c.statusDanger : c.foregroundMuted, fontSize: 13 }}>
                          {wranglerQuery.error ? formatRpcError(wranglerQuery.error) : "Starting Wrangler sidekick…"}
                        </Text>
                        {wranglerQuery.error && (
                          <Pressable accessibilityRole="button" onPress={() => void wranglerQuery.refetch()} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", alignSelf: "flex-start" }}>
                            <Text style={{ color: c.accent, fontSize: 13, fontWeight: "600" }}>Retry</Text>
                          </Pressable>
                        )}
                      </View>
                    )}
                  </View>
                );
              })()}
              </View>
            </View>
          )
          : tab === "quests"
          ? (
            <View style={{ flex: 1, minHeight: 0 }}>
              <Panel theme={theme} fill>
                <Quests theme={theme} workspaceId={workspaceId} onStarted={run=>setPicked("run:"+run)}/>
              </Panel>
            </View>
          )
          : <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: 20 }}>
          {tab === "agents"
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
                <Composer board theme={theme} workspaceId={workspaceId} draftState={persisted.value.composer} onDraftStateChange={saveComposer} onStarted={(run) => { setNewTask(false); setPicked("run:" + run); }} />
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
