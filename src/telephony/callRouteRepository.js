'use strict';

const crypto = require('crypto');
const db = require('../db/repository');

function routeError(message, statusCode = 400, code = 'INVALID_ARGUMENT') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function required(value, name) {
  const text = String(value || '').trim();
  if (!text) throw routeError(`${name} is required`);
  return text;
}

function safeCallContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = ['taskId', 'leadId', 'campaignId', 'autoDialRunId', 'language', 'agentId', 'starhealthEnabled', 'retryPolicy', 'questions', 'assignedContact'];
  const result = {};
  for (const key of allowed) {
    if (value[key] === undefined) continue;
    result[key] = value[key];
  }
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json, 'utf8') > 24000) throw routeError('Call context exceeds the durable storage limit', 400, 'CALL_CONTEXT_TOO_LARGE');
  return result;
}

function safeRoute(row) {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    workspaceId: row.workspace_id,
    providerKey: row.provider_key,
    connectorAccountId: row.connector_account_id,
    phoneNumberId: row.phone_number_id,
    assignmentId: row.assignment_id,
    ownerType: row.owner_type,
    direction: row.direction,
    status: row.status,
    credentialVersion: Number(row.credential_version) || 1,
    billingReservationId: row.billing_reservation_id || null,
    fallbackCallLogId: row.fallback_call_log_id || null,
    callContext: typeof row.call_context_json === 'string'
      ? (() => { try { return JSON.parse(row.call_context_json); } catch (_) { return null; } })()
      : (row.call_context_json || null),
    startedAt: row.started_at,
    endedAt: row.ended_at || null,
  };
}

async function createCallRoute({
  orgId, workspaceId, providerKey, connectorAccountId, phoneNumberId, assignmentId,
  ownerType, direction = 'outbound', credentialVersion = 1, callContext = null,
} = {}) {
  const context = {
    orgId: required(orgId, 'orgId'), workspaceId: required(workspaceId, 'workspaceId'),
    providerKey: required(providerKey, 'providerKey'), connectorAccountId: required(connectorAccountId, 'connectorAccountId'),
    phoneNumberId: required(phoneNumberId, 'phoneNumberId'), assignmentId: required(assignmentId, 'assignmentId'),
    ownerType: required(ownerType, 'ownerType'), direction: required(direction, 'direction'),
  };
  if (!['platform', 'organization'].includes(context.ownerType)) throw routeError('Invalid connector owner type');
  if (!['inbound', 'outbound'].includes(context.direction)) throw routeError('Invalid call direction');
  const durableCallContext = safeCallContext(callContext);
  const connection = await db.pool.connect();
  const id = crypto.randomUUID();
  const callbackToken = crypto.randomBytes(32).toString('base64url');
  const callbackSecretHash = crypto.createHash('sha256').update(callbackToken).digest('hex');
  const now = new Date().toISOString();
  try {
    await connection.query('BEGIN');
    const { rows } = await connection.query(`
      SELECT n.id,n.provider_key,n.connector_account_id,n.inventory_status,n.provisioning_status,
             a.owner_type,a.owner_org_id,a.status AS connector_status,a.credential_version,
             assignment.id AS assignment_id,assignment.org_id,assignment.workspace_id
      FROM telephony_number_assignments assignment
      INNER JOIN telephony_phone_numbers n ON n.id=assignment.phone_number_id
      INNER JOIN telephony_connector_accounts a ON a.id=n.connector_account_id
      WHERE assignment.id=? AND assignment.released_at IS NULL
        AND assignment.org_id=? AND assignment.workspace_id=?
        AND n.id=? AND n.connector_account_id=? AND n.provider_key=?
      FOR UPDATE`, [context.assignmentId, context.orgId, context.workspaceId,
      context.phoneNumberId, context.connectorAccountId, context.providerKey]);
    const assignment = rows[0];
    if (!assignment) throw routeError('Active number assignment changed before call routing was recorded', 409, 'ASSIGNMENT_CHANGED');
    if (assignment.owner_type !== context.ownerType || assignment.connector_status !== 'active'
      || assignment.inventory_status !== 'assigned' || assignment.provisioning_status !== 'ready') {
      throw routeError('Assigned connector number is not ready for calls', 409, 'CONNECTOR_NOT_READY');
    }
    if (Number(assignment.credential_version) !== (Number(credentialVersion) || 1)) {
      throw routeError('Connector credentials changed before the call could be routed', 409, 'CREDENTIALS_ROTATED');
    }
    if (context.ownerType === 'organization' && assignment.owner_org_id !== context.orgId) {
      throw routeError('Organization-owned connector is outside this organization', 403, 'CONNECTOR_SCOPE_FORBIDDEN');
    }
    await connection.query(`
      INSERT INTO telephony_call_routes
        (id,org_id,workspace_id,provider_key,connector_account_id,phone_number_id,assignment_id,
         owner_type,direction,status,credential_version,callback_secret_hash,call_context_json,started_at)
      VALUES (?,?,?,?,?,?,?,?,?,'starting',?,?,?,?)`,
    [id, context.orgId, context.workspaceId, context.providerKey, context.connectorAccountId,
      context.phoneNumberId, context.assignmentId, context.ownerType, context.direction,
      Number(credentialVersion) || 1, callbackSecretHash, durableCallContext ? JSON.stringify(durableCallContext) : null, now]);
    await connection.query('COMMIT');
    return {
      id, ...context, status: 'starting', credentialVersion: Number(credentialVersion) || 1, callbackToken,
      callContext: durableCallContext, startedAt: now, endedAt: null,
    };
  } catch (error) {
    try { await connection.query('ROLLBACK'); } catch (_) { /* preserve original error */ }
    if (error.code === 'ER_DUP_ENTRY') throw routeError('Call route already exists', 409, 'CALL_ROUTE_CONFLICT');
    throw error;
  } finally { connection.release(); }
}

async function attachProviderCallIds(routeId, providerKey, providerCallIds = []) {
  const safeRouteId = required(routeId, 'routeId');
  const safeProvider = required(providerKey, 'providerKey');
  const ids = [...new Set((Array.isArray(providerCallIds) ? providerCallIds : [providerCallIds])
    .map(value => String(value || '').trim()).filter(Boolean))];
  if (!ids.length) return 0;
  const connection = await db.pool.connect();
  try {
    await connection.query('BEGIN');
    const { rows } = await connection.query('SELECT id,provider_key FROM telephony_call_routes WHERE id=? FOR UPDATE', [safeRouteId]);
    if (!rows[0]) throw routeError('Call route was not found', 404, 'CALL_ROUTE_NOT_FOUND');
    if (rows[0].provider_key !== safeProvider) throw routeError('Provider does not match call route', 409, 'PROVIDER_MISMATCH');
    let inserted = 0;
    for (const providerCallId of ids) {
      try {
        await connection.query(`INSERT INTO telephony_call_route_aliases
          (id,route_id,provider_key,provider_call_id,created_at) VALUES (?,?,?,?,?)`,
        [crypto.randomUUID(), safeRouteId, safeProvider, providerCallId, new Date().toISOString()]);
        inserted += 1;
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error;
        const { rows: existing } = await connection.query(
          'SELECT route_id FROM telephony_call_route_aliases WHERE provider_key=? AND provider_call_id=? LIMIT 1',
          [safeProvider, providerCallId]);
        if (existing[0]?.route_id !== safeRouteId) throw routeError('Provider call ID is already attached to another route', 409, 'CALL_ID_CONFLICT');
      }
    }
    await connection.query('COMMIT');
    return inserted;
  } catch (error) {
    try { await connection.query('ROLLBACK'); } catch (_) { /* preserve original error */ }
    throw error;
  } finally { connection.release(); }
}

async function getCallRouteByProviderCallId(providerKey, providerCallId) {
  const { rows } = await db.pool.query(`
    SELECT route.*,reservation.id AS billing_reservation_id FROM telephony_call_route_aliases alias
    INNER JOIN telephony_call_routes route ON route.id=alias.route_id
    LEFT JOIN recharge_billing_reservations reservation ON reservation.telephony_call_route_id=route.id
    WHERE alias.provider_key=? AND alias.provider_call_id=? LIMIT 1`,
  [required(providerKey, 'providerKey'), required(providerCallId, 'providerCallId')]);
  return safeRoute(rows[0]);
}

async function getCallRouteById(routeId) {
  const { rows } = await db.pool.query(
    `SELECT route.*,reservation.id AS billing_reservation_id FROM telephony_call_routes route
     LEFT JOIN recharge_billing_reservations reservation ON reservation.telephony_call_route_id=route.id
     WHERE route.id=? LIMIT 1`, [required(routeId, 'routeId')]);
  return safeRoute(rows[0]);
}

async function verifyCallRouteToken(routeId, token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return false;
  const { rows } = await db.pool.query(
    'SELECT callback_secret_hash FROM telephony_call_routes WHERE id=? LIMIT 1', [required(routeId, 'routeId')]);
  const expected = rows[0]?.callback_secret_hash;
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  const supplied = crypto.createHash('sha256').update(token).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'));
}

async function updateCallRouteStatus(routeId, status, failureCode = null) {
  const allowed = ['starting', 'active', 'ended', 'failed'];
  if (!allowed.includes(status)) throw routeError('Invalid call route status');
  const endedAt = ['ended', 'failed'].includes(status) ? new Date().toISOString() : null;
  const safeFailureCode = failureCode == null || failureCode === '' ? null : String(failureCode);
  if (safeFailureCode && !/^[A-Z0-9_]{1,64}$/.test(safeFailureCode)) throw routeError('failureCode must be a short uppercase code');
  if (safeFailureCode && status !== 'failed') throw routeError('failureCode is only valid for failed routes');
  const result = await db.pool.query(`UPDATE telephony_call_routes SET status=?,ended_at=?,failure_code=?
    WHERE id=? AND (status=? OR (status='starting' AND ? IN ('active','ended','failed'))
      OR (status='active' AND ? IN ('ended','failed')))` ,
  [status, endedAt, safeFailureCode, required(routeId, 'routeId'), status, status, status]);
  if (Number(result?.affectedRows || 0) === 0) {
    throw routeError('Call route was not found or its status transition is invalid', 409, 'CALL_ROUTE_STATE_CONFLICT');
  }
  return true;
}

async function activateCallRoute(routeId) {
  const id = required(routeId, 'routeId');
  const result = await db.pool.query(
    "UPDATE telephony_call_routes SET status='active' WHERE id=? AND status='starting'", [id]);
  if (Number(result?.affectedRows || 0) > 0) return 'active';
  const route = await getCallRouteById(id);
  if (route?.status === 'active' || route?.status === 'ended') return route.status;
  throw routeError('Call route was not found or its status transition is invalid', 409, 'CALL_ROUTE_STATE_CONFLICT');
}

async function claimFallbackCallLog(routeId, fallbackCallLogId) {
  const result = await db.pool.query(`UPDATE telephony_call_routes SET fallback_call_log_id=?
    WHERE id=? AND fallback_call_log_id IS NULL`, [required(fallbackCallLogId, 'fallbackCallLogId'), required(routeId, 'routeId')]);
  return Number(result?.affectedRows || 0) > 0;
}

async function releaseFallbackCallLogClaim(routeId, fallbackCallLogId) {
  const result = await db.pool.query(`UPDATE telephony_call_routes SET fallback_call_log_id=NULL
    WHERE id=? AND fallback_call_log_id=?`, [required(routeId, 'routeId'), required(fallbackCallLogId, 'fallbackCallLogId')]);
  return Number(result?.affectedRows || 0) > 0;
}

module.exports = { createCallRoute, attachProviderCallIds, getCallRouteByProviderCallId, getCallRouteById, verifyCallRouteToken, updateCallRouteStatus, activateCallRoute, claimFallbackCallLog, releaseFallbackCallLogClaim };
