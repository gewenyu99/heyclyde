import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import promises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { flowDaemon, flowSetup, scenario, waitStatus } from './golden/flow.ts'
import { argvLog, git, tempDir } from './helpers.ts'
import { codexArgs } from '../src/backends/codex.ts'
import { permissionMode } from '../src/backends/claude.ts'
import type { TurnInput } from '../src/backends/types.ts'
import type { Run } from '../src/flow/types.ts'

function layout() {
  const root=tempDir('folder-workspace'),selected=join(root,'selected'),nested=join(selected,'unrelated'),sibling=join(root,'sibling')
  mkdirSync(selected);mkdirSync(nested);mkdirSync(sibling)
  for(const directory of [nested,sibling]) {
    git(directory,'init','-q','-b','main');git(directory,'config','commit.gpgsign','false')
    writeFileSync(join(directory,'secret.txt'),'UNRELATED-SECRET-DO-NOT-COLLECT')
    git(directory,'add','secret.txt');git(directory,'commit','-q','-m','decoy')
  }
  return {selected,nested,sibling}
}
function forbidAutomaticDiscovery(t: TestContext, selected: string, state: string) {
  const oldPath=process.env.PATH,bin=join(state,'no-git-bin'),log=join(state,'unexpected-git')
  mkdirSync(bin)
  writeFileSync(join(bin,'git'),'#!/bin/sh\nprintf "%s\\n" "$*" >> '+JSON.stringify(log)+'\nexit 99\n',{mode:0o755})
  process.env.PATH=bin+':'+oldPath
  t.after(()=>{process.env.PATH=oldPath})
  const scan=fs.readdirSync,scanAsync=promises.readdir
  t.mock.method(fs,'readdirSync',function(path,...args){assert.ok(!String(path).startsWith(selected),'runtime must not crawl selected folder');return scan(path,...args)})
  t.mock.method(promises,'readdir',async function(path,...args){assert.ok(!String(path).startsWith(selected),'runtime must not crawl selected folder');return scanAsync(path,...args)})
  syncBuiltinESMExports()
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports()})
  return log
}

test('folder task uses exact selected cwd with no repository discovery, bulk evidence, or Git changes',async t=>{
  const s=await flowSetup('task-rung1'),paths=layout()
  const nestedHead=git(paths.nested,'rev-parse','HEAD'),siblingHead=git(paths.sibling,'rev-parse','HEAD')
  writeFileSync(s.scenario,JSON.stringify({turns:[
    {match:'worker for stage task of',write:{'result.txt':'scoped result'},json:{status:'done',summary:'Wrote result.txt',evidence:[]}},
    {match:'judge for stage task of',json:{verdict:'pass',criteria:[{criterion:'Result exists',pass:true,evidence:'Read result.txt and check output'}],notes:'Checked relevant file.'}},
  ]}))
  const fakePaseo=join(s.state,'paseo-catalog')
  writeFileSync(fakePaseo,'#!/bin/sh\necho "{}"\n',{mode:0o755});process.env.CLYDE_PASEO_BIN=fakePaseo
  const log=forbidAutomaticDiscovery(t,paths.selected,s.state)
  const {d,client}=await flowDaemon()
  try {
    const run=await client.call<Run>('POST','/runs',{directory:true,cwd:paths.selected,flow:'task',input:{prompt:'Write result.txt in this folder',criteria:['Result exists'],checks:['test -f result.txt'],routing:{overrides:{worker:'sol'}}}})
    const done=await waitStatus(client,run.id,['done','failed','asking'])
    assert.equal(done.status,'done',done.error??done.question)
    assert.equal(done.directory,true);assert.equal(done.cwd,paths.selected);assert.equal(done.repo,paths.selected)
    assert.equal(done.branch,'');assert.equal(done.base,'');assert.equal(done.auditedHead,undefined)
    assert.equal(done.stages[0].attempts[0].checks?.[0].code,0)
    assert.equal(readFileSync(join(paths.selected,'result.txt'),'utf8'),'scoped result')
    assert.equal(existsSync(join(paths.selected,'.git')),false)
    assert.equal(existsSync(join(s.home,'worktrees',run.id)),false)
    assert.equal(existsSync(log),false,'not even backend metadata discovery runs git')
    const calls=argvLog(s.state);assert.ok(calls.length>=2);assert.ok(calls.every(call=>call.cwd===paths.selected))
    const records=readdirSync(join(s.home,'threads')).map(name=>readFileSync(join(s.home,'threads',name),'utf8'))
    assert.ok(records.every(text=>!text.includes('UNRELATED-SECRET-DO-NOT-COLLECT')))
    assert.ok(!JSON.stringify(done).includes('UNRELATED-SECRET-DO-NOT-COLLECT'))
    const judge=records.map(text=>JSON.parse(text)).find(thread=>thread.readOnly)
    assert.match(judge.turns[0].prompt,/Worker report \(unverified claims, not proof\)/)
    assert.match(judge.turns[0].prompt,/test -f result.txt/)
    assert.equal(readFileSync(join(paths.nested,'.git','HEAD'),'utf8').trim(),'ref: refs/heads/main')
    assert.equal(readFileSync(join(paths.nested,'.git','refs','heads','main'),'utf8').trim(),nestedHead)
    assert.equal(readFileSync(join(paths.sibling,'.git','refs','heads','main'),'utf8').trim(),siblingHead)
    await assert.rejects(client.call('POST','/runs',{directory:'true',cwd:paths.selected,flow:'task',input:{prompt:'x',criteria:['x']}}),/directory must be boolean/)
    await assert.rejects(client.call('POST','/runs',{directory:true,cwd:paths.selected,flow:'task',input:{prompt:'x',criteria:['x'],cwd:paths.sibling}}),/exact selected workspace/)
    await assert.rejects(client.call('POST','/runs',{directory:true,cwd:paths.selected,flow:'task',input:{prompt:'x',criteria:['x'],draftPR:true}}),/do not publish/)
  } finally {await d.close();await s.memory.close()}
})

test('folder ship keeps plan approval, code gates and a final read-only review without Git assumptions',async t=>{
  const s=await flowSetup('ship-auto'),paths=layout(),sc=scenario('ship-auto')
  for(const turn of sc.turns)delete turn.commit
  writeFileSync(s.scenario,JSON.stringify(sc))
  const log=forbidAutomaticDiscovery(t,paths.selected,s.state)
  const {d,client}=await flowDaemon()
  try {
    const run=await client.call<Run>('POST','/runs',{directory:true,cwd:paths.selected,flow:'ship',input:{intent:'Greet the user with a file.'}})
    const approval=await waitStatus(client,run.id,['asking','failed'])
    assert.equal(approval.status,'asking',approval.error);assert.match(approval.question??'',/^Approve the plan/)
    assert.equal(existsSync(join(paths.selected,'greet.txt')),false,'no implementation before approval')
    await client.answer(run.id,'approved')
    const final=await waitStatus(client,run.id,['asking','failed'])
    assert.equal(final.status,'asking',final.error);assert.match(final.question??'',/finished every stage in the selected folder/)
    assert.doesNotMatch(final.question??'',/branch|commit|SHA/)
    assert.deepEqual(final.stages.map(stage=>[stage.name,stage.status]),[['plan','passed'],['code-it-works:s1','passed'],['code-it-good:s1','passed'],['code-it-clean:s1','passed'],['review','passed']])
    const records=readdirSync(join(s.home,'threads')).map(name=>JSON.parse(readFileSync(join(s.home,'threads',name),'utf8')))
    assert.ok(records.filter(thread=>thread.stage==='review').every(thread=>thread.readOnly===true),'both final reviewer and judge are read-only')
    assert.ok(records.every(thread=>thread.cwd===paths.selected))
    await client.answer(run.id,'approved')
    assert.equal((await waitStatus(client,run.id,['done','failed'])).status,'done')
    assert.equal(existsSync(log),false);assert.equal(existsSync(join(paths.selected,'.git')),false)
  } finally {await d.close();await s.memory.close()}
})

test('folder backend arguments skip automatic Git metadata probes and allow explicit scoped Git checks',()=>{
  const cwd=tempDir('folder-args'),input={directory:true,cwd,rung:{backend:'codex'},env:{CLYDE_HOME:tempDir('folder-args-home')},prompt:'x',signal:new AbortController().signal} as TurnInput
  assert.equal(permissionMode({...input,rung:{backend:'claude'}}),'acceptEdits')
  assert.ok(codexArgs(input,{out:join(cwd,'result')}).includes('--skip-git-repo-check'))
})
