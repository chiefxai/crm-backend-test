jest.mock('../src/db/repositories/workspaceRepository', () => ({
  getAuthorizationState: jest.fn(), getMemberFeatureOverride: jest.fn(), getActive: jest.fn(), ensureDefaultMembership: jest.fn(),
}));
jest.mock('../src/db/repository', () => ({ findMembershipForUser: jest.fn(), getOrg: jest.fn() }));
jest.mock('../src/auth', () => ({ verifyToken: jest.fn() }));
jest.mock('../src/platform/featureFlags', () => ({ isAppFeatureEnabled: jest.fn(), getEnabledAppFeatureKeys: jest.fn() }));
jest.mock('../src/observability/logger', () => ({ getLogger: () => ({ info() {}, error() {} }) }));

const db = require('../src/db/repository');
const workspaces = require('../src/db/repositories/workspaceRepository');
const provider = require('../src/auth');
const features = require('../src/platform/featureFlags');
const { requireAuth } = require('../src/middleware/auth');
const { effectiveKeys, hasInheritedAdminFeatures } = require('../src/authorization/workspaceFeatures');

const previousEnvironment = process.env.NODE_ENV;
beforeEach(() => {
  process.env.NODE_ENV = 'production';
  jest.resetAllMocks();
  provider.verifyToken.mockResolvedValue({ sub: 'admin-a', email: 'admin@example.com', email_verified: true });
  db.findMembershipForUser.mockImplementation(async (_id, _email, orgId) =>
    orgId === 'org-a' ? { memberId: 'member-a', orgId: 'org-a', role: 'Organization Admin', featureFlags: [] } : null);
  db.getOrg.mockResolvedValue({ id: 'org-a', status: 'Active', featureFlags: ['leads', 'reports'] });
  workspaces.getAuthorizationState.mockResolvedValue({ workspace_status: 'Active', organization_status: 'Active', role: null });
  workspaces.getMemberFeatureOverride.mockResolvedValue(null);
  workspaces.getActive.mockResolvedValue({ settings: { enabledFeatures: ['leads'] } });
  features.isAppFeatureEnabled.mockResolvedValue(true);
  features.getEnabledAppFeatureKeys.mockResolvedValue(['leads', 'reports']);
});
afterAll(() => {
  if (previousEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousEnvironment;
});

async function invoke(path = '/api/settings/workspace', orgId = 'org-a') {
  const req = { method: 'GET', originalUrl: path, headers: { authorization: 'Bearer token' },
    get: name => name === 'X-Organization-Id' ? orgId : null };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), set: jest.fn() };
  const next = jest.fn();
  await requireAuth(req, res, next);
  return { req, res, next };
}

test('organization admin can load the active workspace profile without a separate workspace role', async () => {
  const { req, res, next } = await invoke();
  expect(next).toHaveBeenCalledTimes(1);
  expect(res.status).not.toHaveBeenCalled();
  expect(req.authorization).toMatchObject({ organizationRole: 'Organization Admin', workspaceRole: null, platformAdmin: false });
  expect(req.authorization.permissions).toEqual(expect.arrayContaining(['workspace.read', 'workspace.write', 'workspace.settings.manage']));
  expect(req.authorization.permissions).not.toContain('platform.manage');
});

test('organization admin inherits the granted feature ceiling in the selected workspace', async () => {
  const { req, next } = await invoke('/api/leads');
  expect(next).toHaveBeenCalledTimes(1);
  expect(await effectiveKeys(['leads', 'reports'], ['leads'], [], hasInheritedAdminFeatures(req))).toEqual(['leads']);
});

test('an explicit empty member override denies the feature for organization admins too', async () => {
  workspaces.getMemberFeatureOverride.mockResolvedValue([]);
  const { req, res, next } = await invoke('/api/leads');
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(403);
  expect(await effectiveKeys(['leads'], ['leads'], [], hasInheritedAdminFeatures(req), [])).toEqual([]);
});

test.each(['organization', 'workspace', 'platform'])('organization admins cannot bypass a disabled %s feature', async ceiling => {
  if (ceiling === 'organization') db.getOrg.mockResolvedValue({ id: 'org-a', status: 'Active', featureFlags: [] });
  if (ceiling === 'workspace') workspaces.getActive.mockResolvedValue({ settings: { enabledFeatures: [] } });
  if (ceiling === 'platform') features.isAppFeatureEnabled.mockResolvedValue(false);
  const { res, next } = await invoke('/api/leads');
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(403);
});

test('organization admin cannot select another organization', async () => {
  const { res, next } = await invoke('/api/settings/workspace', 'org-b');
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(403);
});

test('billing-only members and ordinary members without workspace assignment remain denied', async () => {
  for (const role of ['Billing Admin', 'Member']) {
    db.findMembershipForUser.mockResolvedValue({ orgId: 'org-a', memberId: 'member-a', role });
    const { res, next } = await invoke();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  }
});

test('suspended workspace recovery does not grant operational permissions', async () => {
  workspaces.getAuthorizationState.mockResolvedValue({ workspace_status: 'Suspended', organization_status: 'Active' });
  const profile = await invoke();
  expect(profile.res.status).toHaveBeenCalledWith(403);
  const session = await invoke('/api/auth/me');
  expect(session.next).toHaveBeenCalled();
  expect(session.req.authorization.permissions).not.toContain('workspace.read');
});
