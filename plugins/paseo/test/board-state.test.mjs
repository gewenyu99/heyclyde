import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
const require=createRequire(import.meta.url),ts=require('typescript'),module={exports:{}};
const code=ts.transpileModule(readFileSync(new URL('../client/board-state.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
new Function('require','module','exports',code)(name=>name==='@getpaseo/plugin'?{defineSettings:value=>value}:name==='@getpaseo/plugin/client'?{}:name==='../shared/clyde'?{workerModels:['auto','sol','sonnet','opus','astra','neon']}:require(name),module,module.exports);
const {BoardStateSession,emptyBoard,emptyComposer,composerDraftSchema,boardSettings,boardSettingsId}=module.exports;
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const scope='["host-a","workspace","workspace-1"]';
function store(initial=emptyBoard(true)){
  const service={doc:{scope,board:structuredClone(initial)},revision:0,writes:[],session:null,fail:false,hold:null};
  service.driver=()=>({status:'ready',revision:String(service.revision),values:structuredClone(service.doc),saveError:null,
    save:async(doc,revision)=>{service.writes.push(structuredClone(doc));if(service.hold)await service.hold;if(service.fail || revision!==String(service.revision))return false;service.doc=structuredClone(doc);service.revision++;service.session?.observe(service.driver());return true;},
    reload:async()=>{service.session?.observe(service.driver());}});
  return service;
}
function attach(service,tab,initialTask){const session=new BoardStateSession(scope,true);service.session=session;session.observe(service.driver(),tab,initialTask);return session;}

test('device settings scope isolates hosts and workspaces and safely defaults new composer fields',()=>{
  const definition=boardSettings(scope,true);assert.equal(definition.scope,'device');assert.equal(definition.version,1);
  assert.equal(definition.schema.parse(undefined).board.composer.selectedWorkspace,'');
  assert.notEqual(boardSettingsId(scope),boardSettingsId('["host-b","workspace","workspace-1"]'));
  assert.notEqual(boardSettingsId(scope),boardSettingsId('["host-a","workspace","workspace-2"]'));
  assert.equal(boardSettingsId(scope),boardSettingsId(scope));
  assert.equal(definition.schema.safeParse({scope:'different',board:emptyBoard()}).success,false);
});
test('reload restores full navigation, composer, Auto result, pending launch and unsent per-run supervisor drafts',async()=>{
  const service=store(),session=attach(service);
  const composer={...emptyComposer(true),text:'Fix navigation',doneWhen:'Back preserves the draft\nReload restores it',flow:'ship',project:'repo-a',selectedWorkspace:'worktree-3',worker:'astra',showCriteria:true,mode:'auto',suggestion:{projectId:'repo-a',reason:'Owns navigation',prompt:'Fix navigation',revision:4,catalogue:'catalogue'},pendingRequest:{id:'request-1',key:'same-launch'}};
  session.update({picked:'run:one',tab:'quests',newTask:true,mobilePane:'chat',composer,supervisorDrafts:{one:'Why was this rejected?',two:'Unsent second draft'}});await flush();
  const restored=attach(service);
  assert.equal(restored.snapshot.value.picked,'run:one');assert.equal(restored.snapshot.value.tab,'quests');assert.equal(restored.snapshot.value.newTask,true);assert.equal(restored.snapshot.value.mobilePane,'chat');
  assert.deepEqual(restored.snapshot.value.composer,composer);assert.deepEqual(restored.snapshot.value.supervisorDrafts,{one:'Why was this rejected?',two:'Unsent second draft'});
  restored.update(previous=>({...previous,composer:{...previous.composer,selectedWorkspace:''}}));await flush();
  assert.equal(attach(service).snapshot.value.composer.selectedWorkspace,'');
});
test('explicit Back stays cleared after reload even if the old deep-link parameter remains',async()=>{
  const service=store(),session=attach(service,undefined,'run:deep-link');await flush();assert.equal(session.snapshot.value.picked,'run:deep-link');
  session.update({picked:'',tab:'board'});await flush();assert.equal(attach(service,undefined,'run:deep-link').snapshot.value.picked,'');
  service.session.observe(service.driver(),undefined,'run:different');assert.equal(service.session.snapshot.value.picked,'run:different');
});
test('settings hydration gates edits and legacy native tab selection migrates without dropping saved drafts',async()=>{
  const saved={...emptyBoard(true),composer:{...emptyComposer(true),text:'Already saved',selectedWorkspace:'saved-workspace'},modifiedAt:10};
  const service=store(saved),session=new BoardStateSession(scope,true);service.session=session;
  session.observe({status:'loading',save:async()=>false,reload:async()=>{}});session.update({picked:'run:wrong'});
  assert.equal(session.snapshot.ready,false);assert.equal(service.writes.length,0);
  session.observe(service.driver(),{state:'run:older',setState:()=>{}});assert.equal(session.snapshot.value.composer.text,'Already saved');assert.equal(session.snapshot.value.picked,'');
  const legacy=store(),migrated=attach(legacy,{state:'run:legacy',setState:()=>{}});await flush();assert.equal(migrated.snapshot.value.picked,'run:legacy');assert.equal(legacy.doc.board.picked,'run:legacy');
});
test('queued writes preserve the newest draft and native tab backup across close/reopen',async()=>{
  const service=store(),tab={state:null,setState(value){this.state=structuredClone(value);}},session=attach(service,tab);
  let release;service.hold=new Promise(resolve=>{release=resolve;});
  session.update(previous=>({...previous,composer:{...previous.composer,text:'first'}}));
  session.update(previous=>({...previous,newTask:true,composer:{...previous.composer,text:'newest',selectedWorkspace:'chosen'}}));
  assert.equal(service.writes.length,1);assert.equal(tab.state.composer.text,'newest');
  service.hold=null;release();await flush();assert.equal(service.doc.board.composer.text,'newest');assert.equal(service.doc.board.composer.selectedWorkspace,'chosen');
  assert.equal(attach(service,tab).snapshot.value.newTask,true);
});
test('a failed device write keeps the local draft and can be retried without resetting it',async()=>{
  const service=store(),session=attach(service);service.fail=true;
  session.update(previous=>({...previous,composer:{...previous.composer,text:'Keep this'}}));await flush();
  assert.match(session.snapshot.error,/save Clyde state/);assert.equal(session.snapshot.value.composer.text,'Keep this');
  service.fail=false;await session.retry();await flush();assert.equal(service.doc.board.composer.text,'Keep this');assert.equal(session.snapshot.error,'');
});

test('legacy staged child state restores the chosen directory itself and keeps the draft',()=>{
  const saved=composerDraftSchema.parse({...emptyComposer(),folderProject:'directory',project:'child-repo',selectedWorkspace:'child-checkout',text:'Keep this prompt'});
  assert.equal(saved.project,'directory');assert.equal(saved.selectedWorkspace,'');assert.equal(saved.text,'Keep this prompt');assert.equal('folderProject' in saved,false);
});
