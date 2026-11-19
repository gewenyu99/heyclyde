import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { currentActivity, workspaceActivity } from '../server/current-activity.ts';
import { home, task } from '../server/shape.ts';

const old='2026-11-19T10:00:00Z', recent='2026-11-19T11:59:00Z';
function records(id='1',cwd='/repo') {
  const thread={id:'thread-'+id,runId:'run-'+id,paseoAgentId:'worker-'+id,cwd,status:'running',rung:{backend:'claude'},createdAt:old,updatedAt:old,turns:[],progress:'Permission requested in Paseo worker worker-'+id};
  const run={id:'run-'+id,title:'Implement real work',flow:'task',cwd,status:'running',createdAt:old,updatedAt:old,stages:[{name:'task',status:'running',startedAt:old,attempts:[{n:1,threadId:thread.id,rung:thread.rung,startedAt:old}]}]};
  return {thread,run};
}

test('historical launcher permission text never establishes a current permission',()=>{
  const {thread,run}=records();
  thread.progress='Permission requested in Paseo worker 11111111-1111-4111-8111-111111111111';
  thread.paseoAgentId='11111111-1111-4111-8111-111111111111';
  let view=task(run,[thread],{});
  assert.equal(view.runActivity.permissionAgentId,undefined);
  assert.doesNotMatch(view.runActivity.headline,/permission/i);
  thread.nativeActivity={permissionPending:true,observedAt:recent};
  view=task(run,[thread],{});
  assert.equal(view.runActivity.permissionAgentId,thread.paseoAgentId);
  thread.nativeActivity.permissionPending=false;
  assert.doesNotMatch(task(run,[thread],{}).runActivity.headline,/permission/i);
});

test('current recorded work and evidence update task and Board without claiming the run finished',()=>{
  const {thread,run}=records();
  thread.nativeActivity={permissionPending:false,observedAt:recent};
  thread.workList={items:[{id:1,text:'Reproduce the bug',status:'done',evidence:'Reproduced it with the router fixture.',updatedAt:recent},{id:2,text:'Fix the router',status:'doing',how:'Checking route restoration',updatedAt:'2026-11-19T11:58:00Z'}]};
  const view=task(run,[thread],{});
  assert.match(view.runActivity.headline,/Fix the router/);
  assert.equal(view.runActivity.latestResult,'Reproduced it with the router fixture.');
  assert.equal(view.status,'running');
  const board=home([thread],[run],{},1,new Date('2026-11-19T12:00:00Z'));
  assert.match(board.tasks[0].current,/Fix the router/);
  assert.equal(board.tasks[0].lastActivity,recent);
  assert.equal(view.lastActivity,recent);
});

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'clyde-current-activity-')), previous=process.env.CLYDE_HOME;
  process.env.CLYDE_HOME=dir;mkdirSync(join(dir,'lists'));
  t.after(()=>{if(previous===undefined)delete process.env.CLYDE_HOME;else process.env.CLYDE_HOME=previous;rmSync(dir,{recursive:true,force:true});});
  return dir;
}
function native(thread, pendingPermissions=[]) { return {id:thread.paseoAgentId,provider:thread.rung.backend,cwd:thread.cwd,status:'running',updatedAt:recent,labels:{'clyde.run':thread.runId,'clyde.thread':thread.id},pendingPermissions}; }

test('Board enriches active workers with one sparse native scan and local work lists',async t=>{
  const dir=fixture(t), a=records('1',dir),b=records('2',dir);
  writeFileSync(join(dir,'lists','thread:'+a.thread.id+'.json'),JSON.stringify({items:[{id:1,text:'Implement fix',status:'doing',updatedAt:recent}]}));
  let scans=0;
  const paseo={agents:{list:async()=>{scans++;return {entries:[{agent:native(a.thread)},{agent:native(b.thread,[{id:'permission'}])}],pageInfo:{hasMore:false}};},ref:()=>{throw Error('No per-card refresh');}}};
  const enriched=await currentActivity(paseo,[a.thread,b.thread],[a.run,b.run]);
  assert.equal(scans,1);
  assert.equal(enriched[0].nativeActivity.permissionPending,false);
  assert.equal(enriched[1].nativeActivity.permissionPending,true);
  assert.equal(enriched[0].workList.items[0].text,'Implement fix');
  assert.equal(a.thread.nativeActivity,undefined,'input state was not mutated');
});

test('selected task refreshes only its verified worker and tolerates old or unavailable native state',async t=>{
  const dir=fixture(t),{thread,run}=records('1',dir);
  let refreshes=0;
  const agent=native(thread);
  const paseo={agents:{ref:()=>({refresh:async()=>{refreshes++;},current:()=>agent}),list:async()=>{throw Error('No full scan for selected task');}}};
  let enriched=await currentActivity(paseo,[thread],[run],run.id);
  assert.equal(refreshes,1);
  assert.equal(enriched[0].nativeActivity.permissionPending,false);
  agent.labels['clyde.thread']='different-thread';
  enriched=await currentActivity(paseo,[thread],[run],run.id);
  assert.equal(enriched[0].nativeActivity,undefined);
  assert.doesNotMatch(task(run,enriched,{}).runActivity.headline,/permission/i);
});

test('workspace home includes isolated managed workers belonging to its runs',()=>{
  const a=records('1','/repo/.worktrees/task-1'), b=records('2','/another/.worktrees/task-2');
  a.run.repo='/repo'; b.run.repo='/another';
  const standalone={...a.thread,id:'standalone',runId:undefined,cwd:'/repo'};
  const scoped=workspaceActivity([a.thread,b.thread,standalone],[a.run,b.run],['/repo']);
  assert.deepEqual(scoped.runs.map(run=>run.id),[a.run.id]);
  assert.deepEqual(scoped.threads.map(thread=>thread.id),[a.thread.id,standalone.id]);
  assert.deepEqual(workspaceActivity([a.thread],[a.run],[undefined]),{runs:[],threads:[]});
});

test('polling time does not manufacture activity and missing native state never revives launcher permissions',async t=>{
  const dir=fixture(t),{thread,run}=records('1',dir);
  thread.nativeActivity={permissionPending:true,observedAt:recent};
  const paseo={agents:{ref:()=>({refresh:async()=>{throw Error('Native connection unavailable');},current:()=>null})}};
  const enriched=await currentActivity(paseo,[thread],[run],run.id);
  assert.equal(enriched[0].nativeActivity,undefined);
  let view=task(run,enriched,{});
  assert.equal(view.runActivity.permissionAgentId,undefined);
  assert.equal(view.lastActivity,old);
  enriched[0].nativeActivity={permissionPending:false,observedAt:new Date().toISOString(),lastActivityAt:old};
  view=task(run,enriched,{});
  assert.equal(view.lastActivity,old);
});
