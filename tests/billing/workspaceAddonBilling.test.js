'use strict';

jest.mock('../../src/billing/adapters/mysql/unitOfWork',()=>({createMysqlUnitOfWork:jest.fn()}));
const {createMysqlUnitOfWork} = require('../../src/billing/adapters/mysql/unitOfWork');
const {createTransactionContext} = require('../../src/billing/kernel/transactionContext');
const {createWorkspaceAddonBilling,monthBoundary} = require('../../src/billing/workspaceAddonBilling');
const {branchQuote,effectivePolicy} = require('../../src/workspaces/organizationPolicy');
process.env.MYSQL_HOST = '127.0.0.1';
process.env.MYSQL_USER = 'test';
process.env.MYSQL_DATABASE = 'test';
const {normalizeSql,closePool} = require('../../src/db/pool');
const policy = {mode:'same_industry',primaryIndustry:'lending',pricing:{baseMonthlyInr:1000,includedWorkspaces:5,maxWorkspaces:7,includedSeats:1,extraSeatMonthlyInr:0,extraWorkspaceMonthlyInr:50,additionalIndustryMonthlyInr:0}};
const existing = Array.from({length:5},(_,i)=>({id:`workspace-${i}`,industry:'lending'}));
const amount = {asset:'INR',units:'5000',scale:2};
const context = {operationId:'purchase-1',actor:{id:'owner'}};
let tx,client,pool,service,provision,now,addon,cycle,invoice;
beforeEach(()=>{
  now='2026-01-31T10:00:00.000Z';
  addon={id:'addon-1',org_id:'org-1',name:'Extra',industry:'lending',member_id:'member-1',status:'pending',workspace_id:null,monthly_units:'5000',auto_renew:1,terms_snapshot_json:JSON.stringify(policy)};
  cycle={id:'cycle-1',org_id:'org-1',addon_id:'addon-1',invoice_id:'invoice-1',cycle_index:0,paid_at:null,starts_at:null,ends_at:null};
  invoice={id:'invoice-1',org_id:'org-1',status:'open',total_units:'5000',paid_units:'0'};
  client={query:jest.fn(async(sql,params=[])=>{
    normalizeSql(sql,params); // Exercise the real adapter's placeholder checks.
    if(sql.includes('SELECT id,status,industry,settings FROM organizations'))return {rows:[{id:'org-1',status:'Active',industry:'lending',settings:{workspacePolicy:policy}}]};
    if(sql.includes('SELECT id,industry FROM workspaces'))return {rows:existing};
    if(sql.includes('COUNT(*) AS count FROM org_members'))return {rows:[{count:1}]};
    if(sql.includes('SELECT id FROM org_members'))return {rows:[{id:'member-1'}]};
    if(sql.includes('SELECT * FROM billing_workspace_addon_cycles'))return {rows:[cycle]};
    if(sql.includes('SELECT * FROM billing_workspace_addons'))return {rows:[addon]};
    if(sql.includes('SELECT * FROM billing_invoices'))return {rows:[invoice]};
    if(sql.includes('SELECT c.*,i.status AS invoice_status'))return {rows:[{...cycle,invoice_status:invoice.status}]};
    return {rows:[]};
  })};
  tx=createTransactionContext(client,{orgId:'org-1'});
  createMysqlUnitOfWork.mockReturnValue({runFinancial:async({callback})=>callback(tx),runLifecycle:async({callback})=>callback(tx)});
  pool={connect:jest.fn(),query:jest.fn(async()=>({rows:[]}))};
  provision=jest.fn(async()=>({id:'new-workspace'}));
  service=createWorkspaceAddonBilling({pool,clock:{now:()=>now},idSource:{newId:prefix=>`${prefix}-1`},provisionWorkspace:provision});
});
afterAll(async()=>{await closePool();});

test('purchase reserves an invoice at the server plan rate without provisioning or issuing usage credits',async()=>{
  const result=await service.createPurchase({orgId:'org-1',memberId:'member-1',context,input:{name:'Extra',industry:'lending',pricingAcceptanceToken:branchQuote(effectivePolicy({settings:{workspacePolicy:policy}},existing),existing,1).token,amountInr:'1'}});
  expect(result).toMatchObject({status:'pending',paymentAmount:amount,monthlyAmount:amount});
  expect(provision).not.toHaveBeenCalled();
  expect(client.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO billing_invoices'))).toBe(true);
  expect(client.query.mock.calls.some(([sql])=>sql.includes('billing_credit'))).toBe(false);
});
test('reserved purchases count against the hard workspace maximum',async()=>{
  const original=client.query.getMockImplementation();
  client.query.mockImplementation(async(sql,...args)=>sql.includes("SELECT id,name FROM billing_workspace_addons")?{rows:[{id:'a',name:'One'},{id:'b',name:'Two'}]}:original(sql,...args));
  await expect(service.createPurchase({orgId:'org-1',memberId:'member-1',context,input:{name:'Extra',industry:'lending',pricingAcceptanceToken:branchQuote(effectivePolicy({settings:{workspacePolicy:policy}},existing),existing,1).token}})).rejects.toMatchObject({statusCode:409});
  expect(client.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO billing_invoices'))).toBe(false);
});
test('only full approved payment provisions the workspace, and the first month begins on approval',async()=>{
  await expect(service.applyInvoicePayment(tx,{orgId:'org-1',invoiceId:'invoice-1',paymentRequestId:'payment-1',amount:{...amount,units:'4999'},now})).rejects.toMatchObject({code:'BILLING_PAYMENT_AMOUNT_MISMATCH'});
  expect(provision).not.toHaveBeenCalled();
  const result=await service.applyInvoicePayment(tx,{orgId:'org-1',invoiceId:'invoice-1',paymentRequestId:'payment-1',amount,now});
  expect(result).toMatchObject({workspaceId:'new-workspace',periodEndsAt:'2026-02-28T10:00:00.000Z'});
  const paidIndex=client.query.mock.calls.findIndex(([sql])=>sql.includes("UPDATE billing_invoices SET status='paid'"));
  expect(paidIndex).toBeGreaterThan(-1);
  expect(provision).toHaveBeenCalledWith(tx,'org-1',expect.objectContaining({name:'Extra'}),'member-1',{billingAddonId:'addon-1'});
  const invoiceTerms=client.query.mock.calls.find(([sql])=>sql.includes('UPDATE billing_workspace_addons SET workspace_id'))[1];
  expect(invoiceTerms[3]).toBe('2026-03-07T10:00:00.000Z');
});
test('a paid invoice cannot provision a second workspace',async()=>{
  cycle.paid_at=now;
  await expect(service.applyInvoicePayment(tx,{orgId:'org-1',invoiceId:'invoice-1',paymentRequestId:'payment-2',amount,now})).rejects.toMatchObject({statusCode:409});
  expect(provision).not.toHaveBeenCalled();
});
test('early renewal preserves the anniversary day across February',async()=>{
  addon={...addon,status:'active',workspace_id:'workspace-6',anchor_at:'2026-01-31T10:00:00.000Z',period_ends_at:'2026-02-28T10:00:00.000Z',grace_ends_at:'2026-03-07T10:00:00.000Z'};
  cycle={...cycle,cycle_index:1,starts_at:addon.period_ends_at,ends_at:monthBoundary(addon.anchor_at,2)};
  now='2026-02-22T10:00:00.000Z';
  const result=await service.applyInvoicePayment(tx,{orgId:'org-1',invoiceId:'invoice-1',paymentRequestId:'payment-2',amount,now});
  expect(result.periodEndsAt).toBe('2026-03-31T10:00:00.000Z');
  expect(provision).not.toHaveBeenCalled();
});
test('paying after grace restarts a fresh month without accumulating suspended-month charges',async()=>{
  addon={...addon,status:'suspended',workspace_id:'workspace-6',anchor_at:'2026-01-31T10:00:00.000Z',period_ends_at:'2026-02-28T10:00:00.000Z',grace_ends_at:'2026-03-07T10:00:00.000Z'};
  cycle={...cycle,cycle_index:1,starts_at:addon.period_ends_at,ends_at:'2026-03-31T10:00:00.000Z'};
  now='2026-06-10T10:00:00.000Z';
  const result=await service.applyInvoicePayment(tx,{orgId:'org-1',invoiceId:'invoice-1',paymentRequestId:'payment-2',amount,now});
  expect(result.periodEndsAt).toBe('2026-07-10T10:00:00.000Z');
  expect(provision).not.toHaveBeenCalled();
  expect(client.query.mock.calls.find(([sql])=>sql.includes("UPDATE workspaces SET status='Active'"))[0]).toContain("$.billingSuspended");
});
test('maintenance issues one renewal invoice before expiry and suspends overdue access after grace',async()=>{
  addon={...addon,status:'active',workspace_id:'workspace-6',anchor_at:now,period_ends_at:'2026-02-28T10:00:00.000Z',grace_ends_at:'2026-03-07T10:00:00.000Z',next_action_at:'2026-02-21T10:00:00.000Z'};
  cycle={...cycle,paid_at:now};invoice.status='paid';now='2026-02-21T10:00:00.000Z';
  pool.query.mockResolvedValue({rows:[{id:addon.id,org_id:addon.org_id,next_action_at:addon.next_action_at}]});
  expect((await service.runMaintenance()).results).toEqual([{id:'addon-1',suspended:false}]);
  expect(client.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO billing_workspace_addon_cycles'))[1]).toEqual(expect.arrayContaining(['2026-03-31T10:00:00.000Z']));
  client.query.mockClear();
  addon.next_action_at=addon.grace_ends_at;cycle={...cycle,cycle_index:1,paid_at:null};invoice.status='open';now=addon.grace_ends_at;
  pool.query.mockResolvedValue({rows:[{id:addon.id,org_id:addon.org_id,next_action_at:addon.next_action_at}]});
  expect((await service.runMaintenance()).results).toEqual([{id:'addon-1',suspended:true}]);
  expect(client.query.mock.calls.some(([sql])=>sql.includes("UPDATE workspaces SET status='Suspended'"))).toBe(true);
  expect(client.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO billing_invoices'))).toBe(false);
});
