'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {readWorkspaceBillingOverview,requireSelectedBillingWorkspace}=require('../../src/billing/workspaceOverviewReadModel');

function fixture(results) {
  const history=[];
  let index=0;
  const connection={async query(sql,params) {
    history.push({sql,params});
    if(/START TRANSACTION|COMMIT|ROLLBACK/.test(sql)) return {rows:[]};
    const result=results[index++];
    if(result instanceof Error) throw result;
    return {rows:result || []};
  },release(){history.push({sql:'RELEASE'});}};
  return {pool:{async connect(){return connection;}},history};
}
const workspace=[{id:'ws-1',name:'Main office',status:'Active'}];
const account=[{status:'active',hold_reason:null}];
test('reads only live workspace pool credits with exact separate subscription and top-up balances',async()=>{
  const {pool,history}=fixture([workspace,account,[
    {grant_kind:'subscription',expires_at:'2026-11-01 00:00:00',asset:'INR',scale:2,balance_units:'9007199254740993',reserved_units:'3'},
    {grant_kind:'topup',expires_at:null,asset:'INR',scale:2,balance_units:'50000',reserved_units:'1000'},
  ]]);
  const result=await readWorkspaceBillingOverview('org-1','ws-1',{pool,now:new Date('2026-10-12T00:00:00Z')});
  assert.equal(result.balances[0].available.units,'9007199254740990');
  assert.equal(result.balances[1].available.units,'49000');
  assert.equal(result.workspaceName,'Main office');
  assert.equal(result.recentPayments,undefined);
  const query=history.find(item=>item.sql.includes('billing_credit_positions'));
  assert.deepEqual(query.params,['org-1','ws-1','2026-10-12T00:00:00.000Z','2026-10-12T00:00:00.000Z']);
  for(const fragment of ["a.account_type='workspace'","a.owner_id=?","a.account_purpose='pool'","g.effective_at<=?","g.expires_at>?"]) assert.ok(query.sql.includes(fragment));
  assert.ok(history.some(item=>item.sql==='COMMIT'));
  assert.equal(history.at(-1).sql,'RELEASE');
});
test('missing ledger reports pending setup without legacy or organization balances',async()=>{
  const {pool,history}=fixture([workspace,[]]);
  const result=await readWorkspaceBillingOverview('org-1','ws-1',{pool});
  assert.equal(result.uninitialized,true);
  assert.deepEqual(result.balances,[]);
  assert.ok(!history.some(item=>item.sql.includes('billing_credit_positions')));
});
test('workspace lookup is scoped to organization and rejects a missing workspace',async()=>{
  const {pool,history}=fixture([[]]);
  assert.equal(await readWorkspaceBillingOverview('org-1','ws-1',{pool}),null);
  assert.deepEqual(history[1].params,['org-1','ws-1']);
});
test('rolls back and releases after a read failure',async()=>{
  const {pool,history}=fixture([workspace,account,new Error('Read failed')]);
  await assert.rejects(readWorkspaceBillingOverview('org-1','ws-1',{pool}),/Read failed/);
  assert.ok(history.some(item=>item.sql==='ROLLBACK'));
  assert.equal(history.at(-1).sql,'RELEASE');
});
test('route rejects viewing another workspace even in the same organization',()=>{
  let code,body,called=false;
  const res={status(value){code=value;return this;},json(value){body=value;}};
  requireSelectedBillingWorkspace({workspaceId:'ws-1',params:{workspaceId:'ws-2'}},res,()=>{called=true;});
  assert.equal(code,403);
  assert.ok(body.error);
  assert.equal(called,false);
  requireSelectedBillingWorkspace({workspaceId:'ws-1',params:{workspaceId:'ws-1'}},res,()=>{called=true;});
  assert.equal(called,true);
});
