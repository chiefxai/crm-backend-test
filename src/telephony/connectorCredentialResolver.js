'use strict';

const db = require('../db/repository');
const registry = require('./registry');
const { decryptJson } = require('../security/channelCredentials');
const accounts = require('./connectorAccountService');

function resolverError(message, statusCode = 409, code = 'CONNECTOR_NOT_READY') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

/**
 * Resolve only an explicitly assigned, ready number for a tenant/workspace.
 * This is an internal primitive; callers must persist its safe identifiers
 * with call context before using provider credentials.
 */
async function resolveAssignedNumber({ orgId, workspaceId, phoneNumberId = null, phoneNumberE164 = null } = {}) {
  if (!orgId || !workspaceId || (!phoneNumberId && !phoneNumberE164)) {
    throw resolverError('Organization, workspace, and assigned phone number are required', 400, 'INVALID_ARGUMENT');
  }
  const identityColumn = phoneNumberId ? 'n.id' : 'n.phone_number_e164';
  const identity = phoneNumberId || phoneNumberE164;
  const { rows } = await db.pool.query(`
    SELECT n.id AS phone_number_id,n.connector_account_id,n.provider_key,n.provider_number_id,
           n.phone_number_e164,n.inventory_status,n.provisioning_status,
           a.display_name AS connector_display_name,a.owner_type,a.owner_org_id,a.status AS connector_status,
           a.credential_ciphertext,a.credential_schema_version,a.credential_version,
           assignment.id AS assignment_id,assignment.org_id,assignment.workspace_id,assignment.assigned_at
    FROM telephony_phone_numbers n
    INNER JOIN telephony_connector_accounts a ON a.id=n.connector_account_id
    INNER JOIN telephony_number_assignments assignment
      ON assignment.phone_number_id=n.id AND assignment.released_at IS NULL
    WHERE ${identityColumn}=? AND assignment.org_id=? AND assignment.workspace_id=?
    LIMIT 2`, [identity, orgId, workspaceId]);
  if (!rows.length) {
    const { rows: inventoryRows } = await db.pool.query(
      `SELECT id FROM telephony_phone_numbers WHERE ${identityColumn}=? LIMIT 1`, [identity]);
    if (inventoryRows.length) {
      throw resolverError('This connector number is not assigned to the active organization and workspace', 403, 'ASSIGNMENT_SCOPE_FORBIDDEN');
    }
    throw resolverError('No active number assignment matches this organization and workspace', 404, 'ASSIGNMENT_NOT_FOUND');
  }
  if (rows.length > 1) throw resolverError('Number assignment is ambiguous', 409, 'ASSIGNMENT_AMBIGUOUS');
  const row = rows[0];
  if (row.inventory_status !== 'assigned') throw resolverError('Assigned number inventory state is inconsistent');
  if (row.connector_status !== 'active') throw resolverError('Assigned connector account is disabled');
  if (row.provisioning_status !== 'ready') throw resolverError('Assigned number is not ready for calls');
  const provider = registry.findConnector(row.provider_key);
  if (!provider || !provider.capabilities?.outbound) throw resolverError('Assigned provider does not support outbound calls');
  const definition = accounts.getProvider(row.provider_key);
  const credentials = accounts.validateCredentials(definition,
    decryptJson(row.credential_ciphertext), null, { partial: false });
  return {
    providerKey: row.provider_key,
    connectorAccountId: row.connector_account_id,
    connectorDisplayName: row.connector_display_name,
    ownerType: row.owner_type,
    ownerOrgId: row.owner_org_id || null,
    credentialSchemaVersion: Number(row.credential_schema_version) || 1,
    credentialVersion: Number(row.credential_version) || 1,
    phoneNumberId: row.phone_number_id,
    providerNumberId: row.provider_number_id || null,
    phoneNumberE164: row.phone_number_e164,
    assignmentId: row.assignment_id,
    orgId: row.org_id,
    workspaceId: row.workspace_id,
    credentials,
  };
}

module.exports = { resolveAssignedNumber };
