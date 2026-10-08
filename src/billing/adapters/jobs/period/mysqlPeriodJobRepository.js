'use strict';

const { validateId } = require('../../../kernel/scope');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../../contracts/errors');

function rowsOf(value) {
  if (Array.isArray(value)) return Array.isArray(value[0]) ? value[0] : value;
  return Array.isArray(value?.rows) ? value.rows : [];
}
function instant(value, field) {
  const result = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  if (!Number.isFinite(Date.parse(result))) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, `${field} must be a valid timestamp.`);
  return result;
}
function boundedLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'limit must be an integer from 1 to 500.');
  return limit;
}

/** Read-only bounded scanners; every mutation is reloaded and locked in a UoW. */
function createMysqlPeriodJobRepository({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Period job repository requires a MySQL pool.');

  async function query(sql, params) {
    const connection = await pool.connect();
    try { return rowsOf(await connection.query(sql, params)); }
    catch (cause) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Billing lifecycle candidate scan failed.', { retryable: true, details: { cause: cause.code || cause.message } });
    } finally { connection.release(); }
  }

  async function listDueActivations({ now, limit = 100, after } = {}) {
    now = instant(now, 'now'); limit = boundedLimit(limit);
    const cursor = after ? [instant(after.startAt, 'after.startAt'), validateId(after.id, 'after.id')] : null;
    const cursorClause = cursor ? 'AND (b.starts_at>? OR (b.starts_at=? AND b.id>?))' : '';
    const params = cursor ? [now, now, cursor[0], cursor[0], cursor[1], limit] : [now, now, limit];
    const rows = await query(
      `SELECT DISTINCT b.id,b.org_id,b.starts_at,b.ends_at,p.id AS payment_request_id
         FROM billing_periods b
         JOIN billing_payment_fulfillments f ON f.org_id=b.org_id AND f.target_id=b.id AND f.fulfillment_kind='subscription_period'
         JOIN billing_payment_requests p ON p.org_id=f.org_id AND p.id=f.payment_request_id
        WHERE b.period_kind='subscription' AND b.status='scheduled' AND b.starts_at<=? AND b.ends_at>?
          AND p.purpose='subscription' AND p.status='approved' AND p.period_id=b.id
          ${cursorClause}
        ORDER BY b.starts_at,b.id LIMIT ?`, params,
    );
    return rows.map((row) => Object.freeze({ id: row.id, orgId: row.org_id, startAt: instant(row.starts_at, 'starts_at'), endAt: instant(row.ends_at, 'ends_at'), paymentRequestId: row.payment_request_id }));
  }

  async function listRenewalsDue({ now, leadTimeSeconds = 7 * 86400, limit = 100, after } = {}) {
    now = instant(now, 'now'); limit = boundedLimit(limit);
    if (!Number.isSafeInteger(leadTimeSeconds) || leadTimeSeconds < 1 || leadTimeSeconds > 90 * 86400) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'leadTimeSeconds must be from 1 to 7776000.');
    }
    const dueThrough = new Date(Date.parse(now) + leadTimeSeconds * 1000).toISOString();
    const cursor = after ? [instant(after.endAt, 'after.endAt'), validateId(after.id, 'after.id')] : null;
    const cursorClause = cursor ? 'AND (b.ends_at>? OR (b.ends_at=? AND b.id>?))' : '';
    const params = cursor ? [now, dueThrough, leadTimeSeconds, cursor[0], cursor[0], cursor[1], limit] : [now, dueThrough, leadTimeSeconds, limit];
    const rows = await query(
      `SELECT b.id,b.org_id,b.starts_at,b.ends_at,b.terms_snapshot_json,
              (SELECT JSON_OBJECT('units',CAST(q.total_units AS CHAR),'asset',q.asset,'scale',q.scale)
                 FROM billing_quotes q WHERE q.org_id=b.org_id AND q.quote_type='renewal' AND q.status='accepted'
                 ORDER BY q.accepted_at DESC,q.created_at DESC LIMIT 1) AS renewal_quote_amount_json,
              (SELECT pr.id FROM billing_payment_requests pr
                JOIN billing_quotes q ON q.org_id=pr.org_id AND q.id=pr.quote_id
               WHERE pr.org_id=b.org_id AND pr.purpose='subscription'
                 AND pr.status IN ('pending_verification','needs_information')
                 AND q.quote_type='renewal' AND q.status='accepted'
               ORDER BY pr.created_at DESC LIMIT 1) AS pending_renewal_request_id,
              (SELECT pr.status FROM billing_payment_requests pr
                JOIN billing_quotes q ON q.org_id=pr.org_id AND q.id=pr.quote_id
               WHERE pr.org_id=b.org_id AND pr.purpose='subscription'
                 AND pr.status IN ('pending_verification','needs_information')
                 AND q.quote_type='renewal' AND q.status='accepted'
               ORDER BY pr.created_at DESC LIMIT 1) AS pending_renewal_status
         FROM billing_periods b
        WHERE b.period_kind='subscription' AND b.status='active' AND b.ends_at>? AND b.ends_at<=?
          AND NOT EXISTS (SELECT 1 FROM billing_periods nextp WHERE nextp.org_id=b.org_id
            AND nextp.period_kind='subscription' AND nextp.status IN ('scheduled','cancelled') AND nextp.starts_at>=b.ends_at)
          AND NOT EXISTS (SELECT 1 FROM billing_outbox o WHERE o.org_id=b.org_id
            AND o.event_type='SubscriptionRenewalDue.v1' AND o.aggregate_type='BillingPeriod' AND o.aggregate_id=b.id
            AND CAST(JSON_UNQUOTE(JSON_EXTRACT(o.payload_json,'$.payload.leadTimeSeconds')) AS UNSIGNED)=?)
          ${cursorClause}
        ORDER BY b.ends_at,b.id LIMIT ?`, params,
    );
    return rows.map((row) => {
      let snapshot;
      try { snapshot = typeof row.terms_snapshot_json === 'string' ? JSON.parse(row.terms_snapshot_json) : row.terms_snapshot_json; }
      catch (cause) { throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Billing period terms snapshot is invalid JSON.', { retryable: true, details: { cause: cause.message } }); }
      let renewalQuoteAmount = row.renewal_quote_amount_json || null;
      if (typeof renewalQuoteAmount === 'string') {
        try { renewalQuoteAmount = JSON.parse(renewalQuoteAmount); }
        catch (cause) { throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Renewal quote amount is invalid JSON.', { retryable: true, details: { cause: cause.message } }); }
      }
      return Object.freeze({ id: row.id, orgId: row.org_id, startAt: instant(row.starts_at, 'starts_at'), endAt: instant(row.ends_at, 'ends_at'), termsSnapshot: snapshot,
        renewalQuoteAmount: renewalQuoteAmount && Object.freeze({ units: String(renewalQuoteAmount.units), asset: renewalQuoteAmount.asset, scale: Number(renewalQuoteAmount.scale) }),
        pendingRenewalRequestId: row.pending_renewal_request_id || null, pendingRenewalStatus: row.pending_renewal_status || null });
    });
  }

  return Object.freeze({ listDueActivations, listRenewalsDue });
}

module.exports = { createMysqlPeriodJobRepository };
