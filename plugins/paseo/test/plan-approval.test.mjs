import assert from 'node:assert/strict';
import test from 'node:test';
import { planApprovalStatus } from '../server/shape.ts';
const stage={name:'plan',startedAt:'2026-11-19T10:00:00Z'},ask={kind:'approve',question:'Approve the plan for run r?',askedAt:'2026-11-19T10:05:00Z'};
test('plan approval uses the latest explicit decision and preserves conditions as changes',()=>{
  assert.equal(planApprovalStatus({stages:[stage],asks:[]}),undefined);
  assert.equal(planApprovalStatus({stages:[stage],asks:[ask]}),'asking');
  assert.equal(planApprovalStatus({stages:[stage],asks:[{...ask,answer:'Approved!'}]}),'passed');
  assert.equal(planApprovalStatus({stages:[stage],asks:[{...ask,answer:'Approved, but rename it'}]}),'sent-back');
  assert.equal(planApprovalStatus({stages:[stage],asks:[{...ask,answer:'yes'},{...ask,askedAt:'2026-11-19T10:06:00Z'}]}),'asking');
});
test('an older approval cannot approve a newer planning round',()=>{
  assert.equal(planApprovalStatus({stages:[stage,{name:'plan-2',startedAt:'2026-11-19T10:10:00Z'}],asks:[{...ask,answer:'yes'}]}),undefined);
  assert.equal(planApprovalStatus({stages:[stage],asks:[{...ask,kind:'provider',answer:'yes'}]}),undefined);
});
