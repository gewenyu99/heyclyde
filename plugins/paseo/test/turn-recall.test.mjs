import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {residents} from '../server/residents.ts';
import {nativeRecall} from '../shared/recall.ts';

test('a normal chat turn automatically emits a nonempty recall card without the agent calling a tool',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'clyde-turn-'));
  const old=Object.fromEntries(['CLYDE_HOME','CLYDE_CONFIG_DIR','PASEO_HOME'].map(k=>[k,process.env[k]]));
  Object.assign(process.env,{CLYDE_HOME:dir,CLYDE_CONFIG_DIR:dir,PASEO_HOME:dir});
  for(const [file,value] of Object.entries({token:'fixture',url:'http://localhost','server-id':'fixture'}))writeFileSync(join(dir,file),value)
  const handlers=new Map(),hooks=new Map(), cards=[], original=globalThis.fetch;
  const plugin=residents({addHook:(name,fn)=>hooks.set(name,fn),handle:(r,fn)=>handlers.set(r.name,fn)});
  let empty=false,recallCount=0,seq=1,text='Which repository owns Clyde?';
  const agent={id:'owner',cwd:dir,provider:'codex',title:'Repo work',background:false,parentAgentId:null};
  const timeline={refetch:async()=>({entries:[{seqStart:seq,item:{type:'user_message',text}}]}),append:async c=>cards.push(c)};
  const paseo={agents:{ref:()=>({timeline,refresh:async()=>{},current:()=>agent})}};
  globalThis.fetch=async (_,opts)=>{
    const req=JSON.parse(opts.body), tool=req.params.name;
    if(tool==='recall')recallCount++;
    return Response.json({result:{content:[{text:'OK'}],_meta:{'clyde/card':{retrieval_id:'packet-'+recallCount,items:empty?[]:[{id:'repo',title:'Use heyclyde',body:'Plugin and runtime live together.'}]}}}},{headers:{'mcp-session-id':'test'}});
  };
  try{
    await hooks.get('agent.turn.before')({agent},{paseo});
    assert.equal(recallCount,1);assert.equal(cards[0].data.notes[0].body,'Plugin and runtime live together.');
    await hooks.get('agent.turn.before')({agent},{paseo});assert.equal(recallCount,1);
    seq++;text='continue';await hooks.get('agent.turn.before')({agent},{paseo});assert.equal(recallCount,1);
    seq++;text='continue with a different release scope';await hooks.get('agent.turn.before')({agent},{paseo});assert.equal(recallCount,2);
    empty=true;seq++;text='Investigate the changed callback contract';
    const visible=cards.length;
    await hooks.get('agent.turn.before')({agent},{paseo});assert.equal(recallCount,3);assert.equal(cards.length,visible);
    seq++;text='oh like not wokring btw lol but good job';await hooks.get('agent.turn.before')({agent},{paseo});assert.equal(recallCount,3);
    await handlers.get('clyde.recall')({agent:agent.id,query:'Deliberately unmatched query'},{paseo});
    assert.equal(cards.length,visible+1);assert.equal(cards.at(-1).data.requested,true);assert.deepEqual(cards.at(-1).data.notes,[]);
  }finally{plugin.close();globalThis.fetch=original;for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v}}
});
test('native MCP tool output renders without asking the model to recall again',()=>{
  const result=nativeRecall('mcp__memory__recall',[{text:'retrieval 12345678-1234-1234-1234-1234567890ab\n\n[1] a: Use heyclyde'}]);
  assert.equal(result.items[0].title,'Use heyclyde');
  assert.equal(nativeRecall('mcp__unrelated__recall',[{text:'unrelated'}]),undefined);
});
