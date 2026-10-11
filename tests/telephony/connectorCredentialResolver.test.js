'use strict';

const mockState = { query: jest.fn(), credentials: { authId: 'acct-1', authToken: 'secret-1' } };
jest.mock('../../src/db/repository', () => ({ pool: { query: mockState.query } }));
jest.mock('../../src/telephony/registry', () => ({ findConnector: jest.fn(key => key === 'fake-voice' ? { capabilities: { outbound: true } } : null) }));
jest.mock('../../src/telephony/connectorAccountService', () => ({
  getProvider: jest.fn(() => ({ credentialSchema: [{ key: 'authId', required: true }, { key: 'authToken', required: true }] })),
  validateCredentials: jest.fn((provider, credentials) => credentials),
}));
jest.mock('../../src/security/channelCredentials', () => ({ decryptJson: jest.fn(() => mockState.credentials) }));

const resolver = require('../../src/telephony/connectorCredentialResolver');

beforeEach(() => mockState.query.mockReset());

test('resolves credentials only for an active, ready assignment in the exact workspace', async () => {
  mockState.query.mockResolvedValue({ rows: [{
    phone_number_id: 'number-1', connector_account_id: 'connector-1', provider_key: 'fake-voice',
    provider_number_id: 'line-1', phone_number_e164: '+14155550123', inventory_status: 'assigned',
    provisioning_status: 'ready', connector_display_name: 'Org voice', owner_type: 'organization',
    owner_org_id: 'org-1', connector_status: 'active', credential_ciphertext: 'encrypted',
    assignment_id: 'assignment-1', org_id: 'org-1', workspace_id: 'workspace-1',
  }] });
  const result = await resolver.resolveAssignedNumber({ orgId: 'org-1', workspaceId: 'workspace-1', phoneNumberE164: '+14155550123' });
  expect(result).toMatchObject({ providerKey: 'fake-voice', connectorAccountId: 'connector-1', phoneNumberId: 'number-1', assignmentId: 'assignment-1', credentials: mockState.credentials });
  expect(mockState.query.mock.calls[0][0]).toContain('assignment.workspace_id=?');
  expect(mockState.query.mock.calls[0][1]).toEqual(['+14155550123', 'org-1', 'workspace-1']);
});

test('refuses numbers that are not ready before returning credential context', async () => {
  mockState.query.mockResolvedValue({ rows: [{
    phone_number_id: 'number-1', connector_account_id: 'connector-1', provider_key: 'fake-voice',
    phone_number_e164: '+14155550123', inventory_status: 'assigned', provisioning_status: 'pending',
    connector_status: 'active', credential_ciphertext: 'encrypted', assignment_id: 'assignment-1',
    org_id: 'org-1', workspace_id: 'workspace-1',
  }] });
  await expect(resolver.resolveAssignedNumber({ orgId: 'org-1', workspaceId: 'workspace-1', phoneNumberId: 'number-1' }))
    .rejects.toMatchObject({ code: 'CONNECTOR_NOT_READY', message: 'Assigned number is not ready for calls' });
});

test('does not allow an inventory number owned by another workspace to fall back to legacy routing', async () => {
  mockState.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'number-1' }] });
  await expect(resolver.resolveAssignedNumber({ orgId: 'org-1', workspaceId: 'workspace-2', phoneNumberE164: '+14155550123' }))
    .rejects.toMatchObject({ code: 'ASSIGNMENT_SCOPE_FORBIDDEN', statusCode: 403 });
});
