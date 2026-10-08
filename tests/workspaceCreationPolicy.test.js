jest.mock('../src/db/client',()=>({ready:Promise.resolve()}));
jest.mock('../src/db/pool',()=>({pool:{connect:jest.fn()}}));
const {pool}=require('../src/db/pool');
const repository=require('../src/db/repositories/workspaceRepository');
const {branchQuote}=require('../src/workspaces/organizationPolicy');
const policy={mode:'single',primaryIndustry:'lending',pricing:{baseMonthlyInr:1000,includedWorkspaces:1,extraWorkspaceMonthlyInr:200,additionalIndustryMonthlyInr:500}};
const workspaces=[{id:'org',industry:'lending'}];
let client;
beforeEach(()=>{
  client={release:jest.fn(),query:jest.fn(async sql=>{
    if(sql.includes('SELECT id,status,industry,settings FROM organizations'))return {rows:[{id:'org',status:'Active',industry:'lending',settings:{workspacePolicy:policy}}]};
    if(sql.includes('SELECT id,industry FROM workspaces'))return {rows:workspaces};
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
test('accepted branch creation stores the upgraded policy and price agreement atomically',async()=>{
  const result=await repository.createWorkspace('org',{name:'Branch',industry:'lending',pricingAcceptanceToken:branchQuote(policy,workspaces).token},'admin');
  expect(result.organizationPricing.totalMonthlyInr).toBe(1200);
  const policyWrite=client.query.mock.calls.find(([sql])=>sql.startsWith('UPDATE organizations SET settings'));
  expect(JSON.parse(policyWrite[1][0]).mode).toBe('same_industry');
  const workspaceWrite=client.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO workspaces'));
  expect(JSON.parse(workspaceWrite[1][6]).billingAgreement.organizationMonthlyQuoteAtCreation.totalMonthlyInr).toBe(1200);
  expect(client.query).toHaveBeenCalledWith('COMMIT');
});
