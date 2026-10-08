'use strict';

const { validateId } = require('../../../kernel/scope');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../../contracts/errors');

function rowsOf(value) {
  if (Array.isArray(value)) return Array.isArray(value[0]) ? value[0] : value;
  return Array.isArray(value?.rows) ? value.rows : [];
}
function boundedLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'limit must be an integer from 1 to 500.');
  return limit;
}
function instant(value) {
  const result = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  if (!Number.isFinite(Date.parse(result))) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'now must be a valid timestamp.');
  return result;
}

/** Bounded, keyset-paginated scan of grant expiries; it performs no writes. */
function createMysqlCreditExpiryJobRepository({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Credit expiry job repository requires a MySQL pool.');

  async function listDueGrants({ now, limit = 100, after } = {}) {
    now = instant(now); limit = boundedLimit(limit);
    const cursor = after ? [instant(after.expiresAt), validateId(after.orgId, 'after.orgId'), validateId(after.grantId, 'after.grantId'), validateId(after.accountId, 'after.accountId')] : null;
    const cursorClause = cursor
      ? 'AND (g.expires_at>? OR (g.expires_at=? AND (g.org_id>? OR (g.org_id=? AND (g.id>? OR (g.id=? AND p.account_id>?))))))'
      : '';
    const params = cursor ? [now, cursor[0], cursor[0], cursor[1], cursor[1], cursor[2], cursor[2], cursor[3], limit] : [now, limit];
    const connection = await pool.connect();
    try {
      const result = await connection.query(
        `SELECT g.org_id,g.id AS grant_id,g.expires_at,p.account_id
           FROM billing_credit_grants g
           JOIN billing_credit_positions p ON p.org_id=g.org_id AND p.grant_id=g.id
           JOIN billing_credit_accounts a ON a.org_id=p.org_id AND a.id=p.account_id
          WHERE g.expires_at IS NOT NULL AND g.expires_at<=?
            AND (g.status='active' OR (g.status='expired'
              AND a.account_purpose NOT LIKE '%\\_clearing' AND p.balance_units>p.reserved_units))
            ${cursorClause}
          ORDER BY g.expires_at,g.org_id,g.id,p.account_id LIMIT ?`, params,
      );
      return rowsOf(result).map((row) => Object.freeze({ orgId: row.org_id, grantId: row.grant_id, accountId: row.account_id, expiresAt: instant(row.expires_at) }));
    } catch (cause) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Credit expiry candidate scan failed.', { retryable: true, details: { cause: cause.code || cause.message } });
    } finally { connection.release(); }
  }

  return Object.freeze({ listDueGrants });
}

module.exports = { createMysqlCreditExpiryJobRepository };
