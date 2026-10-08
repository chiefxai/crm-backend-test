'use strict';

const { validateId } = require('../../../kernel/scope');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../../contracts/errors');

function rowsOf(value) {
  if (Array.isArray(value)) return Array.isArray(value[0]) ? value[0] : value;
  return Array.isArray(value?.rows) ? value.rows : [];
}
function timestamp(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, `${field} must be a valid timestamp.`);
  return date.toISOString();
}
function limitValue(value) {
  if (!Number.isInteger(value) || value < 1 || value > 500) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'limit must be between 1 and 500.');
  return value;
}

/** Read only candidate scan. Provider reconciliation and release happen later. */
function createMysqlReservationRecoveryRepository({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Reservation recovery repository requires a MySQL pool.');

  async function listExpiredOpen({ now, limit = 100, after } = {}) {
    const cutoff = timestamp(now, 'now');
    limit = limitValue(limit);
    const cursor = after ? [timestamp(after.validUntil, 'after.validUntil'), validateId(after.orgId, 'after.orgId'), validateId(after.id, 'after.id')] : null;
    const cursorSql = cursor ? 'AND (r.valid_until>? OR (r.valid_until=? AND (r.org_id>? OR (r.org_id=? AND r.id>?))))' : '';
    const params = cursor ? [cutoff, cursor[0], cursor[0], cursor[1], cursor[1], cursor[2], limit] : [cutoff, limit];
    const connection = await pool.connect();
    try {
      return rowsOf(await connection.query(`SELECT r.id,r.org_id,r.workspace_id,r.usage_operation_id,r.source_revision,
          r.funding_snapshot_json,r.status,r.valid_until,r.version
        FROM billing_reservations r
        WHERE r.valid_until<=? AND r.status IN ('reserved','partially_consumed') ${cursorSql}
        ORDER BY r.valid_until,r.org_id,r.id LIMIT ?`, params)).map((row) => {
        let fundingSnapshot;
        try { fundingSnapshot = typeof row.funding_snapshot_json === 'string' ? JSON.parse(row.funding_snapshot_json) : row.funding_snapshot_json; }
        catch (cause) { throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Reservation recovery snapshot contains invalid JSON.', { retryable: true, details: { cause: cause.message } }); }
        return Object.freeze({ id: row.id, orgId: row.org_id, workspaceId: row.workspace_id,
          usageOperationId: row.usage_operation_id, sourceRevision: row.source_revision,
          fundingSnapshot: fundingSnapshot || {}, status: row.status, validUntil: timestamp(row.valid_until, 'valid_until'), version: Number(row.version) });
      });
    } catch (cause) {
      if (cause instanceof BillingDomainError) throw cause;
      throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Expired reservation scan failed.', { retryable: true, details: { cause: cause.code || cause.message } });
    } finally { connection.release(); }
  }

  return Object.freeze({ listExpiredOpen });
}

module.exports = { createMysqlReservationRecoveryRepository };
