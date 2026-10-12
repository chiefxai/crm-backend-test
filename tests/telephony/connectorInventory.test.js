'use strict';

const { createTelephonyConnectorInventory } = require('../../src/telephony/connectorInventory');

function makeDb(respond) {
  const calls = [];
  const connection = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      return respond(String(sql), params, calls.length);
    },
    release() { calls.push({ sql: 'RELEASE', params: [] }); },
  };
  const db = {
    async connect() { return connection; },
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      return respond(String(sql), params, calls.length);
    },
  };
  return { db, calls };
}

const platformConnector = {
  id: 'acct-platform-1', provider_key: 'twilio', display_name: 'Main account',
  owner_type: 'platform', owner_org_id: null, status: 'active',
};

describe('telephony connector inventory service', () => {
  test('registers existing provider-neutral numbers without exposing credentials', async () => {
    const { db, calls } = makeDb((sql) => {
      if (sql.includes('FROM telephony_connector_accounts')) return { rows: [platformConnector] };
      return { rows: [] };
    });
    const service = createTelephonyConnectorInventory({ pool: db, idFactory: () => 'number-1', clock: () => new Date('2026-10-11T00:00:00Z') });
    const result = await service.registerExistingNumber({
      actor: { type: 'platform' }, connectorAccountId: platformConnector.id,
      phoneNumberE164: '+1 (415) 555-0132', providerNumberId: 'PN-42', displayName: 'Support',
    });
    expect(result).toEqual({
      id: 'number-1', connectorAccountId: platformConnector.id, providerKey: 'twilio',
      phoneNumberE164: '+14155550132', displayName: 'Support', inventoryStatus: 'available', provisioningStatus: 'pending',
    });
    expect(calls.some(({ sql }) => sql.includes('credential_ciphertext'))).toBe(false);
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO telephony_phone_numbers'))).toBe(true);
    expect(calls.map(({ sql }) => sql).filter((sql) => ['BEGIN', 'COMMIT'].includes(sql))).toEqual(['BEGIN', 'COMMIT']);
  });

  test('allocates a verified platform number to an organization without assigning a workspace', async () => {
    const { db, calls } = makeDb((sql) => {
      if (sql.includes('FROM telephony_phone_numbers n')) return { rows: [{
        id: 'number-1', inventory_status: 'available', provisioning_status: 'ready',
        owner_type: 'platform', owner_org_id: null, connector_status: 'active',
      }] };
      if (sql.includes('FROM organizations')) return { rows: [{ id: 'org-1' }] };
      return { rows: [] };
    });
    const service = createTelephonyConnectorInventory({ pool: db, idFactory: () => 'allocation-1', clock: () => new Date('2026-10-11T00:00:00Z') });
    const allocation = await service.allocateNumber({ actor: { type: 'platform' }, phoneNumberId: 'number-1', orgId: 'org-1', allocatedBy: 'admin-1' });
    expect(allocation).toMatchObject({ id: 'allocation-1', phoneNumberId: 'number-1', orgId: 'org-1' });
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO telephony_number_allocations'))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO telephony_number_assignments'))).toBe(false);
    expect(calls.some(({ sql }) => sql.includes("inventory_status='allocated'"))).toBe(true);
  });

  test('assigns then releases under row lock and keeps assignment history', async () => {
    const { db, calls } = makeDb((sql) => {
      if (sql.includes('FROM telephony_phone_numbers n')) return { rows: [{
        id: 'number-1', connector_account_id: platformConnector.id, inventory_status: 'available',
        provisioning_status: 'ready',
        owner_type: 'platform', owner_org_id: null, connector_status: 'active',
      }] };
      if (sql.includes('FROM workspaces')) return { rows: [{ id: 'ws-1' }] };
      if (sql.includes('FROM telephony_number_allocations')) return { rows: [{ id: 'allocation-1' }] };
      if (sql.includes('FROM telephony_number_assignments') && sql.includes('ORDER BY assigned_at')) return { rows: [{ id: 'assignment-2' }] };
      if (sql.includes('FROM telephony_number_assignments')) return { rows: [] };
      if (sql.includes('SET inventory_status')) return { rows: [], affectedRows: 1 };
      return { rows: [] };
    });
    let nextId = 0;
    const service = createTelephonyConnectorInventory({ pool: db, idFactory: () => `assignment-${++nextId}`, clock: () => new Date('2026-10-11T00:00:00Z') });
    const assignment = await service.assignNumber({ actor: { type: 'organization', orgId: 'org-1' }, phoneNumberId: 'number-1', orgId: 'org-1', workspaceId: 'ws-1' });
    expect(assignment).toMatchObject({ id: 'assignment-1', phoneNumberId: 'number-1', orgId: 'org-1', workspaceId: 'ws-1' });
    const release = await service.releaseNumber({ actor: { type: 'organization', orgId: 'org-1' }, phoneNumberId: 'number-1', orgId: 'org-1', reason: 'Customer moved number' });
    expect(release).toMatchObject({ id: 'assignment-2', phoneNumberId: 'number-1', releasedAt: '2026-10-11T00:00:00.000Z' });
    expect(calls.filter(({ sql }) => sql.includes('FOR UPDATE')).length).toBeGreaterThanOrEqual(3);
    expect(calls.some(({ sql }) => sql.includes('UPDATE telephony_number_assignments'))).toBe(true);
    expect(calls.some(({ sql }) => sql.startsWith('DELETE'))).toBe(false);
  });

  test('blocks organization-owned connector numbers from assignment to a different organization', async () => {
    const { db, calls } = makeDb((sql) => {
      if (sql.includes('FROM telephony_phone_numbers n')) return { rows: [{
        id: 'number-org', connector_account_id: 'acct-org', inventory_status: 'available',
        owner_type: 'organization', owner_org_id: 'org-owner', connector_status: 'active',
      }] };
      return { rows: [] };
    });
    const service = createTelephonyConnectorInventory({ pool: db });
    await expect(service.assignNumber({
      actor: { type: 'organization', orgId: 'org-owner' }, phoneNumberId: 'number-org', orgId: 'other-org', workspaceId: 'ws-other',
    })).rejects.toMatchObject({ statusCode: 403, code: 'NUMBER_OWNER_MISMATCH' });
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO telephony_number_assignments'))).toBe(false);
    expect(calls.some(({ sql }) => sql === 'ROLLBACK')).toBe(true);
  });

  test('lists only account fields in the requested owner scope', async () => {
    const { db, calls } = makeDb((sql, params) => {
      expect(sql).toContain("a.owner_type='organization' AND a.owner_org_id=?");
      expect(sql).toContain('telephony_number_allocations');
      expect(params).toEqual(['org-9', 'org-9', 'acct-9']);
      return { rows: [{ id: 'number-9', phone_number_e164: '+14155550132' }] };
    });
    const service = createTelephonyConnectorInventory({ pool: db });
    await service.listInventory({ actor: { type: 'organization', orgId: 'org-9' }, connectorAccountId: 'acct-9' });
    expect(calls[0].sql).not.toContain('credential_ciphertext');
    expect(calls[0].sql).not.toContain('provider_metadata_json');
  });

  test('lists only ready assignments for the active workspace without credentials', async () => {
    const { db, calls } = makeDb((sql, params) => {
      expect(sql).toContain("assignment.org_id=? AND assignment.workspace_id=? AND assignment.released_at IS NULL");
      expect(sql).toContain("n.provisioning_status='ready'");
      expect(params).toEqual(['org-1', 'workspace-1']);
      return { rows: [{ id: 'number-1', phone_number_e164: '+14155550132' }] };
    });
    const service = createTelephonyConnectorInventory({ pool: db });
    await service.listAssignedNumbers({ orgId: 'org-1', workspaceId: 'workspace-1' });
    expect(calls[0].sql).not.toContain('credential_ciphertext');
  });

  test('requires the connector owner to explicitly verify a number before it becomes routable', async () => {
    const { db, calls } = makeDb(sql => {
      if (sql.includes('FROM telephony_phone_numbers n')) return { rows: [{
        id: 'number-1', connector_account_id: platformConnector.id, provisioning_status: 'pending',
        owner_type: 'platform', owner_org_id: null, connector_status: 'active',
      }] };
      return { rows: [] };
    });
    const service = createTelephonyConnectorInventory({ pool: db, clock: () => new Date('2026-10-11T00:00:00Z') });
    await expect(service.markNumberReady({ actor: { type: 'organization', orgId: 'org-1' }, phoneNumberId: 'number-1' }))
      .rejects.toMatchObject({ code: 'CONNECTOR_SCOPE_FORBIDDEN', statusCode: 403 });
    await expect(service.markNumberReady({ actor: { type: 'platform' }, phoneNumberId: 'number-1' }))
      .resolves.toEqual({ id: 'number-1', provisioningStatus: 'ready' });
    expect(calls.some(({ sql }) => sql.includes("SET provisioning_status='ready'"))).toBe(true);
  });
});
