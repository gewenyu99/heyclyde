import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import contribute from "../index.server.ts";

async function waitFor(check) {
  for(let n=0;n<100;n++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,5));}
  throw new Error("Fake quest operation did not settle");
}
function fixture(t) {
  const home=mkdtempSync(join(tmpdir(),"clyde-new-quest-")), old={...process.env};
  Object.assign(process.env,{CLYDE_HOME:home,CLYDE_CONFIG_DIR:home,PASEO_HOME:home});
  execFileSync("git",["init","-q",home]);
  execFileSync("git",["-C",home,"remote","add","origin","git@github.com:owner/repo.git"]);
  for(const [name,value] of Object.entries({url:"http://127.0.0.1:12345",token:"fake-token-"+randomUUID(),"server-id":"fake-host-"+randomUUID(),"daemon.json":JSON.stringify({port:12345,token:"fake-token"})}))writeFileSync(join(home,name),value);
  const quest={id:501,title:"Fix quest launch",brief:"Implement a fix",done_when:"Tests pass",priority:"normal",project:"owner/repo",state:"open",assignee:"any",tags:["quest-routing"]};
  const calls=[],created=[],runs=new Map(),agents=new Map(),sessions=new Map();
  const settings={claimError:"",failLaunch:0};
  const workspaces=[{id:"ws-one",projectId:"project",name:"Main checkout",workspaceDirectory:home}];
  const projects=[{projectId:"project",projectDisplayName:"Repo",projectRootPath:home,projectKind:"git"}];
  let sessionN=0,closed=false;
  const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json",...headers}});
  t.mock.method(globalThis,"fetch",async(url,options={})=>{
    const path=new URL(url).pathname;
    if(path==="/events")return new Response(new ReadableStream({start(controller){options.signal?.addEventListener("abort",()=>controller.close(),{once:true});}}));
    if(path==="/mcp"){
      const body=JSON.parse(options.body);
      if(body.method==="initialize")return json({result:{}},200,{"mcp-session-id":"session-"+(++sessionN)});
      const {name,arguments:args}=body.params,session=options.headers["mcp-session-id"];
      calls.push({name,args,session});
      if(name==="register_agent"){sessions.set(session,args);return json({result:{content:[{text:"Registered"}]}});}
      if(name==="list_quests"){
        if(args.show==="board")return json({result:{content:[{text:JSON.stringify({quests:[quest],after:null})}]}});
        // The chosen quest deliberately isn't in the first 50 scoped results.
        return json({result:{content:[{text:"No open quests for you"}],_meta:{"clyde/card":{quests:[]}}}});
      }
      if(name==="claim_quest"){
        if(settings.claimError)return json({result:{isError:true,content:[{text:settings.claimError}]}});
        const registration=sessions.get(session);
        assert.deepEqual(registration.projects,["owner/repo"]);
        assert.equal(registration.strict_projects,true);
        assert.equal(registration.harness,"claude");
        quest.state="claimed";quest.claimed_by=registration.name;
        return json({result:{content:[{text:"Claimed quest #501. Authoritative briefing."}]}});
      }
      if(name==="recall")return json({result:{content:[{text:"Relevant project evidence"}],_meta:{"clyde/card":{retrieval_id:randomUUID(),items:[]}}}});
      if(name==="complete_quest"||name==="abandon_quest"){quest.state=name==="complete_quest"?"done":"open";return json({result:{content:[{text:"Settled"}]}});}
      if(name==="remember")return json({result:{content:[{text:"Remembered quest-result-note."}]}});
      return json({result:{content:[{text:"OK"}]}});
    }
    if(options.method==="POST"&&path==="/runs"){
      const input=JSON.parse(options.body);calls.push({name:"launch",args:input});
      if(settings.failLaunch-->0)return json({error:"simulated launch failure"},503);
      const id="r-"+input.assignment;
      if(!runs.has(id))runs.set(id,{id,title:quest.title,status:"running",asks:[],stages:[],repo:input.cwd,paseoParentId:input.paseoParentId});
      return json(runs.get(id));
    }
    if(path==="/runs")return json([...runs.values()]);
    if(path.startsWith("/runs/"))return runs.has(path.slice(6))?json(runs.get(path.slice(6))):json({error:"not found"},404);
    throw new Error("Unexpected fake request "+path);
  });
  const create=async(workspaceId,options)=>{
    const duplicate=created.find(c=>c.options.idempotencyKey===options.idempotencyKey);
    if(duplicate)return {id:duplicate.id};
    const id="fresh-"+(created.length+1),cwd=workspaces.find(w=>w.id===workspaceId)?.workspaceDirectory||home;
    created.push({id,workspaceId,options});
    agents.set(id,{id,title:options.title,cwd,provider:options.config.provider.split("/")[0],workspaceId,status:"idle",labels:{},metadata:{}});
    return {id};
  };
  const paseo={
    projects:{list:async()=>({projects})},workspaces:{list:async()=>({entries:workspaces}),ref:id=>({agents:{create:options=>create(id,options)}})},
    providers:{snapshot:async()=>({entries:[{provider:"claude",enabled:true,status:"ready",models:[{id:"sonnet",isDefault:true}]}]})},
    agents:{create:options=>create(undefined,options),list:async()=>({entries:[...agents.values()].map(agent=>({agent})),pageInfo:{hasMore:false}}),ref:id=>({refresh:async()=>{},current:()=>agents.get(id),timeline:{append:async()=>{}}})},
  };
  const handlers=new Map();
  const server={handle:(rpc,handler)=>handlers.set(rpc.name,handler),addHook() {}};
  let teardown=contribute(server);
  const restart=()=>{teardown();teardown=contribute(server);};
  t.after(()=>{
    if(closed)return;closed=true;teardown();
    for(const key of ["CLYDE_HOME","CLYDE_CONFIG_DIR","PASEO_HOME"]){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}
    rmSync(home,{recursive:true,force:true});
  });
  const invoke=(args)=>handlers.get("clyde.new-quest")(args,{paseo});
  const saved=name=>JSON.parse(readFileSync(join(home,name),"utf8"));
  return {home,quest,calls,created,runs,agents,workspaces,projects,paseo,handlers,settings,invoke,saved,restart};
}

test("new quest creates one dedicated orchestrator and claims the chosen quest beyond scoped first-50 results",async t=>{
  const f=fixture(t),input={quest:501,project:"project",requestId:randomUUID()};
  const result=await f.invoke(input);
  assert.deepEqual(result,{id:"r-"+input.requestId});
  assert.equal(f.created.length,1);assert.equal(f.runs.size,1);
  assert.match(f.created[0].options.title,/Quest #501/);
  const origin=f.saved("chat-runs.json")[result.id];
  assert.equal(origin.agent,f.created[0].id);assert.equal(origin.job.quest,501);assert.equal(origin.job.confirmed,true);
  const row=f.saved("residents.json")[origin.agent];
  assert.equal(row.paused,true);assert.equal(row.confirmed,false);assert.deepEqual(row.areas,[]);assert.match(row.role,/Quest #501/);
  assert.match(f.calls.find(c=>c.name==="launch").args.input.prompt,/Authoritative briefing/);
  assert.equal(f.calls.filter(c=>c.name==="dispatch_quest").length,0);
  assert.deepEqual(await f.invoke(input),result);
  f.restart();assert.deepEqual(await f.invoke(input),result);
  assert.equal(f.created.length,1);assert.equal(f.calls.filter(c=>c.name==="claim_quest").length,1);
});

test("new quest publishes canonical slugs and explicit workspace choices",async t=>{
  const f=fixture(t);
  f.workspaces.push({id:"ws-two",projectId:"project",name:"Feature worktree",workspaceDirectory:f.home+"/worktree"});
  const list=await f.handlers.get("clyde.projects")({},{paseo:f.paseo});
  assert.equal(list[0].slug,"owner/repo");assert.equal(list[0].workspaces.length,2);
  await assert.rejects(f.invoke({quest:501,project:"project",requestId:randomUUID()}),/Choose a workspace/);
  const started=await f.invoke({quest:501,project:"project",workspaceId:"ws-two",requestId:randomUUID()});
  assert.equal(f.created[0].workspaceId,"ws-two");assert.equal(f.saved("chat-runs.json")[started.id].job.cwd,f.home+"/worktree");
});

test("new quest rejects cross-project, unavailable workspace, explicit assignee, and non-open quests before creating chats",async t=>{
  const f=fixture(t),args=()=>({quest:501,project:"project",requestId:randomUUID()});
  f.quest.project="other/repo";await assert.rejects(f.invoke(args()),/another project/);
  f.quest.project="owner/repo";f.quest.assignee="assigned-agent";await assert.rejects(f.invoke(args()),/assigned orchestrator/);
  f.quest.assignee="any";f.quest.state="done";await assert.rejects(f.invoke(args()),/no longer open/);
  f.quest.state="open";await assert.rejects(f.invoke({...args(),workspaceId:"foreign-workspace"}),/available workspace/);
  assert.equal(f.created.length,0);assert.equal(f.calls.filter(c=>c.name==="claim_quest").length,0);
});

test("unsupported authoritative targets reuse the same dedicated chat on retry and never launch",async t=>{
  const f=fixture(t),input={quest:501,project:"project",requestId:randomUUID()};
  f.settings.claimError="Quest requires a different harness";
  await assert.rejects(f.invoke(input),/different harness/);f.restart();await assert.rejects(f.invoke(input),/different harness/);
  assert.equal(f.created.length,1);assert.equal(f.runs.size,0);
  assert.equal(f.calls.filter(c=>c.name==="register_agent").length,1,"only actual orchestrator identity is registered");
});

test("a successful claim with a failed launch retries and settles through existing quest tracking",async t=>{
  t.mock.timers.enable({apis:["setInterval"]});
  const f=fixture(t),input={quest:501,project:"project",requestId:randomUUID()};
  f.settings.failLaunch=1;
  await assert.rejects(f.invoke(input),/simulated launch failure/);
  assert.equal(f.saved("chat-runs.json")["r-"+input.requestId].job.confirmed,true);
  f.restart();const result=await f.invoke(input);
  assert.equal(f.created.length,1);assert.equal(f.calls.filter(c=>c.name==="claim_quest").length,1);
  f.runs.get(result.id).status="done";f.runs.get(result.id).stages=[{summary:"Verified quest change"}];
  t.mock.timers.tick(4000);
  await waitFor(()=>f.calls.some(c=>c.name==="complete_quest"));
  assert.equal(f.saved("chat-runs.json")[result.id].job.complete,true);
  assert.equal(f.calls.find(c=>c.name==="complete_quest").args.entry_id,"quest-result-note");
});

test("reopened quests create a new orchestrator while original request remains idempotent",async t=>{
  const f=fixture(t),input={quest:501,project:"project",requestId:randomUUID()};
  const first=await f.invoke(input);f.runs.get(first.id).status="failed";f.quest.state="open";
  const second=await f.invoke({...input,requestId:randomUUID()});
  assert.notEqual(first.id,second.id);assert.equal(f.created.length,2);
  assert.deepEqual(await f.invoke(input),first);
});

test("concurrent request reuse cannot create a quest for a different input",async t=>{
  const f=fixture(t),input={quest:501,project:"project",requestId:randomUUID()};
  const first=f.invoke(input),same=f.invoke(input);
  await assert.rejects(f.invoke({...input,quest:502}),/already belongs/);
  assert.deepEqual(await same,await first);assert.equal(f.created.length,1);
  await assert.rejects(f.invoke({...input,workspaceId:"ws-one"}),/already belongs/);
});

test("failed quest runs abandon their real claim through existing settlement",async t=>{
  t.mock.timers.enable({apis:["setInterval"]});
  const f=fixture(t),result=await f.invoke({quest:501,project:"project",requestId:randomUUID()});
  f.runs.get(result.id).status="failed";
  t.mock.timers.tick(4000);
  await waitFor(()=>f.calls.some(c=>c.name==="abandon_quest"));
  assert.equal(f.saved("chat-runs.json")[result.id].job.complete,true);
  assert.equal(f.quest.state,"open");
  assert.equal(f.calls.filter(c=>c.name==="dispatch_quest").length,0);
});
