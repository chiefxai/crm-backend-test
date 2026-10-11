'use strict';

const { validateId } = require('./kernel/scope');
const { toPaymentApiStatus } = require('./paymentStatus');
const { getPool } = require('../db/pool');
const { dateIso } = require('./overviewReadModel');

const MAX_PAGE_SIZE = 100;

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
    || value.v !== 1 || typeof value.createdAt !== 'string' || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}$/.test(value.createdAt)) {
    throw invalidPage('Invalid payment pagination cursor.');
  }
  try { validateId(value.id, 'cursor.id'); } catch (_) { throw invalidPage('Invalid payment pagination cursor.'); }
  if (!Number.isFinite(Date.parse(value.createdAt.replace(' ', 'T') + 'Z'))) throw invalidPage('Invalid payment pagination cursor.');
  return value;
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ v: 1, createdAt: row.created_cursor, id: row.id })).toString('base64url');
}
const PAYMENT_FILTERS = new Set(['all', 'topup', 'workspace', 'subscription', 'invoice']);
function parsePaymentFilter(value) {
  if (value === undefined) return 'all';
  if (typeof value !== 'string' || !PAYMENT_FILTERS.has(value)) {
    throw invalidPage('type must be all, topup, workspace, subscription, or invoice.');
  }
  return value;
}

function toPayment(row) {
  return {
    id: row.id,
    purpose: row.purpose,
    // A generic invoice payment is not always a workspace add-on.
    // Identify workspace invoices using the persisted org-scoped cycle.
    invoiceId: row.invoice_id || null,
    workspaceAddonName: row.workspace_addon_name || null,
    status: toPaymentApiStatus(row.status),
    expectedAmount: { asset: row.asset, units: String(row.expected_amount_units), scale: Number(row.scale) },
    receivedAmount: row.received_amount_units == null ? null
      : { asset: row.asset, units: String(row.received_amount_units), scale: Number(row.scale) },
    submittedAt: dateIso(row.submitted_at || row.created_at),
    reviewedAt: dateIso(row.reviewed_at),
    informationRequest: null,
  };
}

/** An authenticated org-scoped page of persisted payment requests; no financial mutations. */
async function listPaymentRequests(orgId, { limit, cursor, type } = {}, { pool = getPool() } = {}) {
  validateId(orgId, 'orgId');
  const pageSize = parseLimit(limit);
  const after = decodeCursor(cursor);
  const filter = parsePaymentFilter(type);
  const args = [orgId];
  let range = '';
  if (after) {
    range = ' AND (p.created_at<? OR (p.created_at=? AND p.id<?))';
    args.push(after.createdAt, after.createdAt, after.id);
  }
  // Filter at the database before LIMIT so each payment-history page has
  // real matching results, even with mixed invoice/top-up submissions.
  const typeWhere = filter === 'all' ? ''
    : filter === 'workspace' ? " AND p.purpose='invoice' AND c.id IS NOT NULL"
    : filter === 'invoice' ? " AND p.purpose='invoice' AND c.id IS NULL"
    : " AND p.purpose=?";
  if (filter === 'topup' || filter === 'subscription') args.push(filter);
  args.push(pageSize + 1);
  const result = await pool.query(`SELECT p.id,p.purpose,p.invoice_id,p.status,p.expected_amount_units,p.received_amount_units,p.asset,p.scale,
       p.submitted_at,p.reviewed_at,p.created_at,DATE_FORMAT(p.created_at,'%Y-%m-%d %H:%i:%s.%f') AS created_cursor,
       a.name AS workspace_addon_name
     FROM billing_payment_requests p
     LEFT JOIN billing_workspace_addon_cycles c ON c.org_id=p.org_id AND c.invoice_id=p.invoice_id
     LEFT JOIN billing_workspace_addons a ON a.org_id=c.org_id AND a.id=c.addon_id
     WHERE p.org_id=?${typeWhere}${range}
     ORDER BY p.created_at DESC,p.id DESC LIMIT ?`, args);
  if (!Array.isArray(result?.rows)) throw new TypeError('Billing storage returned an invalid result.');
  const hasMore = result.rows.length > pageSize;
  const page = result.rows.slice(0, pageSize);
  return { rows: page.map(toPayment), nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null };
}

module.exports = { listPaymentRequests, parseLimit, parsePaymentFilter, decodeCursor, encodeCursor, toPayment };
