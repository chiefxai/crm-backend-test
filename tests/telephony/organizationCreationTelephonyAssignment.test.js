'use strict';

const mockCalls = [];
let mockInventoryRows;
let mockUpdateRows = 1;
const mockConnection = {
  async query(sql, params = []) {
    sql = String(sql);
    mockCalls.push({ sql, params });
    if (sql.includes('FROM telephony_phone_numbers n')) return { rows: mockInventoryRows };
    if (sql.includes('UPDATE telephony_phone_numbers')) return { affectedRows: mockUpdateRows, rows: [] };
    if (sql.includes('SELECT * FROM organizations')) return { rows: [{ id: 'org-1', name: 'New Org', settings: {} }] };
    if (sql.includes('SELECT * FROM organization_cloud_projects')) return { rows: [{ id: 'cloud-1', organization_id: 'org-1', settings: {} }] };
    return { rows: [], affectedRows: 1 };
  },
  release() {},
};

jest.mock('../../src/db/client', () => ({ ready: Promise.resolve() }));
jest.mock('../../src/db/pool', () => ({ pool: { connect: jest.fn(async () => mockConnection) } }));
jest.mock('../../src/db/repositories/workspaceRepository', () => ({ ensureDefault: jest.fn(async () => {}) }));

const { createOrganizationSetup } = require('../../src/db/repositories/organizationRepository');
const platformRouter = require('../../src/routes/platform');

const baseInput = {
  name: 'New Org', workspaceName: 'new-org', industry: 'lending', subscriptionPlan: 'Starter',
  gcpProject: { projectId: 'project-1', credentialsEncrypted: 'ciphertext' },
  chargeScope: 'ai_and_call_provider', platformTelephonyNumberId: 'number-1',
};

describe('initial platform telephony number assignment during organization creation', () => {
  beforeEach(() => {
    mockCalls.length = 0;
    mockInventoryRows = [{ id: 'number-1', provider_key: 'twilio', inventory_status: 'available', provisioning_status: 'ready', connector_status: 'active' }];
    mockUpdateRows = 1;
  });

  test('assigns to the new organization default workspace in the organization transaction', async () => {
    const result = await createOrganizationSetup({ ...baseInput, platformTelephonyAssignedBy: 'admin-1' });
    const insert = mockCalls.find(({ sql }) => sql.includes('INSERT INTO telephony_number_assignments'));
    expect(insert.params.slice(1, 6)).toEqual(['number-1', expect.any(String), expect.any(String), 'admin-1', expect.any(String)]);
    expect(insert.params[2]).toBe(insert.params[3]); // default workspace id is the organization id
    expect(mockCalls.find(({ sql }) => sql.includes('FROM telephony_phone_numbers n')).sql).toContain('FOR UPDATE');
    expect(mockCalls.some(({ sql }) => sql.includes("SET inventory_status='assigned'"))).toBe(true);
    expect(mockCalls.map(({ sql }) => sql).filter((sql) => ['BEGIN', 'COMMIT'].includes(sql))).toEqual(['BEGIN', 'COMMIT']);
    expect(result.telephonyAssignment).toMatchObject({ phoneNumberId: 'number-1', providerKey: 'twilio' });
    expect(mockCalls.some(({ sql }) => sql.includes('INSERT INTO virtual_numbers'))).toBe(false);
    expect(mockCalls.some(({ sql }) => sql.includes('INSERT INTO channels'))).toBe(false);
  });

  test('rejects platform allocation when the feature is off or both provider choices are supplied', () => {
    const validate = platformRouter.validatePlatformTelephonySelection;
    expect(() => validate({ numberId: 'number-1', callProvider: null, chargeScope: 'ai_and_call_provider', enabled: false }))
      .toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(() => validate({ numberId: 'number-1', callProvider: { authId: 'a' }, chargeScope: 'ai_and_call_provider', enabled: true }))
      .toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => validate({ numberId: 'number-1', callProvider: null, chargeScope: 'ai_only', enabled: true }))
      .toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  test('allows deferred platform allocation only for the enabled AI plus phone setup', () => {
    const validate = platformRouter.validateDeferredPlatformTelephonyAllocation;
    expect(validate({ pending: true, numberId: null, callProvider: null, chargeScope: 'ai_and_call_provider', enabled: true })).toBe(true);
    expect(() => validate({ pending: true, numberId: null, callProvider: null, chargeScope: 'ai_and_call_provider', enabled: false }))
      .toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(() => validate({ pending: true, numberId: 'number-1', callProvider: null, chargeScope: 'ai_and_call_provider', enabled: true }))
      .toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => validate({ pending: true, numberId: null, callProvider: null, chargeScope: 'ai_only', enabled: true }))
      .toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => validate({ pending: false, numberId: null, callProvider: null, chargeScope: 'ai_only', enabled: false })).not.toThrow();
  });

  test.each([
    [[], 404, 'TELEPHONY_NUMBER_NOT_FOUND'],
    [[{ id: 'number-1', provider_key: 'twilio', inventory_status: 'available', provisioning_status: 'ready', connector_status: 'disabled' }], 409, 'TELEPHONY_CONNECTOR_INACTIVE'],
    [[{ id: 'number-1', provider_key: 'twilio', inventory_status: 'assigned', connector_status: 'active' }], 409, 'TELEPHONY_NUMBER_UNAVAILABLE'],
    [[{ id: 'number-1', provider_key: 'vobiz', inventory_status: 'available', provisioning_status: 'pending', connector_status: 'active' }], 409, 'TELEPHONY_NUMBER_NOT_READY'],
  ])('rolls back organization when allocation validation fails', async (rows, statusCode, code) => {
    mockInventoryRows = rows;
    await expect(createOrganizationSetup(baseInput)).rejects.toMatchObject({ statusCode, code });
    expect(mockCalls.map(({ sql }) => sql)).toContain('ROLLBACK');
    expect(mockCalls.map(({ sql }) => sql)).not.toContain('COMMIT');
  });

  test('rolls back organization when inventory status update loses a race', async () => {
    mockUpdateRows = 0;
    await expect(createOrganizationSetup(baseInput)).rejects.toMatchObject({ statusCode: 409, code: 'TELEPHONY_NUMBER_UNAVAILABLE' });
    expect(mockCalls.map(({ sql }) => sql)).toContain('ROLLBACK');
    expect(mockCalls.map(({ sql }) => sql)).not.toContain('COMMIT');
  });
});
