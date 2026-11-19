import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync,mkdtempSync,realpathSync,rmSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { projectRegistry } from '../server/project-registry.ts';

function fixture(t){
  const base=realpathSync(mkdtempSync(join(tmpdir(),'clyde-project-registry-')));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const repo=name=>{
    const path=join(base,name);mkdirSync(path);
    execFileSync('git',['init','-q',path]);
    execFileSync('git',['-C',path,'-c','user.name=test','-c','user.email=test@example.test','-c','commit.gpgsign=false','commit','--allow-empty','-qm','initial']);
    execFileSync('git',['-C',path,'remote','add','origin','https://github.com/owner/'+name+'.git']);
    return path;
  };
  const likeVincent=repo('like-vincent'),heyclyde=repo('heyclyde');
  const projects=[{projectId:'parent',projectDisplayName:'work-code',projectRootPath:base,projectKind:'non_git'},{projectId:'clyde-label',projectDisplayName:'Clyde',projectRootPath:likeVincent,projectKind:'git'}];
  const workspaces=[],opened=[],handlers=new Map();
  const settings={misroute:false};
  const paseo={projects:{list:async()=>({projects})},agents:{list:async()=>({entries:[],pageInfo:{hasMore:false}})},workspaces:{list:async()=>({entries:workspaces}),open:async({cwd,requestId})=>{
    opened.push({cwd,requestId});
    if(settings.misroute)return {id:'wrong-workspace',projectId:'parent',directory:base};
    const project={projectId:'new-repo',projectDisplayName:'heyclyde',projectRootPath:cwd,projectKind:'git'};
    projects.push(project);
    const workspace={id:'new-workspace',projectId:project.projectId,workspaceDirectory:cwd};workspaces.push(workspace);
    return {id:workspace.id,projectId:project.projectId,directory:cwd};
  }}};
  projectRegistry({handle:(rpc,handler)=>handlers.set(rpc.name,handler)});
  return {base,repo,heyclyde,likeVincent,projects,workspaces,paseo,opened,settings,
    list:args=>handlers.get('clyde.projects')(args??{},{paseo}),open:(path,requestId=randomUUID())=>handlers.get('clyde.open-project')({path,requestId},{paseo})};
}

test('all registered projects stay visible including folder registries, with exact truthful Git eligibility',async t=>{
  const f=fixture(t);
  f.projects.push({projectId:'missing',projectDisplayName:'Unavailable',projectRootPath:join(f.base,'not-there'),projectKind:'git'},{projectId:'directory',projectDisplayName:'Directory registry',projectRootPath:f.base,projectKind:'directory'});
  const rows=await f.list();
  assert.equal(rows.length,4);assert.equal(rows.find(p=>p.id==='directory').eligible,false);
  const folder=rows.find(p=>p.id==='parent');assert.equal(folder.kind,'non_git');assert.equal(folder.eligible,false);assert.match(folder.ineligibleReason,/Registered folder/);
  const clyde=rows.find(p=>p.id==='clyde-label');assert.equal(clyde.name,'Clyde');assert.equal(clyde.slug,'owner/like-vincent');assert.equal(clyde.path,f.likeVincent);assert.equal(clyde.eligible,true);assert.match(clyde.label,/like-vincent/);
  assert.equal(rows.find(p=>p.id==='missing').eligible,false);
  assert.equal(f.opened.length,0);
});

test('explicit repository selection uses native open once, never an ancestor/name match, and retry reuses registration',async t=>{
  const f=fixture(t),id=randomUUID();
  const [first,concurrent]=await Promise.all([f.open(f.heyclyde,id),f.open(f.heyclyde,id)]);
  assert.equal(first.projectId,concurrent.projectId);assert.equal(first.path,concurrent.path);assert.equal(first.projectId,'new-repo');assert.equal(first.path,f.heyclyde);
  assert.equal(f.opened.length,1);assert.equal(f.opened[0].cwd,f.heyclyde);
  assert.deepEqual(await f.open(f.heyclyde,id),{projectId:'new-repo',path:f.heyclyde});
  assert.equal(f.opened.length,1);
  const row=(await f.list()).find(p=>p.id==='new-repo');assert.equal(row.eligible,true);assert.equal(row.slug,'owner/heyclyde');
});

test('already registered exact root or symlink returns its project without opening a workspace',async t=>{
  const f=fixture(t),alias=join(f.base,'alias');symlinkSync(f.likeVincent,alias);
  assert.deepEqual(await f.open(alias),{projectId:'clyde-label',path:f.likeVincent});
  assert.equal(f.opened.length,0);assert.equal(f.workspaces.length,0);
});

test('explicit local Git selection rejects subdirectories, folder parents, missing paths, uncommitted repositories and misrouted SDK result',async t=>{
  const f=fixture(t),sub=join(f.heyclyde,'subdir');mkdirSync(sub);
  await assert.rejects(f.open(sub),/repository root/);
  await assert.rejects(f.open(f.base),/existing Git repository/);
  await assert.rejects(f.open(join(f.base,'missing')),/unavailable/);
  const empty=join(f.base,'empty');mkdirSync(empty);execFileSync('git',['init','-q',empty]);
  await assert.rejects(f.open(empty),/initial commit/);
  await assert.rejects(f.open('relative/path'),/absolute/);
  assert.equal(f.opened.length,0);
  f.settings.misroute=true;await assert.rejects(f.open(f.heyclyde),/own project/);
});

test('workspace scoping is exact and an unavailable agent list does not hide registered projects',async t=>{
  const f=fixture(t);
  f.workspaces.push({id:'existing',projectId:'clyde-label',workspaceDirectory:f.likeVincent});
  f.paseo.agents.list=async()=>{throw Error('chat history unavailable');};
  assert.deepEqual((await f.list({workspaceId:'existing'})).map(p=>p.id),['clyde-label']);
  assert.deepEqual(await f.list({workspaceId:'unknown'}),[]);
  assert.equal((await f.list()).length,2);
});
