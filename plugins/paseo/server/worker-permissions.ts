/** Explicit user responses to live worker requests, scoped to the run's current attempt. */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PluginHandlerContext, PluginServerContext } from '@getpaseo/plugin/server';
import { respondWorkerPermissionRpc, workerPermissionsRpc, type WorkerPermissions } from '../shared/clyde.ts';
import { call } from './daemon.ts';
import type { RawRun, RawThread } from './shape.ts';

type Paseo = PluginHandlerContext['paseo'];
type Agent = NonNullable<ReturnType<ReturnType<Paseo['agents']['ref']>['current']>>;
type Request = Agent['pendingPermissions'][number];
type Response = Parameters<ReturnType<Paseo['agents']['ref']>['respondToPermission']>[0]['response'];
type Option = WorkerPermissions['requests'][number]['options'][number] & { response:Response };
function path(value:string):string {
  try{return realpathSync(value);}catch{return resolve(value);}
}
function samePath(a?:string|null,b?:string|null):boolean {
  return !!a && !!b && path(a)===path(b);
}

/** Ignore stale launcher progress; ownership comes from the current attempt and native snapshot. */
function currentWorker(run:RawRun,threads:RawThread[]):RawThread|undefined {
  if(run.status!=='running' || run.archivedAt || run.endedAt)return;
  const stage=run.stages.findLast(s=>s.status==='running' || s.status==='asking') ?? run.stages.at(-1);
  const attempt=stage?.attempts.at(-1);
  if(stage?.status!=='running' || stage.endedAt || !attempt || attempt.endedAt || attempt.result || attempt.verdict || attempt.judgeId || attempt.ok===false)return;
  const worker=threads.find(t=>t.id===attempt.threadId);
  if(!worker || worker.runId!==run.id || worker.status!=='running' || worker.archivedAt || worker.readOnly || !worker.paseoAgentId || !samePath(worker.cwd,run.cwd))return;
  return worker;
}
const revision=(request:Request)=>createHash('sha256').update(JSON.stringify(request)).digest('hex');
function inputText(request:Request):string|undefined {
  if(request.input===undefined && request.detail===undefined)return;
  return JSON.stringify({input:request.input,detail:request.detail},null,2);
}
function options(request:Request):Option[] {
  // Never approve input that the board could only show partially, particularly shell commands.
  if((inputText(request)?.length ?? 0)>8000)return [];
  const command=request.detail?.type==='shell' ? request.detail.command : request.input?.command;
  if(request.name.toLowerCase()==='bash' && (typeof command!=='string' || !command.trim()))return [];
  // Questions need form responses/updatedInput. Leave their richer native UI in charge.
  if(request.kind==='question')return [];
  if(request.actions!==undefined){
    if(!Array.isArray(request.actions) || !request.actions.length)return [];
    const seen=new Set<string>();
    for(const a of request.actions){
      if(!a || typeof a.id!=='string' || !a.id || seen.has(a.id) || typeof a.label!=='string' || !a.label.trim() || !['allow','deny'].includes(a.behavior) || (a.variant!==undefined && !['primary','secondary','danger'].includes(a.variant)))return [];
      seen.add(a.id);
    }
    return request.actions.map(a=>({id:a.id,label:a.label,behavior:a.behavior,...(a.variant?{variant:a.variant}:{}),response:{behavior:a.behavior,selectedActionId:a.id}}));
  }
  if(request.kind!=='tool')return [];
  return [
    {id:'allow-once',label:'Allow once',behavior:'allow',variant:'primary',response:{behavior:'allow'}},
    {id:'deny',label:'Deny',behavior:'deny',variant:'danger',response:{behavior:'deny',message:'Denied by user'}},
  ];
}
function display(request:Request):WorkerPermissions['requests'][number] {
  const choices=options(request),input=inputText(request);
  return {id:request.id,revision:revision(request),kind:request.kind,name:request.name,title:request.title || request.name,
    ...(request.description?{description:request.description}:{}),...(input?{input:input.length>8000?input.slice(0,7980)+'\n[truncated]':input}:{}),
    options:choices.map(({response,...choice})=>choice),...(!choices.length?{unsupported:'Open the worker in Paseo to answer this request.'}:{})};
}

export function workerPermissions(server:PluginServerContext):void {
  const responding=new Set<string>();
  async function readWorker(runId:string) {
    const [run,threads]=await Promise.all([call<RawRun>('GET','/runs/'+encodeURIComponent(runId)),call<RawThread[]>('GET','/threads')]);
    return {run,worker:currentWorker(run,threads)};
  }
  async function live(runId:string,paseo:Paseo) {
    const {run,worker}=await readWorker(runId);
    if(!worker)return null;
    const handle=paseo.agents.ref(worker.paseoAgentId!);
    await handle.refresh();
    const agent=handle.current();
    if(!agent || agent.id!==worker.paseoAgentId || agent.archivedAt || agent.provider!==worker.rung.backend || agent.labels?.['clyde.run']!==run.id || agent.labels?.['clyde.thread']!==worker.id || !samePath(agent.cwd,worker.cwd))throw new Error('The current Paseo worker could not be verified.');
    if((agent.pendingPermissions ?? []).some(r=>r.provider!==agent.provider))throw new Error('The pending request does not match the worker provider.');
    // A worker can finish while its native snapshot refreshes.
    const latest=await readWorker(runId);
    if(latest.worker?.id!==worker.id || latest.worker.paseoAgentId!==agent.id)throw new Error('The run changed workers. Refresh before answering.');
    return {agent,handle,worker};
  }
  server.handle(workerPermissionsRpc,async({runId},{paseo})=>{
    try{
      const value=await live(runId,paseo);
      if(!value)return {requests:[]};
      return {agentId:value.agent.id,requests:(value.agent.pendingPermissions ?? []).map(display)};
    }catch(error){return {requests:[],error:(error as Error).message};}
  });
  server.handle(respondWorkerPermissionRpc,async({runId,agentId,requestId,revision:expected,optionId},{paseo})=>{
    if(responding.has(runId))throw new Error('A worker response is already being sent.');
    responding.add(runId);
    try{
      const value=await live(runId,paseo);
      if(!value || value.agent.id!==agentId)throw new Error('This is no longer the current worker for this run.');
      const requests=(value.agent.pendingPermissions ?? []).filter(r=>r.id===requestId);
      if(requests.length!==1 || revision(requests[0])!==expected)throw new Error('This permission request changed or has already been answered. Refresh before answering.');
      const choice=options(requests[0]).find(o=>o.id===optionId);
      if(!choice)throw new Error('This response is not offered for the pending request. Open the worker in Paseo.');
      await value.handle.respondToPermission({requestId,response:choice.response});
      return {ok:true as const};
    }finally{responding.delete(runId);}
  });
}
