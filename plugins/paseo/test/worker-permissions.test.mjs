import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { workerPermissions } from '../server/worker-permissions.ts';

function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'clyde-permission-test-')),previous=process.env.CLYDE_HOME;
  process.env.CLYDE_HOME=home;
  writeFileSync(join(home,'daemon.json'),JSON.stringify({port:11111,token:'fake'}));
  t.after(()=>{if(previous===undefined)delete process.env.CLYDE_HOME;else process.env.CLYDE_HOME=previous;rmSync(home,{recursive:true,force:true});});
  const request={id:'permission-1',provider:'claude',name:'Bash',kind:'tool',title:'Run test command',description:'Needs terminal access',input:{command:'npm test'}};
  const attempt={n:1,threadId:'thread-1',rung:{backend:'claude'},startedAt:'now'};
  const run={id:'run-1',status:'running',cwd:home,stages:[{name:'code',status:'running',attempts:[attempt]}]};
  const thread={id:'thread-1',runId:run.id,status:'running',cwd:home,rung:{backend:'claude'},paseoAgentId:'worker-1'};
  const agent={id:'worker-1',provider:'claude',cwd:home,labels:{'clyde.run':run.id,'clyde.thread':thread.id},pendingPermissions:[request]};
  const calls=[],snapshots={refresh:async()=>{},respond:async()=>{}},handlers=new Map();
  let runReads=0;
  const hooks={afterRun:()=>{}};
  t.mock.method(globalThis,'fetch',async(url)=>{
    const path=new URL(url).pathname;
    if(path==='/threads')return Response.json([thread]);
    if(path==='/runs/'+run.id){runReads++;hooks.afterRun(runReads);return Response.json(run);}
    return Response.json({error:'not found'},{status:404});
  });
  const paseo={agents:{ref:id=>({refresh:async()=>{calls.push({method:'refresh',id});await snapshots.refresh();},current:()=>structuredClone(agent),respondToPermission:async input=>{calls.push({method:'respond',id,input});await snapshots.respond();agent.pendingPermissions=agent.pendingPermissions.filter(p=>p.id!==input.requestId);}})}};
  workerPermissions({handle:(rpc,handler)=>handlers.set(rpc.name,handler)});
  const read=()=>handlers.get('clyde.worker-permissions')({runId:run.id},{paseo});
  const respond=(item,optionId='allow-once',overrides={})=>handlers.get('clyde.respond-worker-permission')({runId:run.id,agentId:agent.id,requestId:item.id,revision:item.revision,optionId,...overrides},{paseo});
  return {home,request,attempt,run,thread,agent,calls,snapshots,hooks,read,respond};
}

test('ordinary live tool requests show exact evidence and Allow once / Deny without automatic response',async t=>{
  const f=fixture(t),state=await f.read();
  assert.equal(state.agentId,'worker-1');assert.equal(state.requests.length,1);
  const item=state.requests[0];
  assert.equal(item.title,'Run test command');assert.match(item.input,/npm test/);
  assert.deepEqual(item.options.map(o=>[o.id,o.label]),[['allow-once','Allow once'],['deny','Deny']]);
  assert.equal(f.calls.filter(c=>c.method==='respond').length,0);
  assert.deepEqual(await f.respond(item),{ok:true});
  assert.deepEqual(f.calls.find(c=>c.method==='respond').input,{requestId:'permission-1',response:{behavior:'allow'}});
  assert.deepEqual((await f.read()).requests,[]);
});

test('Deny only denies the exact pending tool request',async t=>{
  const f=fixture(t),state=await f.read();
  await f.respond(state.requests[0],'deny');
  assert.deepEqual(f.calls.find(c=>c.method==='respond').input,{requestId:'permission-1',response:{behavior:'deny',message:'Denied by user'}});
});

test('provider offered actions preserve their ids, labels, and exact selectedActionId mapping',async t=>{
  const f=fixture(t);
  f.request.kind='plan';f.request.actions=[{id:'review-first',label:'Review plan first',behavior:'deny',variant:'secondary'},{id:'implement-resume',label:'Implement and resume',behavior:'allow',variant:'primary',intent:'implement_resume'}];
  const item=(await f.read()).requests[0];
  assert.deepEqual(item.options.map(o=>o.id),['review-first','implement-resume']);
  await assert.rejects(f.respond(item,'allow-once'),/not offered/);
  await f.respond(item,'implement-resume');
  assert.deepEqual(f.calls.find(c=>c.method==='respond').input.response,{behavior:'allow',selectedActionId:'implement-resume'});
});

test('question forms and malformed offered actions use the native fallback and cannot be answered here',async t=>{
  const f=fixture(t);
  f.request.kind='question';f.request.actions=[{id:'yes',label:'Yes',behavior:'allow'}];
  let item=(await f.read()).requests[0];
  assert.equal(item.options.length,0);assert.match(item.unsupported,/Open the worker/);
  await assert.rejects(f.respond(item,'yes'),/not offered/);
  f.request.kind='tool';f.request.actions=[{id:'same',label:'A',behavior:'allow'},{id:'same',label:'B',behavior:'deny'}];
  item=(await f.read()).requests[0];assert.equal(item.options.length,0);
  await assert.rejects(f.respond(item,'same'),/not offered/);
  assert.equal(f.calls.filter(c=>c.method==='respond').length,0);
});

test('stale request contents, resolved requests, forged options, and foreign agent requests are refused',async t=>{
  const f=fixture(t),item=(await f.read()).requests[0];
  f.request.input.command='different-command';
  await assert.rejects(f.respond(item),/changed or has already been answered/);
  const fresh=(await f.read()).requests[0];
  await assert.rejects(f.respond(fresh,'always-allow'),/not offered/);
  await assert.rejects(f.respond(fresh,'allow-once',{agentId:'foreign-agent'}),/no longer the current worker/);
  await assert.rejects(f.respond(fresh,'allow-once',{requestId:'foreign-request'}),/changed or has already been answered/);
  f.agent.pendingPermissions=[];await assert.rejects(f.respond(fresh),/changed or has already been answered/);
  assert.equal(f.calls.filter(c=>c.method==='respond').length,0);
});

test('terminal runs, finished attempts, reviewers, wrong labels, paths, and providers cannot expose response controls',async t=>{
  const variants=[f=>f.run.status='done',f=>f.run.archivedAt='now',f=>f.attempt.endedAt='now',f=>f.attempt.result={status:'done'},f=>f.attempt.judgeId='judge-1',f=>f.thread.readOnly=true,f=>f.thread.runId='other-run',f=>f.agent.labels['clyde.run']='other-run',f=>f.agent.labels['clyde.thread']='other-thread',f=>f.agent.cwd='/foreign',f=>f.agent.provider='codex',f=>f.agent.archivedAt='now'];
  const f=fixture(t),baseline={run:structuredClone(f.run),thread:structuredClone(f.thread),agent:structuredClone(f.agent)};
  for(const mutate of variants){
    Object.keys(f.run).forEach(k=>delete f.run[k]);Object.assign(f.run,structuredClone(baseline.run));
    f.attempt=f.run.stages[0].attempts[0];
    Object.keys(f.thread).forEach(k=>delete f.thread[k]);Object.assign(f.thread,structuredClone(baseline.thread));
    Object.keys(f.agent).forEach(k=>delete f.agent[k]);Object.assign(f.agent,structuredClone(baseline.agent));
    mutate(f);assert.deepEqual((await f.read()).requests,[]);
  }
  assert.equal(f.calls.filter(c=>c.method==='respond').length,0);
});

test('run changes while native snapshot refreshes are fenced before responding',async t=>{
  const f=fixture(t),item=(await f.read()).requests[0];
  f.snapshots.refresh=async()=>{f.attempt.endedAt='finished during refresh';};
  await assert.rejects(f.respond(item),/changed workers/);
  assert.equal(f.calls.filter(c=>c.method==='respond').length,0);
});

test('concurrent duplicate responses are rejected while the first explicit response is pending',async t=>{
  const f=fixture(t),item=(await f.read()).requests[0],held=Promise.withResolvers();
  f.snapshots.respond=()=>held.promise;
  const first=f.respond(item);
  await assert.rejects(f.respond(item),/already being sent/);
  held.resolve();await first;
  assert.equal(f.calls.filter(c=>c.method==='respond').length,1);
});

test('oversized or missing Bash commands require full native review and cannot be approved from truncated evidence',async t=>{
  const f=fixture(t);
  f.request.input.command='echo '+ 'x'.repeat(9000)+'; dangerous-tail';
  let item=(await f.read()).requests[0];
  assert.match(item.input,/truncated/);assert.equal(item.options.length,0);assert.match(item.unsupported,/Open the worker/);
  await assert.rejects(f.respond(item),/not offered/);
  delete f.request.input;
  item=(await f.read()).requests[0];assert.equal(item.options.length,0);
  await assert.rejects(f.respond(item),/not offered/);
  f.request.input={};f.request.detail={type:'shell',command:'printf "complete command from detail"'};
  item=(await f.read()).requests[0];
  assert.match(item.input,/complete command from detail/);assert.equal(item.options.length,2);
  assert.equal(f.calls.filter(c=>c.method==='respond').length,0);
});

test('provider-mismatched requests fail closed and SDK response errors leave the pending request retryable',async t=>{
  const f=fixture(t),item=(await f.read()).requests[0];
  f.request.provider='codex';
  const mismatch=await f.read();assert.deepEqual(mismatch.requests,[]);assert.match(mismatch.error,/worker provider/);
  await assert.rejects(f.respond(item),/worker provider/);
  f.request.provider='claude';f.snapshots.respond=async()=>{throw new Error('Native request is temporarily unavailable');};
  await assert.rejects(f.respond(item),/temporarily unavailable/);
  assert.equal((await f.read()).requests.length,1);
  f.snapshots.respond=async()=>{};
  assert.deepEqual(await f.respond(item,'deny'),{ok:true});
});
