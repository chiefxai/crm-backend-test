jest.mock('../src/db/client',()=>({ready:Promise.resolve()}));
jest.mock('../src/db/pool',()=>({pool:{connect:jest.fn()}}));
const {pool}=require('../src/db/pool');
const repository=require('../src/db/repositories/workspaceRepository');
const {branchQuote,effectivePolicy}=require('../src/workspaces/organizationPolicy');
const policy={mode:'same_industry',primaryIndustry:'lending',pricing:{baseMonthlyInr:1000,includedWorkspaces:5,maxWorkspaces:8,includedSeats:1,extraSeatMonthlyInr:0,extraWorkspaceMonthlyInr:50,additionalIndustryMonthlyInr:500}};
const workspaces=[{id:'org',industry:'lending'}];
let client;
beforeEach(()=>{
  client={release:jest.fn(),query:jest.fn(async sql=>{
    if(sql.includes('SELECT id,status,industry,settings FROM organizations'))return {rows:[{id:'org',status:'Active',industry:'lending',settings:{workspacePolicy:policy}}]};
    if(sql.includes('SELECT id,industry FROM workspaces'))return {rows:workspaces};
    if(sql.includes('COUNT(*) AS seat_count'))return {rows:[{seat_count:1}]};
    if(sql.includes('SELECT id FROM org_members'))return {rows:[{id:'admin'}]};
    return {rows:[]};
  })};
  pool.connect.mockResolvedValue(client);
});
test('repository rolls back unauthorized industry creation before any workspace insert',async()=>{
  await expect(repository.createWorkspace('org',{name:'Other business',industry:'automotive'},'admin')).rejects.toMatchObject({statusCode:403});
  expect(client.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO workspaces'))).toBe(false);
  expect(client.query).toHaveBeenCalledWith('ROLLBACK');
});
test('repository rejects an unaccepted price and releases the transaction',async()=>{
  await expect(repository.createWorkspace('org',{name:'Branch',industry:'lending'},'admin')).rejects.toMatchObject({statusCode:409});
  expect(client.release).toHaveBeenCalled();
  expect(client.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO workspaces'))).toBe(false);
});
test('accepted included workspace creation stores its price agreement atomically',async()=>{
  const result=await repository.createWorkspace('org',{name:'Branch',industry:'lending',pricingAcceptanceToken:branchQuote(effectivePolicy({settings:{workspacePolicy:policy}},workspaces),workspaces,1).token},'admin');
  expect(result.organizationPricing.totalMonthlyInr).toBe(1000);
  const workspaceWrite=client.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO workspaces'));
  expect(JSON.parse(workspaceWrite[1][6]).billingAgreement.organizationMonthlyQuoteAtCreation.totalMonthlyInr).toBe(1000);
  expect(client.query).toHaveBeenCalledWith('COMMIT');
});
test.each([false,true])('unpaid additional workspace is rejected even with an accepted quote (platform admin=%s)',async platformAdmin=>{
  const existing = Array.from({length:5},(_,index)=>({id:`w-${index}`,industry:'lending'}));
  const original = client.query.getMockImplementation();
  client.query.mockImplementation(async(sql,...args)=>sql.includes('SELECT id,industry FROM workspaces') ? {rows:existing} : original(sql,...args));
  await expect(repository.createWorkspace('org',{name:'Extra',industry:'lending',pricingAcceptanceToken:branchQuote(policy,existing).token},'admin',{platformAdmin})).rejects.toMatchObject({statusCode:402});
  expect(client.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO workspaces'))).toBe(false);
  expect(client.query).toHaveBeenCalledWith('ROLLBACK');
});
test('an HTTP supplied addon identifier does not bypass the public provisioning boundary',async()=>{
  const existing = Array.from({length:5},(_,index)=>({id:`w-${index}`,industry:'lending'}));
  const original = client.query.getMockImplementation();
  client.query.mockImplementation(async(sql,...args)=>sql.includes('SELECT id,industry FROM workspaces') ? {rows:existing} : original(sql,...args));
  await expect(repository.createWorkspace('org',{name:'Extra',industry:'lending'},'admin',{billingAddonId:'fake',paidAddon:true,platformAdmin:true})).rejects.toMatchObject({statusCode:402});
});
test('internal provisioning requires the paid invoice and writes the addon identifier into its billing agreement',async()=>{
  const existing = Array.from({length:5},(_,index)=>({id:`w-${index}`,industry:'lending'}));
  const original = client.query.getMockImplementation();
  let paid=false;
  client.query.mockImplementation(async(sql,...args)=>{
    if(sql.includes('SELECT id,industry FROM workspaces'))return {rows:existing};
    if(sql.includes('SELECT a.id FROM billing_workspace_addons'))return {rows:paid?[{id:'addon-1'}]:[]};
    return original(sql,...args);
  });
  const input={name:'Extra',industry:'lending'};
  await expect(repository.createWorkspaceInTransaction(client,'org',input,'admin',{billingAddonId:'addon-1'})).rejects.toMatchObject({statusCode:402});
  expect(client.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO workspaces'))).toBe(false);
  paid=true;
  await repository.createWorkspaceInTransaction(client,'org',input,'admin',{billingAddonId:'addon-1'});
  const workspaceWrite=client.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO workspaces'));
  expect(JSON.parse(workspaceWrite[1][6]).billingAgreement).toMatchObject({addonId:'addon-1',separatelyInvoiced:true});
});
