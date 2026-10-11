jest.mock('../../src/db/repository',()=>({findMembershipForUser:jest.fn()}));
jest.mock('../../src/auth',()=>({verifyToken:jest.fn()}));
jest.mock('../../src/db/repositories/workspaceRepository',()=>({getAuthorizationState:jest.fn(),getDefault:jest.fn()}));
const {resolveAuthorization}=require('../../src/middleware/auth');
const workspaces=require('../../src/db/repositories/workspaceRepository');
const {authorization}=require('../../src/authorization/policy');
const args={userId:'owner-1',email:'owner@example.test',orgId:'org-1',workspaceId:'workspace-6',membership:{role:'Owner',memberId:'member-1'}};
const previousEnv={NODE_ENV:process.env.NODE_ENV,MULTI_WORKSPACE_ENABLED:process.env.MULTI_WORKSPACE_ENABLED,WORKSPACE_ISOLATION_VERIFIED:process.env.WORKSPACE_ISOLATION_VERIFIED};
beforeEach(()=>{
  process.env.NODE_ENV='production';process.env.MULTI_WORKSPACE_ENABLED='true';process.env.WORKSPACE_ISOLATION_VERIFIED='true';
  workspaces.getAuthorizationState.mockResolvedValue({workspace_status:'Suspended',organization_status:'Active',status:'Active',role:'Workspace Admin'});
});
afterAll(()=>{for(const [key,value] of Object.entries(previousEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
test('a suspended workspace cannot authorize operational requests',async()=>{
  await expect(resolveAuthorization(args)).rejects.toMatchObject({statusCode:403});
});
test('organization billing remains available to settle an expired add-on without operational access',async()=>{
  const result=await resolveAuthorization({...args,allowInactiveWorkspace:true});
  expect(result.permissions).toEqual(expect.arrayContaining(['billing.read','billing.payment.submit']));
  expect(result.workspaceRole).toBeNull();expect(result.permissions).not.toContain('workspace.read');
});
test('workspace members do not gain billing recovery privileges',async()=>{
  await expect(resolveAuthorization({...args,membership:{role:'Member'},allowInactiveWorkspace:true})).rejects.toMatchObject({statusCode:403});
});
test('billing recovery cannot bypass a suspended organization',async()=>{
  workspaces.getAuthorizationState.mockResolvedValue({workspace_status:'Suspended',organization_status:'Suspended'});
  await expect(resolveAuthorization({...args,allowInactiveWorkspace:true})).rejects.toMatchObject({statusCode:403});
});
test.each(['Owner','Organization Admin','Billing Admin'])('server advertises payment submission for %s',role=>{
  expect(authorization({orgRole:role,workspaceRole:null}).permissions).toContain('billing.payment.submit');
  expect(authorization({orgRole:'Member',workspaceRole:'Workspace Admin'}).permissions).not.toContain('billing.payment.submit');
});
