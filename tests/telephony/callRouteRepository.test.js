'use strict';

const crypto = require('crypto');
const mockState = { query: jest.fn(), connect: jest.fn() };
jest.mock('../../src/db/repository', () => ({ pool: mockState }));

const routes = require('../../src/telephony/callRouteRepository');

function createConnection(rows = []) {
  const connection = {
    query: jest.fn(async sql => sql.includes('SELECT n.id') ? { rows } : { rows: [], affectedRows: 1 }),
    release: jest.fn(),
  };
  mockState.connect.mockResolvedValue(connection);
  return connection;
}

beforeEach(() => { mockState.query.mockReset(); mockState.connect.mockReset(); });

test('creates a durable route only for the exact active, ready assignment', async () => {
  const connection = createConnection([{
    id: 'number-1', provider_key: 'fake-voice', connector_account_id: 'connector-1',
    inventory_status: 'assigned', provisioning_status: 'ready', owner_type: 'platform',
    owner_org_id: null, connector_status: 'active', credential_version: 1, assignment_id: 'assignment-1',
    org_id: 'org-1', workspace_id: 'workspace-1',
  }]);
  const route = await routes.createCallRoute({
    orgId: 'org-1', workspaceId: 'workspace-1', providerKey: 'fake-voice',
    connectorAccountId: 'connector-1', phoneNumberId: 'number-1', assignmentId: 'assignment-1',
    ownerType: 'platform', direction: 'outbound',
  });
  expect(route).toMatchObject({ orgId: 'org-1', workspaceId: 'workspace-1', providerKey: 'fake-voice', status: 'starting' });
  expect(connection.query.mock.calls[1][0]).toContain('assignment.id=? AND assignment.released_at IS NULL');
  expect(connection.query.mock.calls[1][1]).toEqual(['assignment-1', 'org-1', 'workspace-1', 'number-1', 'connector-1', 'fake-voice']);
  expect(connection.query.mock.calls.at(-1)[0]).toBe('COMMIT');
  expect(route).not.toHaveProperty('credentials');
  expect(route.callbackToken).toHaveLength(43);
  expect(route).not.toHaveProperty('callbackSecretHash');
  expect(connection.release).toHaveBeenCalled();
});

test('rejects a changed or unready assignment and rolls back', async () => {
  const connection = createConnection([]);
  await expect(routes.createCallRoute({
    orgId: 'org-1', workspaceId: 'workspace-1', providerKey: 'fake-voice',
    connectorAccountId: 'connector-1', phoneNumberId: 'number-1', assignmentId: 'stale-assignment',
    ownerType: 'platform', direction: 'outbound',
  })).rejects.toMatchObject({ code: 'ASSIGNMENT_CHANGED', statusCode: 409 });
  expect(connection.query.mock.calls.at(-1)[0]).toBe('ROLLBACK');
});

test('rejects a credential rotation that races assigned-number resolution', async () => {
  createConnection([{
    id: 'number-1', provider_key: 'vobiz', connector_account_id: 'connector-1',
    inventory_status: 'assigned', provisioning_status: 'ready', owner_type: 'platform',
    owner_org_id: null, connector_status: 'active', credential_version: 2,
    assignment_id: 'assignment-1', org_id: 'org-1', workspace_id: 'workspace-1',
  }]);
  await expect(routes.createCallRoute({
    orgId: 'org-1', workspaceId: 'workspace-1', providerKey: 'vobiz',
    connectorAccountId: 'connector-1', phoneNumberId: 'number-1', assignmentId: 'assignment-1',
    ownerType: 'platform', direction: 'outbound', credentialVersion: 1,
  })).rejects.toMatchObject({ code: 'CREDENTIALS_ROTATED', statusCode: 409 });
});

test('persists only whitelisted call context and never credentials', async () => {
  const connection = createConnection([{
    id: 'number-1', provider_key: 'vobiz', connector_account_id: 'connector-1',
    inventory_status: 'assigned', provisioning_status: 'ready', owner_type: 'platform',
    owner_org_id: null, connector_status: 'active', credential_version: 1,
    assignment_id: 'assignment-1', org_id: 'org-1', workspace_id: 'workspace-1',
  }]);
  const route = await routes.createCallRoute({
    orgId: 'org-1', workspaceId: 'workspace-1', providerKey: 'vobiz',
    connectorAccountId: 'connector-1', phoneNumberId: 'number-1', assignmentId: 'assignment-1',
    ownerType: 'platform', callContext: { taskId: 'task-1', questions: ['Age?'], credentials: { authToken: 'secret' } },
  });
  expect(route.callContext).toEqual({ taskId: 'task-1', questions: ['Age?'] });
  const insert = connection.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO telephony_call_routes'));
  expect(insert[1].at(-2)).toBe(JSON.stringify({ taskId: 'task-1', questions: ['Age?'] }));
  expect(insert[1].join(' ')).not.toContain('secret');
});

test('attaches provider call aliases idempotently and resolves only safe route fields', async () => {
  const connection = {
    query: jest.fn(async sql => {
      if (sql.startsWith('SELECT id,provider_key')) return { rows: [{ id: 'route-1', provider_key: 'fake-voice' }] };
      if (sql.startsWith('INSERT INTO telephony_call_route_aliases')) return { rows: [] };
      return { rows: [], affectedRows: 1 };
    }),
    release: jest.fn(),
  };
  mockState.connect.mockResolvedValue(connection);
  expect(await routes.attachProviderCallIds('route-1', 'fake-voice', ['sid-1', 'sid-1', 'sid-2'])).toBe(2);
  expect(connection.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO telephony_call_route_aliases'))).toHaveLength(2);

  mockState.query.mockResolvedValue({ rows: [{ id: 'route-1', org_id: 'org-1', workspace_id: 'workspace-1',
    provider_key: 'fake-voice', connector_account_id: 'connector-1', phone_number_id: 'number-1',
    assignment_id: 'assignment-1', owner_type: 'organization', direction: 'outbound', status: 'active',
    credential_schema_version: 1, started_at: '2026-10-11T00:00:00.000Z', ended_at: null }] });
  const route = await routes.getCallRouteByProviderCallId('fake-voice', 'sid-1');
  expect(route).toMatchObject({ id: 'route-1', orgId: 'org-1', assignmentId: 'assignment-1' });
  expect(route).not.toHaveProperty('credentials');
});

test('uses constrained route state transitions and structured failure codes', async () => {
  mockState.query.mockResolvedValue({ affectedRows: 1 });
  await expect(routes.updateCallRouteStatus('route-1', 'active')).resolves.toBe(true);
  expect(mockState.query.mock.calls[0][1]).toEqual(['active', null, null, 'route-1', 'active', 'active', 'active']);
  await expect(routes.updateCallRouteStatus('route-1', 'failed', 'HTTP_503')).resolves.toBe(true);
  await expect(routes.updateCallRouteStatus('route-1', 'failed', 'provider token rejected')).rejects.toMatchObject({ statusCode: 400 });
  mockState.query.mockResolvedValue({ affectedRows: 0 });
  await expect(routes.updateCallRouteStatus('route-1', 'active')).rejects.toMatchObject({ code: 'CALL_ROUTE_STATE_CONFLICT' });
});

test('validates callback tokens without exposing the stored hash and keeps ended routes terminal', async () => {
  const token = 'a'.repeat(43);
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  mockState.query.mockResolvedValueOnce({ rows: [{ callback_secret_hash: hash }] });
  await expect(routes.verifyCallRouteToken('route-1', token)).resolves.toBe(true);
  mockState.query.mockResolvedValueOnce({ rows: [{ callback_secret_hash: hash }] });
  await expect(routes.verifyCallRouteToken('route-1', 'b'.repeat(43))).resolves.toBe(false);

  mockState.query.mockResolvedValueOnce({ affectedRows: 0 }).mockResolvedValueOnce({ rows: [{
    id: 'route-1', org_id: 'org-1', workspace_id: 'workspace-1', provider_key: 'vobiz',
    connector_account_id: 'connector-1', phone_number_id: 'number-1', assignment_id: 'assignment-1',
    owner_type: 'platform', direction: 'outbound', status: 'ended', credential_version: 1,
    started_at: '2026-10-11T00:00:00.000Z', ended_at: '2026-10-11T00:01:00.000Z',
  }] });
  await expect(routes.activateCallRoute('route-1')).resolves.toBe('ended');
});

test('claims fallback call-log creation once per durable route', async () => {
  mockState.query.mockResolvedValueOnce({ affectedRows: 1 });
  await expect(routes.claimFallbackCallLog('route-1', 'fallback-1')).resolves.toBe(true);
  expect(mockState.query.mock.calls[0][0]).toContain('fallback_call_log_id IS NULL');
  mockState.query.mockResolvedValueOnce({ affectedRows: 0 });
  await expect(routes.claimFallbackCallLog('route-1', 'fallback-1')).resolves.toBe(false);
  mockState.query.mockResolvedValueOnce({ affectedRows: 1 });
  await expect(routes.releaseFallbackCallLogClaim('route-1', 'fallback-1')).resolves.toBe(true);
});
