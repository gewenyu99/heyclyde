import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
const require=createRequire(import.meta.url),ts=require('typescript');
const compiled=ts.transpileModule(readFileSync(new URL('../client/orchestration-flow.tsx',import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const module={exports:{}};
new Function('require','module','exports',compiled)(name=>name==='react-native'?{Pressable:'Pressable',ScrollView:'ScrollView',Text:'Text',View:'View'}:name==='./palette'?{}:require(name),module,module.exports);
const {orchestrationNodes,orchestrationBands,bandFlowLayout,flowLayout,flowEdgeKind}=module.exports;
const piece=(id,phase,status='pending',extra={})=>({id,title:id==='PLAN'?'Plan the work':id==='S1'?'Implement routing':id,status,phases:[{stage:phase,label:phase,status}],...extra});
const view=(pieces,attempts={})=>({steps:[{name:'Actual work',pieces}],attempts,approve:false});
test('planning shows the real plan and explicit future approval/build/review, without invented completion',()=>{
  const nodes=orchestrationNodes(view([piece('PLAN','plan','running')],{plan:[{n:1}]}));
  assert.deepEqual(nodes.map(node=>node.title),['Plan','Approve','Build','Review']);
  assert.equal(nodes[0].stage,'plan');assert.equal(nodes[0].observed,true);
  assert.ok(nodes.slice(1).every(node=>!node.observed && node.status===undefined && node.stage===undefined));
});
test('approval reflects the actual question and planned slices replace the generic Build outline',()=>{
  const v=view([piece('PLAN','plan','passed'),piece('S1','code-it-works:slice-1'),piece('REVIEW','review')],{plan:[{n:1}]});v.approve=true;
  const nodes=orchestrationNodes(v);
  assert.equal(nodes[1].status,'asking');assert.equal(nodes[1].observed,true);
  assert.equal(nodes[2].title,'Build · Implement routing');assert.equal(nodes[2].observed,false);assert.equal(nodes[2].stage,'code-it-works:slice-1');
  assert.equal(nodes[3].stage,'review');assert.equal(nodes[3].status,'pending');
});
test('actual task nodes and current phases remain selectable without a fake ship lifecycle',()=>{
  const p=piece('TASK','build','running');p.phases.push({stage:'audit',label:'audit',status:'pending'});
  let nodes=orchestrationNodes(view([p],{build:[{n:1}]}));assert.equal(nodes.length,1);assert.equal(nodes[0].stage,'build');
  p.phases[0].status='passed';p.phases[1].status='running';nodes=orchestrationNodes(view([p],{build:[{n:1}],audit:[{n:1}]}));assert.equal(nodes[0].stage,'audit');
});
test('responsive connected rows preserve workflow order and stay inside the diagram bounds',()=>{
  for(const width of [220,390,620,1000]){
    const {positions,nodeWidth,nodeHeight,width:total,height}=flowLayout(7,width);
    assert.equal(positions.length,7);
    positions.forEach(p=>{assert.ok(p.x>=0 && p.x+nodeWidth<=total);assert.ok(p.y>=0 && p.y+nodeHeight<=height);});
    positions.slice(1).forEach((p,i)=>assert.ok(p.y===positions[i].y || p.x===positions[i].x,'each consecutive node has a direct orthogonal connector'));
  }
});

test('small desktop holds four lifecycle nodes in one row, and single tasks stay compact',()=>{
  const desktop=flowLayout(4,640);assert.equal(desktop.width<=640,true);assert.ok(desktop.positions.every(p=>p.y===0));
  const simple=flowLayout(1,640,true);assert.equal(simple.height,84);assert.equal(simple.nodeHeight,84);
});
test('approval gate shows an explicitly approved decision as Passed',()=>{
  const v=view([piece('PLAN','plan','passed')]);v.planApproval='passed';
  const gate=orchestrationNodes(v)[1];assert.equal(gate.status,'passed');assert.equal(gate.observed,true);assert.equal(gate.note,'Plan approved');
});
test('nodes surface worker, live action, attempts/sent-back meta, phases, and memory handoff edges',()=>{
  const plan=piece('PLAN','plan','passed',{rung:'claude · sonnet',attempts:2,sentBack:1,handoff:true,startedAt:'2026-11-19T10:00:00Z',endedAt:'2026-11-19T10:04:00Z'});
  const slice=piece('S1','code-it-works:s1','running',{
    rung:'codex · sol',progress:'Running unit tests',attempts:1,sentBack:0,handoff:false,
    phases:[
      {stage:'code-it-works:s1',label:'works',status:'passed'},
      {stage:'code-it-good:s1',label:'good',status:'running'},
      {stage:'code-it-clean:s1',label:'clean',status:'pending'},
    ],
  });
  const v=view([plan,slice],{plan:[{n:1},{n:2}],'code-it-good:s1':[{n:1}]});v.planApproval='passed';
  const nodes=orchestrationNodes(v);
  assert.equal(nodes[0].worker,'claude · sonnet');
  assert.equal(nodes[0].handoff,true);
  assert.equal(nodes[0].sentBack,1);
  assert.match(nodes[0].meta,/2 attempts · sent back 1 · 4 min/);
  assert.equal(nodes[2].worker,'codex · sol');
  assert.equal(nodes[2].action,'Running unit tests');
  assert.equal(nodes[2].phases.length,3);
  assert.equal(flowEdgeKind(nodes[0],nodes[1]),'memory');
  assert.equal(flowEdgeKind(nodes[1],nodes[2]),'live');
  assert.equal(flowEdgeKind(nodes[2],{id:'ask',title:'Ask',status:'asking',observed:true}),'ask');
  assert.equal(flowEdgeKind(nodes[2],nodes[3]),'order');
});
test('multi-band giant flow layout stacks step bands with left label gutters and 8px-grid cells',()=>{
  const plan=piece('PLAN','plan','passed',{rung:'claude · opus',handoff:true});
  const s1=piece('S1','code-it-works:s1','passed',{rung:'claude · sonnet'});
  const s2=piece('S2','code-it-works:s2','running',{rung:'codex · sol',progress:'Writing tests'});
  const s3=piece('S3','code-it-works:s3','pending');
  const s4=piece('S4','code-it-works:s4','pending');
  const review=piece('REVIEW','review','pending');
  const v=view([plan,s1,s2,s3,s4,review],{plan:[{n:1}]});v.planApproval='passed';
  const bands=orchestrationBands(v);
  assert.equal(bands.length,4);
  assert.equal(bands[0].name,'Plan & approve');
  assert.equal(bands[1].name,'Build · Slices 1–3');
  assert.equal(bands[2].name,'Build · Slice 4');
  assert.equal(bands[3].name,'Verify & review');
  const layout=bandFlowLayout(bands,800);
  assert.ok(layout.height > 1000,'multi-band giant graph stacks bands vertically');
  assert.equal(layout.positions.size,7);
  assert.ok(layout.positions.get('S1').y > layout.positions.get('PLAN').y);
  assert.ok(layout.positions.get('S4').y > layout.positions.get('S1').y);
  assert.ok(layout.positions.get('REVIEW').y > layout.positions.get('S4').y);
});
