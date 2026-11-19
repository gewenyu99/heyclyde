import { projectRegistry } from "./server/project-registry.ts";
import { currentActivity, workspaceActivity } from "./server/current-activity.ts";
import { suggestProject } from "./server/project-selection.ts";
import { workerPermissions } from "./server/worker-permissions.ts";
import { allowRunLookups } from "./server/allow-run-lookups.ts";
import { isProjectChat, listAllAgents, projectSlug, residents } from "./server/residents.ts";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { call, ensureCompanion, follow, readJson, updateWhenIdle } from "./server/daemon.ts";
import { home, task, threadTask, transcript, type RawRun, type RawThread } from "./server/shape.ts";
import { supervisorRpc, askSupervisorRpc, type SupervisorState, removeRpc, launchRpc, openChatRpc, steerRpc, answerRpc, homeRpc, stopRpc, taskRpc, transcriptRpc, waitRpc, type Diff, type workerModels } from "./shared/clyde.ts";
import { newQuestRpc, questProjectMatches } from "./shared/clyde.ts";

type PaseoApi = PluginHandlerContext["paseo"];
type ProviderId = Parameters<PaseoApi["providers"]["listModels"]>[0];

const agents = () => readJson<Record<string, string>>("paseo-threads.json") ?? {};
const failed = (err: unknown) => ({ error: (err as Error).message });

type WorkerModel = typeof workerModels[number];
type WorkspaceEntry = Awaited<ReturnType<PaseoApi["workspaces"]["list"]>>["entries"][number];
type ProjectEntry = Awaited<ReturnType<PaseoApi["projects"]["list"]>>["projects"][number];

const PROVIDER_PREF: Record<WorkerModel, string[]> = {
  neon: ["antigravity", "claude", "codex"],
  astra: ["antigravity", "claude", "codex"],
  sonnet: ["claude", "codex", "antigravity"],
  opus: ["claude", "codex", "antigravity"],
  sol: ["codex", "claude", "antigravity"],
  auto: ["claude", "codex", "antigravity"],
};

const LAUNCH_CHAT_ERROR = "Could not open a project chat automatically. Open a chat in this project and try again.";

function pickSelectableModel(models?: { id: string; isDefault?: boolean; isSelectable?: boolean }[]): string | undefined {
  const selectable = (models ?? []).filter((m) => m.isSelectable !== false);
  return (selectable.find((m) => m.isDefault) ?? selectable[0])?.id;
}

/** Resolve an available provider/model string from Paseo for auto-opening a project chat. */
async function pickProvider(paseo: PaseoApi, cwd: string, worker: WorkerModel): Promise<string | undefined> {
  const pref = PROVIDER_PREF[worker] ?? PROVIDER_PREF.auto;
  let snap = await paseo.providers?.snapshot?.({ cwd }).catch(() => null);
  let entries = snap?.entries ?? [];
  let ready = entries.filter((e) => e.enabled !== false && e.status === "ready");
  if (ready.length === 0 && entries.some((e) => e.enabled !== false && e.status === "loading") && paseo.providers?.waitForReady) {
    snap = await paseo.providers.waitForReady({ cwd, timeoutMs: 10_000 }).catch(() => snap);
    entries = snap?.entries ?? entries;
    ready = entries.filter((e) => e.enabled !== false && e.status === "ready");
  }
  const sortByPref = <T extends { provider: string }>(items: T[]) =>
    [...items].sort((a, b) => {
      const ia = pref.indexOf(a.provider);
      const ib = pref.indexOf(b.provider);
      return (ia === -1 ? pref.length : ia) - (ib === -1 ? pref.length : ib);
    });
  for (const chosen of sortByPref(ready)) {
    let modelId = pickSelectableModel(chosen.models);
    if (!modelId && paseo.providers?.listModels) {
      const listed = await paseo.providers.listModels(chosen.provider as ProviderId, { cwd }).catch(() => null);
      modelId = pickSelectableModel(listed?.models);
    }
    if (modelId) return `${chosen.provider}/${modelId}`;
    if (chosen.models === undefined && !paseo.providers?.listModels) return chosen.provider;
  }
  const avail = await paseo.providers?.listAvailable?.().catch(() => null);
  const readyNames = (avail?.providers ?? []).filter((p) => p.available);
  for (const chosen of sortByPref(readyNames)) {
    if (paseo.providers?.listModels) {
      const listed = await paseo.providers.listModels(chosen.provider as ProviderId, { cwd }).catch(() => null);
      const modelId = pickSelectableModel(listed?.models);
      if (modelId) return `${chosen.provider}/${modelId}`;
    } else {
      return chosen.provider;
    }
  }
  return undefined;
}

/** Open a chat in the selected project when launchRpc starts without an existing chat. */
async function createProjectChat(
  paseo: PaseoApi,
  selected: ProjectEntry,
  workspaces: WorkspaceEntry[],
  worker: WorkerModel,
  prompt: string,
  requestId: string,
  selectedProvider?: string,
): Promise<string> {
  const ws = workspaces.find((w) => !w.background && !w.internal && !w.archivingAt && !(w as { archivedAt?: string | null }).archivedAt);
  const chatCwd = ws?.workspaceDirectory || selected.projectRootPath;
  const provider = selectedProvider ?? await pickProvider(paseo, chatCwd, worker);
  if (!provider) throw new Error(LAUNCH_CHAT_ERROR);
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  const title = (firstLine || selected.projectDisplayName).slice(0, 72);
  const idempotencyKey = "clyde-launch-" + requestId;
  const labels = { "clyde.orchestrator": "r-" + requestId.replace(/^quest-/, "") };
  try {
    const handle = ws && paseo.workspaces?.ref
      ? await paseo.workspaces.ref(ws.id).agents.create({ idempotencyKey, title, labels, config: { provider } })
      : await paseo.agents?.create?.({ cwd: chatCwd, idempotencyKey, title, labels, config: { provider } });
    if (!handle?.id) throw new Error(LAUNCH_CHAT_ERROR);
    return handle.id;
  } catch (err) {
    if (err instanceof Error && err.message === LAUNCH_CHAT_ERROR) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not open a project chat automatically in ${selected.projectDisplayName}: ${detail}`);
  }
}

/** What the run's branch has changed so far: commits and diff stat against the base it was cut from. */
function diffOf(r: RawRun): Diff | undefined {
  if (!r.cwd || !r.base) return undefined;
  try {
    const git = (...a: string[]) => execFileSync("git", ["-C", r.cwd!, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    const commits = Number(git("rev-list", "--count", `${r.base}..HEAD`)) || 0;
    const stat = git("diff", "--shortstat", r.base);
    const num = (re: RegExp) => Number(stat.match(re)?.[1] ?? 0);
    return { commits, files: num(/(\d+) files? changed/), insertions: num(/(\d+) insertions?/), deletions: num(/(\d+) deletions?/) };
  } catch {
    return undefined;
  }
}

function canonicalPath(p?: string): string | undefined {
  if (!p) return undefined;
  try { return realpathSync(p); } catch { return p; }
}

function findProjectForPath(
  targetPath: string | undefined,
  projects: ProjectEntry[],
  workspaces: WorkspaceEntry[],
): { project: ProjectEntry; workspaces: WorkspaceEntry[] } | undefined {
  const target = canonicalPath(targetPath);
  if (!target) return undefined;
  const gitProjects = projects.filter((p) => p.projectKind !== "non_git");
  const projectById = new Map(gitProjects.map((p) => [p.projectId, p]));
  const wsMatch = workspaces.find((w) => projectById.has(w.projectId) && canonicalPath(w.workspaceDirectory) === target);
  const exactProject = (wsMatch ? projectById.get(wsMatch.projectId) : undefined)
    ?? gitProjects.find((p) => canonicalPath(p.projectRootPath) === target);
  const project = exactProject ?? gitProjects
    .map((p) => ({ p, root: canonicalPath(p.projectRootPath) }))
    .filter((x): x is { p: ProjectEntry; root: string } => Boolean(x.root) && target.startsWith(x.root + "/"))
    .sort((a, b) => b.root.length - a.root.length)[0]?.p;
  if (!project) return undefined;
  return { project, workspaces: workspaces.filter((w) => w.projectId === project.projectId) };
}

async function resolveProjectChat(
  paseo: PaseoApi,
  allAgents: Awaited<ReturnType<typeof listAllAgents>>,
  targetPath: string | undefined,
  title: string,
  exactRepository = false,
): Promise<{ agentId: string; created: boolean } | null> {
  const [{ projects }, { entries: workspaces }] = await Promise.all([
    paseo.projects.list(),
    paseo.workspaces.list(),
  ]);
  const match = findProjectForPath(targetPath, projects, workspaces);
  if (!match) return null;
  if (exactRepository && canonicalPath(match.project.projectRootPath) !== canonicalPath(targetPath) &&
      !match.workspaces.some(w => canonicalPath(w.workspaceDirectory) === canonicalPath(targetPath))) return null;
  const workspaceIds = new Set(match.workspaces.map((w) => w.id));
  const chats = allAgents
    .filter((a) => a.workspaceId && workspaceIds.has(a.workspaceId) && isProjectChat(a))
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""));
  if (chats.length > 0) return { agentId: chats[0].id, created: false };
  const agentId = await createProjectChat(paseo, match.project, match.workspaces, "auto", title, "open-chat-" + randomUUID());
  return { agentId, created: true };
}

export default function contribute(server: PluginServerContext) {
  workerPermissions(server);
  suggestProject(server);
  allowRunLookups(server);
  const live = follow(ensureCompanion);
  const cancelUpdate = typeof readJson<{ pid?: number }>("daemon.json")?.pid === "number" ? updateWhenIdle() : undefined;
  const residentControl = residents(server);
  type QuestStart = { quest:number;project:string;workspaceId?:string;agent?:string;id?:string };
  const questStarts = readJson<Record<string,QuestStart>>("quest-starts.json") ?? {};
  const startingQuests = new Map<string,Promise<{id:string}>>();
  const questRequests = new Map<string,{signature:string;promise:Promise<{id:string}>}>();
  const saveQuestStarts = () => {
    const dir = process.env.CLYDE_HOME || join(homedir(), ".clyde");
    mkdirSync(dir,{recursive:true,mode:0o700});
    const path=join(dir,"quest-starts.json");
    writeFileSync(path+".tmp",JSON.stringify(questStarts),{mode:0o600});
    renameSync(path+".tmp",path);
  };
  projectRegistry(server);
  server.handle(newQuestRpc, async (input, {paseo}) => {
    const {quest,project,workspaceId,requestId}=input;
    const known=questStarts[requestId];
    if(known && (known.quest!==quest || known.project!==project || known.workspaceId!==workspaceId))throw new Error("This request already belongs to another quest or project.");
    const signature=JSON.stringify([quest,project,workspaceId]);
    const activeRequest=questRequests.get(requestId);
    if(activeRequest){
      if(activeRequest.signature!==signature)throw new Error("This request already belongs to another quest or project.");
      return activeRequest.promise;
    }
    const key=JSON.stringify([project,quest]);
    const pending=startingQuests.get(key);
    if(pending){
      if(!known)throw new Error("This quest is already starting. Retry shortly.");
      return pending;
    }
    const start=(async()=>{
      const selected=(await paseo.projects.list()).projects.find(p=>p.projectId===project && p.projectKind!=="non_git");
      if(!selected)throw new Error("Select an available Git project in Paseo.");
      const available=(await paseo.workspaces.list()).entries.filter(w=>w.projectId===project && !w.background && !w.internal && !w.archivingAt && !(w as {archivedAt?:string|null}).archivedAt);
      const workspace=workspaceId ? available.find(w=>w.id===workspaceId) : available.length===1 ? available[0] : undefined;
      if(workspaceId && !workspace)throw new Error("Choose an available workspace in the selected project.");
      if(!workspaceId && available.length>1)throw new Error("Choose a workspace for the new quest orchestrator.");
      if(known?.id)return {id:known.id};
      let prior:QuestStart|undefined;
      if(!known)for(const candidate of Object.values(questStarts)){
        if(candidate.quest!==quest || candidate.project!==project || !candidate.agent)continue;
        if(candidate.id){
          const run=await call<{status:string}>("GET","/runs/"+encodeURIComponent(candidate.id)).catch(err=>{if(!String(err).includes("404"))throw err;return null;});
          if(run && ["done","failed","stopped"].includes(run.status))continue;
        }
        prior=candidate;break;
      }
      const record=known ?? prior ?? {quest,project,...(workspaceId?{workspaceId}:{})};
      if(prior && prior.workspaceId!==workspaceId)throw new Error("This quest already has an orchestrator in another workspace.");
      const slug=projectSlug(selected.projectRootPath),cwd=workspace?.workspaceDirectory || selected.projectRootPath;
      const item=(await residentControl.questBoard()).quests.find(q=>q.id===quest);
      if(!item)throw new Error("This quest is no longer available.");
      if(!questProjectMatches(slug,item.project))throw new Error("This quest belongs to another project.");
      if(item.assignee && item.assignee!=="any")throw new Error("This quest targets an existing agent; start it with its assigned orchestrator.");
      if(!record.agent){
        if(item.state && item.state!=="open")throw new Error("This quest is no longer open.");
        const provider=await pickProvider(paseo,cwd,"auto");
        if(!provider)throw new Error(LAUNCH_CHAT_ERROR);
        questStarts[requestId]=record;saveQuestStarts();
        record.agent=await createProjectChat(paseo,selected,workspace?[workspace]:[],"auto",`Quest #${quest}: ${item.title}`,"quest-"+requestId,provider);
        saveQuestStarts();
      }else if(!known){questStarts[requestId]=record;saveQuestStarts();}
      await residentControl.prepareQuestOwner(record.agent,quest,slug,paseo);
      const result=await residentControl.startQuest({agent:record.agent,quest,requestId,item},paseo);
      record.id=result.id;saveQuestStarts();
      return result;
    })();
    startingQuests.set(key,start);
    questRequests.set(requestId,{signature,promise:start});
    try{return await start;}finally{
      if(startingQuests.get(key)===start)startingQuests.delete(key);
      if(questRequests.get(requestId)?.promise===start)questRequests.delete(requestId);
    }
  });
  server.handle(launchRpc, async ({project,workspaceId,prompt,criteria,flow,worker,requestId,agentId,newChat,allowAntigravityFullAccess}, {paseo}) => {
    const selected=(await paseo.projects.list()).projects.find(p => p.projectId === project && p.projectKind !== "non_git");
    if (!selected) throw new Error("Select an available Git project in Paseo.");
    const allWorkspaces=(await paseo.workspaces.list()).entries.filter(w=>w.projectId===project);
    const activeWorkspace = workspaceId ? allWorkspaces.find((w) => w.id === workspaceId) : undefined;
    if (workspaceId && !activeWorkspace) throw new Error("Workspace belongs to another project.");
    const workspaces = activeWorkspace ? [activeWorkspace] : allWorkspaces;
    const workspaceIds=new Set(workspaces.map(w=>w.id));
    const agents=(await listAllAgents(paseo))
      .filter(a=>a.workspaceId && workspaceIds.has(a.workspaceId) && isProjectChat(a))
      .sort((a,b)=>(b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""));
    if(agentId && !agents.some(a=>a.id===agentId)) throw new Error("Choose a chat in the selected project.");
    const origin = agentId
      ? agentId
      : !newChat && agents.length >= 1
      ? agents[0].id
      : await createProjectChat(paseo, selected, workspaces, worker, prompt, requestId);
    const launchCwd = activeWorkspace?.workspaceDirectory || selected.projectRootPath;
    const routing=worker === "auto" ? {} : {overrides:{worker}};
    const existing=await call<{id:string,repo:string}>("GET","/runs/"+encodeURIComponent("r-"+requestId)).catch(e=>{if(!String(e).includes("404"))throw e;return null;});
    if(existing){const allowed=[selected.projectRootPath,activeWorkspace?.workspaceDirectory].filter(Boolean);if(!allowed.includes(existing.repo))throw new Error("Task belongs to another project.");residentControl.track(existing.id,origin,paseo);return {id:existing.id};}
    const notes=await residentControl.context(origin,prompt,paseo);
    const input=flow==="ship"
      ? {intent:prompt,criteria,notes:[criteria?.length ? "User completion criteria:\n"+criteria.join("\n") : "", notes].filter(Boolean).join("\n\n"),routing}
      : {prompt:prompt+notes,criteria:criteria?.length ? criteria : [prompt],routing};
    const run=await call<{id:string}>("POST","/runs",{flow,input:{...input,allowAntigravityFullAccess:worker==="neon"&&allowAntigravityFullAccess===true},cwd:launchCwd,assignment:requestId,paseoParentId:origin});
    if(origin)residentControl.track(run.id,origin,paseo);
    return {id:run.id};
  });
  server.handle(homeRpc, async ({workspaceId},{paseo}) => {
    try {
      const [threads, runs] = await Promise.all([call<RawThread[]>("GET", "/threads"), call<RawRun[]>("GET", "/runs")]);
      const workspace=workspaceId ? (await paseo.workspaces.list()).entries.find(w=>w.id===workspaceId) : undefined;
      const root=workspaceId ? (await paseo.projects.list()).projects.find(p=>p.projectId===workspace?.projectId)?.projectRootPath : undefined;
      const scoped = workspaceId ? workspaceActivity(threads, runs, [root, workspace?.workspaceDirectory]) : {threads,runs};
      const observed = await currentActivity(paseo, scoped.threads, scoped.runs);
      return { data: home(observed, scoped.runs, agents(), live.revision()) };
    } catch (err) { return failed(err); }
  });
  server.handle(taskRpc, async ({ kind, id }, {paseo}) => {
    try {
      const threads = await call<RawThread[]>("GET", "/threads");
      const safeId = encodeURIComponent(id);
      if (kind === "thread") return { data: threadTask(await call<RawThread>("GET", `/threads/${safeId}`), agents()) };
      const run = await call<RawRun>("GET", `/runs/${safeId}`);
      return { data: { ...task(run, await currentActivity(paseo, threads, [run], id), agents()), diff: diffOf(run) } };
    } catch (err) { return failed(err); }
  });
  server.handle(supervisorRpc, ({ id }) =>
    call<SupervisorState>("GET", `/runs/${encodeURIComponent(id)}/supervisor`));
  server.handle(askSupervisorRpc, async ({ id, text, requestId }) => {
    await call("POST", `/runs/${encodeURIComponent(id)}/supervisor`, { text, requestId });
    return { ok: true };
  });
  server.handle(transcriptRpc, async ({ threadId }) => {
    try { return { data: transcript(await call<RawThread>("GET", `/threads/${encodeURIComponent(threadId)}`)) }; } catch (err) { return failed(err); }
  });
  server.handle(waitRpc, async ({ after }) => ({ revision: await live.wait(after) }));
  server.handle(answerRpc, async ({ kind, id, text, askKey, allowAntigravityFullAccess }, { paseo }) => {
    try {
      const safeId = encodeURIComponent(id);
      if (kind === "run" && text.trim().toLowerCase() === "retry" && askKey) {
        const run = await call<RawRun>("GET", `/runs/${safeId}`);
        const ask = run.asks?.find(a => a.key === askKey && a.answer === undefined);
        if (run.status === "asking" && ask?.kind === "provider" && /originating Paseo (agent|workspace)/i.test(ask.question)) {
          const candidates = await listAllAgents(paseo);
          const previous = candidates.find(a => a.id === run.paseoParentId);
          if (!previous || previous.archivedAt || !previous.workspaceId) {
            // A retry repairs the execution parent; the quest claim stays with its original owner.
            const destination = await resolveProjectChat(paseo, candidates, run.repo ?? run.cwd, run.title, true);
            if (!destination) throw new Error("Open the run's Git project in Paseo before retrying.");
            await call("POST", `/runs/${safeId}/parent`, { paseoParentId: destination.agentId });
            await residentControl.openForRun(run, destination.agentId, paseo, !residentControl.isQuestRun(id));
          }
        }
      }
      await call("POST", kind === "run" ? `/runs/${safeId}/answer` : `/threads/${safeId}/messages`, { text, via: "paseo", askKey, allowAntigravityFullAccess });
      return { ok: true };
    } catch (err) { return { ok: false, error: (err as Error).message }; }
  });
  server.handle(removeRpc,async({kind,id})=>{await call("POST","/"+(kind==="run"?"runs":"threads")+"/"+encodeURIComponent(id)+"/archive",{});return {ok:true};});
  server.handle(steerRpc, async ({id,text}) => { await call("POST","/runs/"+encodeURIComponent(id)+"/steer",{text}); return {ok:true}; });
  server.handle(stopRpc, async ({ kind, id }) => {
    try {
      const safeId = encodeURIComponent(id);
      await call("POST", kind === "run" ? `/runs/${safeId}/stop` : `/threads/${safeId}/stop`, {});
      return { ok: true };
    } catch (err) { return { ok: false, error: (err as Error).message }; }
  });
  server.handle(openChatRpc, async ({ kind, id }, { paseo }) => {
    const safeId = encodeURIComponent(id);
    const allAgents = await listAllAgents(paseo);
    const liveById = new Map(allAgents.filter((a) => !a.archivedAt).map((a) => [a.id, a]));
    if (kind === "thread") {
      const thread = await call<RawThread>("GET", `/threads/${safeId}`);
      const direct = [thread.paseoParentId, agents()[thread.id], thread.paseoAgentId].find(
        (candidate): candidate is string => typeof candidate === "string" && liveById.has(candidate),
      );
      if (direct) return { agentId: direct };
      const projectChat = await resolveProjectChat(paseo, allAgents, thread.cwd, thread.title || thread.id);
      if (projectChat) return projectChat;
      throw new Error("Could not find or open a chat for this task. Open a chat in Paseo and try again.");
    }
    const [run, threads] = await Promise.all([
      call<RawRun>("GET", `/runs/${safeId}`),
      call<RawThread[]>("GET", "/threads"),
    ]);
    const chatRuns = readJson<Record<string, { agent?: string }>>("chat-runs.json") ?? {};
    const originId = run.paseoParentId ?? chatRuns[run.id]?.agent;
    if (originId && liveById.has(originId)) {
      await residentControl.openForRun(run, originId, paseo, false).catch(() => {});
      return { agentId: originId };
    }
    let projectChatError: unknown;
    const projectChat = await resolveProjectChat(paseo, allAgents, run.repo ?? run.cwd, run.title || run.id).catch((err) => {
      projectChatError = err;
      return null;
    });
    if (projectChat) {
      const canReattach = !residentControl.isQuestRun(run.id);
      if (canReattach && (run.status === "asking" || run.status === "running")) {
        await call("POST", `/runs/${safeId}/parent`, { paseoParentId: projectChat.agentId }).catch(() => {});
      }
      await residentControl.openForRun(run, projectChat.agentId, paseo, canReattach).catch(() => {});
      return projectChat;
    }
    const rep = run.stages[0]?.attempts[0]?.threadId;
    const workerId = threads.findLast((t) => t.runId === run.id && !t.archivedAt && t.paseoAgentId && liveById.has(t.paseoAgentId))?.paseoAgentId
      ?? (rep && agents()[rep] && liveById.has(agents()[rep]) ? agents()[rep] : undefined);
    if (workerId) return { agentId: workerId };
    if (projectChatError) throw projectChatError;
    throw new Error("Could not find or open a chat for this task. Open a chat in Paseo and try again.");
  });
  return () => { cancelUpdate?.(); residentControl.close(); live.close(); };
}
