jest.mock('../../src/db/pool', () => ({ getPool: jest.fn() }));
const {
  availableUnits, groupBalances, previewManualAllocation, readManualAllocationOverview, requireManualAllocation,
} = require('../../src/billing/manualAllocationReadModel');

const account = { kind: 'subscription', expiresAt: '2026-11-01T00:00:00.000Z',
  id: 'grant-1', available: { asset:'INR',scale:2,units:'9000' },
  held: { asset:'INR',scale:2,units:'1000' }, positionVersion: 7 };
const snapshot = {
  uninitialized:false, writable:true,
  workspaces:[{ id:'workspace-a',name:'Workspace A',status:'Active' },
    { id:'workspace-b',name:'Workspace B',status:'Suspended' }],
  grants:[account],
};
const input = { grantId:'grant-1', workspaceId:'workspace-a', amountUnits:'2500', expectedPositionVersion:7 };

describe('manual organization-owned credit allocations', () => {
  it('sums positions exactly without mixing grant kinds or workspace scopes', () => {
    const rows = [
      { account_type:'organization',owner_id:'org-a',grant_kind:'subscription',asset:'INR',scale:2,balance_units:'10000',reserved_units:'1000' },
      { account_type:'organization',owner_id:'org-a',grant_kind:'subscription',asset:'INR',scale:2,balance_units:'2200',reserved_units:'200' },
      { account_type:'workspace',owner_id:'workspace-a',grant_kind:'subscription',asset:'INR',scale:2,balance_units:'4000',reserved_units:'0' },
      { account_type:'organization',owner_id:'org-a',grant_kind:'topup',asset:'CREDIT',scale:0,balance_units:'9',reserved_units:'1' },
    ];
    const grouped=groupBalances(rows);
    expect(grouped).toHaveLength(3);
    expect(grouped[0]).toMatchObject({ ownerType:'organization',ownerId:'org-a',kind:'subscription',
      available:{asset:'INR',units:'11000',scale:2},held:{asset:'INR',units:'1200',scale:2} });
    expect(grouped[1].available.units).toBe('4000');
    expect(grouped[2].available).toEqual({ asset:'CREDIT',units:'8',scale:0 });
    expect(() => availableUnits({ balance_units:'4',reserved_units:'5' })).toThrow('Inconsistent');
  });

  it('calculates preview from available (not held) grant units with original expiry', () => {
    expect(previewManualAllocation(snapshot,input)).toEqual({
      grantId:'grant-1',workspaceId:'workspace-a',workspaceName:'Workspace A',kind:'subscription',
      amount:{asset:'INR',units:'2500',scale:2},remaining:{asset:'INR',units:'6500',scale:2},
      expiresAt:'2026-11-01T00:00:00.000Z',expectedPositionVersion:7,
    });
  });

  it('fails closed when effective terms do not permit manual allocation', () => {
    expect(() => requireManualAllocation({ allocation: {
      allocationMode: 'automatic', status: 'ready', manualAllocationAllowed: false,
    } })).toThrow(expect.objectContaining({ code: 'MANUAL_ALLOCATION_NOT_APPLICABLE', statusCode: 409 }));
    expect(() => requireManualAllocation({ allocation: {
      allocationMode: 'unknown', status: 'unavailable', manualAllocationAllowed: false,
    } })).toThrow(expect.objectContaining({ code: 'MANUAL_ALLOCATION_NOT_APPLICABLE', statusCode: 409 }));
    expect(() => requireManualAllocation({ allocation: {
      allocationMode: 'manual', status: 'ready', manualAllocationAllowed: true,
    } })).not.toThrow();
  });

  it('rejects missing or suspended workspace, overspend, stale version, held accounts and invalid units', () => {
    for (const changed of [
      {...input,workspaceId:'workspace-b'}, {...input,workspaceId:'not-owned'},
      {...input,amountUnits:'9001'}, {...input,amountUnits:'0'},
      {...input,amountUnits:'1.20'}, {...input,expectedPositionVersion:8},
    ]) expect(() => previewManualAllocation(snapshot,changed)).toThrow();
    expect(() => previewManualAllocation({...snapshot,writable:false},input)).toThrow();
    expect(() => previewManualAllocation({...snapshot,uninitialized:true},input)).toThrow();
  });

  it('loads eligible credits and transfer history within an org-scoped read-only transaction', async () => {
    const sql = [];
    const connection = {
      query: jest.fn(async (statement,args=[]) => {
        sql.push({statement,args});
        if (statement.startsWith('SELECT status,hold_reason')) return {rows:[{status:'active',hold_reason:null}]};
        if (statement.startsWith('SELECT id,name,status')) return {rows:snapshot.workspaces};
        if (statement.includes('FROM billing_credit_positions p')) return {rows:[
          {grant_id:'grant-1',grant_kind:'subscription',balance_units:'10000',reserved_units:'1000',
            asset:'INR',scale:2,account_type:'organization',owner_id:'org-a',
            effective_at:'2026-10-01',expires_at:'2026-11-01',version:7},
          {grant_id:'grant-1',grant_kind:'subscription',balance_units:'3000',reserved_units:'100',
            asset:'INR',scale:2,account_type:'workspace',owner_id:'workspace-a',
            effective_at:'2026-10-01',expires_at:'2026-11-01',version:2},
        ]};
        if (statement.includes('FROM billing_journals j')) return {rows:[{
          id:'journal-1',created_at:'2026-10-10T12:00:00Z',actor_id:'member-a',
          grant_id:'grant-1',amount_units:'2000',asset:'INR',scale:2,
          workspace_id:'workspace-a',workspace_name:'Workspace A',
        }]};
        return {rows:[]};
      }),
      release: jest.fn(),
    };
    const result=await readManualAllocationOverview('org-a',{pool:{connect:async()=>connection},now:new Date('2026-10-10T12:00:00Z')});
    expect(result.uninitialized).toBe(false);
    expect(result.writable).toBe(true);
    expect(result.grants).toHaveLength(1);
    expect(result.grants[0].available.units).toBe('9000');
    expect(result.history[0].workspaceName).toBe('Workspace A');
    expect(sql[0].statement).toBe('START TRANSACTION READ ONLY');
    expect(sql.at(-1).statement).toBe('COMMIT');
    expect(sql.filter(x=>x.statement.includes('FROM billing_credit_positions'))[0].args)
      .toEqual(['org-a','2026-10-10T12:00:00.000Z','2026-10-10T12:00:00.000Z']);
    expect(sql.some(x=>x.statement.includes("a.account_purpose='pool'"))).toBe(true);
    expect(sql.some(x=>x.statement.includes("j.org_id=? AND j.operation_type='credit_transfer'"))).toBe(true);
    expect(connection.release).toHaveBeenCalledTimes(1);
  });

  it('does not substitute legacy balance when organization billing is uninitialized', async () => {
    const connection={query:jest.fn().mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]})
      .mockResolvedValueOnce({rows:[]}),release:jest.fn()};
    const result=await readManualAllocationOverview('org-a',{pool:{connect:async()=>connection}});
    expect(result.uninitialized).toBe(true);
    expect(result.grants).toEqual([]);
    expect(connection.release).toHaveBeenCalled();
  });
});
