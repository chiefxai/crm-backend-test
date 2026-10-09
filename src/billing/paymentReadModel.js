'use strict';

const { validateId } = require('./kernel/scope');
const { getPool } = require('../db/pool');
const { dateIso } = require('./overviewReadModel');

const MAX_PAGE_SIZE = 100;
const STATUS_MAP = Object.freeze({ needs_clarification: 'needs_information', pending: 'pending_verification' });

function parseLimit(value) {
  if (value === undefined) return 25;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw invalidPage('limit must be an integer from 1 to 100.');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > MAX_PAGE_SIZE) throw invalidPage('limit must be an integer from 1 to 100.');
  return number;
}

function invalidPage(message) {
  const error = new TypeError(message);
  error.statusCode = 400;
  return error;
}

function decodeCursor(raw) {
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw invalidPage('Invalid payment pagination cursor.');
  }
  let value;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch (_) { throw invalidPage('Invalid payment pagination cursor.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'createdAt,id,v'
    || value.v !== 1 || typeof value.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt)) {
    throw invalidPage('Invalid payment pagination cursor.');
  }
  try { validateId(value.id, 'cursor.id'); } catch (_) { throw invalidPage('Invalid payment pagination cursor.'); }
  if (!Number.isFinite(Date.parse(value.createdAt))) throw invalidPage('Invalid payment pagination cursor.');
  return value;
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ v: 1, createdAt: dateIso(row.created_at), id: row.id })).toString('base64url');
}
function toPayment(row) {
  return {
    id: row.id,
    purpose: row.purpose,
    status: STATUS_MAP[row.status] || row.status,
    expectedAmount: { asset: row.asset, units: String(row.expected_amount_units), scale: Number(row.scale) },
    receivedAmount: row.received_amount_units == null ? null
      : { asset: row.asset, units: String(row.received_amount_units), scale: Number(row.scale) },
    submittedAt: dateIso(row.submitted_at || row.created_at),
    reviewedAt: dateIso(row.reviewed_at),
    informationRequest: null,
  };
}

/** An authenticated org-scoped page of persisted payment requests; no financial mutations. */
async function listPaymentRequests(orgId, { limit, cursor } = {}, { pool = getPool() } = {}) {
  validateId(orgId, 'orgId');
  const pageSize = parseLimit(limit);
  const after = decodeCursor(cursor);
  const args = [orgId];
  let range = '';
  if (after) {
    range = ' AND (created_at<? OR (created_at=? AND id<?))';
    const at = new Date(after.createdAt);
    args.push(at, at, after.id);
  }
  args.push(pageSize + 1);
  const result = await pool.query(`SELECT id,purpose,status,expected_amount_units,received_amount_units,asset,scale,
       submitted_at,reviewed_at,created_at
     FROM billing_payment_requests
     WHERE org_id=?${range}
     ORDER BY created_at DESC,id DESC LIMIT ?`, args);
  if (!Array.isArray(result?.rows)) throw new TypeError('Billing storage returned an invalid result.');
  const hasMore = result.rows.length > pageSize;
  const page = result.rows.slice(0, pageSize);
  return { rows: page.map(toPayment), nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null };
}

module.exports = { listPaymentRequests, parseLimit, decodeCursor, encodeCursor, toPayment };
