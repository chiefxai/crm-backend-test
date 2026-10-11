jest.mock('../src/db/repositories/workspaceRepository', () => ({}));
jest.mock('../src/db/repository', () => ({}));
jest.mock('../src/auth', () => ({ verifyToken: jest.fn(), resolveIdentity: jest.fn() }));
jest.mock('../src/observability/logger', () => ({ getLogger: () => ({ info() {}, error() {} }) }));

const provider = require('../src/auth');
const { requireAuthIdentityOnly, requirePlatformAdmin } = require('../src/middleware/auth');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('email-based platform-admin authorization', () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldProvider = process.env.AUTH_PROVIDER;
  const oldAllowlist = process.env.PLATFORM_ADMIN_EMAILS;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_PROVIDER = 'identity_platform';
    process.env.PLATFORM_ADMIN_EMAILS = 'ops@example.com';
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    if (oldProvider === undefined) delete process.env.AUTH_PROVIDER;
    else process.env.AUTH_PROVIDER = oldProvider;
    if (oldAllowlist === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
    else process.env.PLATFORM_ADMIN_EMAILS = oldAllowlist;
  });

  async function authenticate(claims) {
    provider.verifyToken.mockResolvedValue(claims);
    provider.resolveIdentity.mockImplementation(async (_token, payload) => payload);
    const req = { headers: { authorization: 'Bearer token' } };
    const res = response();
    const next = jest.fn();
    await requireAuthIdentityOnly(req, res, next);
    return { req, res, next };
  }

  test.each([undefined, false, 'true'])('rejects allowlisted addresses without boolean email_verified=%s', async (email_verified) => {
    const { req, res, next } = await authenticate({ sub: 'u1', email: 'ops@example.com', email_verified });
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.userEmail).toBeNull();
    const adminNext = jest.fn();
    requirePlatformAdmin(req, res, adminNext);
    expect(adminNext).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  test('allows an allowlisted address only when its provider claim is verified', async () => {
    const { req, res, next } = await authenticate({ sub: 'u1', email: 'ops@example.com', email_verified: true });
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.userEmail).toBe('ops@example.com');
    const adminNext = jest.fn();
    requirePlatformAdmin(req, res, adminNext);
    expect(adminNext).toHaveBeenCalledTimes(1);
  });

  test('enriches Cognito-style access tokens before deciding email verification', async () => {
    provider.verifyToken.mockResolvedValue({ sub: 'u1', token_use: 'access' });
    provider.resolveIdentity.mockResolvedValue({ sub: 'u1', email: 'ops@example.com', email_verified: true });
    const req = { headers: { authorization: 'Bearer access-token' } };
    const next = jest.fn();
    await requireAuthIdentityOnly(req, response(), next);
    expect(provider.resolveIdentity).toHaveBeenCalledWith('access-token', { sub: 'u1', token_use: 'access' });
    expect(req.userEmail).toBe('ops@example.com');
  });
});
