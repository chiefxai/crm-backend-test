'use strict';

const { getPool } = require('../db/pool');
const { validateId } = require('./kernel/scope');
const { dateIso } = require('./overviewReadModel');

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
  return {
    id: row.id,
    orgId: row.org_id,
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
  };
}

async function listPlatformPaymentReviews({ status = 'pending_verification', limit, cursor, orgId } = {},
  { pool = getPool() } = {}) {
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
  if (status !== 'all') { where += ' AND status=?'; args.push(status); }
  if (orgId) { where += ' AND org_id=?'; args.push(orgId); }
  if (after) {
    where += ' AND (created_at<? OR (created_at=? AND id<?))';
    args.push(after.createdAt, after.createdAt, after.id);
  }
  args.push(size + 1);
  const result = await pool.query(`SELECT id,org_id,purpose,status,version,expected_amount_units,
    received_amount_units,asset,scale,payment_reference,proof_object_key,submitted_at,reviewed_at,created_at,
    DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s.%f') AS created_cursor
    FROM billing_payment_requests${where} ORDER BY created_at DESC,id DESC LIMIT ?`, args);
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
