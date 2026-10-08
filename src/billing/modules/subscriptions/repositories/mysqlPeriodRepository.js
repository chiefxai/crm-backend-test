'use strict';

const crypto = require('crypto');
const { assertTransactionContext } = require('../../../kernel/transactionContext');
const { validateId } = require('../../../kernel/scope');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../../contracts/errors');

const STATUSES = new Set(['scheduled', 'active', 'ended', 'cancelled']);
const TRANSITIONS = Object.freeze({
  scheduled: new Set(['active', 'cancelled']),
  active: new Set(['ended']),
  ended: new Set(),
  cancelled: new Set(),
});

function rowsOf(value) {
  const result = Array.isArray(value) && value.length === 2 && Array.isArray(value[0]) ? value[0] : value;
  return Array.isArray(result) ? result : result?.rows || [];
}
function affectedRows(value) {
  const result = Array.isArray(value) && value.length === 2 && !Array.isArray(value[0]) ? value[0]
    : Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value;
  return Number(result?.affectedRows ?? result?.rowCount ?? 0);
}
function instant(value, field) {
  const n = value instanceof Date ? value.getTime()
    : typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
      ? Date.parse(dateValue(value)) : Date.parse(value);
  if (!Number.isFinite(n)) throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, `${field} must be a valid instant.`);
  return n;
}
function json(value, label) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch (cause) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, `${label} must be JSON-safe.`, { details: { cause: cause.message } });
  }
  if (encoded === undefined || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, `${label} must be a JSON object.`);
  }
  try { return JSON.parse(encoded); } catch (cause) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, `${label} must be JSON-safe.`, { details: { cause: cause.message } });
  }
}
function parseJson(value, label) {
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch (cause) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, `${label} is invalid JSON.`, { retryable: true, details: { cause: cause.message } });
  }
}
function dateValue(value) {
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  // mysql DATETIME is timezone-naive by design; interpret persisted wall time
  // as UTC so result mapping is stable across application host timezones.
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(text)
    ? `${text.replace(' ', 'T').replace(/\.(\d{3})\d+$/, '.$1')}Z` : text;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Stored billing period contains an invalid date.', { retryable: true });
  return date.toISOString();
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
function mapRow(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    orgId: row.org_id,
    periodKind: row.period_kind,
    startAt: dateValue(row.starts_at),
    endAt: dateValue(row.ends_at),
    anchorAt: row.anchor_at == null ? null : dateValue(row.anchor_at),
    termsVersion: row.terms_version == null ? null : Number(row.terms_version),
    status: row.status,
    termsSnapshot: deepFreeze(parseJson(row.terms_snapshot_json, 'Billing period terms snapshot')),
    activatedAt: row.activated_at == null ? null : dateValue(row.activated_at),
    closedAt: row.closed_at == null ? null : dateValue(row.closed_at),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  });
}
function assertOrg(tx, orgId) {
  assertTransactionContext(tx);
  validateId(orgId, 'orgId');
  if (tx.metadata?.orgId !== orgId) throw new TypeError('Billing period orgId must match transaction orgId.');
}
function validatePeriod(period) {
  for (const key of ['id', 'orgId', 'periodKind']) validateId(period[key], key);
  validateId(period.status || 'scheduled', 'status');
  if ((period.status || 'scheduled') !== 'scheduled') {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, 'New billing periods must start in scheduled state.');
  }
  const start = instant(period.startAt, 'startAt');
  const end = instant(period.endAt, 'endAt');
  if (end <= start) throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, 'Period endAt must be after startAt.');
  if (period.anchorAt != null) instant(period.anchorAt, 'anchorAt');
  if (period.termsVersion != null && (!Number.isSafeInteger(Number(period.termsVersion)) || Number(period.termsVersion) < 1)) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, 'termsVersion must be a positive safe integer or null.');
  }
  return { start, end, snapshot: json(period.termsSnapshot, 'termsSnapshot') };
}

/** Transaction-bound repository for immutable subscription and postpaid periods. */
function createMysqlPeriodRepository() {
  async function getBillingAccount(tx, { orgId }) {
    assertOrg(tx, orgId);
    const row = rowsOf(await tx.query(
      `SELECT org_id,timezone,fallback_mode,postpaid_eligible,status,hold_reason
         FROM organization_billing_accounts WHERE org_id=? FOR UPDATE`, [orgId],
    ))[0];
    if (!row) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Organization billing account does not exist.');
    return Object.freeze({ orgId: row.org_id, timezone: row.timezone || 'UTC', fallbackMode: row.fallback_mode,
      postpaidEligible: Boolean(Number(row.postpaid_eligible)), status: row.status, holdReason: row.hold_reason || null });
  }

  async function getCurrentPeriodForUpdate(tx, { orgId, at }) {
    assertOrg(tx, orgId);
    instant(at, 'at');
    const rows = rowsOf(await tx.query(
      `SELECT id,org_id,period_kind,starts_at,ends_at,anchor_at,terms_version,status,terms_snapshot_json,activated_at,closed_at,created_at,updated_at
         FROM billing_periods
        WHERE org_id=? AND starts_at<=? AND ends_at>? AND status IN ('active','scheduled')
        ORDER BY starts_at DESC LIMIT 2 FOR UPDATE`, [orgId, at, at],
    ));
    if (rows.length > 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Overlapping current billing periods detected.', { retryable: true, details: { orgId, at } });
    return mapRow(rows[0]);
  }

  async function getPeriod(tx, { orgId, periodId }) {
    assertOrg(tx, orgId);
    validateId(periodId, 'periodId');
    return mapRow(rowsOf(await tx.query(
      `SELECT id,org_id,period_kind,starts_at,ends_at,anchor_at,terms_version,status,terms_snapshot_json,activated_at,closed_at,created_at,updated_at
         FROM billing_periods WHERE org_id=? AND id=? LIMIT 1`, [orgId, periodId],
    ))[0]);
  }

  async function insertScheduledPeriod(tx, period) {
    assertOrg(tx, period?.orgId);
    const { start, end, snapshot } = validatePeriod(period);
    // UoW takes this same account lock first; repeating it here documents and
    // preserves serialization when the repository is used by another runner.
    const account = rowsOf(await tx.query('SELECT org_id FROM organization_billing_accounts WHERE org_id=? FOR UPDATE', [period.orgId]))[0];
    if (!account) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Organization billing account does not exist.');
    const overlaps = rowsOf(await tx.query(
      `SELECT id,starts_at,ends_at,status FROM billing_periods
        WHERE org_id=? AND status<>'cancelled' AND starts_at<? AND ends_at>? ORDER BY starts_at LIMIT 1 FOR UPDATE`,
      [period.orgId, period.endAt, period.startAt],
    ));
    if (overlaps.length) throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, 'Billing period overlaps an existing non-cancelled period.', {
      details: { orgId: period.orgId, conflictingPeriodId: overlaps[0].id },
    });
    const now = period.createdAt || period.updatedAt;
    if (!now) throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, 'createdAt or updatedAt is required.');
    instant(now, 'createdAt');
    const anchorAt = period.anchorAt ?? null;
    await tx.query(
      `INSERT INTO billing_periods
         (id,org_id,period_kind,starts_at,ends_at,anchor_at,terms_version,status,terms_snapshot_json,activated_at,closed_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,'scheduled',?,NULL,NULL,?,?)`,
      [period.id, period.orgId, period.periodKind, period.startAt, period.endAt, anchorAt,
        period.termsVersion ?? null, JSON.stringify(snapshot), now, period.updatedAt || now],
    );
    return Object.freeze({ id: period.id, orgId: period.orgId, periodKind: period.periodKind,
      startAt: dateValue(period.startAt), endAt: dateValue(period.endAt), anchorAt: anchorAt == null ? null : dateValue(anchorAt),
      termsVersion: period.termsVersion == null ? null : Number(period.termsVersion), status: 'scheduled', termsSnapshot: snapshot,
      activatedAt: null, closedAt: null, createdAt: dateValue(now), updatedAt: dateValue(period.updatedAt || now) });
  }

  async function assertPaymentApproved(tx, { orgId, paymentRequestId }) {
    assertOrg(tx, orgId);
    validateId(paymentRequestId, 'paymentRequestId');
    const rows = rowsOf(await tx.query(
      `SELECT id FROM billing_payment_requests
        WHERE org_id=? AND id=? AND purpose='subscription' AND status='approved' FOR UPDATE`,
      [orgId, paymentRequestId],
    ));
    if (!rows.length) throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_NOT_FUNDED, 'Approved subscription payment was not found.', { details: { orgId, paymentRequestId } });
    return true;
  }

  async function getApprovedSubscriptionPurchase(tx, { orgId, paymentRequestId }) {
    assertOrg(tx, orgId);
    validateId(paymentRequestId, 'paymentRequestId');
    const row = rowsOf(await tx.query(
      `SELECT p.id AS payment_request_id,p.period_id,p.quote_id,p.purpose,p.status AS payment_status,p.reviewed_at,
              q.quote_type,q.status AS quote_status,q.paid_at,q.terms_snapshot_json
         FROM billing_payment_requests p
         JOIN billing_quotes q ON q.org_id=p.org_id AND q.id=p.quote_id
        WHERE p.org_id=? AND p.id=? AND p.purpose='subscription' AND p.status='approved'
          AND q.quote_type IN ('purchase','renewal')
        LIMIT 1 FOR UPDATE`, [orgId, paymentRequestId],
    ))[0];
    if (!row) throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_NOT_FUNDED, 'Approved subscription payment with a purchased quote was not found.', { details: { orgId, paymentRequestId } });
    const termsSnapshot = deepFreeze(parseJson(row.terms_snapshot_json, 'Purchased subscription quote snapshot'));
    if (!termsSnapshot || termsSnapshot.schemaVersion !== 1 || !termsSnapshot.plan?.terms || !termsSnapshot.includedCredits) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Purchased subscription quote snapshot is incomplete.', { retryable: true, details: { orgId, paymentRequestId } });
    }
    const approvalAt = row.reviewed_at == null ? null : dateValue(row.reviewed_at);
    const paidAt = row.paid_at == null ? null : dateValue(row.paid_at);
    const purchaseAt = approvalAt || paidAt;
    if (!purchaseAt) throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Approved subscription purchase is missing its persisted approval and payment timestamps.', { retryable: true, details: { orgId, paymentRequestId } });
    return Object.freeze({ paymentRequestId: row.payment_request_id, periodId: row.period_id || null,
      quoteId: row.quote_id, quoteType: row.quote_type, quoteStatus: row.quote_status,
      approvalAt, paidAt, purchaseAt, termsSnapshot, effectiveTerms: termsSnapshot.plan.terms });
  }

  async function assertPeriodFunded(tx, { orgId, periodId, paymentRequestId }) {
    assertOrg(tx, orgId);
    validateId(periodId, 'periodId');
    const rows = rowsOf(await tx.query(
      `SELECT f.id
         FROM billing_payment_fulfillments f
         JOIN billing_payment_requests p ON p.org_id=f.org_id AND p.id=f.payment_request_id
        WHERE f.org_id=? AND f.target_id=? AND f.fulfillment_kind='subscription_period'
          AND p.org_id=? AND p.period_id=? AND p.purpose='subscription' AND p.status='approved'
          AND (? IS NULL OR p.id=?)
        LIMIT 1 FOR UPDATE`, [orgId, periodId, orgId, periodId, paymentRequestId ?? null, paymentRequestId ?? null],
    ));
    if (!rows.length) throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_NOT_FUNDED, 'Billing period has no approved subscription fulfillment.', { details: { orgId, periodId } });
    return true;
  }

  async function getPeriodFunding(tx, { orgId, periodId }) {
    assertOrg(tx, orgId);
    validateId(periodId, 'periodId');
    const row = rowsOf(await tx.query(
      `SELECT p.id AS payment_request_id
         FROM billing_payment_fulfillments f
         JOIN billing_payment_requests p ON p.org_id=f.org_id AND p.id=f.payment_request_id
        WHERE f.org_id=? AND f.target_id=? AND f.fulfillment_kind='subscription_period'
          AND p.purpose='subscription' AND p.status='approved' AND p.period_id=?
        ORDER BY f.created_at,f.id LIMIT 1 FOR UPDATE`, [orgId, periodId, periodId],
    ))[0];
    return row ? Object.freeze({ paymentRequestId: row.payment_request_id }) : null;
  }

  async function linkApprovedSubscriptionPayment(tx, { orgId, paymentRequestId, periodId, now }) {
    assertOrg(tx, orgId);
    validateId(paymentRequestId, 'paymentRequestId');
    validateId(periodId, 'periodId');
    instant(now, 'now');
    const period = rowsOf(await tx.query(
      `SELECT id,period_kind,status FROM billing_periods WHERE org_id=? AND id=? FOR UPDATE`, [orgId, periodId],
    ))[0];
    if (!period) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Billing period does not exist.');
    if (period.period_kind !== 'subscription' || period.status !== 'scheduled') {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, 'Subscription payment can only fund a scheduled subscription period.');
    }
    const payment = rowsOf(await tx.query(
      `SELECT id,period_id,status,purpose FROM billing_payment_requests WHERE org_id=? AND id=? FOR UPDATE`, [orgId, paymentRequestId],
    ))[0];
    if (!payment || payment.purpose !== 'subscription' || payment.status !== 'approved') {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_NOT_FUNDED, 'An approved subscription payment is required to fund this period.');
    }
    if (payment.period_id && payment.period_id !== periodId) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Approved payment is already linked to another billing period.', { details: { paymentRequestId, linkedPeriodId: payment.period_id } });
    }
    if (!payment.period_id) {
      const updated = await tx.query(
        `UPDATE billing_payment_requests SET period_id=?,updated_at=? WHERE org_id=? AND id=? AND period_id IS NULL AND status='approved' AND purpose='subscription'`,
        [periodId, now, orgId, paymentRequestId],
      );
      if (affectedRows(updated) !== 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_CONCURRENCY, 'Approved payment changed before it could be linked to its period.', { retryable: true });
    }
    const prior = rowsOf(await tx.query(
      `SELECT id FROM billing_payment_fulfillments
        WHERE org_id=? AND payment_request_id=? AND fulfillment_kind='subscription_period' AND target_id=? FOR UPDATE`,
      [orgId, paymentRequestId, periodId],
    ))[0];
    if (prior) return Object.freeze({ periodId, paymentRequestId, fulfillmentId: prior.id, alreadyLinked: true });
    const keyMaterial = `${orgId}\0${paymentRequestId}\0subscription_period\0${periodId}`;
    const digest = crypto.createHash('sha256').update(keyMaterial).digest('hex');
    const fulfillmentId = `billing-fulfillment-${digest}`;
    const idempotencyKey = `subscription-period-${digest}`;
    await tx.query(
      `INSERT INTO billing_payment_fulfillments
         (id,org_id,payment_request_id,fulfillment_kind,target_id,idempotency_key,result_json,fulfilled_at,created_at)
       VALUES (?,?,?,'subscription_period',?,?,?, ?,?)`,
      [fulfillmentId, orgId, paymentRequestId, periodId, idempotencyKey, JSON.stringify({ periodId }), now, now],
    );
    return Object.freeze({ periodId, paymentRequestId, fulfillmentId, alreadyLinked: false });
  }

  async function transitionPeriod(tx, { orgId, periodId, expectedStatus, status, fields = {}, fundingProof, allowPostpaidActivation = false }) {
    assertOrg(tx, orgId);
    validateId(periodId, 'periodId');
    if (!STATUSES.has(expectedStatus) || !STATUSES.has(status) || !TRANSITIONS[expectedStatus]?.has(status)) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, 'Invalid billing period state transition.', { details: { expectedStatus, status } });
    }
    const allowedFields = new Set(['activatedAt', 'closedAt', 'updatedAt']);
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).some((key) => !allowedFields.has(key))) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, 'Only lifecycle timestamps may be changed; terms snapshots are immutable.');
    }
    const row = rowsOf(await tx.query(
      `SELECT id,period_kind,status,starts_at,ends_at FROM billing_periods WHERE org_id=? AND id=? FOR UPDATE`, [orgId, periodId],
    ))[0];
    if (!row) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Billing period does not exist.');
    if (row.status !== expectedStatus) throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_CONCURRENCY, 'Billing period state changed concurrently.', { retryable: true, details: { expectedStatus, actualStatus: row.status } });
    if (status === 'active') {
      if (fields.updatedAt == null) throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, 'updatedAt is required for activation.');
      const activationAt = instant(fields.activatedAt ?? fields.updatedAt, 'activatedAt');
      if (activationAt < instant(row.starts_at, 'starts_at') || activationAt >= instant(row.ends_at, 'ends_at')) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, 'A billing period can only activate within its purchased time window.');
      }
      if (row.period_kind === 'postpaid') {
        if (!allowPostpaidActivation) throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_NOT_FUNDED, 'Postpaid period activation requires an explicit postpaid authorization.');
        const account = rowsOf(await tx.query(
          `SELECT postpaid_eligible,status,hold_reason FROM organization_billing_accounts WHERE org_id=? FOR UPDATE`, [orgId],
        ))[0];
        if (!account || !Number(account.postpaid_eligible) || String(account.status).toLowerCase() !== 'active' || account.hold_reason) {
          throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_NOT_FUNDED, 'Organization is not eligible for postpaid period activation.');
        }
      } else {
        if (!fundingProof?.paymentRequestId) throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_NOT_FUNDED, 'Subscription period activation requires funding proof.');
        await assertPeriodFunded(tx, { orgId, periodId, paymentRequestId: fundingProof.paymentRequestId });
        await assertPaymentApproved(tx, { orgId, paymentRequestId: fundingProof.paymentRequestId });
      }
    }
    if (fields.updatedAt == null) throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, 'updatedAt is required for period state changes.');
    const activatedAt = fields.activatedAt ?? (status === 'active' ? fields.updatedAt : null);
    const closedAt = fields.closedAt ?? (status === 'ended' || status === 'cancelled' ? fields.updatedAt : null);
    for (const [key, value] of Object.entries({ activatedAt, closedAt, updatedAt: fields.updatedAt })) if (value != null) instant(value, key);
    const result = await tx.query(
      `UPDATE billing_periods SET status=?,activated_at=COALESCE(?,activated_at),closed_at=COALESCE(?,closed_at),updated_at=COALESCE(?,updated_at)
        WHERE org_id=? AND id=? AND status=?`,
      [status, activatedAt ?? null, closedAt ?? null, fields.updatedAt, orgId, periodId, expectedStatus],
    );
    if (affectedRows(result) !== 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_CONCURRENCY, 'Billing period changed before the state transition was saved.', { retryable: true });
    return getPeriod(tx, { orgId, periodId });
  }

  async function listPeriods(tx, { orgId, from, to, limit = 100 }) {
    assertOrg(tx, orgId);
    if (from != null) instant(from, 'from');
    if (to != null) instant(to, 'to');
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, 'limit must be an integer from 1 to 500.');
    const clauses = ['org_id=?']; const params = [orgId];
    if (from != null) { clauses.push('ends_at>?'); params.push(from); }
    if (to != null) { clauses.push('starts_at<?'); params.push(to); }
    params.push(limit);
    return rowsOf(await tx.query(
      `SELECT id,org_id,period_kind,starts_at,ends_at,anchor_at,terms_version,status,terms_snapshot_json,activated_at,closed_at,created_at,updated_at
         FROM billing_periods WHERE ${clauses.join(' AND ')} ORDER BY starts_at DESC,id LIMIT ?`, params,
    )).map(mapRow);
  }

  return Object.freeze({ getBillingAccount, getCurrentPeriodForUpdate, getPeriod, insertScheduledPeriod, transitionPeriod, listPeriods,
    assertPaymentApproved, assertPeriodFunded, getPeriodFunding, linkApprovedSubscriptionPayment, getApprovedSubscriptionPurchase });
}

module.exports = { createMysqlPeriodRepository, mapBillingPeriodRow: mapRow };
