'use strict';

const { validateId } = require('./kernel/scope');

function dateIso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const raw = String(value);
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw;
  const date = new Date(normalized);
  if (!Number.isFinite(date.valueOf())) throw new TypeError('Invalid billing timestamp in storage.');
  return date.toISOString();
}

function parsePage(value) {
  if (value == null) return 30;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || Number(value) > 100) {
    const error = new TypeError('limit must be an integer between 1 and 100.');
    error.statusCode = 400;
    throw error;
  }
  return Number(value);
}
function parseCursor(value) {
  if (value == null) return null;
  try {
    if (typeof value !== 'string' || value.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error();
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (!decoded || decoded.v !== 1 || typeof decoded.createdAt !== 'string'
      || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}$/.test(decoded.createdAt)) throw Error();
    validateId(decoded.id, 'cursor.id');
    if (Object.keys(decoded).sort().join(',') !== 'createdAt,id,v') throw Error();
    return decoded;
  } catch (_) {
    const error = new TypeError('Invalid payment review cursor.');
    error.statusCode = 400;
    throw error;
  }
}
function mapRow(row) {
  let subscriptionUpgrade;
  if (row.quote_type === 'adjustment' && row.quote_snapshot_json != null) {
    try {
      const snapshot = typeof row.quote_snapshot_json === 'string' ? JSON.parse(row.quote_snapshot_json) : row.quote_snapshot_json;
      const adjustment = snapshot?.adjustment;
      if (snapshot?.schemaVersion === 1 && snapshot?.purpose === 'adjustment' && adjustment?.kind === 'immediate_upgrade'
          && adjustment.currentPlan && adjustment.targetPlan && adjustment.prorationAmount && adjustment.incrementalIncludedCredits
          && typeof adjustment.renewalAnchorAt === 'string') {
        subscriptionUpgrade = {
          currentPlan: { id: adjustment.currentPlan.id, version: Number(adjustment.currentPlan.version) },
          targetPlan: { id: adjustment.targetPlan.id, version: Number(adjustment.targetPlan.version) },
          prorationAmount: adjustment.prorationAmount,
          incrementalIncludedCredits: adjustment.incrementalIncludedCredits,
          renewalAnchorAt: adjustment.renewalAnchorAt,
        };
      }
    } catch (_) { /* malformed historical quote snapshots are omitted from this read-only DTO */ }
  }
  return {
    id: row.id,
    orgId: row.org_id,
    organizationName: row.organization_name || null,
    purpose: row.purpose,
    status: row.status,
    version: Number(row.version),
    expectedAmount: { asset: row.asset, units: String(row.expected_amount_units), scale: Number(row.scale) },
    receivedAmount: row.received_amount_units == null ? null
      : { asset: row.asset, units: String(row.received_amount_units), scale: Number(row.scale) },
    paymentReference: row.payment_reference,
    proofAvailable: Boolean(row.proof_object_key),
    submittedAt: dateIso(row.submitted_at || row.created_at),
    reviewedAt: dateIso(row.reviewed_at),
    ...(row.workspace_addon_name ? {workspaceAddon:{name:row.workspace_addon_name,invoiceId:row.invoice_id}} : {}),
    ...(subscriptionUpgrade ? { subscriptionUpgrade } : {}),
  };
}

async function listPlatformPaymentReviews({ status = 'pending_verification', limit, cursor, orgId } = {},
  { pool: suppliedPool } = {}) {
  const pool = suppliedPool || require('../db/pool').getPool();
  if (!['pending_verification', 'needs_clarification', 'approved', 'rejected', 'all'].includes(status)) {
    const error = new TypeError('Invalid review status.');
    error.statusCode = 400;
    throw error;
  }
  if (orgId !== undefined) validateId(orgId, 'orgId');
  const size = parsePage(limit);
  const after = parseCursor(cursor);
  let where = ' WHERE 1=1';
  const args = [];
  if (status !== 'all') { where += ' AND billing_payment_requests.status=?'; args.push(status); }
  if (orgId) { where += ' AND billing_payment_requests.org_id=?'; args.push(orgId); }
  if (after) {
    where += ' AND (billing_payment_requests.created_at<? OR (billing_payment_requests.created_at=? AND billing_payment_requests.id<?))';
    args.push(after.createdAt, after.createdAt, after.id);
  }
  args.push(size + 1);
  const result = await pool.query(`SELECT billing_payment_requests.id,billing_payment_requests.org_id,organizations.name AS organization_name,billing_payment_requests.purpose,
    billing_payment_requests.status,billing_payment_requests.version,billing_payment_requests.expected_amount_units,
    billing_payment_requests.received_amount_units,billing_payment_requests.asset,billing_payment_requests.scale,
    billing_payment_requests.payment_reference,billing_payment_requests.proof_object_key,billing_payment_requests.submitted_at,
    billing_payment_requests.reviewed_at,billing_payment_requests.created_at,billing_payment_requests.invoice_id,
    q.quote_type,q.terms_snapshot_json AS quote_snapshot_json,
    (SELECT a.name FROM billing_workspace_addon_cycles c
      JOIN billing_workspace_addons a ON a.org_id=c.org_id AND a.id=c.addon_id
      WHERE c.org_id=billing_payment_requests.org_id AND c.invoice_id=billing_payment_requests.invoice_id LIMIT 1) AS workspace_addon_name,
    DATE_FORMAT(billing_payment_requests.created_at,'%Y-%m-%d %H:%i:%s.%f') AS created_cursor
    FROM billing_payment_requests
    LEFT JOIN organizations ON organizations.id=billing_payment_requests.org_id
    LEFT JOIN billing_quotes q
      ON q.org_id=billing_payment_requests.org_id AND q.id=billing_payment_requests.quote_id
      ${where} ORDER BY billing_payment_requests.created_at DESC,billing_payment_requests.id DESC LIMIT ?`, args);
  if (!Array.isArray(result?.rows)) throw new TypeError('Invalid billing query result.');
  const hasMore = result.rows.length > size;
  const rows = result.rows.slice(0, size);
  const last = rows[rows.length - 1];
  return {
    rows: rows.map(mapRow),
    nextCursor: hasMore ? Buffer.from(JSON.stringify({
      v: 1, createdAt: last.created_cursor, id: last.id,
    })).toString('base64url') : null,
  };
}

module.exports = { listPlatformPaymentReviews, parseCursor, parsePage, mapRow };
