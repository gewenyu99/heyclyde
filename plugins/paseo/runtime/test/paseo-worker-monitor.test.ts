import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runManagedWorker } from '../src/paseo-turn.ts'

function launcher(scenario='permissions',timeoutMs=80){
  const base=mkdtempSync(join(tmpdir(),'clyde-live-worker-')),dist=join(base,'cli/dist'),sdk=join(base,'client/dist')
  mkdirSync(join(dist,'utils'),{recursive:true});mkdirSync(sdk,{recursive:true})
  writeFileSync(join(base,'package.json'),'{"type":"module"}')
  writeFileSync(join(dist,'utils/daemon-target.js'),'export const selectDaemonTarget=()=>({})')
  writeFileSync(join(dist,'utils/client.js'),`import {appendFileSync} from 'node:fs';export const connectToDaemon=async()=>({close:async()=>{},cancelAgent:async()=>appendFileSync(${JSON.stringify(join(base,'cancelled'))},'cancelled')})`)
  writeFileSync(join(sdk,'index.js'),`
    let listener,sent=false,n=0
    const scenario=${JSON.stringify(scenario)},cwd=${JSON.stringify(base)}
    const snapshot={id:'child',provider:'codex',cwd,status:'idle',activeTurn:null,pendingPermissions:[],labels:{'clyde.run':'run-one','clyde.thread':'thread-one'}}
    const rows=[]
    const emit=event=>listener?.({agentId:'child',event})
    const line=item=>{rows.push({turnId:'exact-turn',item});emit({type:'timeline',turnId:'exact-turn',item})}
    const child={id:'child',cwd,current:()=>snapshot,refresh:async()=>{
      if(!sent)return
      n++
      snapshot.activeTurn=n===1?null:{turnId:'exact-turn'};snapshot.status=n===1?'idle':'running';snapshot.pendingPermissions=[]
      if(scenario==='permissions'){
        if(n===2)line({type:'tool_call',name:'Read',status:'running'})
        if(n>=3&&n<=12){snapshot.pendingPermissions=[{id:'first-request'}];if(n>=5){snapshot.status='idle';snapshot.activeTurn=null}}
        if(n===4)line({type:'assistant_message',text:'Interim plan awaiting permission'})
        if(n===13)line({type:'todo',items:[{text:'Implement fix',activeForm:'Implementing the fix',status:'in_progress'}]})
        if(n>=14&&n<=23)snapshot.pendingPermissions=[{id:'second-request'}]
        if(n===25){snapshot.status='idle';snapshot.activeTurn=null;line({type:'assistant_message',text:'Exact requested turn finished'});emit({type:'turn_completed',turnId:'exact-turn'})}
      }
      if(scenario==='foreign'&&n===2){snapshot.activeTurn={turnId:'foreign-turn'};emit({type:'turn_started',turnId:'foreign-turn'})}
      if(scenario==='error'&&n===2){snapshot.status='error';snapshot.lastError='Provider failed explicitly'}
      if(scenario==='active')snapshot.activeTurn={turnId:'exact-turn'}
      if(scenario==='quick'){snapshot.status='idle';snapshot.activeTurn=null}
    },send:async(text,opts)=>{
      if(opts.messageId!=='thread-one-turn-2'||opts.activeTurnBehavior!==undefined)throw Error('Missing exact stable queued message identity')
      sent=true;line({type:'user_message',messageId:opts.messageId,text})
      if(scenario==='quick'){line({type:'assistant_message',text:'Quick exact response'});emit({type:'turn_completed',turnId:'exact-turn'})}
    },timeline:{subscribe:fn=>{listener=fn;const unsubscribe=()=>{};unsubscribe.ready=Promise.resolve();return unsubscribe},refetch:async()=>({entries:rows})}}
    export const createPaseoApi=()=>({agents:{ref:id=>id==='parent'?{refresh:async()=>{if(scenario!=='archived-first')throw Error('Archived parent must not be queried on follow-up')},current:()=>({archivedAt:'yesterday'})}:child}})
  `)
  const input={first:scenario==='archived-first',id:'child',parent:'parent',backend:'codex',run:'run-one',thread:'thread-one',cwd:base,messageId:'thread-one-turn-2',prompt:'keep going',timeoutMs}
  try{
    let output
    try{output=execFileSync(process.execPath,[new URL('../src/paseo-worker.mjs',import.meta.url).pathname,dist],{input:JSON.stringify(input),encoding:'utf8',env:{...process.env,CLYDE_PASEO_POLL_MS:'10'},stdio:['pipe','pipe','pipe']})}
    catch(error){output=(error as {stdout:string}).stdout}
    return {events:output!.trim().split('\n').map(line=>JSON.parse(line)),cancelled:(()=>{try{return readFileSync(join(base,'cancelled'),'utf8')}catch{return ''}})()}
  }finally{rmSync(base,{recursive:true,force:true})}
}

test('launcher monitors queued → active → permission → resume → new permission → exact completion without spending approval wait budget',()=>{
  const {events,cancelled}=launcher()
  const states=events.filter(e=>e.workerState).map(e=>e.workerState)
  assert.deepEqual([...new Set(states.map(s=>s.status))],['queued','active','permission','idle'])
  assert.ok(states.some(s=>s.requestIds.includes('first-request')))
  assert.ok(states.some(s=>s.requestIds.includes('second-request')))
  assert.ok(events.some(e=>e.progress==='Paseo worker resumed after permission request'))
  assert.ok(states.some(s=>s.activity==='Implementing the fix'))
  assert.ok(Date.parse(states.at(-1).observedAt)-Date.parse(states[0].observedAt)>160)
  assert.ok(states.every(s=>s.turnId==='exact-turn' && s.messageId==='thread-one-turn-2'))
  assert.equal(states.at(-1).permissionPending,false)
  assert.deepEqual(events.at(-1),{ok:true,text:'Exact requested turn finished'})
  assert.equal(cancelled,'')
})

test('existing child finishes its next exact turn even when the originating parent is archived',()=>{
  assert.deepEqual(launcher('quick').events.at(-1),{ok:true,text:'Quick exact response'})
})

test('new child creation still refuses an archived originating parent',()=>{
  const {events,cancelled}=launcher('archived-first')
  assert.match(events.at(-1).error,/originating Paseo agent is unavailable/)
  assert.ok(!events.some(e=>e.started))
  assert.equal(cancelled,'')
})

test('launcher refuses a different native turn and never cancels that unrelated turn',()=>{
  const {events,cancelled}=launcher('foreign')
  assert.match(events.at(-1).error,/changed turns/)
  assert.equal(cancelled,'')
})

test('launcher reports provider errors and stops only an owned turn that exceeds active budget',()=>{
  const failure=launcher('error')
  assert.match(failure.events.at(-1).error,/Provider failed explicitly/)
  assert.equal(failure.events.filter(e=>e.workerState).at(-1).workerState.status,'error')
  const timeout=launcher('active',20)
  assert.match(timeout.events.at(-1).error,/active execution timed out/)
  assert.equal(timeout.cancelled,'cancelled')
})

test('managed wrapper excludes permission wall time from its outer deadline and records live state',async t=>{
  const base=mkdtempSync(join(tmpdir(),'clyde-worker-wrapper-')),bin=join(base,'worker.mjs')
  writeFileSync(bin,`#!/usr/bin/env node
    let raw='';for await(const chunk of process.stdin)raw+=chunk;const x=JSON.parse(raw)
    const state=status=>console.log(JSON.stringify({workerState:{agentId:x.id,messageId:x.messageId,status,permissionPending:status==='permission',requestIds:status==='permission'?['pending']:[],observedAt:new Date().toISOString()}}))
    state('permission');console.log(JSON.stringify({progress:'Permission requested in Paseo worker '+x.id}))
    const heartbeat=setInterval(()=>state('permission'),10)
    setTimeout(()=>{clearInterval(heartbeat);state('idle');console.log(JSON.stringify({ok:true,text:'Finished after permission'}))},100)
  `,{mode:0o755})
  const previous={...process.env}
  Object.assign(process.env,{CLYDE_HOME:base,CLYDE_TURN_TIMEOUT_MS:'20',CLYDE_PASEO_WORKER_BIN:bin})
  t.after(()=>{for(const key of ['CLYDE_HOME','CLYDE_TURN_TIMEOUT_MS','CLYDE_PASEO_WORKER_BIN']){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key]}rmSync(base,{recursive:true,force:true})})
  t.mock.timers.enable({apis:['setTimeout']})
  const ready=Promise.withResolvers<void>()
  const thread={id:'thread-one',paseoAgentId:'child',paseoParentId:'parent',cwd:base,title:'Worker',rung:{backend:'codex'},turns:[{},{}]} as any
  const promise=runManagedWorker(thread,{rung:thread.rung,cwd:base,prompt:'continue',env:{},signal:new AbortController().signal,onProgress:line=>{if(line.startsWith('Permission requested'))ready.resolve()}})
  await ready.promise
  t.mock.timers.tick(11_000)
  const result=await promise
  assert.equal(result.ok,true)
  assert.equal(thread.workerState.status,'idle')
  assert.equal(thread.workerState.permissionPending,false)
})
