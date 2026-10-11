jest.mock('../src/workspaces/scope', () => ({ runWithScope: (_scope, callback) => callback() }));
jest.mock('../src/authorization/policy', () => ({
  authorization: () => ({}),
  enforceRequest: (_req, _res, next) => next(),
  organizationRole: () => null,
  WORKSPACE_ROLES: [],
}));
jest.mock('../src/db/repositories/workspaceRepository', () => ({
  getAuthorizationState: jest.fn(),
  getDefault: jest.fn(),
}));
jest.mock('../src/workspaces/capabilities', () => ({ multipleWorkspacesEnabled: () => false }));
jest.mock('../src/db/repository', () => ({
  findMembershipForUser: jest.fn(),
  getOrg: jest.fn(),
}));
jest.mock('../src/auth', () => ({ verifyToken: jest.fn() }));
jest.mock('../src/observability/logger', () => ({ getLogger: () => ({ info() {}, error() {} }) }));

const db = require('../src/db/repository');
const provider = require('../src/auth');
const workspaces = require('../src/db/repositories/workspaceRepository');
const { requireAuth } = require('../src/middleware/auth');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set() { return this; },
  };
}

describe('requireAuth error status', () => {
  const oldNodeEnv = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_PROVIDER = 'cognito';
    jest.clearAllMocks();
    provider.verifyToken.mockResolvedValue({ sub: 'user-a' });
    db.findMembershipForUser.mockResolvedValue({ orgId: 'org-a', role: 'Agent', memberId: 'member-a' });
    db.getOrg.mockResolvedValue({ id: 'org-a', status: 'Active' });
  });
  afterAll(() => {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    delete process.env.AUTH_PROVIDER;
  });

  function request() {
    return {
      headers: { authorization: 'Bearer valid-token' },
      originalUrl: '/api/auth/me',
      get: () => null,
    };
  }

  test('invalid tokens return 401', async () => {
    provider.verifyToken.mockRejectedValueOnce(new Error('bad signature'));
    const res = createResponse();
    await requireAuth(request(), res, jest.fn());
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or expired token' });
  });

  test('workspace authorization failures return 500 instead of masquerading as invalid tokens', async () => {
    workspaces.getAuthorizationState.mockRejectedValueOnce(new Error('workspace schema is unavailable'));
    const res = createResponse();
    await requireAuth(request(), res, jest.fn());
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Authentication service unavailable' });
  });
});
