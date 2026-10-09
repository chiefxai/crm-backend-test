'use strict';

const { getPool } = require('../db/pool');
const { validateId } = require('./kernel/scope');

const MAX_FINDINGS = 100;

// Every finding is evidence for investigation, NOT authorization to change balances.
const CHECKS = Object.freeze([
  Object.freeze({
    code: 'ACTIVE_SUBSCRIPTION_UNFUNDED',
    severity: 'critical',
    sql: `SELECT p.org_id,p.id AS entity_id
      FROM billing_periods p
      WHERE p.org_id=? AND p.period_kind='subscription' AND p.status='active'
        AND NOT EXISTS (
          SELECT 1 FROM billing_payment_fulfillments f
          JOIN billing_payment_requests r ON r.org_id=f.org_id AND r.id=f.payment_request_id
          WHERE f.org_id=p.org_id AND f.fulfillment_kind='subscription_period'
            AND f.target_id=p.id AND r.purpose='subscription' AND r.status='approved'
            AND r.period_id=p.id
        )
      ORDER BY p.id LIMIT ?`,
  }),
  Object.freeze({
    code: 'DUPLICATE_SUBSCRIPTION_GRANT',
    severity: 'critical',
    sql: `SELECT g.org_id,g.period_id AS entity_id
      FROM billing_credit_grants g
      WHERE g.org_id=? AND g.grant_kind='subscription' AND g.period_id IS NOT NULL
      GROUP BY g.org_id,g.period_id HAVING COUNT(*)>1
      ORDER BY g.period_id LIMIT ?`,
  }),
  Object.freeze({
    code: 'APPROVED_TOPUP_UNFULFILLED',
    severity: 'high',
    sql: `SELECT r.org_id,r.id AS entity_id
      FROM billing_payment_requests r
      WHERE r.org_id=? AND r.purpose='topup' AND r.status='approved'
        AND NOT EXISTS (
          SELECT 1 FROM billing_payment_fulfillments f
          WHERE f.org_id=r.org_id AND f.payment_request_id=r.id
            AND f.fulfillment_kind='topup_credit_grant'
        )
      ORDER BY r.id LIMIT ?`,
  }),
  Object.freeze({
    code: 'INVALID_CREDIT_POSITION',
    severity: 'critical',
    sql: `SELECT p.org_id,p.id AS entity_id
      FROM billing_credit_positions p
      WHERE p.org_id=? AND (p.balance_units<0 OR p.reserved_units<0
        OR p.reserved_units>p.balance_units)
      ORDER BY p.id LIMIT ?`,
  }),
  Object.freeze({
    code: 'APPROVED_INVOICE_UNFULFILLED',
    severity: 'high',
    sql: `SELECT r.org_id,r.id AS entity_id
      FROM billing_payment_requests r
      WHERE r.org_id=? AND r.purpose='invoice' AND r.status='approved'
        AND NOT EXISTS (
          SELECT 1 FROM billing_payment_fulfillments f
          WHERE f.org_id=r.org_id AND f.payment_request_id=r.id
            AND f.fulfillment_kind='invoice_payment'
        )
      ORDER BY r.id LIMIT ?`,
  }),
]);

function validatedLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FINDINGS) {
    throw new TypeError('limit must be an integer from 1 to 100.');
  }
  return limit;
}

/** Single repeatable-read, read-only snapshot; zero write/repair statements. */
async function reconcileOrganizationBilling(orgId, {
  pool = getPool(), limit = 25, checkedAt = new Date().toISOString(),
} = {}) {
  orgId = validateId(orgId, 'orgId');
  limit = validatedLimit(limit);
  if (!Number.isFinite(Date.parse(checkedAt))) throw new TypeError('checkedAt is invalid.');
  const connection = await pool.connect();
  let started = false;
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION READ ONLY');
    started = true;
    const account = await connection.query(
      'SELECT org_id FROM organization_billing_accounts WHERE org_id=?', [orgId]);
    if (!Array.isArray(account.rows)) throw new TypeError('Invalid billing account query result.');
    if (!account.rows.length) {
      await connection.query('COMMIT');
      started = false;
      return Object.freeze({ orgId, checkedAt, initialized: false, complete: true, findings: [] });
    }
    const findings = [];
    let complete = true;
    for (const check of CHECKS) {
      const result = await connection.query(check.sql, [orgId, limit + 1]);
      if (!Array.isArray(result.rows)) throw new TypeError('Invalid reconciliation query result.');
      if (result.rows.length > limit) complete = false;
      for (const row of result.rows.slice(0, limit)) {
        if (row.org_id !== orgId || typeof row.entity_id !== 'string') {
          throw new TypeError('Reconciliation query returned an unexpected organization or identifier.');
        }
        findings.push(Object.freeze({ code: check.code, severity: check.severity, entityId: row.entity_id }));
      }
    }
    await connection.query('COMMIT');
    started = false;
    return Object.freeze({ orgId, checkedAt, initialized: true, complete, findings: Object.freeze(findings) });
  } catch (error) {
    if (started) await connection.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { reconcileOrganizationBilling, validatedLimit, CHECKS };
