'use strict';

const { validateId } = require('./kernel/scope');
const { getPool } = require('../db/pool');
const db = require('../db/repository');

function dateIso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const raw = String(value);
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(raw)
    ? raw.replace(' ', 'T') + 'Z' : raw;
  const d = new Date(normalized);
  if (!Number.isFinite(d.valueOf())) throw new TypeError('Invalid billing timestamp in storage.');
  return d.toISOString();
}
function amount(asset, units, scale) {
  return { asset, units: String(units), scale: Number(scale) };
}
function period(row) {
  if (!row) return null;
  return { id: row.id, startsAt: dateIso(row.starts_at), endsAt: dateIso(row.ends_at),
    status: row.status, termsVersion: row.terms_version == null ? null : Number(row.terms_version) };
}
function payment(row) {
  return { id: row.id, purpose: row.purpose, status: row.status,
    expectedAmount: amount(row.asset, row.expected_amount_units, row.scale),
    receivedAmount: row.received_amount_units == null ? null : amount(row.asset, row.received_amount_units, row.scale),
    submittedAt: dateIso(row.submitted_at || row.created_at), reviewedAt: dateIso(row.reviewed_at),
    informationRequest: null };
}
function invoice(row) {
  return { id: row.id, status: row.status, total: amount(row.asset, row.total_units, row.scale),
    paid: amount(row.asset, row.paid_units, row.scale), issuedAt: dateIso(row.issued_at),
    dueAt: dateIso(row.due_at) };
}
function aggregateBalances(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.grant_kind, row.asset, Number(row.scale), dateIso(row.expires_at)]);
    const current = groups.get(key) || { kind: row.grant_kind, asset: row.asset,
      scale: Number(row.scale), expiresAt: dateIso(row.expires_at), balance: 0n, held: 0n };
    current.balance += BigInt(row.balance_units);
    current.held += BigInt(row.reserved_units);
    groups.set(key, current);
  }
  return Array.from(groups.values(), item => ({
    kind: item.kind,
    available: amount(item.asset, (item.balance - item.held).toString(), item.scale),
    held: amount(item.asset, item.held.toString(), item.scale),
    expiresAt: item.expiresAt,
  }));
}

/**
 * Consistent tenant-scoped snapshot of the new billing ledger. Do not fall
 * back to legacy INR wallets: those are a separate financial system.
 */
async function readBillingOverview(orgId, { pool = getPool(), orgReader = db.getOrg, now = new Date() } = {}) {
  validateId(orgId, 'orgId');
  const org = await orgReader(orgId);
  if (!org) return null;
  const connection = await pool.connect();
  let started = false;
  try {
    await connection.query('START TRANSACTION READ ONLY');
    started = true;
    const accountRows = (await connection.query(
      'SELECT org_id FROM organization_billing_accounts WHERE org_id=?', [orgId])).rows;
    if (!accountRows.length) {
      await connection.query('COMMIT');
      started = false;
      return { uninitialized: true };
    }
    const at = now instanceof Date ? now.toISOString() : dateIso(now);
    const [periodRows, paymentRows, invoiceRows, balanceRows, termsRows] = await Promise.all([
      // Queries share one transaction snapshot, but execute sequentially on one connection
      // when the MySQL adapter queues commands.
      connection.query(`SELECT id,starts_at,ends_at,status,terms_version FROM billing_periods
        WHERE org_id=? AND status IN ('active','scheduled')
        ORDER BY starts_at ASC,id ASC LIMIT 100`, [orgId]),
      connection.query(`SELECT id,purpose,status,expected_amount_units,received_amount_units,asset,scale,submitted_at,reviewed_at,created_at
        FROM billing_payment_requests WHERE org_id=? ORDER BY created_at DESC,id DESC LIMIT 20`, [orgId]),
      connection.query(`SELECT id,status,total_units,paid_units,asset,scale,issued_at,due_at
        FROM billing_invoices WHERE org_id=? AND status IN ('open','partially_paid','overdue')
        ORDER BY due_at ASC,id ASC LIMIT 50`, [orgId]),
      connection.query(`SELECT g.grant_kind,g.expires_at,p.asset,p.scale,p.balance_units,p.reserved_units
        FROM billing_credit_positions p
        JOIN billing_credit_grants g ON g.org_id=p.org_id AND g.id=p.grant_id
        JOIN billing_credit_accounts a ON a.org_id=p.org_id AND a.id=p.account_id
        WHERE p.org_id=? AND a.account_type='organization' AND a.status='active'
          AND g.status='active' AND g.effective_at<=?
          AND (g.expires_at IS NULL OR g.expires_at>?)`, [orgId, at, at]),
      connection.query(`SELECT terms_snapshot_json FROM organization_billing_terms
        WHERE org_id=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>?)
        ORDER BY version DESC LIMIT 1`, [orgId, at, at]),
    ]);
    const active = periodRows.rows.find(row => row.status === 'active' && dateIso(row.starts_at) <= at && dateIso(row.ends_at) > at);
    const upcoming = periodRows.rows.find(row => row.status === 'scheduled' && dateIso(row.ends_at) > at);
    const termsValue = termsRows.rows[0]?.terms_snapshot_json;
    const subscriptionTerms = termsValue == null ? null : typeof termsValue === 'string' ? JSON.parse(termsValue) : termsValue;
    const result = {
      orgId,
      billingMethod: org.billingMethod === 'recharge_based' ? 'recharge_based' : 'pay_as_you_go',
      activePeriod: period(active),
      nextPeriod: period(upcoming),
      balances: aggregateBalances(balanceRows.rows),
      recentPayments: paymentRows.rows.map(payment),
      outstandingInvoices: invoiceRows.rows.map(invoice),
      subscriptionTerms,
    };
    await connection.query('COMMIT');
    started = false;
    return result;
  } catch (error) {
    if (started) await connection.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { readBillingOverview, aggregateBalances, dateIso };
