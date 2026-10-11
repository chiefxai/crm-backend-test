jest.mock('../src/db/repositories/workspaceRepository', () => ({
  getAuthorizationState: jest.fn(), getMemberFeatureOverride: jest.fn(), getActive: jest.fn(), ensureDefaultMembership: jest.fn(),
}));
jest.mock('../src/db/repository', () => ({ findMembershipForUser: jest.fn(), getOrg: jest.fn() }));
jest.mock('../src/auth', () => ({ verifyToken: jest.fn() }));
jest.mock('../src/observability/logger', () => ({ getLogger: () => ({ info() {}, error() {} }) }));
jest.mock('../src/db/pool', () => ({ getPool: jest.fn() }));

const db = require('../src/db/repository');
const workspaces = require('../src/db/repositories/workspaceRepository');
const provider = require('../src/auth');
const poolModule = require('../src/db/pool');
const { requireAuth } = require('../src/middleware/auth');
const { FEATURE_FLAG } = require('../src/middleware/subscriptionAccessGate');

const previous = { nodeEnv: process.env.NODE_ENV, flag: process.env[FEATURE_FLAG] };
beforeEach(() => {
  process.env.NODE_ENV = 'production';
  delete process.env[FEATURE_FLAG];
  jest.clearAllMocks();
  provider.verifyToken.mockResolvedValue({ sub: 'admin-a', email: 'admin@example.com', email_verified: true });
  db.findMembershipForUser.mockResolvedValue({ memberId: 'member-a', orgId: 'org-a', role: 'Organization Admin', featureFlags: [] });
  db.getOrg.mockResolvedValue({ id: 'org-a', status: 'Active', featureFlags: [] });
  workspaces.getAuthorizationState.mockResolvedValue({ workspace_status: 'Active', organization_status: 'Active', role: null });
  workspaces.getMemberFeatureOverride.mockResolvedValue(null);
  const pool = { query: jest.fn(async () => [[{ billing_access_state: 'operational', billing_suspension_cause: null }]]) };
  poolModule.getPool.mockReturnValue(pool);
});
afterAll(() => {
  if (previous.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.nodeEnv;
  if (previous.flag === undefined) delete process.env[FEATURE_FLAG]; else process.env[FEATURE_FLAG] = previous.flag;
});

async function invoke(path = '/api/records') {
  const req = { method: 'GET', originalUrl: path, headers: { authorization: 'Bearer token' },
    get: (name) => name === 'X-Organization-Id' ? 'org-a' : null };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), set: jest.fn() };
  const next = jest.fn();
  await requireAuth(req, res, next);
  return { req, res, next };
}

test('gate is off by default and does not read subscription state', async () => {
  const { next } = await invoke('/api/records');
  expect(next).toHaveBeenCalledTimes(1);
  expect(poolModule.getPool).not.toHaveBeenCalled();
});

test.each(['billing_recovery', 'billing_suspended'])('%s blocks operational API while authorized billing recovery remains reachable', async (state) => {
  process.env[FEATURE_FLAG] = 'true';
  const pool = poolModule.getPool();
  pool.query.mockResolvedValue([[{ billing_access_state: state,
    billing_suspension_cause: state === 'billing_recovery' ? 'initial_subscription_unpaid' : 'subscription_expired',
  }]]);

  const operational = await invoke('/api/records');
  expect(operational.next).not.toHaveBeenCalled();
  expect(operational.res.status).toHaveBeenCalledWith(state === 'billing_recovery' ? 402 : 403);

  const billing = await invoke('/api/billing/overview');
  expect(billing.next).toHaveBeenCalledTimes(1);
  expect(billing.req.subscriptionAccess).toMatchObject({ state });
  const session = await invoke('/api/auth/me');
  expect(session.next).toHaveBeenCalledTimes(1);
  expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE org_id=? LIMIT 1'), ['org-a']);
});

test('manual and security suspension causes cannot use the billing recovery exception', async () => {
  process.env[FEATURE_FLAG] = 'true';
  const pool = poolModule.getPool();
  pool.query.mockResolvedValue([[{ billing_access_state: 'billing_suspended', billing_suspension_cause: 'security_suspension' }]]);
  const { res, next } = await invoke('/api/billing/overview');
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(403);
});

test('an expired restriction deadline blocks operational requests even before the scheduler updates state', async () => {
  process.env[FEATURE_FLAG] = 'true';
  const pool = poolModule.getPool();
  pool.query.mockResolvedValue([[{ billing_access_state: 'operational', billing_suspension_cause: null,
    restriction_deadline: '2000-01-01 00:00:00.000' }]]);
  const operational = await invoke('/api/records');
  expect(operational.next).not.toHaveBeenCalled();
  expect(operational.res.status).toHaveBeenCalledWith(403);
  const billing = await invoke('/api/billing/subscription-renewal');
  expect(billing.next).toHaveBeenCalledTimes(1);
  expect(billing.req.subscriptionAccess.deadlinePassed).toBe(true);
});

test('non-billing causes cannot use billing recovery even if the state is recovery', async () => {
  process.env[FEATURE_FLAG] = 'true';
  poolModule.getPool().query.mockResolvedValue([[{ billing_access_state: 'billing_recovery', billing_suspension_cause: 'manual_suspension' }]]);
  const { res, next } = await invoke('/api/billing/overview');
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(403);
});

test('missing subscription status fails closed after the flag is enabled', async () => {
  process.env[FEATURE_FLAG] = 'true';
  poolModule.getPool().query.mockResolvedValue([[]]);
  const { res, next } = await invoke('/api/records');
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SUBSCRIPTION_ACCESS_UNAVAILABLE' }));
});

test('pre-existing organization suspension still blocks billing routes before the subscription exception', async () => {
  process.env[FEATURE_FLAG] = 'true';
  db.getOrg.mockResolvedValue({ id: 'org-a', status: 'Suspended', featureFlags: [] });
  const { res, next } = await invoke('/api/billing/overview');
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(403);
  expect(poolModule.getPool).not.toHaveBeenCalled();
});
