jest.mock('../../src/db/pool', () => ({ getPool: jest.fn() }));
jest.mock('../../src/middleware/auth', () => ({
  requireAuth: (req, _res, next) => {
    const role=req.get('X-Test-Role') || 'Member';
    req.userId = 'user-1'; req.orgId = 'org-1';
    const financial = ['Organization Admin','Owner'].includes(role);
    req.authorization = { organizationRole:role, permissions:financial
      ? ['billing.read','billing.organization.read','billing.credit.allocate']
      : role === 'Billing Admin'
        ? ['billing.read','billing.organization.read'] : ['billing.read'] };
    next();
  },
  requirePermission: permission => (req,res,next) => req.authorization?.permissions.includes(permission)
    ? next() : res.status(403).json({ error:'Permission denied',permission }),
}));
jest.mock('../../src/billing/manualAllocationReadModel', () => {
  const original=jest.requireActual('../../src/billing/manualAllocationReadModel');
  return { ...original,readManualAllocationOverview:jest.fn() };
});
const express=require('express');
const request=require('supertest');
const { readManualAllocationOverview }=require('../../src/billing/manualAllocationReadModel');
const {
  router, parseTransferInput, transfersEnabled, requireOrganizationCreditAdmin,
} = require('../../src/billing/manualAllocationRouter');

const app=express();
app.use(express.json());
app.use('/api/billing',router);

const snapshot = {
  uninitialized:false,writable:true,
  grants:[{id:'grant-a',kind:'topup',expiresAt:null,positionVersion:3,
    available:{asset:'INR',units:'11000',scale:2},held:{asset:'INR',units:'1000',scale:2}}],
  balances:[],history:[],
  workspaces:[{id:'workspace-1',name:'North',status:'Active'}],
};

describe('organization admin-only manual allocation routes', () => {
  const initial = process.env.BILLING_MANUAL_ALLOCATION_ENABLED;
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BILLING_MANUAL_ALLOCATION_ENABLED;
    readManualAllocationOverview.mockResolvedValue(snapshot);
  });
  afterAll(() => {
    if (initial === undefined) delete process.env.BILLING_MANUAL_ALLOCATION_ENABLED;
    else process.env.BILLING_MANUAL_ALLOCATION_ENABLED = initial;
  });

  it('returns ledger balances in read-only mode to organization admins', async () => {
    const res=await request(app).get('/api/billing/manual-allocations')
      .set('X-Test-Role','Organization Admin').expect(200);
    expect(res.body.transfersEnabled).toBe(false);
    expect(res.body.grants).toHaveLength(1);
    expect(readManualAllocationOverview).toHaveBeenCalledWith('org-1');
  });

  it.each(['Member','Billing Admin','Workspace Admin','Manager'])(
    'forbids %s from viewing, previewing, or transferring organization credits', async role => {
      await request(app).get('/api/billing/manual-allocations').set('X-Test-Role',role).expect(403);
      await request(app).post('/api/billing/manual-allocations/preview').set('X-Test-Role',role)
        .send({grantId:'grant-a',workspaceId:'workspace-1',amountUnits:'100',expectedPositionVersion:3})
        .expect(403);
      await request(app).post('/api/billing/manual-allocations/transfer').set('X-Test-Role',role)
        .send({}).expect(403);
    },
  );

  it('previews a permitted transfer without requiring the write enablement flag', async () => {
    const response=await request(app).post('/api/billing/manual-allocations/preview')
      .set('X-Test-Role','Organization Admin')
      .send({grantId:'grant-a',workspaceId:'workspace-1',amountUnits:'2000',expectedPositionVersion:3})
      .expect(200);
    expect(response.body.amount).toEqual({ asset:'INR',units:'2000',scale:2 });
    expect(response.body.remaining.units).toBe('9000');
    expect(response.body.transfersEnabled).toBe(false);
  });

  it('rejects inactive workspace, excessive amount, stale grant and forged org fields', async () => {
    const post=body=>request(app).post('/api/billing/manual-allocations/preview')
      .set('X-Test-Role','Organization Admin').send(body);
    await post({grantId:'grant-a',workspaceId:'other-org-workspace',amountUnits:'2000',expectedPositionVersion:3}).expect(404);
    await post({grantId:'grant-a',workspaceId:'workspace-1',amountUnits:'20000',expectedPositionVersion:3}).expect(409);
    await post({grantId:'grant-a',workspaceId:'workspace-1',amountUnits:'2000',expectedPositionVersion:1}).expect(409);
    await post({grantId:'grant-a',workspaceId:'workspace-1',amountUnits:'2000',expectedPositionVersion:3,orgId:'forged'}).expect(400);
  });

  it('keeps real financial transfers disabled by default, even for an org admin', async () => {
    const result=await request(app).post('/api/billing/manual-allocations/transfer')
      .set('X-Test-Role','Owner')
      .send({grantId:'grant-a',workspaceId:'workspace-1',
        amount:{asset:'INR',units:'2000',scale:2},expectedPositionVersion:3})
      .expect(503);
    expect(result.body.code).toBe('BILLING_MANUAL_ALLOCATION_DISABLED');
    expect(readManualAllocationOverview).not.toHaveBeenCalled();
    expect(transfersEnabled()).toBe(false);
  });

  it('rejects forged actor and scope fields in transfer commands', () => {
    expect(() => parseTransferInput({grantId:'grant-a',workspaceId:'workspace-1',
      amount:{asset:'INR',units:'100',scale:2},expectedPositionVersion:3,
      fromScope:{orgId:'other-org',ownerType:'workspace',ownerId:'other-org'}})).toThrow();
    expect(() => parseTransferInput({grantId:'grant-a',workspaceId:'workspace-1',
      amount:{asset:'INR',units:'100',scale:2},expectedPositionVersion:3, actor:{id:'forged'}})).toThrow();
    expect(() => parseTransferInput({grantId:'grant-a',workspaceId:'workspace-1',
      amount:{asset:'INR',units:'0',scale:2},expectedPositionVersion:3})).toThrow();
    expect(() => parseTransferInput({grantId:'grant-a',workspaceId:'workspace-1',
      amount:{asset:'INR',units:'1',scale:2,ownerId:'forged'},expectedPositionVersion:3})).toThrow();
  });

  it('does not grant allocation privilege based on role spelling alone', () => {
    const next=jest.fn();
    const res={status:jest.fn().mockReturnThis(),json:jest.fn()};
    requireOrganizationCreditAdmin({authorization:{organizationRole:'Organization Admin',permissions:[]}},res,next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
