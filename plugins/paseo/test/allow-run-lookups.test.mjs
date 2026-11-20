import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { allowRunLookups } from '../server/allow-run-lookups.ts';

const runId='r-a11ce001',threadId='t-worker-1',workerId='worker-1';
const TRUSTED_BASE='https://memory.heyclyde.me';
const TRUSTED_MCP=TRUSTED_BASE+'/mcp';

function fixture(t, opts = {}){
  const root=mkdtempSync(join(tmpdir(),'clyde-run-lookups-'));
  const home=join(root,'workspace');
  const configDir=join(root,'clyde-config');
  const claudeDir=join(root,'claude-config');
  const codexDir=join(root,'codex-config');
  const geminiDir=join(root,'gemini-config');
  mkdirSync(home,{recursive:true});
  mkdirSync(configDir,{recursive:true});
  mkdirSync(claudeDir,{recursive:true});
  mkdirSync(codexDir,{recursive:true});
  mkdirSync(join(geminiDir,'config'),{recursive:true});

  const savedEnv={
    CLYDE_HOME:process.env.CLYDE_HOME,
    CLYDE_CONFIG_DIR:process.env.CLYDE_CONFIG_DIR,
    CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR,
    CLAUDE_CONFIG_FILE:process.env.CLAUDE_CONFIG_FILE,
    CLAUDE_MANAGED_MCP_FILE:process.env.CLAUDE_MANAGED_MCP_FILE,
    CODEX_HOME:process.env.CODEX_HOME,
    GEMINI_CONFIG_DIR:process.env.GEMINI_CONFIG_DIR,
  };
  process.env.CLYDE_HOME=home;
  process.env.CLYDE_CONFIG_DIR=configDir;
  process.env.CLAUDE_CONFIG_DIR=claudeDir;
  process.env.CLAUDE_CONFIG_FILE=join(claudeDir,'.claude.json');
  process.env.CLAUDE_MANAGED_MCP_FILE=join(claudeDir,'managed-mcp.json');
  process.env.CODEX_HOME=codexDir;
  process.env.GEMINI_CONFIG_DIR=geminiDir;

  writeFileSync(join(home,'daemon.json'),JSON.stringify({port:11111,token:'fixture'}));
  if(opts.trustedUrl !== null){
    writeFileSync(join(configDir,'url'), opts.trustedUrl ?? TRUSTED_BASE);
  }
  if(opts.claudeConfig !== null){
    writeFileSync(process.env.CLAUDE_CONFIG_FILE, JSON.stringify(opts.claudeConfig ?? {
      mcpServers:{memory:{type:'http',url:TRUSTED_MCP}},
    }));
  }
  if(opts.codexToml !== null){
    writeFileSync(join(codexDir,'config.toml'), opts.codexToml ?? `[mcp_servers.memory]\nurl = "${TRUSTED_MCP}"\n`);
  }
  if(opts.geminiConfig !== null){
    writeFileSync(join(geminiDir,'config','mcp_config.json'), JSON.stringify(opts.geminiConfig ?? {
      mcpServers:{memory:{serverUrl:TRUSTED_MCP}},
    }));
  }

  t.after(()=>{
    for(const [k,v] of Object.entries(savedEnv)){
      if(v===undefined)delete process.env[k];
      else process.env[k]=v;
    }
    rmSync(root,{recursive:true,force:true});
  });

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
  return {root,home,configDir,claudeDir,codexDir,geminiDir,request,attempt,stage,run,thread,agent,state,invoke,orchestrator};
}
const noGrant=f=>{assert.deepEqual(f.state.responses,[]);assert.equal(f.state.answered,0);};

test('every live Paseo agent always gets permission for Paseo built-in Clyde tools and trusted memory MCP tools',async t=>{
  const names=[
    'mcp__paseo__clyde_recall','mcp__paseo__clyde_recall_more','mcp__paseo__clyde_remember','mcp__paseo__clyde_get_entry','mcp__paseo__clyde_get_blob','mcp__paseo__clyde_post_quest','mcp__paseo__clyde_list_quests','mcp__paseo__clyde_delegate',
    'mcp__memory__recall','mcp__memory__recall_more','mcp__memory__check_messages','mcp__memory__get_entry','mcp__memory__get_blob','mcp__memory__remember','mcp__memory__feedback','mcp__memory__list_quests','mcp__memory__post_quest',
  ];
  for(const role of ['ordinary','worker','orchestrator'])for(const name of names)await t.test(role+' '+name,async t=>{
    const f=fixture(t);
    if(role==='orchestrator')f.orchestrator();
    if(role==='ordinary')f.agent.labels={};
    f.request.name=name;
    await f.invoke();
    assert.deepEqual(f.state.responses,[{requestId:'permission-1',response:{behavior:'allow'}}]);
    assert.equal(f.state.answered,1);
    assert.deepEqual(f.agent.pendingPermissions,[]);
    assert.equal(f.state.refreshes,2,'native request is refreshed before granting');
  });
});

test('verified active Clyde workers auto-approve all tool calls including Bash, Write, and offered allow actions',async t=>{
  for(const values of [
    {name:'Bash',input:{command:'npm test'}},
    {name:'Write',input:{path:'a.ts'}},
    {name:'Bash',actions:[{id:'allow-always',label:'Always allow',behavior:'allow'}]},
  ])await t.test(JSON.stringify(values),async t=>{
    const f=fixture(t);Object.assign(f.request,values);
    await f.invoke();
    assert.equal(f.state.answered,1);
    assert.equal(f.state.responses[0].response.behavior,'allow');
    if(values.actions)assert.equal(f.state.responses[0].response.selectedActionId,'allow-always');
  });
});

test('trusted memory server verification works across claude, codex, and antigravity without mutating settings',async t=>{
  for(const provider of ['claude','codex','antigravity'])await t.test(provider,async t=>{
    const f=fixture(t);
    f.request.provider=provider;f.agent.provider=provider;f.thread.rung.backend=provider;f.attempt.rung.backend=provider;
    f.request.name='mcp__memory__check_messages';
    const before=readFileSync(process.env.CLAUDE_CONFIG_FILE,'utf8');
    await f.invoke();
    assert.equal(f.state.answered,1);
    assert.equal(readFileSync(process.env.CLAUDE_CONFIG_FILE,'utf8'),before,'never writes local settings');
  });
});

test('untrusted, shadowed, stdio, missing, or malformed memory server configs fail closed for mcp__memory__ tools',async t=>{
  const cases={
    'missing clyde url': { opts:{trustedUrl:null} },
    'untrusted claude url': { opts:{claudeConfig:{mcpServers:{memory:{type:'http',url:'https://evil.example/mcp'}}}} },
    'stdio claude memory server': { opts:{claudeConfig:{mcpServers:{memory:{type:'stdio',command:'node',args:['evil.js']}}}} },
    'disabled claude memory server': { opts:{claudeConfig:{mcpServers:{memory:{type:'http',url:TRUSTED_MCP,disabled:true}}}} },
    'missing claude memory server': { opts:{claudeConfig:{mcpServers:{other:{type:'http',url:TRUSTED_MCP}}}} },
    'project .mcp.json shadows memory with untrusted url': {
      mutate:f=>writeFileSync(join(f.home,'.mcp.json'),JSON.stringify({mcpServers:{memory:{type:'http',url:'https://evil.example/mcp'}}})),
    },
    'parent dir .mcp.json shadows memory with stdio': {
      mutate:f=>writeFileSync(join(f.root,'.mcp.json'),JSON.stringify({mcpServers:{memory:{command:'sh',args:['-c','pwn']}}})),
    },
    'malformed project .mcp.json fails closed': {
      mutate:f=>writeFileSync(join(f.home,'.mcp.json'),'{broken json'),
    },
    'project-scoped .claude.json shadows memory': {
      mutate:f=>writeFileSync(process.env.CLAUDE_CONFIG_FILE,JSON.stringify({
        mcpServers:{memory:{type:'http',url:TRUSTED_MCP}},
        projects:{[f.home]:{mcpServers:{memory:{type:'http',url:'https://evil.example/mcp'}}}},
      })),
    },
    'request metadata url contradicts trusted server': {
      mutate:f=>{f.request.metadata={serverUrl:'https://evil.example/mcp'};},
    },
    'request detail server contradicts memory': {
      mutate:f=>{f.request.detail={server:'evil'};},
    },
    'untrusted codex toml url': {
      opts:{codexToml:'[mcp_servers.memory]\nurl = "https://evil.example/mcp"\n'},
      mutate:f=>{f.request.provider='codex';f.agent.provider='codex';f.thread.rung.backend='codex';},
    },
    'codex stdio command': {
      opts:{codexToml:'[mcp_servers.memory]\ncommand = "evil"\nurl = "https://memory.heyclyde.me/mcp"\n'},
      mutate:f=>{f.request.provider='codex';f.agent.provider='codex';f.thread.rung.backend='codex';},
    },
    'untrusted antigravity url': {
      opts:{geminiConfig:{mcpServers:{memory:{serverUrl:'https://evil.example/mcp'}}}},
      mutate:f=>{f.request.provider='antigravity';f.agent.provider='antigravity';f.thread.rung.backend='antigravity';},
    },
    'unknown provider fails closed': {
      mutate:f=>{f.request.provider='custom';f.agent.provider='custom';f.thread.rung.backend='custom';},
    },
  };
  for(const [name,spec] of Object.entries(cases))await t.test(name,async t=>{
    const f=fixture(t, spec.opts);
    f.request.name='mcp__memory__recall';
    spec.mutate?.(f);
    await f.invoke();
    noGrant(f);
  });
});

test('non-tool prompts, deny-only actions, and malformed action payloads remain for explicit review',async t=>{
  const requests=[
    {kind:'plan'}, {kind:'question'},
    {actions:[{id:'deny-only',label:'Deny',behavior:'deny'}]},
    {actions:{length:0}},
  ];
  for(const values of requests)await t.test(JSON.stringify(values),async t=>{
    const f=fixture(t);Object.assign(f.request,values);await f.invoke();noGrant(f);
    assert.equal(f.state.refreshes,0);assert.equal(f.state.reads.length,0);
  });
});

test('ordinary chats, orchestrators, forged ownership labels, foreign native agents and provider mismatches never auto-grant non-Clyde tools',async t=>{
  const variants={
    'ordinary chat Bash':f=>{f.agent.labels={};},
    'orchestrator Bash':f=>{f.orchestrator();},
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
  for(const [name,mutate]of Object.entries(variants))await t.test(name,async t=>{
    const f=fixture(t);f.request.name='Bash';mutate(f);await f.invoke();noGrant(f);
  });
});

test('archived, completed, superseded, reviewed and failed workers cannot auto-approve non-Clyde tools',async t=>{
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
  for(const [name,mutate]of Object.entries(variants))await t.test(name,async t=>{
    const f=fixture(t);f.request.name='Bash';mutate(f);await f.invoke();noGrant(f);
  });
});

test('the final refresh rejects resolved, replaced, deny-only and ambiguous pending requests',async t=>{
  const variants={
    resolved:f=>{f.agent.pendingPermissions=[];},
    replaced:f=>{f.agent.pendingPermissions=[{...f.request,id:'new-request'}];},
    'same id changed tool':f=>{f.agent.pendingPermissions=[{...f.request,name:'Write'}];},
    'same id changed provider':f=>{f.agent.pendingPermissions=[{...f.request,provider:'codex'}];},
    'same id deny-only action':f=>{f.agent.pendingPermissions=[{...f.request,actions:[{id:'deny',behavior:'deny',label:'Deny'}]}];},
    'same id changed kind':f=>{f.agent.pendingPermissions=[{...f.request,kind:'plan'}];},
    'duplicate request ids':f=>{f.agent.pendingPermissions=[f.request,{...f.request}];},
    'agent disappeared':f=>{f.state.native=null;},
    'agent archived':f=>{f.agent.archivedAt='now';},
    'agent relabelled':f=>{f.agent.labels={};},
    'agent provider changed':f=>{f.agent.provider='codex';},
    'worker finished':f=>{f.attempt.endedAt='now';},
  };
  for(const [name,mutate]of Object.entries(variants))await t.test(name,async t=>{
    const f=fixture(t);f.request.name='Bash';f.state.refresh=async n=>{if(n===2)mutate(f);};await f.invoke();noGrant(f);
  });
});

test('lookup failures and native refresh failures leave non-Clyde permissions pending without a fallback grant',async t=>{
  for(const failure of ['run service','thread service','native refresh','offline daemon'])await t.test(failure,async t=>{
    const f=fixture(t);
    f.request.name='Bash';
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
