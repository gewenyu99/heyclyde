import assert from 'node:assert/strict';
import test from 'node:test';
import {needsRecall,recallPacket} from '../shared/recall.ts';
test('new work and changes recall, a continuation reuses available context',()=>{
  assert.ok(needsRecall('continue',false));assert.ok(!needsRecall('continue',true));
  assert.ok(needsRecall('continue with the new repo',true));assert.ok(needsRecall('what did we decide?',true));
});
test('Clyde cards retain authorized bodies and text-only providers still display titles',()=>{
  assert.equal(recallPacket({retrieval_id:'stored',items:[{id:'one',title:'Decision',body:'Evidence'}]},'').items[0].body,'Evidence');
  const id='12345678-1234-1234-1234-1234567890ab';
  assert.deepEqual(JSON.parse(JSON.stringify(recallPacket(null,'retrieval '+id+'\n\n[T1] new-note: Project decision'))),{retrieval_id:id,items:[{id:'new-note',title:'Project decision'}]});
});
