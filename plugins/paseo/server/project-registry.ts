/** Paseo's registered Git and directory projects, with exact source placement. */
import { execFile } from 'node:child_process';
import { realpathSync,statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { PluginHandlerContext,PluginServerContext } from '@getpaseo/plugin/server';
import { openProjectRpc,projectsRpc,type ProjectChat } from '../shared/clyde.ts';
import { isProjectChat,listAllAgents } from './residents.ts';
import {verifyDirectory,directorySlug} from './project-path.ts';

type Paseo=PluginHandlerContext['paseo'];
type Project=Awaited<ReturnType<Paseo['projects']['list']>>['projects'][number];
function canonical(value:string):string|undefined {try{return realpathSync(value);}catch{return;}}
function git(cwd:string,args:string[]):Promise<string> {
  return new Promise((resolve,reject)=>execFile('git',['-C',cwd,...args],{timeout:1000,maxBuffer:8192},(error,stdout)=>error?reject(error):resolve(stdout.trim())));
}
export async function verifyRepository(path:string):Promise<string> {
  if(!isAbsolute(path) || path.includes('\0'))throw new Error('Enter an absolute local Git repository path.');
  const root=canonical(path);
  if(!root || !statSync(root).isDirectory())throw new Error('The selected project directory is unavailable.');
  let result:string;
  try{result=await git(root,['rev-parse','--show-toplevel','--verify','HEAD']);}
  catch(error){throw new Error('Select an existing Git repository with an initial commit.',{cause:error});}
  const [reported,head]=result.split('\n');
  if(canonical(reported)!==root)throw new Error('Select the Git repository root, rather than a subfolder.');
  if(!/^[a-f0-9]{40,64}$/i.test(head??''))throw new Error('The selected Git repository needs an initial commit.');
  return root;
}
export async function projectEligibility(project:Pick<Project,'projectKind'|'projectRootPath'>):Promise<{eligible:boolean;ineligibleReason?:string}> {
  try{if(project.projectKind==='git')await verifyRepository(project.projectRootPath);else verifyDirectory(project.projectRootPath);return {eligible:true};}
  catch(error){return {eligible:false,ineligibleReason:(error as Error).message};}
}
export async function canonicalProjectSlug(root:string):Promise<string> {
  try{const remote=await git(root,['remote','get-url','origin']);const match=remote.match(/[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);if(match)return match[1].toLowerCase();}catch{}
  const name=root.replace(/\/$/,'').split('/').at(-1)?.toLowerCase().replace(/[^a-z0-9_-]/g,'-').replace(/^-+|-+$/g,'');
  return name || 'local';
}

export function projectRegistry(server:PluginServerContext):void {
  const requestPaths=new Map<string,string>();
  const opening=new Map<string,Promise<{projectId:string;workspaceId?:string;path:string}>>();
  server.handle(projectsRpc,async({workspaceId},{paseo})=>{
    const [{projects},{entries:workspaces},agents]=await Promise.all([paseo.projects.list(),paseo.workspaces.list(),listAllAgents(paseo).catch(()=>[])]);
    const workspace=workspaceId?workspaces.find(w=>w.id===workspaceId):undefined;
    const projectByWorkspace=new Map(workspaces.map(w=>[w.id,w.projectId]));
    const chatsByProject=new Map<string,ProjectChat[]>();
    for(const agent of agents){
      if(!isProjectChat(agent) || !agent.workspaceId || (workspaceId && agent.workspaceId!==workspaceId))continue;
      const projectId=projectByWorkspace.get(agent.workspaceId);if(!projectId)continue;
      const list=chatsByProject.get(projectId)??[];
      list.push({id:agent.id,title:agent.title?.trim() || agent.provider+' chat · '+agent.id.slice(0,6),provider:agent.provider,updatedAt:agent.updatedAt ?? agent.createdAt ?? ''});
      chatsByProject.set(projectId,list);
    }
    return Promise.all(projects.filter(p=>!workspaceId || p.projectId===workspace?.projectId).map(async p=>{
      const [eligibility,slug]=await Promise.all([projectEligibility(p),p.projectKind==='git'?canonicalProjectSlug(p.projectRootPath):directorySlug(p.projectRootPath)]);
      return {id:p.projectId,name:p.projectDisplayName,label:p.projectDisplayName+' · '+(p.projectKind==='git'?slug:'folder'),slug,path:p.projectRootPath,kind:p.projectKind,...eligibility,
        workspaces:workspaces.filter(w=>w.projectId===p.projectId && (!workspaceId || w.id===workspaceId) && !w.background && !w.internal && !w.archivingAt && !(w as {archivedAt?:string|null}).archivedAt)
          .map(w=>({id:w.id,name:w.title || w.name || w.id,path:w.workspaceDirectory})),
        chats:(chatsByProject.get(p.projectId)??[]).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))};
    }));
  });
  server.handle(openProjectRpc,async({path,requestId},{paseo})=>{
    const root=verifyDirectory(path.trim());
    if(requestPaths.has(requestId) && requestPaths.get(requestId)!==root)throw new Error('This request already belongs to another project path.');
    requestPaths.set(requestId,root);
    const pending=opening.get(root);if(pending)return pending;
    const operation=(async()=>{
      const before=await paseo.projects.list();
      const existing=before.projects.find(p=>canonical(p.projectRootPath)===root);
      if(existing)return {projectId:existing.projectId,path:root};
      // The public SDK performs Paseo's native open-project workflow; never borrow an ancestor or a name match.
      const workspace=await paseo.workspaces.open({cwd:root,requestId});
      const after=await paseo.projects.list();
      const registered=after.projects.find(p=>canonical(p.projectRootPath)===root);
      if(!registered || workspace.projectId!==registered.projectId || canonical(workspace.directory??'')!==root)throw new Error('Paseo did not register the selected directory as its own project. Open that exact directory in Paseo and retry.');
      return {projectId:registered.projectId,workspaceId:workspace.id,path:root};
    })();
    opening.set(root,operation);
    try{return await operation;}finally{if(opening.get(root)===operation)opening.delete(root);}
  });
}
