import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test,{after} from 'node:test';
import {execFileSync} from 'node:child_process';
import { classifyProject,suggestProject } from '../server/project-selection.ts';

const repositories=mkdtempSync(join(tmpdir(),'clyde-eligible-projects-'));
after(()=>rmSync(repositories,{recursive:true,force:true}));
for(const name of ['clyde','website']){
  const path=join(repositories,name);mkdirSync(path);
  execFileSync('git',['init','-q',path]);
  execFileSync('git',['-C',path,'-c','user.name=test','-c','user.email=test@example.test','-c','commit.gpgsign=false','commit','--allow-empty','-qm','initial']);
}

function fixture(options={}){
  let handler;
  suggestProject({handle:(_rpc,fn)=>{handler=fn;}},options);
  const projects=[{projectId:'one',projectDisplayName:'Clyde',projectRootPath:join(repositories,'clyde'),projectKind:'git'},{projectId:'two',projectDisplayName:'Website',projectRootPath:join(repositories,'website'),projectKind:'git'}];
  const paseo={projects:{list:async()=>({projects})}};
  return {projects,paseo,invoke:prompt=>handler({prompt},{paseo})};
}

test('Auto offers only authoritative bounded project IDs, names and canonical slugs and validates selection',async()=>{
  let seen;
  const f=fixture({classify:async(prompt,projects)=>{seen={prompt,projects};return {projectId:'one',reason:'The task names Clyde.'};}});
  f.projects.push({projectId:'nongit',projectDisplayName:'Notes',projectRootPath:'/private/secret',projectKind:'non_git'},{projectId:'stale-git',projectDisplayName:'Missing checkout',projectRootPath:'/not-present/checkout',projectKind:'git'});
  assert.deepEqual(await f.invoke('Fix Clyde'),{projectId:'one',reason:'The task names Clyde.'});
  assert.deepEqual(Object.keys(seen.projects[0]).sort(),['id','name','slug']);
  assert.equal(seen.projects.length,2);
  assert.equal(seen.projects[0].slug,'clyde');
  assert.doesNotMatch(JSON.stringify(seen.projects),/not-present|private|secret/);
});

test('Auto strictly rejects invented IDs, extra response fields, invalid types, missing reason and oversized reason',async()=>{
  for(const value of [{projectId:'unknown',reason:'Invented'},{projectId:'one',reason:'okay',launch:true},{projectId:23,reason:'bad'},{projectId:'one'},{projectId:'one',reason:'x'.repeat(301)},['one']]){
    const f=fixture({classify:async()=>value});
    assert.equal((await f.invoke('Do something')).projectId,undefined);
  }
  assert.deepEqual(await fixture({classify:async()=>({projectId:null,reason:'No clear match.'})}).invoke('Do something'),{reason:'No clear match.'});
});

test('Auto sanitizes metadata and refuses a project removed during classification',async()=>{
  let received;
  const f=fixture({classify:async(_prompt,projects)=>{received=projects;f.projects.splice(0,1);return {projectId:'one',reason:'Clyde'};}});
  f.projects[0].projectDisplayName='Clyde\u0000\u202e /Users/owner/private-file '+ 'x'.repeat(400);
  const result=await f.invoke('Clyde');
  assert.equal(result.projectId,undefined);
  assert.ok(received[0].name.length<=160);
  assert.doesNotMatch(received[0].name,/\u0000|\u202e|\/Users/);
});

test('Auto bounds request size, catalog size, concurrency and the complete lookup deadline',async()=>{
  let release;
  const held=new Promise(resolve=>{release=resolve;});
  const f=fixture({classify:async()=>held,timeoutMs:20});
  const one=f.invoke('First'),two=f.invoke('Second');
  assert.match((await f.invoke('Third')).reason,/busy/);
  assert.match((await one).reason,/timed out/);assert.match((await two).reason,/timed out/);
  release({projectId:null,reason:'No match'});
  assert.equal((await f.invoke('')).projectId,undefined);
  assert.match((await f.invoke('x'.repeat(12001))).reason,/12,000/);
  const many=fixture({classify:async()=>{throw Error('Should not classify oversized catalog');}});
  many.projects.push(...Array.from({length:64},(_,n)=>({...many.projects[0],projectId:'extra-'+n})));
  assert.match((await many.invoke('Task')).reason,/Too many/);
});

test('real classifier command uses ephemeral read-only Luna low with disabled tools and a validated JSON schema',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'clyde-classifier-test-')),bin=join(dir,'codex'),log=join(dir,'log.json');
  const previous=process.env.CLYDE_CODEX_BIN;
  process.env.CLYDE_CODEX_BIN=bin;
  t.after(()=>{if(previous===undefined)delete process.env.CLYDE_CODEX_BIN;else process.env.CLYDE_CODEX_BIN=previous;rmSync(dir,{recursive:true,force:true});});
  writeFileSync(bin,`#!/usr/bin/env node
    import {writeFileSync,readFileSync} from 'node:fs';let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
    const argv=process.argv.slice(2),schema=JSON.parse(readFileSync(argv[argv.indexOf('--output-schema')+1],'utf8'));
    writeFileSync(${JSON.stringify(log)},JSON.stringify({argv,prompt,schema,cwd:process.cwd(),runtimeToken:process.env.MEMORY_RUNTIME_TOKEN}));
    writeFileSync(argv[argv.indexOf('-o')+1],JSON.stringify({projectId:'one',reason:'Names Clyde'}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'error',message:'startup diagnostic'}}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message'}}));
  `,{mode:0o755});
  const result=await classifyProject('Fix Clyde',[{id:'one',name:'Clyde',slug:'owner/clyde'}],new AbortController().signal);
  assert.deepEqual(result,{projectId:'one',reason:'Names Clyde'});
  const saved=JSON.parse(readFileSync(log,'utf8'));
  assert.ok(saved.argv.includes('--ephemeral'));assert.ok(saved.argv.includes('--ignore-user-config'));
  assert.equal(saved.argv[saved.argv.indexOf('-m')+1],'gpt-6-luna');assert.ok(saved.argv.includes('model_reasoning_effort="low"'));
  assert.equal(saved.argv[saved.argv.indexOf('-s')+1],'read-only');assert.ok(saved.argv.includes('web_search="disabled"'));
  assert.ok(saved.argv.includes('shell_tool'));assert.ok(saved.argv.includes('apps'));
  assert.equal(saved.runtimeToken,undefined);
  assert.deepEqual(saved.schema.properties.projectId.anyOf[0].enum,['one']);
  assert.match(saved.prompt,/untrusted data/);assert.match(saved.prompt,/owner\/clyde/);
});

test('classifier aborts tool attempts, oversized output, and deadline without accepting an answer',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'clyde-classifier-limits-')),bin=join(dir,'codex'),previous=process.env.CLYDE_CODEX_BIN;
  process.env.CLYDE_CODEX_BIN=bin;
  t.after(()=>{if(previous===undefined)delete process.env.CLYDE_CODEX_BIN;else process.env.CLYDE_CODEX_BIN=previous;rmSync(dir,{recursive:true,force:true});});
  const run=code=>{
    writeFileSync(bin,'#!/usr/bin/env node\n'+code,{mode:0o755});
    return classifyProject('Task',[{id:'one',name:'One',slug:'owner/one'}],new AbortController().signal);
  };
  await assert.rejects(run(`console.log(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'do-not-run'}}));setInterval(()=>{},1000)`),/tool call/);
  await assert.rejects(run(`console.log('x'.repeat(40000));setInterval(()=>{},1000)`),/output exceeded/);
  writeFileSync(bin,'#!/usr/bin/env node\nsetInterval(()=>{},1000)',{mode:0o755});
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),30);
  try{await assert.rejects(classifyProject('Task',[{id:'one',name:'One',slug:'owner/one'}],abort.signal),/timed out/);}finally{clearTimeout(timer);}
});

test('Auto offers an existing directory project without requiring Git or a child checkout',async()=>{
  const path=join(repositories,'plain-notes');mkdirSync(path);
  let offered;
  const f=fixture({classify:async(_prompt,projects)=>{offered=projects;return {projectId:'folder',reason:'The task names the notes folder.'};}});
  f.projects.push({projectId:'folder',projectDisplayName:'Notes folder',projectRootPath:path,projectKind:'non_git'});
  assert.deepEqual(await f.invoke('Organize the notes folder'),{projectId:'folder',reason:'The task names the notes folder.'});
  assert.equal(offered.find(p=>p.id==='folder').slug,'plain-notes');
});
