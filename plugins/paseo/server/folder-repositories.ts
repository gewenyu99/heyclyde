/** On-demand discovery inside one explicitly selected registered folder; never a recursive disk scan. */
import { readdir,realpath,stat } from 'node:fs/promises';
import { basename,isAbsolute,join,relative } from 'node:path';
import type { PluginHandlerContext,PluginServerContext } from '@getpaseo/plugin/server';
import { folderReposRpc } from '../shared/clyde.ts';

type Paseo=PluginHandlerContext['paseo'];
type Repo={path:string;name:string;slug:string;projectId?:string};
type Checks={verifyRepository:(path:string)=>Promise<string>;canonicalProjectSlug:(path:string)=>Promise<string>};
const MAX_DIRECTORIES=5000,DEADLINE_MS=20_000;
function contained(root:string,path:string):boolean {
  const tail=relative(root,path);
  return !!tail && !tail.startsWith('..'+(process.platform==='win32'?'\\':'/')) && tail!=='..' && !isAbsolute(tail);
}

export function registerFolderRepos(server:PluginServerContext,checks:Checks):void {
  const pending=new Map<string,Promise<Repo[]>>();
  server.handle(folderReposRpc,async({projectId},{paseo})=>{
    const existing=pending.get(projectId);if(existing)return existing;
    if(pending.size>=2)throw new Error('Folder discovery is busy. Try this folder again shortly.');
    let cancelled=false,timer:ReturnType<typeof setTimeout>;
    const guard=()=>{if(cancelled)throw new Error('Folder discovery stopped. Retry the selected folder.');};
    const discover=async():Promise<Repo[]>=>{
      const {projects}=await paseo.projects.list();guard();
      const folder=projects.find(p=>p.projectId===projectId);
      if(!folder || !['non_git','directory'].includes(folder.projectKind))throw new Error('Select an available registered folder project.');
      const root=await realpath(folder.projectRootPath);guard();
      if(!(await stat(root)).isDirectory())throw new Error('The selected folder is unavailable.');
      const entries=await readdir(root,{withFileTypes:true});guard();
      const directories=entries.filter(e=>e.isDirectory() || e.isSymbolicLink());
      if(directories.length>MAX_DIRECTORIES)throw new Error('This folder has too many immediate directories to check safely. Select a narrower folder; no partial results were returned.');
      const candidates=new Map<string,{projectId?:string;name:string}>();
      const add=async(path:string,projectId?:string,name?:string)=>{
        guard();let canonical:string;
        try{canonical=await realpath(path);}catch{return;}
        guard();if(!contained(root,canonical))return;
        try{if(!(await stat(canonical)).isDirectory())return;}catch{return;}
        const old=candidates.get(canonical);
        if(!old || projectId)candidates.set(canonical,{name:name || basename(canonical),...(projectId?{projectId}:old?.projectId?{projectId:old.projectId}:{})});
      };
      let next=0;
      await Promise.all(Array.from({length:Math.min(4,directories.length)},async()=>{
        while(next<directories.length){const entry=directories[next++];await add(join(root,entry.name));}
      }));
      // Already registered nested roots are known exact paths, not extra recursive exploration.
      const registered=projects.filter(p=>p.projectKind==='git');next=0;
      await Promise.all(Array.from({length:Math.min(4,registered.length)},async()=>{
        while(next<registered.length){const p=registered[next++];await add(p.projectRootPath,p.projectId,p.projectDisplayName);}
      }));
      if(candidates.size>MAX_DIRECTORIES)throw new Error('This folder has too many checkout candidates to check safely. No partial results were returned.');
      const paths=[...candidates.entries()],results:Repo[]=[];next=0;
      await Promise.all(Array.from({length:Math.min(4,paths.length)},async()=>{
        while(next<paths.length){
          guard();const [candidate,metadata]=paths[next++];let verified:string;
          try{verified=await checks.verifyRepository(candidate);}catch(error){
            const cause=(error as {cause?:{killed?:boolean;code?:string}})?.cause;
            if(cause?.killed || ['ETIMEDOUT','EACCES','ENOENT'].includes(cause?.code??''))throw new Error('A checkout check could not finish. No partial results were returned; retry the selected folder.');
            continue;
          }
          guard();if(verified!==candidate || !contained(root,verified))continue;
          let beforeSlug:string;try{beforeSlug=await realpath(verified);}catch{continue;}
          if(beforeSlug!==verified || !contained(root,beforeSlug))continue;
          const slug=await checks.canonicalProjectSlug(verified);guard();
          // Recheck containment after Git reads, including symlinks changed during discovery.
          let current:string;try{current=await realpath(verified);}catch{continue;}
          if(current!==verified || !contained(root,current))continue;
          results.push({path:verified,name:metadata.name,slug,...(metadata.projectId?{projectId:metadata.projectId}:{})});
        }
      }));
      guard();const latest=(await paseo.projects.list()).projects.find(p=>p.projectId===projectId);guard();
      if(!latest || !['non_git','directory'].includes(latest.projectKind) || await realpath(latest.projectRootPath)!==root)throw new Error('The selected folder changed during discovery. Select it again.');
      return results.sort((a,b)=>a.name.localeCompare(b.name)||a.path.localeCompare(b.path));
    };
    const operation=Promise.race([discover(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{cancelled=true;reject(new Error('Folder discovery timed out. No partial results were returned. Try a narrower folder.'));},DEADLINE_MS);})]);
    pending.set(projectId,operation);
    try{return await operation;}finally{cancelled=true;clearTimeout(timer!);if(pending.get(projectId)===operation)pending.delete(projectId);}
  });
}
