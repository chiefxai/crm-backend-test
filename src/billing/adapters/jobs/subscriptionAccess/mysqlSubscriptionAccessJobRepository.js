'use strict';

const { validateId } = require('../../../kernel/scope');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../../contracts/errors');

function rowsOf(value) {
  if (Array.isArray(value)) return Array.isArray(value[0]) ? value[0] : value;
  return Array.isArray(value?.rows) ? value.rows : [];
}

function instant(value, field) {
  const input = value instanceof Date ? value.toISOString() : String(value);
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(input)
    ? `${input.replace(' ', 'T').replace(/\.(\d{3})\d+$/, '.$1')}Z` : input;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, `${field} must be a valid timestamp.`);
  return date.toISOString();
}

function boundedLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'limit must be an integer from 1 to 500.');
  }
  return limit;
}

/** Read-only bounded scan. Each mutation is reloaded under the org lifecycle lock. */
function createMysqlSubscriptionAccessJobRepository({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Subscription access job repository requires a MySQL pool.');

  async function listDueAccessRestrictions({ now, limit = 100, afterOrgId } = {}) {
    now = instant(now, 'now');
    limit = boundedLimit(limit);
    if (afterOrgId != null) validateId(afterOrgId, 'afterOrgId');
    const connection = await pool.connect();
    try {
      const cursor = afterOrgId == null ? '' : 'AND org_id>?';
      const params = afterOrgId == null ? [now, limit] : [now, afterOrgId, limit];
      const result = await connection.query(
        `SELECT org_id,billing_access_state,billing_suspension_cause,restriction_deadline,version
           FROM organization_subscriptions
          WHERE restriction_deadline IS NOT NULL AND restriction_deadline<=?
            AND billing_access_state IN ('operational','billing_recovery')
            AND (billing_suspension_cause IS NULL OR billing_suspension_cause NOT IN ('manual','security','manual_suspension','security_suspension'))
            ${cursor}
          ORDER BY org_id LIMIT ?`, params,
      );
      return rowsOf(result).map((row) => Object.freeze({
        orgId: row.org_id,
        billingAccessState: row.billing_access_state,
        billingSuspensionCause: row.billing_suspension_cause || null,
        restrictionDeadline: instant(row.restriction_deadline, 'restriction_deadline'),
        version: Number(row.version),
      }));
    } catch (cause) {
      if (cause instanceof BillingDomainError) throw cause;
      throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Subscription access candidate scan failed.', {
        retryable: true, details: { cause: cause.code || cause.message },
      });
    } finally {
      connection.release();
    }
  }

  return Object.freeze({ listDueAccessRestrictions });
}

module.exports = { createMysqlSubscriptionAccessJobRepository };
