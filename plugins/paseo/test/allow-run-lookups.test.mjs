import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { allowRunLookups } from '../server/allow-run-lookups.ts';

const runId='r-a11ce001',threadId='t-worker-1',workerId='worker-1';
function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'clyde-run-lookups-')), previous=process.env.CLYDE_HOME;
  process.env.CLYDE_HOME=home;
  writeFileSync(join(home,'daemon.json'),JSON.stringify({port:11111,token:'fixture'}));
  t.after(()=>{if(previous===undefined)delete process.env.CLYDE_HOME;else process.env.CLYDE_HOME=previous;rmSync(home,{recursive:true,force:true});});
  const request={id:'permission-1',provider:'claude',kind:'tool',name:'mcp__paseo__clyde_recall',input:{query:'Project context'}};
  const attempt={n:1,threadId,rung:{backend:'claude'},startedAt:'now'};
  const stage={name:'plan',status:'running',attempts:[attempt]};
  const run={id:runId,cwd:home,status:'running',stages:[stage],paseoParentId:'orchestrator-1'};
  const thread={id:threadId,runId,status:'running',cwd:home,stage:stage.name,rung:{backend:'claude'},paseoAgentId:workerId};
  const agent={id:workerId,provider:'claude',cwd:home,labels:{'clyde.run':runId,'clyde.thread':threadId},pendingPermissions:[request]};
  const state={native:agent,refreshes:0,reads:[],responses:[],answered:0,refresh:async()=>{},respond:async()=>{},read:async path=>path==='/runs/'+runId?run:path==='/threads/'+threadId?thread:null};
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const path=new URL(url).pathname;
    state.reads.push({path,method:options.method});
    return Response.json(await state.read(path));
  });
  const hooks=new Map();
  allowRunLookups({addHook:(name,handler)=>hooks.set(name,handler)});
  assert.deepEqual([...hooks.keys()],['agent.permission.before']);
  const paseo={agents:{ref:id=>({
    refresh:async()=>{assert.equal(id,agent.id);await state.refresh(++state.refreshes);},
    current:()=>structuredClone(state.native),
    respondToPermission:async value=>{state.responses.push(value);await state.respond(value);state.answered++;agent.pendingPermissions=agent.pendingPermissions.filter(p=>p.id!==value.requestId);},
  })}};
  const invoke=()=>hooks.get('agent.permission.before')({agent:{id:agent.id},request:structuredClone(request)},{paseo});
  const orchestrator=()=>{agent.id='orchestrator-1';agent.labels={'clyde.orchestrator':runId};};
  return {home,request,attempt,stage,run,thread,agent,state,invoke,orchestrator};
}
const noGrant=f=>{assert.deepEqual(f.state.responses,[]);assert.equal(f.state.answered,0);};

test('only exact read-only lookup tools get a single-request allow for verified current workers or orchestrators',async t=>{
  for(const role of ['worker','orchestrator'])for(const name of ['mcp__paseo__clyde_recall','mcp__paseo__clyde_recall_more'])await t.test(role+' '+name,async t=>{
    const f=fixture(t);if(role==='orchestrator')f.orchestrator();f.request.name=name;
    await f.invoke();
    assert.deepEqual(f.state.responses,[{requestId:'permission-1',response:{behavior:'allow'}}]);
    assert.equal(f.state.answered,1);
    assert.deepEqual(f.agent.pendingPermissions,[]);
    assert.ok(f.state.reads.every(r=>r.method==='GET'),'policy never mutates run or thread records');
    assert.equal(f.state.refreshes,2,'native request is refreshed before granting');
  });
});

test('write tools, shell commands, namespace lookalikes and promoted permission actions remain for explicit review',async t=>{
  const requests=[
    {name:'mcp__paseo__clyde_remember'}, {name:'mcp__paseo__clyde_delegate'}, {name:'Bash'}, {name:'Write'},
    {name:'mcp__memory__recall'}, {name:'mcp__paseo__clyde_recall_extra'}, {name:'mcp__paseo__CLYDE_RECALL'},
    {kind:'plan'}, {kind:'question'},
    {actions:[{id:'allow-always',label:'Always allow',behavior:'allow'}]},
    {actions:[{id:'implement-resume',label:'Implement and resume',behavior:'allow',intent:'implement_resume'}]},
    {actions:{length:0}},
  ];
  for(const values of requests)await t.test(JSON.stringify(values),async t=>{
    const f=fixture(t);Object.assign(f.request,values);await f.invoke();noGrant(f);
    assert.equal(f.state.refreshes,0);assert.equal(f.state.reads.length,0);
  });
});

test('ordinary chats, forged ownership labels, foreign native agents and provider mismatches never auto-grant',async t=>{
  const variants={
    ordinary:f=>{f.agent.labels={};},
    'forged run label':f=>{f.agent.labels['clyde.run']='r-deadbeef';},
    'malformed run label':f=>{f.agent.labels['clyde.run']='../../other';},
    'forged thread label':f=>{f.agent.labels['clyde.thread']='t-other';},
    'runtime binds different agent':f=>{f.thread.paseoAgentId='other-worker';},
    'native ref returns foreign identity':f=>{f.state.native={...f.agent,id:'other-worker'};},
    'request provider differs':f=>{f.request.provider='codex';},
    'thread provider differs':f=>{f.thread.rung.backend='codex';},
    'thread belongs to another run':f=>{f.thread.runId='r-deadbeef';},
    'thread belongs to another stage':f=>{f.thread.stage='implementation';},
    'runtime returns another run':f=>{f.run.id='r-deadbeef';},
    'runtime returns another thread':f=>{f.thread.id='t-other';},
    'native workspace differs':f=>{f.agent.cwd='/another-project';},
    'runtime workspace differs':f=>{f.thread.cwd='/another-project';},
    'ordinary parent is not labelled orchestrator':f=>{f.agent.labels={};f.run.paseoParentId=f.agent.id;},
    'forged orchestrator label':f=>{f.orchestrator();f.run.paseoParentId='another-parent';},
  };
  for(const [name,mutate]of Object.entries(variants))await t.test(name,async t=>{const f=fixture(t);mutate(f);await f.invoke();noGrant(f);});
});

test('archived, completed, superseded, reviewed and failed workers cannot use the live-worker policy',async t=>{
  const variants={
    'archived native worker':f=>{f.agent.archivedAt='now';},
    'archived run':f=>{f.run.archivedAt='now';},
    'ended run':f=>{f.run.endedAt='now';},
    'completed run':f=>{f.run.status='done';},
    'stopped run':f=>{f.run.status='stopped';},
    'failed run':f=>{f.run.status='failed';},
    'run waiting for a decision':f=>{f.run.status='asking';},
    'passed stage':f=>{f.stage.status='passed';},
    'ended stage':f=>{f.stage.endedAt='now';},
    'ended attempt':f=>{f.attempt.endedAt='now';},
    'reported result':f=>{f.attempt.result={status:'done'};},
    'judged attempt':f=>{f.attempt.verdict={verdict:'pass'};},
    'failed attempt':f=>{f.attempt.ok=false;},
    'reviewer active':f=>{f.attempt.judgeId='judge';},
    'superseded worker':f=>{f.stage.attempts.push({...f.attempt,n:2,threadId:'new-worker'});},
    'idle worker':f=>{f.thread.status='idle';},
    'queued worker':f=>{f.thread.status='queued';},
    'failed worker':f=>{f.thread.status='failed';},
    'archived worker':f=>{f.thread.archivedAt='now';},
    'read-only reviewer':f=>{f.thread.readOnly=true;},
  };
  for(const [name,mutate]of Object.entries(variants))await t.test(name,async t=>{const f=fixture(t);mutate(f);await f.invoke();noGrant(f);});
});

test('orchestrators can read paused runs but not terminal, archived or unbound runs',async t=>{
  await t.test('paused run',async t=>{const f=fixture(t);f.orchestrator();f.run.status='asking';await f.invoke();assert.equal(f.state.answered,1);});
  for(const status of ['done','failed','stopped'])await t.test(status,async t=>{const f=fixture(t);f.orchestrator();f.run.status=status;await f.invoke();noGrant(f);});
});

test('the final refresh rejects resolved, replaced, promoted and ambiguous pending requests',async t=>{
  const variants={
    resolved:f=>{f.agent.pendingPermissions=[];},
    replaced:f=>{f.agent.pendingPermissions=[{...f.request,id:'new-request'}];},
    'same id changed tool':f=>{f.agent.pendingPermissions=[{...f.request,name:'Bash'}];},
    'same id changed provider':f=>{f.agent.pendingPermissions=[{...f.request,provider:'codex'}];},
    'same id promoted action':f=>{f.agent.pendingPermissions=[{...f.request,actions:[{id:'always',behavior:'allow',label:'Always allow'}]}];},
    'same id changed kind':f=>{f.agent.pendingPermissions=[{...f.request,kind:'plan'}];},
    'duplicate request ids':f=>{f.agent.pendingPermissions=[f.request,{...f.request}];},
    'agent disappeared':f=>{f.state.native=null;},
    'agent archived':f=>{f.agent.archivedAt='now';},
    'agent relabelled':f=>{f.agent.labels={};},
    'agent provider changed':f=>{f.agent.provider='codex';},
    'worker finished':f=>{f.attempt.endedAt='now';},
  };
  for(const [name,mutate]of Object.entries(variants))await t.test(name,async t=>{
    const f=fixture(t);f.state.refresh=async n=>{if(n===2)mutate(f);};await f.invoke();noGrant(f);
  });
});

test('lookup failures and native refresh failures leave the permission pending without a fallback grant',async t=>{
  for(const failure of ['run service','thread service','native refresh','offline daemon'])await t.test(failure,async t=>{
    const f=fixture(t);
    if(failure==='offline daemon')f.state.read=async()=>{throw Error('fetch failed');};
    else if(failure==='native refresh')f.state.refresh=async()=>{throw Error('native lookup unavailable');};
    else {const read=f.state.read;f.state.read=async path=>{if(path.startsWith(failure==='run service'?'/runs/':'/threads/'))throw Error('lookup service unavailable');return read(path);};}
    await f.invoke();noGrant(f);assert.equal(f.agent.pendingPermissions.length,1);
  });
});

test('a failed native permission response is not retried or expanded and stays pending for explicit review',async t=>{
  const f=fixture(t);f.state.respond=async()=>{throw Error('native permission service unavailable');};
  await f.invoke();
  assert.deepEqual(f.state.responses,[{requestId:'permission-1',response:{behavior:'allow'}}]);
  assert.equal(f.state.answered,0);assert.equal(f.agent.pendingPermissions.length,1);
});
