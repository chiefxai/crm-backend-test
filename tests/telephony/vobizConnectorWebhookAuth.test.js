const crypto = require('crypto');

jest.mock('../../src/telephony/callRouteRepository', () => ({ getCallRouteById: jest.fn(), verifyCallRouteToken: jest.fn() }));
jest.mock('../../src/telephony/connectorAccountService', () => ({ getAccount: jest.fn() }));

const routes = require('../../src/telephony/callRouteRepository');
const accounts = require('../../src/telephony/connectorAccountService');
const { encryptJson } = require('../../src/security/channelCredentials');
const { isVobizWebhookAuthorized, requireVobizWebhook } = require('../../src/telephony/vobiz/vobizWebhookAuth');

describe('connector-scoped Vobiz webhook authentication', () => {
  const previousEncryptionKey = process.env.CHANNEL_CREDENTIALS_ENCRYPTION_KEY;
  const previousWebhookSecret = process.env.VOBIZ_WEBHOOK_SECRET;
  const previousNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.CHANNEL_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('hex');
    delete process.env.VOBIZ_WEBHOOK_SECRET;
    jest.clearAllMocks();
    routes.getCallRouteById.mockResolvedValue({
      id: 'route-1', providerKey: 'vobiz', connectorAccountId: 'account-1',
      ownerType: 'organization', orgId: 'org-1', workspaceId: 'workspace-1',
    });
    routes.verifyCallRouteToken.mockImplementation(async (routeId, token) => routeId === 'route-1' && token === 'route-secret');
    accounts.getAccount.mockImplementation(async () => ({
      credential_ciphertext: encryptJson({ authId: 'vobiz-account', authToken: 'account-secret' }),
    }));
  });

  afterAll(() => {
    if (previousEncryptionKey === undefined) delete process.env.CHANNEL_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.CHANNEL_CREDENTIALS_ENCRYPTION_KEY = previousEncryptionKey;
    if (previousWebhookSecret === undefined) delete process.env.VOBIZ_WEBHOOK_SECRET;
    else process.env.VOBIZ_WEBHOOK_SECRET = previousWebhookSecret;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });

  function signedRequest(authToken) {
    const baseUrl = 'https://api.example.com/api/vobiz/incoming';
    const nonce = 'provider-nonce';
    const signature = crypto.createHmac('sha256', authToken).update(`${baseUrl}.${nonce}`).digest('base64');
    return {
      baseUrl: '/api/vobiz', path: '/incoming', protocol: 'https', headers: {},
      query: { telephony_route_id: 'route-1', telephony_route_token: 'route-secret' }, body: {},
      get(name) {
        return ({
          host: 'api.example.com',
          'X-Vobiz-Signature-V3': signature,
          'X-Vobiz-Signature-V3-Nonce': nonce,
        })[name];
      },
    };
  }

  test('uses the assigned connector credentials and exposes the durable route context', async () => {
    const req = signedRequest('account-secret');
    expect(await isVobizWebhookAuthorized(req)).toBe(true);
    expect(routes.getCallRouteById).toHaveBeenCalledWith('route-1');
    expect(accounts.getAccount).toHaveBeenCalledWith('account-1', { ownerType: 'organization', ownerOrgId: 'org-1' });
    expect(req.telephonyCallRoute).toMatchObject({ orgId: 'org-1', workspaceId: 'workspace-1' });
  });

  test('does not fall back to legacy credentials when a route id has an invalid signature', async () => {
    const req = signedRequest('wrong-secret');
    expect(await isVobizWebhookAuthorized(req)).toBe(false);
    expect(req.telephonyCallRoute).toBeUndefined();
  });

  test('rejects a changed route ID token even when the provider signature is valid', async () => {
    const req = signedRequest('account-secret');
    req.query.telephony_route_token = 'tampered-route-token';
    expect(await isVobizWebhookAuthorized(req)).toBe(false);
    expect(accounts.getAccount).not.toHaveBeenCalled();
  });

  test('accepts a valid connector signature in production without a global webhook secret', async () => {
    process.env.NODE_ENV = 'production';
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await requireVobizWebhook(signedRequest('account-secret'), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
