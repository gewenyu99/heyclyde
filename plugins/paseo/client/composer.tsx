import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { launchRpc, projectsRpc, suggestProjectRpc, workerModels } from "../shared/clyde";
import { palette } from "./brand.generated";
import { formatRpcError, MIN_HIT_HEIGHT, scheme } from "./palette";
import { FolderRepositories } from "./folder-repositories";
import { AddProject } from "./add-project";
import { requestId } from "./request-id";
import { emptyComposer, type ComposerDraft } from "./board-state";

type Worker = typeof workerModels[number];
const workerLabel = (worker: Worker) => worker[0].toUpperCase() + worker.slice(1);
function catalogueOf(projects: readonly { id:string; slug?:string; path:string }[] | undefined) {
  return JSON.stringify((projects ?? []).map(project => [project.id, project.slug, project.path]).sort((a,b) => a[0]!.localeCompare(b[0]!)));
}
const isFolder=(project:{kind?:string}|undefined)=>project?.kind==="non_git";
export function Composer(
  { theme, onStarted, workspaceId, agentId, board = false, draftState, onDraftStateChange }: {
    theme: PluginTheme;
    workspaceId?: string;
    agentId?: string;
    board?: boolean;
    draftState?: ComposerDraft;
    onDraftStateChange?: (draft:ComposerDraft|((previous:ComposerDraft)=>ComposerDraft))=>void;
    onStarted: (id: string) => void;
  },
) {
  const c = theme.colors, edge = palette[scheme(theme)].edge, read = useRpc(projectsRpc), launch = useRpc(launchRpc), suggest = useRpc(suggestProjectRpc), cache = useQueryClient();
  const projectKey = ["clyde", "projects", workspaceId ?? "all"];
  const projects = useQuery({
    queryKey: projectKey,
    queryFn: () => read({ workspaceId }),
  });
  const autoAvailable = board && !workspaceId;
  const [localDraft,setLocalDraft]=useState(()=>draftState ?? emptyComposer(autoAvailable));
  const form=draftState ?? localDraft, formRef=useRef(form);formRef.current=form;
  function writeDraft(patch:Partial<ComposerDraft>){if((Object.keys(patch) as (keyof ComposerDraft)[]).every(key=>Object.is(formRef.current[key],patch[key])))return;const next={...formRef.current,...patch};formRef.current=next;setLocalDraft(next);onDraftStateChange?.(next);}
  const {project,chatId,text,flow,worker,menu,doneWhen,showCriteria,allowNeon,mode,routingNote,suggestion}=form;
  const setProject=(project:string)=>writeDraft({project}),setChatId=(chatId:string)=>writeDraft({chatId}),setText=(text:string)=>writeDraft({text});
  const setFlow=(flow:"task"|"ship")=>writeDraft({flow}),setWorker=(worker:Worker)=>writeDraft({worker}),setMenu=(menu:ComposerDraft["menu"])=>writeDraft({menu});
  const setDoneWhen=(doneWhen:string)=>writeDraft({doneWhen}),setShowCriteria=(showCriteria:boolean)=>writeDraft({showCriteria}),setAllowNeon=(allowNeon:boolean)=>writeDraft({allowNeon});
  const setMode=(mode:"auto"|"manual")=>writeDraft({mode}),setRoutingNote=(routingNote:string)=>writeDraft({routingNote}),setSuggestion=(suggestion:ComposerDraft["suggestion"])=>writeDraft({suggestion});
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [routingBusy, setRoutingBusy] = useState(false);
  const pending = useRef<{key:string;id:string}|null>(form.pendingRequest);
  const locked = useRef(false),routingLocked=useRef(false);
  const revision = useRef(suggestion?.revision ?? 0), draft = useRef(text), modeRef = useRef(mode), projectRef = useRef(project);
  useEffect(()=>()=>{revision.current++;routingLocked.current=false;},[]);
  // Progress events can refetch projects without changing the routing candidates.
  const catalogue = catalogueOf(projects.data), previousCatalogue = useRef(suggestion?.catalogue ?? catalogue);
  useEffect(() => {
    if (!projects.data || catalogue === previousCatalogue.current) return;
    previousCatalogue.current = catalogue; revision.current++; routingLocked.current = false;
    setSuggestion(undefined); setRoutingBusy(false);
  }, [catalogue]);
  const pinned=workspaceId && projects.data?.length===1?projects.data[0]:undefined;
  const folderId=workspaceId?(isFolder(pinned)?pinned?.id:""):form.folderProject;
  const repositoryProjects=useQuery({queryKey:["clyde","projects","all"],queryFn:()=>read({}),enabled:!!workspaceId && !!folderId});
  const folder=(projects.data ?? []).find(p=>p.id===folderId && isFolder(p));
  const originPlace=pinned?.workspaces?.find(w=>w.id===workspaceId);
  useEffect(()=>{
    if(!folderId || !workspaceId || formRef.current.folderProject===folderId)return;
    const different=!!formRef.current.folderProject;
    revision.current++;modeRef.current="manual";if(different)projectRef.current="";
    writeDraft({folderProject:folderId,mode:"manual",suggestion:undefined,...(different?{project:"",selectedWorkspace:""}:{})});
  },[folderId,workspaceId]);
  function pinnedFolderNow(){const rows=cache.getQueryState<NonNullable<typeof projects.data>>(projectKey)?.data;return !!workspaceId && rows?.length===1 && isFolder(rows[0]);}
  function changeDraft(value:string) {
    draft.current = value; revision.current++; routingLocked.current = false;
    writeDraft({text:value,suggestion:undefined,routingNote:""});setRoutingBusy(false);
  }
  function chooseProject(id:string, chosenWorkspace = "") {
    if (locked.current) return;
    routingLocked.current = false; revision.current++; modeRef.current = "manual"; projectRef.current = id;
    const row=cache.getQueryState<NonNullable<typeof projects.data>>(projectKey)?.data?.find(p=>p.id===id);
    const choosingFolder=isFolder(row);if(choosingFolder)projectRef.current="";
    writeDraft({folderProject:choosingFolder?id:"",selectedWorkspace:choosingFolder?"":chosenWorkspace,mode:"manual",project:choosingFolder?"":id,suggestion:undefined,routingNote:"",chatId:"",menu:null});setRoutingBusy(false);setError("");
  }
  function chooseAuto() {
    if (locked.current) return;
    routingLocked.current = false; revision.current++; modeRef.current = "auto"; projectRef.current = "";
    writeDraft({folderProject:"",selectedWorkspace:"",mode:"auto",project:"",suggestion:undefined,routingNote:"",menu:null});setRoutingBusy(false);setError("");
  }
  function chooseRepository(id:string){
    if(locked.current)return;
    revision.current++;routingLocked.current=false;modeRef.current="manual";projectRef.current=id;
    writeDraft({folderProject:folderId || "",project:id,selectedWorkspace:"",mode:"manual",suggestion:undefined,routingNote:"",chatId:"",menu:null});setRoutingBusy(false);setError("");
    void (workspaceId?repositoryProjects:projects).refetch();
  }
  function currentTarget() {
    const state = cache.getQueryState<NonNullable<typeof projects.data>>(projectKey);
    if (!state?.data) return;
    if(pinnedFolderNow())return cache.getQueryState<NonNullable<typeof projects.data>>(["clyde","projects","all"])?.data?.find(p=>p.id===projectRef.current && p.eligible!==false && !isFolder(p));
    if (workspaceId) return state.data.length === 1 && state.data[0].eligible !== false && !isFolder(state.data[0]) ? state.data[0] : undefined;
    if (modeRef.current === "manual") return state.data.find(p => p.id === projectRef.current && p.eligible !== false && !isFolder(p));
    if (!suggestion || suggestion.prompt !== draft.current || suggestion.revision !== revision.current || suggestion.catalogue !== catalogueOf(state.data)) return;
    return state.data.find(p => p.id === suggestion.projectId && p.eligible !== false && !isFolder(p));
  }
  const selected = currentTarget();
  const workspaceFor = (items: {id:string;name:string;path:string}[] = []) => {
    const id = (pinnedFolderNow()?undefined:workspaceId) || formRef.current.selectedWorkspace;
    return id ? items.find(w => w.id === id) : items.length === 1 ? items[0] : undefined;
  };
  const place = workspaceFor(selected?.workspaces);
  const pinnedCheckout=!!workspaceId && !pinnedFolderNow();
  const needsWorkspace = !!selected && !pinnedCheckout && !place && (!!form.selectedWorkspace || (selected.workspaces?.length ?? 0) > 1);

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
      if (!result.projectId || !latest?.data?.some(p => p.id === result.projectId && p.eligible !== false && !isFolder(p))) {
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
    const location = (pinnedFolderNow()?undefined:workspaceId) || workspaceFor(target.workspaces)?.id;
    if (!location && (formRef.current.selectedWorkspace || (target.workspaces?.length ?? 0) > 1)) return;
    locked.current = true;
    setBusy(true);
    setError("");
    const prompt = draft.current;
    const criteria = doneWhen.split("\n").map((line) => line.trim()).filter(Boolean);
    const key = JSON.stringify([target.id, location ?? "", effectiveAgentId || "__new__", prompt, flow, worker, criteria, allowNeon]);
    if (pending.current?.key !== key) { pending.current = { key, id: requestId() }; writeDraft({pendingRequest:pending.current}); }
    const launchRequestId=pending.current.id;
    try {
      const run = await launch({
        project: target.id,
        ...(location ? { workspaceId:location } : {}),
        prompt,
        criteria,
        allowAntigravityFullAccess: worker === "neon" && allowNeon,
        flow,
        worker,
        agentId: effectiveAgentId || undefined,
        ...(wantsNewChat ? { newChat: true } : {}),
        requestId: launchRequestId,
      });
      pending.current = null;
      const complete=(current:ComposerDraft):ComposerDraft=>{
        const same=current.text===prompt && current.pendingRequest?.id===launchRequestId;
        return {...current,pendingRequest:current.pendingRequest?.id===launchRequestId?null:current.pendingRequest,...(same?{text:"",doneWhen:"",showCriteria:false,allowNeon:false,suggestion:undefined}:{})};
      };
      const completed=complete(formRef.current);formRef.current=completed;setLocalDraft(completed);onDraftStateChange?.(complete);
      revision.current++;draft.current=completed.text;
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
  const inactive = busy || routingBusy || needsWorkspace || !text.trim() || (!selected && !needsRouting) || !projects.data?.length;
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
        {workspaceId && pinned && <Text style={{color:c.foreground,fontSize:13}}>{pinned.label || pinned.name}{originPlace?` · ${originPlace.name}`:""}</Text>}
        {(!workspaceId || !pinnedCheckout) && control((folder?.label || folder?.name || selected?.label || selected?.name || (autoAvailable && mode === "auto" ? "Project · Auto" : "Choose a project")) + " ▾", () => setMenu(menu === "project" ? null : "project"), false, { expanded: menu === "project" })}
        {board && !pinnedCheckout && selected && (selected.workspaces?.length ?? 0) > 0 &&
          control((place?.name || "Choose workspace") + " ▾", () => setMenu(menu === "workspace" ? null : "workspace"), false, { expanded:menu === "workspace" })}
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
      {folder && <View style={{gap:6}}>
        {selected && <Text style={{color:c.foreground,fontSize:13,fontWeight:"600"}}>Repository · {selected.label || selected.name}</Text>}
        <FolderRepositories theme={theme} projectId={folder.id} onSelect={chooseRepository} />
        {!!repositoryProjects.error && !!workspaceId && <Text accessibilityRole="alert" style={{color:c.statusDanger,fontSize:13}}>{formatRpcError(repositoryProjects.error)}</Text>}
      </View>}
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
              accessibilityState={{ selected: mode === "manual" && (folder?.id || selected?.id) === p.id, disabled: busy || (p.eligible === false && !isFolder(p)) }}
              disabled={busy || (p.eligible === false && !isFolder(p))}
              onPress={() => chooseProject(p.id)}
              style={{ padding: 8, minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
            >
              <Text style={{ color: mode === "manual" && (folder?.id || selected?.id) === p.id ? c.accent : c.foreground, fontWeight: "600", fontSize: 13 }}>{p.label || p.name}</Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                {p.path}{p.eligible === false && p.ineligibleReason ? ` · ${p.ineligibleReason}` : ""}{!board ? ` · ${p.chats.length} open ${p.chats.length === 1 ? "chat" : "chats"}` : ""}
              </Text>
            </Pressable>
          ))}
          {!workspaceId && <AddProject theme={theme} onSelected={chooseProject} />}
        </View>
      )}
      {menu === "workspace" && <View style={{gap:4}}>
        {selected?.workspaces?.map(w=><Pressable key={w.id} accessibilityRole="button" accessibilityState={{selected:place?.id===w.id,disabled:busy}} disabled={busy}
          onPress={()=>writeDraft({selectedWorkspace:w.id,menu:null})} style={{minHeight:MIN_HIT_HEIGHT,justifyContent:"center",padding:8}}>
          <Text style={{fontSize:13,color:c.foreground,fontWeight:"600"}}>{w.name}</Text>
          <Text style={{fontSize:12,color:c.foregroundMuted}}>{w.path}</Text>
        </Pressable>)}
      </View>}
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
