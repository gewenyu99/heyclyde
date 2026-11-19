import assert from 'node:assert/strict';
import test from 'node:test';
import {needsRecall,recallPacket,usedNotes,usedFirst,nativeFeedback} from '../shared/recall.ts';
test('new work and changes recall, a continuation reuses available context',()=>{
  assert.ok(needsRecall('continue',false));assert.ok(!needsRecall('continue',true));
  assert.ok(needsRecall('continue with the new repo',true));assert.ok(needsRecall('what did we decide?',true));
});
test('Clyde cards retain authorized bodies and text-only providers still display titles',()=>{
  assert.equal(recallPacket({retrieval_id:'stored',items:[{id:'one',title:'Decision',body:'Evidence'}]},'').items[0].body,'Evidence');
  const id='12345678-1234-1234-1234-1234567890ab';
  assert.deepEqual(JSON.parse(JSON.stringify(recallPacket(null,'retrieval '+id+'\n\n[T1] new-note: Project decision'))),{retrieval_id:id,items:[{id:'new-note',title:'Project decision'}]});
});

test('acknowledged per-note usage sorts a stable group; a packet vote cannot create used stamps',()=>{
  const rows=[{id:'a'},{id:'b'},{id:'c'},{id:'d'}], args={retrieval_id:'r',entries:[{entry_id:'d',verdict:'used'},{entry_id:'c',verdict:'wrong'},{entry_id:'b',verdict:'used'}]};
  assert.deepEqual(usedFirst(rows,new Set(usedNotes(args,'Logged.'))).map(n=>n.id),['b','d','a','c']);
  assert.equal(usedNotes(args,'No retrieval r.'),undefined);
  assert.equal(usedNotes({card_vote:true,verdict:'helpful'},'Logged.'),undefined);
  assert.equal(usedNotes({verdict:'helpful'},'Logged.'),undefined);
  assert.deepEqual(usedNotes({nothing_useful:true},'Logged.'),[]);
  assert.equal(nativeFeedback('unrelated_feedback',{type:'unknown',input:args,output:'Logged.'}),undefined);
  assert.deepEqual(nativeFeedback('mcp__memory__feedback',{type:'unknown',input:args,output:{content:[{text:'Logged.'}]}})?.args,args);
});
test('native text packets preserve confidence, provenance and the actual body',()=>{
  const id='12345678-1234-1234-1234-1234567890ab';
  const {items}=recallPacket(null,'retrieval '+id+'\n\n[T2] n: Use the source\n    new · fact · unverified · 0.50 · chance 2 of 3\n    from codex on mac\n    Keep the original.\n\nAfter using these, call feedback.');
  assert.deepEqual(items,[{id:'n',title:'Use the source',kind:'fact',verified:false,confidence:.5,trial:true,chance:2,provenance:'from codex on mac',body:'Keep the original.'}]);
});
