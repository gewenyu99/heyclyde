import { residents } from "./server/residents";
import { execFileSync } from "node:child_process";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { call, ensureCompanion, follow, readJson } from "./server/daemon";
import { home, task, threadTask, transcript, type RawRun, type RawThread } from "./server/shape";
import { projectsRpc, launchRpc, steerRpc, answerRpc, homeRpc, stopRpc, taskRpc, transcriptRpc, waitRpc, type Diff } from "./shared/clyde";

const agents = () => readJson<Record<string, string>>("paseo-threads.json") ?? {};
const failed = (err: unknown) => ({ error: (err as Error).message });

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
    const {projects} = await paseo.projects.list();
    const workspace=workspaceId ? (await paseo.workspaces.list()).entries.find(w=>w.id===workspaceId) : undefined;
    return projects.filter(p => (!workspaceId || p.projectId===workspace?.projectId) && p.projectKind !== "non_git").map(p => ({id:p.projectId,name:p.projectDisplayName,path:p.projectRootPath}));
  });
  server.handle(launchRpc, async ({project,prompt,flow,worker,requestId,agentId}, {paseo}) => {
    const selected=(await paseo.projects.list()).projects.find(p => p.projectId === project && p.projectKind !== "non_git");
    if (!selected) throw new Error("Select an available Git project in Paseo.");
    const workspaces=(await paseo.workspaces.list()).entries.filter(w=>w.projectId===project);
    const workspaceIds=new Set(workspaces.map(w=>w.id));
    const agents=(await paseo.agents.list()).entries.map(e=>e.agent).filter(a=>a.workspaceId && workspaceIds.has(a.workspaceId) && !a.archivedAt && !a.background && !a.labels?.["paseo.parent-agent-id"]);
    if(agentId && !agents.some(a=>a.id===agentId)) throw new Error("Choose a chat in the selected project.");
    const origin=agentId ?? (agents.length===1?agents[0].id:undefined);
    const routing=worker === "auto" ? {} : {overrides:{worker}};
    if(!origin)throw new Error("Choose a chat for this task. Open /clyde in that chat to start it with project memory.");
    const existing=await call<{id:string,repo:string}>("GET","/runs/r-"+requestId).catch(e=>{if(!String(e).includes("404"))throw e;return null;});
    if(existing){if(existing.repo!==selected.projectRootPath)throw new Error("Task belongs to another project.");residentControl.track(existing.id,origin,paseo);return {id:existing.id};}
    const notes=await residentControl.context(origin,prompt,paseo);
    const input=flow==="ship"?{intent:prompt,notes,routing}:{prompt:prompt+notes,criteria:[prompt],routing};
    const run=await call<{id:string}>("POST","/runs",{flow,input,cwd:selected.projectRootPath,assignment:requestId});
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
      if (kind === "thread") return { data: threadTask(await call<RawThread>("GET", `/threads/${id}`), agents()) };
      const run = await call<RawRun>("GET", `/runs/${id}`);
      return { data: { ...task(run, threads, agents()), diff: diffOf(run) } };
    } catch (err) { return failed(err); }
  });
  server.handle(transcriptRpc, async ({ threadId }) => {
    try { return { data: transcript(await call<RawThread>("GET", `/threads/${threadId}`)) }; } catch (err) { return failed(err); }
  });
  server.handle(waitRpc, async ({ after }) => ({ revision: await live.wait(after) }));
  server.handle(answerRpc, async ({ kind, id, text }) => {
    try {
      await call("POST", kind === "run" ? `/runs/${id}/answer` : `/threads/${id}/messages`, { text, via: "paseo" });
      return { ok: true };
    } catch (err) { return { ok: false, error: (err as Error).message }; }
  });
  server.handle(steerRpc, async ({id,text}) => { await call("POST","/runs/"+encodeURIComponent(id)+"/steer",{text}); return {ok:true}; });
  server.handle(stopRpc, async ({ kind, id }) => {
    try {
      await call("POST", kind === "run" ? `/runs/${id}/stop` : `/threads/${id}/stop`, {});
      return { ok: true };
    } catch (err) { return { ok: false, error: (err as Error).message }; }
  });
  return () => { residentControl.close(); live.close(); };
}
