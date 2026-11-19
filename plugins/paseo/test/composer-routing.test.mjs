import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
const require=createRequire(import.meta.url), ts=require('typescript');
const compiled=ts.transpileModule(readFileSync(new URL('../client/composer.tsx',import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const stateModule={exports:{}};
const stateCode=ts.transpileModule(readFileSync(new URL('../client/board-state.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
new Function('require','module','exports',stateCode)(name=>name==='@getpaseo/plugin'?{defineSettings:value=>value}:name==='@getpaseo/plugin/client'?{}:name==='../shared/clyde'?{workerModels:['auto','sol','sonnet','opus','astra','neon']}:require(name),stateModule,stateModule.exports);
let generated=0;
const projects=[{id:'repo-a',name:'Alpha',path:'/alpha',chats:[]},{id:'repo-b',name:'Beta',path:'/beta',chats:[]}];
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
function ui(props={}){
  let hooks=[],slot=0,effects=[],tree,changes=[],suggestions=[],launches=[],launchError;
  const listeners=new Set(), query={data:structuredClone(projects),status:'success',fetchStatus:'idle',isInvalidated:false,dataUpdatedAt:1};
  const allQuery={...query,data:structuredClone(projects)};
  const queryFor=key=>props.workspaceId && key?.[2]==='all'?allQuery:query;
  const react={useState(initial){const at=slot++;if(!(at in hooks))hooks[at]=typeof initial==='function'?initial():initial;return [hooks[at],value=>{hooks[at]=typeof value==='function'?value(hooks[at]):value;}];},useRef(initial){const at=slot++;return hooks[at]??=( {current:initial});},useEffect(fn,deps){const at=slot++,old=hooks[at];if(!old || deps.some((value,i)=>value!==old.deps[i])){effects.push(()=>{old?.cleanup?.();hooks[at]={deps,cleanup:fn()};});}}};
  const cache={getQueryState:key=>queryFor(key),getQueryCache:()=>({subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}}),invalidateQueries:async()=>{}};
  const rpc={launch:async arg=>{launches.push(arg);if(launchError)throw Error(launchError);return {id:'run'};},suggest:arg=>{const next=defer();suggestions.push({...next,arg});return next.promise;}};
  const theme={colors:new Proxy({},{get:()=> '#555555'})};
  const mocks={'./board-state':stateModule.exports,'./add-project':{AddProject:()=>null},react,'react-native':{Pressable:'Pressable',Text:'Text',TextInput:'TextInput',View:'View'},'@getpaseo/plugin/client':{useRpc:contract=>rpc[contract.name]},'@tanstack/react-query':{useQuery:options=>{const q=queryFor(options.queryKey);return {...q,isFetching:q.fetchStatus==='fetching',isError:q.status==='error',isSuccess:q.status==='success',refetch:async()=>{}};},useQueryClient:()=>cache},'../shared/clyde':{launchRpc:{name:'launch'},suggestProjectRpc:{name:'suggest'},projectsRpc:{name:'projects'},workerModels:['auto','neon']},'./brand.generated':{palette:{light:{edge:'#555555'}}},'./palette':{formatRpcError:e=>e.message,MIN_HIT_HEIGHT:44,scheme:()=> 'light'},'./request-id':{requestId:()=> 'id-'+(++generated)}};
  const module={exports:{}};new Function('require','module','exports',compiled)(name=>name in mocks?mocks[name]:require(name),module,module.exports);
  const all=node=>!node || typeof node!=='object'?[]:[node,...[node.props?.children].flat(Infinity).flatMap(all)];
  const text=node=>node==null?'':typeof node==='string'||typeof node==='number'?String(node):[node.props?.children].flat(Infinity).map(text).join('');
  const render=()=>{slot=0;tree=module.exports.Composer({theme,board:true,onStarted:()=>{},...props,onDraftStateChange:update=>{const base=props.draftState??changes.at(-1)??stateModule.exports.emptyComposer(true);const next=typeof update==='function'?update(base):update;changes.push(next);if(props.draftState!==undefined)props.draftState=next;props.onDraftStateChange?.(update);}});const pending=effects;effects=[];pending.forEach(fn=>fn());return tree;};
  const button=label=>{const node=all(tree).find(node=>node.type==='Pressable'&&text(node)===label);assert.ok(node,'button '+label);return node;};
  const click=label=>{const node=button(label);assert.ok(!node.props.disabled,'enabled '+label);node.props.onPress();render();};
  const draft=value=>{all(tree).find(node=>node.type==='TextInput'&&node.props.accessibilityLabel==='Task instructions').props.onChangeText(value);render();};
  const changeRegistry=(kind='invalidate')=>{query.dataUpdatedAt++;query.isInvalidated=kind==='invalidate';listeners.forEach(listener=>listener({type:'updated',action:{type:kind},query:{queryKey:['clyde','projects',props.workspaceId??'all']}}));render();};
  render();return {render,click,button,draft,suggestions,launches,query,allQuery,changeRegistry,changes,unmount:()=>hooks.forEach(hook=>hook?.cleanup?.()),contents:()=>text(tree),setLaunchError:value=>{launchError=value;}};
}

test('Auto routes only on action, shows project and reason, then requires a separate launch',async()=>{
  const h=ui();h.draft('Fix Beta routing');assert.equal(h.suggestions.length,0);
  h.click('Choose project');assert.equal(h.launches.length,0);assert.equal(h.suggestions[0].arg.prompt,'Fix Beta routing');
  h.suggestions[0].resolve({projectId:'repo-b',reason:'The request names Beta routing.'});await flush();h.render();
  assert.match(h.contents(),/Auto chose Beta\. The request names Beta routing\./);
  h.click('Start task');await flush();assert.equal(h.launches[0].project,'repo-b');assert.equal(h.launches[0].newChat,true);
});

test('editing draft cancels an in-flight and an already resolved Auto target',async()=>{
  const h=ui();h.draft('Alpha fix');h.click('Choose project');h.draft('Beta fix');
  h.suggestions[0].resolve({projectId:'repo-a',reason:'Alpha'});await flush();h.render();
  assert.equal(h.launches.length,0);assert.doesNotMatch(h.contents(),/Auto chose/);
  h.click('Choose project');h.suggestions[1].resolve({projectId:'repo-b',reason:'Beta'});await flush();h.render();
  h.draft('Now Alpha');assert.doesNotMatch(h.contents(),/Auto chose/);h.button('Choose project');
});

test('manual selection wins over a delayed Auto response',async()=>{
  const h=ui();h.draft('Fix this');h.click('Choose project');h.click('Project · Auto ▾');
  const alpha=h.button('Alpha/alpha');alpha.props.onPress();h.render();
  h.suggestions[0].resolve({projectId:'repo-b',reason:'Beta'});await flush();h.render();
  h.click('Start task');await flush();assert.equal(h.launches[0].project,'repo-a');
});

test('unrelated invalidations and refetches preserve pending and resolved Auto choices',async()=>{
  const h=ui();h.draft('Fix Alpha');h.click('Choose project');h.changeRegistry();h.query.isInvalidated=false;
  h.suggestions[0].resolve({projectId:'repo-a',reason:'Alpha'});await flush();h.render();assert.match(h.contents(),/Auto chose Alpha/);
  const start=h.button('Start task').props.onPress;
  h.query.data.reverse();h.changeRegistry('success');assert.match(h.contents(),/Auto chose Alpha/);
  start();await flush();assert.equal(h.launches[0].project,'repo-a');assert.equal(h.suggestions.length,1);
});

test('material project changes fence delayed suggestions and old launch callbacks',async()=>{
  const h=ui();h.draft('Fix Alpha');h.click('Choose project');
  h.query.data[0].path='/new-alpha';h.changeRegistry('success');
  h.suggestions[0].resolve({projectId:'repo-a',reason:'Alpha'});await flush();h.render();assert.doesNotMatch(h.contents(),/Auto chose/);
  h.click('Choose project');h.suggestions[1].resolve({projectId:'repo-a',reason:'Alpha'});await flush();h.render();
  const oldStart=h.button('Start task').props.onPress;
  h.query.data[0].slug='new/alpha';h.changeRegistry('success');oldStart();await flush();assert.equal(h.launches.length,0);
});

test('abstention, unknown project IDs and RPC failures require explicit manual selection',async()=>{
  for(const result of [{reason:'Not enough context.'},{projectId:'missing',reason:'Unknown'}]){
    const h=ui();h.draft('Fix it');h.click('Choose project');h.suggestions[0].resolve(result);await flush();h.render();
    assert.match(h.contents(),/Choose a project ▾/);assert.equal(h.button('Start task').props.disabled,true);assert.equal(h.launches.length,0);
  }
  const h=ui();h.draft('Fix it');h.click('Choose project');h.suggestions[0].reject(Error('offline'));await flush();h.render();
  assert.match(h.contents(),/Select one manually/);assert.equal(h.button('Start task').props.disabled,true);
});

test('workspace stays pinned and a failed launch reuses its request ID',async()=>{
  const h=ui({workspaceId:'workspace-a'});h.query.data=[structuredClone(projects[0])];h.render();h.draft('Fix Alpha');
  h.setLaunchError('temporary');h.click('Start task');await flush();h.render();h.click('Start task');await flush();
  assert.equal(h.suggestions.length,0);assert.equal(h.launches[0].workspaceId,'workspace-a');assert.equal(h.launches[0].project,'repo-a');
  assert.equal(h.launches[0].requestId,h.launches[1].requestId);
});

test('rapid duplicate Choose actions make one request and registry replacement cannot use an old Start callback',async()=>{
  const h=ui();h.draft('Fix Alpha');const choose=h.button('Choose project').props.onPress;
  choose();choose();h.render();assert.equal(h.suggestions.length,1);
  h.suggestions[0].resolve({projectId:'repo-a',reason:'Alpha'});await flush();h.render();
  const oldStart=h.button('Start task').props.onPress;
  h.query.data=[structuredClone(projects[1])];h.changeRegistry('success');oldStart();await flush();
  assert.equal(h.launches.length,0);assert.doesNotMatch(h.contents(),/Auto chose/);
});


test('restored Auto selection and complete form remain usable after remount',async()=>{
  const h=ui();h.draft('Fix Beta');h.click('Choose project');h.suggestions[0].resolve({projectId:'repo-b',reason:'Beta routing'});await flush();h.render();
  const saved={...h.changes.at(-1),doneWhen:'Restore everything',showCriteria:true,flow:'ship',worker:'neon',selectedWorkspace:'chosen-workspace'};h.unmount();
  const restored=ui({draftState:saved});restored.query.data[1].workspaces=[{id:'chosen-workspace',name:'Chosen workspace',path:'/beta/chosen'}];restored.render();assert.match(restored.contents(),/Auto chose Beta/);assert.equal(restored.button('Start planning').props.disabled,false);assert.equal(restored.suggestions.length,0);
  restored.draft('Different task');assert.equal(restored.changes.at(-1).selectedWorkspace,'chosen-workspace');assert.doesNotMatch(restored.contents(),/Auto chose/);
});
test('pending launch idempotency survives composer removal and client reload',async()=>{
  const h=ui({workspaceId:'workspace-a'});h.query.data=[structuredClone(projects[0])];h.render();h.draft('Fix Alpha');h.setLaunchError('temporary');h.click('Start task');await flush();h.render();
  const saved=structuredClone(h.changes.at(-1)),id=h.launches[0].requestId;assert.equal(saved.pendingRequest.id,id);h.unmount();
  const restored=ui({workspaceId:'workspace-a',draftState:saved});restored.query.data=[structuredClone(projects[0])];restored.render();restored.click('Start task');await flush();
  assert.equal(restored.launches[0].requestId,id);assert.equal(restored.changes.at(-1).text,'');assert.equal(restored.changes.at(-1).pendingRequest,null);
});
test('an old unmounted router cannot overwrite a newly reopened draft',async()=>{
  const h=ui();h.draft('Old task');h.click('Choose project');const changes=h.changes.length;h.unmount();
  h.suggestions[0].resolve({projectId:'repo-a',reason:'Old result'});await flush();assert.equal(h.changes.length,changes);
});



const folderRow={id:'folder',name:'work-code',label:'work-code',kind:'non_git',eligible:true,path:'/work-code',chats:[],workspaces:[{id:'folder-ws',name:'Folder workspace',path:'/work-code'}]};
const selectFolder=h=>{h.query.data=[structuredClone(folderRow)];h.render();h.draft('Work in this directory');h.click('Project · Auto ▾');h.click('work-code/work-code');};
test('selecting a directory launches that exact project root without choosing a child or workspace',async()=>{
  const h=ui();selectFolder(h);assert.equal(h.button('Start task').props.disabled,false);h.click('Start task');await flush();
  assert.equal(h.launches[0].project,'folder');assert.equal(h.launches[0].workspaceId,undefined);assert.equal(h.launches[0].newChat,true);
  assert.doesNotMatch(h.contents(),/repository in this folder|Repository ·/);
});
test('pinned directory tab shows the actual workspace name and sends its exact workspace and origin agent',async()=>{
  const h=ui({workspaceId:'folder-ws',agentId:'folder-agent'});h.query.data=[structuredClone(folderRow)];h.render();h.draft('Work here');
  assert.match(h.contents(),/Folder workspace/);assert.equal(h.button('Start task').props.disabled,false);h.click('Start task');await flush();
  assert.equal(h.launches[0].project,'folder');assert.equal(h.launches[0].workspaceId,'folder-ws');assert.equal(h.launches[0].agentId,'folder-agent');
});
test('multiple named workspaces remain optional and the exact saved choice survives return',async()=>{
  const h=ui();selectFolder(h);h.query.data[0].workspaces.push({id:'second',name:'Second workspace',path:'/other-workspace'});h.render();assert.equal(h.button('Start task').props.disabled,false);
  h.click('Project root ▾');h.click('Second workspace/other-workspace');const saved=structuredClone(h.changes.at(-1));h.unmount();
  const restored=ui({draftState:saved});restored.query.data=structuredClone(h.query.data);restored.render();
  assert.equal(restored.button('Start task').props.disabled,false);assert.match(restored.contents(),/Second workspace/);restored.click('Start task');await flush();assert.equal(restored.launches[0].workspaceId,'second');
  restored.draft('Back at root');restored.click('Second workspace ▾');restored.click('Project root/work-code');restored.click('Start task');await flush();assert.equal(restored.launches[1].project,'folder');assert.equal(restored.launches[1].workspaceId,undefined);
});
test('Auto can select an existing directory even with legacy Git-only eligibility metadata',async()=>{
  const h=ui();h.query.data=[{...structuredClone(folderRow),eligible:false,ineligibleReason:'Registered folder. Git required.'}];h.render();h.draft('Work in work-code');h.click('Choose project');h.suggestions[0].resolve({projectId:'folder',reason:'The requested directory'});await flush();h.render();
  assert.match(h.contents(),/Auto chose work-code/);h.click('Start task');await flush();assert.equal(h.launches[0].project,'folder');assert.equal(h.launches[0].workspaceId,undefined);
});
test('a stale explicit workspace choice does not silently reroute to the project root',async()=>{
  const saved={...stateModule.exports.emptyComposer(),project:'folder',selectedWorkspace:'removed',text:'Keep my location'};
  const h=ui({draftState:saved});h.query.data=[structuredClone(folderRow)];h.render();assert.equal(h.button('Start task').props.disabled,true);
  h.click('Choose workspace ▾');h.click('Project root/work-code');h.click('Start task');await flush();assert.equal(h.launches[0].workspaceId,undefined);
});
test('composer has no nested repository selection dependency',()=>{
  const source=readFileSync(new URL('../client/composer.tsx',import.meta.url),'utf8');assert.doesNotMatch(source,/FolderRepositories|chooseRepository|repositoryProjects|folderProject|folderId/);
});
