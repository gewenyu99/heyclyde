import { isProjectChat, listAllAgents, residents } from "./server/residents.ts";
import { execFileSync } from "node:child_process";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { call, ensureCompanion, follow, readJson } from "./server/daemon.ts";
import { home, task, threadTask, transcript, type RawRun, type RawThread } from "./server/shape.ts";
import { removeRpc, projectsRpc, launchRpc, steerRpc, answerRpc, homeRpc, stopRpc, taskRpc, transcriptRpc, waitRpc, type Diff, type ProjectChat, type workerModels } from "./shared/clyde.ts";

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
): Promise<string> {
  const ws = workspaces.find((w) => !w.background && !w.internal && !w.archivingAt && !(w as { archivedAt?: string | null }).archivedAt);
  const chatCwd = ws?.workspaceDirectory || selected.projectRootPath;
  const provider = await pickProvider(paseo, chatCwd, worker);
  if (!provider) throw new Error(LAUNCH_CHAT_ERROR);
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  const title = (firstLine || selected.projectDisplayName).slice(0, 72);
  const idempotencyKey = "clyde-launch-" + requestId;
  try {
    const handle = ws && paseo.workspaces?.ref
      ? await paseo.workspaces.ref(ws.id).agents.create({ idempotencyKey, title, config: { provider } })
      : await paseo.agents?.create?.({ cwd: chatCwd, idempotencyKey, title, config: { provider } });
    if (!handle?.id) throw new Error(LAUNCH_CHAT_ERROR);
    return handle.id;
  } catch (err) {
    if (err instanceof Error && err.message === LAUNCH_CHAT_ERROR) throw err;
    throw new Error(LAUNCH_CHAT_ERROR);
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

export default function contribute(server: PluginServerContext) {
  const live = follow(ensureCompanion);
  const residentControl = residents(server);
  server.handle(projectsRpc, async ({workspaceId}, {paseo}) => {
    const [{ projects }, { entries: workspaces }, agents] = await Promise.all([
      paseo.projects.list(),
      paseo.workspaces.list(),
      listAllAgents(paseo),
    ]);
    const workspace = workspaceId ? workspaces.find((w) => w.id === workspaceId) : undefined;
    const projectByWorkspace = new Map(workspaces.map((w) => [w.id, w.projectId]));
    const chatsByProject = new Map<string, ProjectChat[]>();
    for (const a of agents) {
      if (!isProjectChat(a) || !a.workspaceId) continue;
      if (workspaceId && a.workspaceId !== workspaceId) continue;
      const pid = projectByWorkspace.get(a.workspaceId);
      if (!pid) continue;
      const fallback = a.provider.charAt(0).toUpperCase() + a.provider.slice(1) + " chat · " + a.id.slice(0, 6);
      const list = chatsByProject.get(pid) ?? [];
      list.push({
        id: a.id,
        title: (a.title ?? "").trim() || fallback,
        provider: a.provider,
        updatedAt: a.updatedAt ?? a.createdAt ?? "",
      });
      chatsByProject.set(pid, list);
    }
    return projects
      .filter((p) => (!workspaceId || p.projectId === workspace?.projectId) && p.projectKind !== "non_git")
      .map((p) => ({
        id: p.projectId,
        name: p.projectDisplayName,
        path: p.projectRootPath,
        chats: (chatsByProject.get(p.projectId) ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      }));
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
      return { data: home(workspaceId ? threads.filter(t=>t.cwd===root || t.cwd===workspace?.workspaceDirectory) : threads,
        workspaceId ? runs.filter(r=>r.repo===root || r.repo===workspace?.workspaceDirectory) : runs, agents(), live.revision()) };
    } catch (err) { return failed(err); }
  });
  server.handle(taskRpc, async ({ kind, id }) => {
    try {
      const threads = await call<RawThread[]>("GET", "/threads");
      const safeId = encodeURIComponent(id);
      if (kind === "thread") return { data: threadTask(await call<RawThread>("GET", `/threads/${safeId}`), agents()) };
      const run = await call<RawRun>("GET", `/runs/${safeId}`);
      return { data: { ...task(run, threads, agents()), diff: diffOf(run) } };
    } catch (err) { return failed(err); }
  });
  server.handle(transcriptRpc, async ({ threadId }) => {
    try { return { data: transcript(await call<RawThread>("GET", `/threads/${encodeURIComponent(threadId)}`)) }; } catch (err) { return failed(err); }
  });
  server.handle(waitRpc, async ({ after }) => ({ revision: await live.wait(after) }));
  server.handle(answerRpc, async ({ kind, id, text, askKey, allowAntigravityFullAccess }) => {
    try {
      const safeId = encodeURIComponent(id);
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
  return () => { residentControl.close(); live.close(); };
}
