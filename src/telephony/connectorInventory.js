'use strict';

const crypto = require('crypto');

function inventoryError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function requireText(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) throw inventoryError(`${field} is required`, 400, 'INVALID_ARGUMENT');
  return normalized;
}

function normalizeE164(value) {
  const phoneNumber = String(value || '').trim().replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
    throw inventoryError('Phone number must be a valid E.164 number', 400, 'INVALID_PHONE_NUMBER');
  }
  return phoneNumber;
}

function ownerScope(ownerType, ownerOrgId) {
  if (ownerType === 'platform') {
    if (ownerOrgId) throw inventoryError('Platform connector scope must not include an organization', 400, 'INVALID_OWNER_SCOPE');
    return { ownerType, ownerOrgId: null };
  }
  if (ownerType === 'organization' && ownerOrgId) {
    return { ownerType, ownerOrgId: requireText(ownerOrgId, 'ownerOrgId') };
  }
  throw inventoryError('A valid connector owner scope is required', 400, 'INVALID_OWNER_SCOPE');
}

function assertActorOwnsConnector(actor, connector) {
  const scope = ownerScope(actor?.type, actor?.orgId || null);
  if (scope.ownerType !== connector.owner_type || scope.ownerOrgId !== (connector.owner_org_id || null)) {
    throw inventoryError('Connector is outside the caller’s owner scope', 403, 'CONNECTOR_SCOPE_FORBIDDEN');
  }
}

function createTelephonyConnectorInventory({ pool, idFactory = () => crypto.randomUUID(), clock = () => new Date() } = {}) {
  async function getPool() {
    if (pool) return pool;
    return require('../db/pool').pool;
  }

  async function withTransaction(work) {
    const db = await getPool();
    const connection = await db.connect();
    try {
      await connection.query('BEGIN');
      const result = await work(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      try { await connection.query('ROLLBACK'); } catch (_) { /* retain original error */ }
      throw error;
    } finally {
      connection.release();
    }
  }

  async function getConnectorForUpdate(connection, connectorAccountId) {
    const { rows } = await connection.query(`
      SELECT id, provider_key, display_name, owner_type, owner_org_id, status
      FROM telephony_connector_accounts
      WHERE id=?
      FOR UPDATE`, [requireText(connectorAccountId, 'connectorAccountId')]);
    if (!rows[0]) throw inventoryError('Connector account was not found', 404, 'CONNECTOR_NOT_FOUND');
    if (rows[0].status !== 'active') throw inventoryError('Connector account is not active', 409, 'CONNECTOR_INACTIVE');
    return rows[0];
  }

  async function listInventory({ actor, connectorAccountId = null } = {}) {
    const scope = ownerScope(actor?.type, actor?.orgId || null);
    const db = await getPool();
    const params = scope.ownerType === 'organization' ? [scope.ownerOrgId, scope.ownerOrgId] : [];
    let connectorFilter = '';
    if (connectorAccountId) {
      connectorFilter = ' AND a.id=?';
      params.push(requireText(connectorAccountId, 'connectorAccountId'));
    }
    const ownershipFilter = scope.ownerType === 'platform'
      ? "a.owner_type='platform'"
      : "((a.owner_type='organization' AND a.owner_org_id=?) OR EXISTS (SELECT 1 FROM telephony_number_allocations allocation WHERE allocation.phone_number_id=n.id AND allocation.org_id=? AND allocation.released_at IS NULL))";
    const { rows } = await db.query(`
      SELECT n.id, n.connector_account_id, n.provider_key, n.provider_number_id,
             n.phone_number_e164, n.display_name, n.inventory_status,
             n.provisioning_status, n.created_at, n.updated_at,
             a.display_name AS connector_display_name, a.owner_type, a.owner_org_id,
             active_assignment.org_id AS assigned_org_id,
             active_assignment.id AS assignment_id,
             active_assignment.workspace_id AS assigned_workspace_id,
             assigned_workspace.name AS assigned_workspace_name,
             active_allocation.org_id AS allocated_org_id,
             allocated_org.name AS allocated_org_name,
             active_allocation.id AS allocation_id,
             active_assignment.assigned_at
      FROM telephony_phone_numbers n
      INNER JOIN telephony_connector_accounts a ON a.id=n.connector_account_id
      LEFT JOIN telephony_number_assignments active_assignment
        ON active_assignment.phone_number_id=n.id AND active_assignment.released_at IS NULL
      LEFT JOIN workspaces assigned_workspace ON assigned_workspace.id=active_assignment.workspace_id
      LEFT JOIN telephony_number_allocations active_allocation
        ON active_allocation.phone_number_id=n.id AND active_allocation.released_at IS NULL
      LEFT JOIN organizations allocated_org ON allocated_org.id=active_allocation.org_id
      WHERE ${ownershipFilter}${connectorFilter}
      ORDER BY a.display_name, n.phone_number_e164`, params);
    // Explicit projection intentionally excludes encrypted credentials and provider metadata.
    return rows;
  }

  async function listWorkspaces({ orgId, search = '' } = {}) {
    const targetOrgId = requireText(orgId, 'orgId');
    const term = String(search || '').trim().slice(0, 100);
    const db = await getPool();
    const params = [targetOrgId];
    const filter = term ? ' AND name LIKE ?' : '';
    if (term) params.push(`%${term}%`);
    const { rows } = await db.query(`SELECT id,name FROM workspaces WHERE org_id=?${filter} ORDER BY name LIMIT 100`, params);
    return rows;
  }

  async function allocateNumber({ actor, phoneNumberId, orgId, allocatedBy = null } = {}) {
    if (actor?.type !== 'platform') throw inventoryError('Only platform admins can allocate platform numbers', 403, 'PLATFORM_REQUIRED');
    const targetOrgId = requireText(orgId, 'orgId');
    return withTransaction(async (connection) => {
      const { rows } = await connection.query(`SELECT n.id,n.inventory_status,n.provisioning_status,a.owner_type,a.owner_org_id,a.status AS connector_status FROM telephony_phone_numbers n INNER JOIN telephony_connector_accounts a ON a.id=n.connector_account_id WHERE n.id=? FOR UPDATE`, [requireText(phoneNumberId, 'phoneNumberId')]);
      const number = rows[0];
      if (!number) throw inventoryError('Phone number was not found', 404, 'PHONE_NUMBER_NOT_FOUND');
      assertActorOwnsConnector(actor, number);
      if (number.owner_type !== 'platform') throw inventoryError('Only platform-owned numbers can be allocated', 400, 'NUMBER_NOT_PLATFORM_OWNED');
      if (number.connector_status !== 'active') throw inventoryError('Connector account is not active', 409, 'CONNECTOR_INACTIVE');
      if (number.provisioning_status !== 'ready') throw inventoryError('Phone number must be verified before allocation', 409, 'PHONE_NUMBER_NOT_READY');
      if (number.inventory_status !== 'available') throw inventoryError('Phone number is not available', 409, 'PHONE_NUMBER_UNAVAILABLE');
      const { rows: orgRows } = await connection.query('SELECT id FROM organizations WHERE id=? LIMIT 1', [targetOrgId]);
      if (!orgRows[0]) throw inventoryError('Organization was not found', 404, 'ORGANIZATION_NOT_FOUND');
      const now = clock().toISOString(); const id = idFactory();
      await connection.query('INSERT INTO telephony_number_allocations (id,phone_number_id,org_id,allocated_by,allocated_at) VALUES (?,?,?,?,?)', [id, number.id, targetOrgId, allocatedBy, now]);
      await connection.query("UPDATE telephony_phone_numbers SET inventory_status='allocated',updated_at=? WHERE id=?", [now, number.id]);
      return { id, phoneNumberId: number.id, orgId: targetOrgId, allocatedAt: now };
    });
  }

  async function releaseAllocation({ actor, phoneNumberId, orgId, releasedBy = null, reason = null } = {}) {
    if (actor?.type !== 'platform') throw inventoryError('Only platform admins can reclaim platform numbers', 403, 'PLATFORM_REQUIRED');
    const targetOrgId = requireText(orgId, 'orgId');
    return withTransaction(async (connection) => {
      const { rows } = await connection.query('SELECT n.id,n.connector_account_id,a.owner_type,a.owner_org_id FROM telephony_phone_numbers n INNER JOIN telephony_connector_accounts a ON a.id=n.connector_account_id WHERE n.id=? FOR UPDATE', [requireText(phoneNumberId, 'phoneNumberId')]);
      const number = rows[0];
      if (!number) throw inventoryError('Phone number was not found', 404, 'PHONE_NUMBER_NOT_FOUND');
      assertActorOwnsConnector(actor, number);
      const { rows: allocations } = await connection.query('SELECT id FROM telephony_number_allocations WHERE phone_number_id=? AND org_id=? AND released_at IS NULL LIMIT 1 FOR UPDATE', [number.id, targetOrgId]);
      if (!allocations[0]) throw inventoryError('No active organization allocation exists', 404, 'ACTIVE_ALLOCATION_NOT_FOUND');
      const { rows: assignments } = await connection.query('SELECT id FROM telephony_number_assignments WHERE phone_number_id=? AND released_at IS NULL LIMIT 1 FOR UPDATE', [number.id]);
      if (assignments[0]) throw inventoryError('Unassign the number from its workspace before reclaiming it', 409, 'NUMBER_ASSIGNED_TO_WORKSPACE');
      const now = clock().toISOString(); const safeReason = reason == null ? null : String(reason).trim().slice(0,1000) || null;
      await connection.query('UPDATE telephony_number_allocations SET released_by=?,released_at=?,release_reason=? WHERE id=? AND released_at IS NULL', [releasedBy, now, safeReason, allocations[0].id]);
      await connection.query("UPDATE telephony_phone_numbers SET inventory_status='available',updated_at=? WHERE id=?", [now, number.id]);
      return { id: allocations[0].id, phoneNumberId: number.id, orgId: targetOrgId, releasedAt: now, releaseReason: safeReason };
    });
  }

  async function listAssignedNumbers({ orgId, workspaceId } = {}) {
    const targetOrgId = requireText(orgId, 'orgId');
    const targetWorkspaceId = requireText(workspaceId, 'workspaceId');
    const db = await getPool();
    const { rows } = await db.query(`
      SELECT n.id,n.provider_key,n.phone_number_e164,n.display_name,n.provisioning_status,
             account.display_name AS connector_display_name,account.owner_type,
             assignment.id AS assignment_id
      FROM telephony_number_assignments assignment
      INNER JOIN telephony_phone_numbers n ON n.id=assignment.phone_number_id
      INNER JOIN telephony_connector_accounts account ON account.id=n.connector_account_id
      WHERE assignment.org_id=? AND assignment.workspace_id=? AND assignment.released_at IS NULL
        AND account.status='active' AND n.inventory_status='assigned' AND n.provisioning_status='ready'
      ORDER BY n.phone_number_e164,assignment.assigned_at`, [targetOrgId, targetWorkspaceId]);
    return rows;
  }

  async function markNumberReady({ actor, phoneNumberId } = {}) {
    return withTransaction(async (connection) => {
      const { rows } = await connection.query(`
        SELECT n.id,n.connector_account_id,n.provisioning_status,a.owner_type,a.owner_org_id,a.status AS connector_status
        FROM telephony_phone_numbers n
        INNER JOIN telephony_connector_accounts a ON a.id=n.connector_account_id
        WHERE n.id=? FOR UPDATE`, [requireText(phoneNumberId, 'phoneNumberId')]);
      const number = rows[0];
      if (!number) throw inventoryError('Phone number was not found', 404, 'PHONE_NUMBER_NOT_FOUND');
      assertActorOwnsConnector(actor, number);
      if (number.connector_status !== 'active') throw inventoryError('Connector account is not active', 409, 'CONNECTOR_INACTIVE');
      if (number.provisioning_status === 'ready') return { id: number.id, provisioningStatus: 'ready' };
      const now = clock().toISOString();
      await connection.query(`UPDATE telephony_phone_numbers SET provisioning_status='ready',updated_at=? WHERE id=?`, [now, number.id]);
      return { id: number.id, provisioningStatus: 'ready' };
    });
  }

  async function registerExistingNumber({ actor, connectorAccountId, phoneNumberE164, providerNumberId = null, displayName = null } = {}) {
    const phoneNumber = normalizeE164(phoneNumberE164);
    const safeProviderNumberId = providerNumberId == null ? null : requireText(providerNumberId, 'providerNumberId');
    const safeDisplayName = displayName == null ? null : String(displayName).trim().slice(0, 191) || null;
    return withTransaction(async (connection) => {
      const connector = await getConnectorForUpdate(connection, connectorAccountId);
      assertActorOwnsConnector(actor, connector);
      const now = clock().toISOString();
      const numberId = idFactory();
      await connection.query(`
        INSERT INTO telephony_phone_numbers
          (id, connector_account_id, provider_key, provider_number_id, phone_number_e164,
           display_name, inventory_status, provisioning_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'available', 'pending', ?, ?)`,
      [numberId, connector.id, connector.provider_key, safeProviderNumberId, phoneNumber, safeDisplayName, now, now]);
      return {
        id: numberId,
        connectorAccountId: connector.id,
        providerKey: connector.provider_key,
        phoneNumberE164: phoneNumber,
        displayName: safeDisplayName,
        inventoryStatus: 'available',
        provisioningStatus: 'pending',
      };
    });
  }

  async function assignNumber({ actor, phoneNumberId, orgId, workspaceId, assignedBy = null } = {}) {
    const targetOrgId = requireText(orgId, 'orgId');
    const targetWorkspaceId = requireText(workspaceId, 'workspaceId');
    return withTransaction(async (connection) => {
      const { rows } = await connection.query(`
        SELECT n.id, n.connector_account_id, n.inventory_status, n.provisioning_status, a.owner_type, a.owner_org_id, a.status AS connector_status
        FROM telephony_phone_numbers n
        INNER JOIN telephony_connector_accounts a ON a.id=n.connector_account_id
        WHERE n.id=?
        FOR UPDATE`, [requireText(phoneNumberId, 'phoneNumberId')]);
      const number = rows[0];
      if (!number) throw inventoryError('Phone number was not found', 404, 'PHONE_NUMBER_NOT_FOUND');
      if (number.owner_type === 'organization') assertActorOwnsConnector(actor, number);
      else if (actor?.type !== 'organization') assertActorOwnsConnector(actor, number);
      if (number.connector_status !== 'active') throw inventoryError('Connector account is not active', 409, 'CONNECTOR_INACTIVE');
      if (number.owner_type === 'organization' && number.owner_org_id !== targetOrgId) {
        throw inventoryError('Organization-owned connector numbers can only be assigned within their owning organization', 403, 'NUMBER_OWNER_MISMATCH');
      }
      if (number.owner_type === 'platform') {
        if (actor?.type !== 'organization' || actor.orgId !== targetOrgId) throw inventoryError('Platform inventory must be assigned by its allocated organization admin', 403, 'NUMBER_OWNER_MISMATCH');
        const { rows: allocationRows } = await connection.query('SELECT id FROM telephony_number_allocations WHERE phone_number_id=? AND org_id=? AND released_at IS NULL LIMIT 1 FOR UPDATE', [number.id, targetOrgId]);
        if (!allocationRows[0]) throw inventoryError('Platform number is not allocated to this organization', 403, 'NUMBER_NOT_ALLOCATED_TO_ORG');
      }
      if (number.provisioning_status !== 'ready') throw inventoryError('Phone number must be verified before assignment', 409, 'PHONE_NUMBER_NOT_READY');
      if (!['available', 'allocated'].includes(number.inventory_status)) throw inventoryError('Phone number is not available for assignment', 409, 'PHONE_NUMBER_UNAVAILABLE');
      const { rows: workspaceRows } = await connection.query(
        'SELECT id FROM workspaces WHERE org_id=? AND id=? LIMIT 1', [targetOrgId, targetWorkspaceId]);
      if (!workspaceRows[0]) throw inventoryError('Workspace does not belong to the target organization', 400, 'WORKSPACE_ORG_MISMATCH');
      const { rows: activeRows } = await connection.query(
        'SELECT id FROM telephony_number_assignments WHERE phone_number_id=? AND released_at IS NULL LIMIT 1 FOR UPDATE', [number.id]);
      if (activeRows[0]) throw inventoryError('Phone number already has an active assignment', 409, 'PHONE_NUMBER_ALREADY_ASSIGNED');
      const now = clock().toISOString();
      const assignmentId = idFactory();
      await connection.query(`
        INSERT INTO telephony_number_assignments
          (id, phone_number_id, org_id, workspace_id, assigned_by, assigned_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      [assignmentId, number.id, targetOrgId, targetWorkspaceId, assignedBy, now]);
      await connection.query(`
        UPDATE telephony_phone_numbers SET inventory_status='assigned', updated_at=?
        WHERE id=?`, [now, number.id]);
      return { id: assignmentId, phoneNumberId: number.id, orgId: targetOrgId, workspaceId: targetWorkspaceId, assignedAt: now };
    });
  }

  async function releaseNumber({ actor, phoneNumberId, orgId, workspaceId = null, releasedBy = null, reason = null } = {}) {
    const targetOrgId = requireText(orgId, 'orgId');
    const safeReason = reason == null ? null : String(reason).trim().slice(0, 1000) || null;
    return withTransaction(async (connection) => {
      const { rows } = await connection.query(`
        SELECT n.id, n.connector_account_id, n.inventory_status, a.owner_type, a.owner_org_id
        FROM telephony_phone_numbers n
        INNER JOIN telephony_connector_accounts a ON a.id=n.connector_account_id
        WHERE n.id=?
        FOR UPDATE`, [requireText(phoneNumberId, 'phoneNumberId')]);
      const number = rows[0];
      if (!number) throw inventoryError('Phone number was not found', 404, 'PHONE_NUMBER_NOT_FOUND');
      if (number.owner_type === 'organization') assertActorOwnsConnector(actor, number);
      else if (actor?.type !== 'organization') assertActorOwnsConnector(actor, number);
      if (number.owner_type === 'organization' && number.owner_org_id !== targetOrgId) {
        throw inventoryError('Organization-owned connector numbers can only be released within their owning organization', 403, 'NUMBER_OWNER_MISMATCH');
      }
      const { rows: assignmentRows } = await connection.query(`
        SELECT id FROM telephony_number_assignments
        WHERE phone_number_id=? AND org_id=? AND released_at IS NULL${workspaceId ? ' AND workspace_id=?' : ''}
        ORDER BY assigned_at DESC LIMIT 1 FOR UPDATE`, workspaceId ? [number.id, targetOrgId, requireText(workspaceId, 'workspaceId')] : [number.id, targetOrgId]);
      const assignment = assignmentRows[0];
      if (!assignment) throw inventoryError('No active assignment exists for this organization', 404, 'ACTIVE_ASSIGNMENT_NOT_FOUND');
      const now = clock().toISOString();
      await connection.query(`
        UPDATE telephony_number_assignments
        SET released_by=?, released_at=?, release_reason=?
        WHERE id=? AND released_at IS NULL`, [releasedBy, now, safeReason, assignment.id]);
      let nextStatus = 'available';
      if (number.owner_type === 'platform') {
        const { rows: allocations } = await connection.query('SELECT id FROM telephony_number_allocations WHERE phone_number_id=? AND org_id=? AND released_at IS NULL LIMIT 1', [number.id, targetOrgId]);
        if (allocations[0]) nextStatus = 'allocated';
      }
      await connection.query('UPDATE telephony_phone_numbers SET inventory_status=?,updated_at=? WHERE id=?', [nextStatus, now, number.id]);
      return { id: assignment.id, phoneNumberId: number.id, orgId: targetOrgId, releasedAt: now, releaseReason: safeReason };
    });
  }

  return { listInventory, listWorkspaces, listAssignedNumbers, markNumberReady, registerExistingNumber, allocateNumber, releaseAllocation, assignNumber, releaseNumber };
}

const defaultService = createTelephonyConnectorInventory();
module.exports = {
  createTelephonyConnectorInventory,
  listInventory: (...args) => defaultService.listInventory(...args),
  listWorkspaces: (...args) => defaultService.listWorkspaces(...args),
  listAssignedNumbers: (...args) => defaultService.listAssignedNumbers(...args),
  markNumberReady: (...args) => defaultService.markNumberReady(...args),
  registerExistingNumber: (...args) => defaultService.registerExistingNumber(...args),
  allocateNumber: (...args) => defaultService.allocateNumber(...args),
  releaseAllocation: (...args) => defaultService.releaseAllocation(...args),
  assignNumber: (...args) => defaultService.assignNumber(...args),
  releaseNumber: (...args) => defaultService.releaseNumber(...args),
};
