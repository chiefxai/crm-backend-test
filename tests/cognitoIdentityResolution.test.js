jest.mock('../src/observability/logger', () => ({
  getLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const previousRegion = process.env.COGNITO_REGION;
const previousPool = process.env.COGNITO_USER_POOL_ID;
process.env.COGNITO_REGION = 'ap-south-1';
process.env.COGNITO_USER_POOL_ID = 'ap-south-1_test';

const { CognitoIdentityProviderClient, AdminGetUserCommand, GetUserCommand } = require('@aws-sdk/client-cognito-identity-provider');
const send = jest.spyOn(CognitoIdentityProviderClient.prototype, 'send');
const { resolveIdentity } = require('../src/auth/providers/cognito');

const claims = { sub: 'user-a', username: 'signed-username', token_use: 'access', scope: 'openid profile email' };
const attributes = (sub = 'user-a', verified = 'true') => ({ UserAttributes: [
  { Name: 'sub', Value: sub },
  { Name: 'email', Value: 'admin@example.com' },
  { Name: 'email_verified', Value: verified },
] });

afterEach(() => send.mockReset());
afterAll(() => {
  send.mockRestore();
  if (previousRegion === undefined) delete process.env.COGNITO_REGION;
  else process.env.COGNITO_REGION = previousRegion;
  if (previousPool === undefined) delete process.env.COGNITO_USER_POOL_ID;
  else process.env.COGNITO_USER_POOL_ID = previousPool;
});

test('OIDC-only access tokens resolve verified email using the configured user pool', async () => {
  send.mockResolvedValue(attributes());
  const identity = await resolveIdentity('token', claims);
  const command = send.mock.calls[0][0];
  expect(command).toBeInstanceOf(AdminGetUserCommand);
  expect(command.input).toEqual({ UserPoolId: 'ap-south-1_test', Username: 'signed-username' });
  expect(identity.email).toBe('admin@example.com');
  expect(identity.email_verified).toBe(true);
});

test('self-service scoped tokens use GetUser', async () => {
  send.mockResolvedValue(attributes());
  await resolveIdentity('token', { ...claims, scope: 'aws.cognito.signin.user.admin' });
  expect(send.mock.calls[0][0]).toBeInstanceOf(GetUserCommand);
});

test('attributes for another subject cannot grant email-based privileges', async () => {
  send.mockResolvedValue(attributes('different-user'));
  expect(await resolveIdentity('token', claims)).toEqual(claims);
});

test('unverified email remains unverified', async () => {
  send.mockResolvedValue(attributes('user-a', 'false'));
  expect((await resolveIdentity('token', claims)).email_verified).toBe(false);
});

test('failed IAM lookup does not fabricate an identity', async () => {
  send.mockRejectedValue(new Error('AccessDenied'));
  expect(await resolveIdentity('token', claims)).toEqual(claims);
});

test('ID token verification claims do not require a remote lookup', async () => {
  const identity = { sub: 'user-a', email: 'admin@example.com', email_verified: true, token_use: 'id' };
  expect(await resolveIdentity('token', identity)).toEqual(identity);
  expect(send).not.toHaveBeenCalled();
});
