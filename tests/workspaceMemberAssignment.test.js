jest.mock('../src/db/client',()=>({ready:Promise.resolve()}));
jest.mock('../src/db/pool',()=>({pool:{connect:jest.fn()}}));

const {pool}=require('../src/db/pool');
const repository=require('../src/db/repositories/workspaceRepository');

let client,otherAdmins,currentRole,roleSource,organizationRole;
beforeEach(()=>{
  otherAdmins=0;
  currentRole='Workspace Admin';
  roleSource='manual';
  organizationRole='Member';
  client={release:jest.fn(),query:jest.fn(async sql=>{
    if(sql.startsWith('SELECT id FROM workspaces')) return {rows:[{id:'workspace-1'}]};
    if(sql.startsWith('SELECT id,role,status FROM org_members')) return {rows:[{id:'member-1',role:organizationRole,status:'Active'}]};
    if(sql.startsWith('SELECT role,status,role_source FROM workspace_members')) return {rows:[{role:currentRole,status:'Active',role_source:roleSource}]};
    if(sql.includes('COUNT(*) AS admin_count')) return {rows:[{admin_count:otherAdmins}]};
    return {rows:[]};
  })};
  pool.connect.mockResolvedValue(client);
});

test.each(['Owner','Organization Admin'])('%s can demote the last Workspace Admin',async role=>{
  const result=await repository.setMemberAssignment('org-1','workspace-1','member-1','Member','Active',{organizationRole:role});
  expect(result).toMatchObject({role:'Member',status:'Active'});
  expect(client.query).toHaveBeenCalledWith('COMMIT');
  expect(client.query.mock.calls.some(([sql])=>sql.includes('COUNT(*) AS admin_count'))).toBe(false);
});

test('Organization Admin can revoke the last Workspace Admin assignment',async()=>{
  const result=await repository.setMemberAssignment('org-1','workspace-1','member-1','Workspace Admin','Inactive',{organizationRole:'Organization Admin'});
  expect(result.status).toBe('Inactive');
  expect(client.query).toHaveBeenCalledWith('COMMIT');
});

test.each([null,{organizationRole:'Member',workspaceRole:'Workspace Admin'},{organizationRole:'Billing Admin'}])(
  'last-admin protection remains for callers without organization administration: %j',async authority=>{
    await expect(repository.setMemberAssignment('org-1','workspace-1','member-1','Member','Active',authority))
      .rejects.toMatchObject({statusCode:409,expose:true});
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE workspace_members'))).toBe(false);
    expect(client.release).toHaveBeenCalled();
  },
);

test('Workspace Admin can demote another admin when a replacement exists',async()=>{
  otherAdmins=1;
  await repository.setMemberAssignment('org-1','workspace-1','member-1','Member','Active',{organizationRole:'Member',workspaceRole:'Workspace Admin'});
  expect(client.query).toHaveBeenCalledWith('COMMIT');
});

test('Organization Admin can demote the last legacy Workspace Admin',async()=>{
  currentRole='Member';
  organizationRole='Workspace Admin';
  roleSource='legacy';
  await repository.setMemberAssignment('org-1','workspace-1','member-1','Viewer','Active',{organizationRole:'Organization Admin'});
  expect(client.query).toHaveBeenCalledWith('COMMIT');
});

test('legacy Workspace Admin is still protected for workspace-level callers',async()=>{
  currentRole='Member';
  organizationRole='Workspace Admin';
  roleSource='legacy';
  await expect(repository.setMemberAssignment('org-1','workspace-1','member-1','Member'))
    .rejects.toMatchObject({statusCode:409});
});
