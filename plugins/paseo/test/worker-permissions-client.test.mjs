import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function ui(){
  let store,cursor;
  const jsx=(type,props)=>({type,props});
  const useState=initial=>{const target=store,index=cursor++;if(!(index in target))target[index]=initial;return [target[index],value=>{target[index]=typeof value==='function'?value(target[index]):value;}];};
  const useRef=initial=>useState({current:initial})[0];
  const response=Promise.withResolvers(),calls=[];
  const query={dataUpdatedAt:10,data:{agentId:'worker',requests:[]},isPending:false,isFetching:false,refetch:async()=>{calls.push('refetch');}};
  const modules={
    'react/jsx-runtime':{jsx,jsxs:jsx},'react':{useState,useRef,useEffect:()=>{}},
    'react-native':{Text:'Text',View:'View',Pressable:'Pressable'},
    '@getpaseo/plugin/client':{useRpc:contract=>contract.name==='respond'?async args=>{calls.push(args);await response.promise;}:async()=>query.data},
    '@tanstack/react-query':{useQuery:()=>query,useQueryClient:()=>({invalidateQueries:async()=>{calls.push('invalidate');}})},
    '../shared/clyde':{workerPermissionsRpc:{name:'read'},respondWorkerPermissionRpc:{name:'respond'}},
    './palette':{formatRpcError:e=>e.message,MIN_HIT_HEIGHT:44},
  };
  const source=readFileSync(new URL('../client/worker-permissions.tsx',import.meta.url),'utf8');
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,exports={};
  new Function('require','exports',output)(name=>modules[name]??{},exports);
  const render=(component,props,state=[])=>{store=state;cursor=0;return component(props);};
  const theme={colors:{foreground:'#111',foregroundMuted:'#333',surface1:'#fff',surface2:'#eee',border:'#ccc',accent:'#123',accentForeground:'#fff',statusDanger:'#800'}};
  return {root:exports.WorkerPermissions,query,response,calls,theme,render};
}
function elements(node,predicate){if(!node||typeof node!=='object')return [];if(Array.isArray(node))return node.flatMap(n=>elements(n,predicate));return [...(predicate(node)?[node]:[]),...elements(node.props?.children,predicate)];}
function text(node){if(typeof node==='string')return node;if(Array.isArray(node))return node.map(text).join('\n');return node&&typeof node==='object'?text(node.props?.children):'';}

test('Bash permission renders one full command, direct choices and accurate pending/submission/resolution states',async t=>{
  t.mock.method(Date,'now',()=>1000);
  const f=ui(),command='ls -la /workspace/heyclyde/{plugins/paseo,plugins/paseo/client}';
  f.query.data.requests=[{id:'request',revision:'v1',kind:'tool',name:'Bash',title:'Run shell command',description:'List the plugin folders.\nBrace expansion',input:command+'\n\nWorking directory: /workspace/heyclyde',options:[{id:'allow-once',label:'Allow once',behavior:'allow',variant:'primary'},{id:'deny',label:'Deny',behavior:'deny',variant:'danger'}]}];
  const rootState=[],requestState=[],props={theme:f.theme,runId:'run',onPending:()=>{}};
  const root=()=>f.render(f.root,props,rootState);
  let request=elements(root(),node=>typeof node.type==='function')[0];
  const card=()=>f.render(request.type,request.props,requestState);
  let view=card();
  assert.match(text(view),/Awaiting your decision/);assert.equal(text(view).split(command).length-1,1);
  assert.deepEqual(elements(view,node=>node.type==='Pressable').map(n=>n.props.accessibilityLabel),['Allow once','Deny']);
  elements(view,node=>node.props?.accessibilityLabel==='Allow once')[0].props.onPress();
  view=card();assert.match(text(view),/Sending your response/);
  assert.ok(elements(view,node=>node.type==='Pressable').every(n=>n.props.disabled));
  elements(view,node=>node.props?.accessibilityLabel==='Deny')[0].props.onPress();
  assert.equal(f.calls.filter(c=>typeof c==='object').length,1,'duplicate click is ignored');
  f.response.resolve();await new Promise(setImmediate);
  view=card();assert.match(text(view),/Response sent. Checking whether the request is resolved/);
  request={...request,props:{...request.props,observedAt:2000}};
  assert.match(text(card()),/Paseo still shows this request as pending/);
  f.query.data.requests=[];
  assert.match(text(root()),/No pending worker permission requests/);
  assert.doesNotMatch(text(root()),/worker can continue/);
});

test('truncated permission input exposes native review and no Allow action',()=>{
  const f=ui();
  f.query.data.requests=[{id:'request',revision:'v1',kind:'tool',name:'Bash',title:'Run shell command',input:'partial command\n[truncated]',options:[],unsupported:'Open the worker in Paseo to answer this request.'}];
  const root=f.render(f.root,{theme:f.theme,runId:'run',onPending:()=>{},openAgent:()=>{}},[]);
  const request=elements(root,node=>typeof node.type==='function')[0],card=f.render(request.type,request.props,[]);
  assert.match(text(card),/Review permission in Paseo/);
  assert.doesNotMatch(text(card),/Allow once|Awaiting your decision/);
});
