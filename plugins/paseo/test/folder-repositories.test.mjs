import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync,mkdtempSync,realpathSync,renameSync,rmSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename,join } from 'node:path';
import test from 'node:test';
import { projectRegistry } from '../server/project-registry.ts';
import { registerFolderRepos } from '../server/folder-repositories.ts';

function fixture(t){
  const base=realpathSync(mkdtempSync(join(tmpdir(),'clyde-folder-repos-'))),root=join(base,'selected');mkdirSync(root);
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const repo=(path)=>{
    mkdirSync(path,{recursive:true});execFileSync('git',['init','-q',path]);
    execFileSync('git',['-C',path,'-c','user.name=test','-c','user.email=test@example.test','-c','commit.gpgsign=false','commit','--allow-empty','-qm','initial']);
    execFileSync('git',['-C',path,'remote','add','origin','https://github.com/owner/'+basename(path)+'.git']);return path;
  };
  const projects=[{projectId:'folder',projectDisplayName:'Selected folder',projectKind:'non_git',projectRootPath:root}],handlers=new Map();
  const paseo={projects:{list:async()=>({projects})},workspaces:{open:async()=>{throw Error('Discovery must never open/register a project');}}};
  projectRegistry({handle:(rpc,fn)=>handlers.set(rpc.name,fn)});
  return {base,root,repo,projects,paseo,handlers,read:(projectId='folder')=>handlers.get('clyde.folder-repos')({projectId},{paseo})};
}

test('selected folder discovery finds unregistered immediate checkouts and registered nested roots without recursive scanning',async t=>{
  const f=fixture(t),main=f.repo(join(f.root,'heyclyde')),other=f.repo(join(f.root,'like-vincent'));
  const registered=f.repo(join(f.root,'workbench','registered')),unregistered=f.repo(join(f.root,'workbench','not-registered'));
  f.projects.push({projectId:'known',projectDisplayName:'Registered worktree',projectKind:'git',projectRootPath:registered});
  const rows=await f.read();
  assert.deepEqual(new Set(rows.map(r=>r.path)),new Set([main,other,registered]));
  assert.ok(!rows.some(r=>r.path===unregistered));
  assert.equal(rows.find(r=>r.path===main).slug,'owner/heyclyde');
  assert.equal(rows.find(r=>r.path===main).projectId,undefined);
  assert.equal(rows.find(r=>r.path===registered).projectId,'known');
});

test('symlink escapes and outside registered repositories are excluded; inside aliases are canonicalized and deduplicated',async t=>{
  const f=fixture(t),inside=f.repo(join(f.root,'inside')),outside=f.repo(join(f.base,'outside'));
  symlinkSync(outside,join(f.root,'escaped'));symlinkSync(inside,join(f.root,'alias'));
  f.projects.push({projectId:'outside',projectDisplayName:'Outside',projectKind:'git',projectRootPath:join(f.root,'escaped')});
  const rows=await f.read();assert.deepEqual(rows.map(r=>r.path),[inside]);
  assert.ok(!rows.some(r=>r.path===outside || r.projectId==='outside'));
});

test('only an explicitly selected available folder registry can be scanned, with no ancestor selection',async t=>{
  const f=fixture(t);f.repo(f.root);mkdirSync(join(f.root,'ordinary-directory'));
  f.projects.push({projectId:'git-project',projectDisplayName:'Git project',projectKind:'git',projectRootPath:f.root});
  await assert.rejects(f.read('unknown'),/Select an available registered folder/);
  await assert.rejects(f.read('git-project'),/Select an available registered folder/);
  assert.deepEqual(await f.read(),[],'a child of a Git root must not be mistaken for the root checkout');
});

test('discovery is bounded to four checkout checks and returns every valid candidate, with no first-repository selection',async t=>{
  const f=fixture(t);for(let n=0;n<11;n++)mkdirSync(join(f.root,'repo-'+n));
  let active=0,maximum=0,calls=0;
  registerFolderRepos({handle:(rpc,fn)=>f.handlers.set(rpc.name,fn)},{verifyRepository:async path=>{active++;maximum=Math.max(maximum,active);calls++;await new Promise(resolve=>setTimeout(resolve,2));active--;return path;},canonicalProjectSlug:async path=>'owner/'+basename(path)});
  const [first,same]=await Promise.all([f.read(),f.read()]);
  assert.equal(maximum,4);assert.equal(first.length,11);assert.equal(same.length,11);assert.equal(calls,11);
});

test('a checkout replaced by an escaping symlink is rejected before reading its slug',async t=>{
  const f=fixture(t),inside=join(f.root,'inside'),outside=join(f.base,'outside');mkdirSync(inside);mkdirSync(outside);
  let slugReads=0;
  registerFolderRepos({handle:(rpc,fn)=>f.handlers.set(rpc.name,fn)},{verifyRepository:async path=>{renameSync(path,path+'-old');symlinkSync(outside,path);return path;},canonicalProjectSlug:async()=>{slugReads++;return 'owner/escape';}});
  assert.deepEqual(await f.read(),[]);assert.equal(slugReads,0);
});

test('a timed-out checkout check reports an explicit failure instead of silently returning a partial list',async t=>{
  const f=fixture(t);mkdirSync(join(f.root,'good'));mkdirSync(join(f.root,'slow'));
  registerFolderRepos({handle:(rpc,fn)=>f.handlers.set(rpc.name,fn)},{verifyRepository:async path=>{if(path.endsWith('/slow'))throw new Error('git timed out',{cause:{killed:true}});return path;},canonicalProjectSlug:async path=>'owner/'+basename(path)});
  await assert.rejects(f.read(),/No partial results/);
});
