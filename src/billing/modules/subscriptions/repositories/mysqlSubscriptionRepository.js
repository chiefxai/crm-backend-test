'use strict';

const { assertTransactionContext } = require('../../../kernel/transactionContext');
const { validateId } = require('../../../kernel/scope');

function rowsOf(value) {
  const result = Array.isArray(value) && value.length === 2 && Array.isArray(value[0]) ? value[0] : value;
  return Array.isArray(result) ? result : result?.rows || [];
}
function affectedRows(value) {
  const result = Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value;
  return Number(result?.affectedRows ?? result?.rowCount ?? 0);
}
function assertOrg(tx, orgId) {
  assertTransactionContext(tx);
  validateId(orgId, 'orgId');
  if (tx.metadata?.orgId !== orgId) throw new TypeError('Subscription orgId must match transaction orgId.');
}
function instant(value, name) {
  const input = value instanceof Date ? value.toISOString() : String(value);
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(input)
    ? `${input.replace(' ', 'T').replace(/\.(\d{3})\d+$/, '.$1')}Z` : input;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${name} must be a valid timestamp.`);
  return date.toISOString();
}
function parseObject(value, name) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError(`${name} must be a JSON object.`);
  return Object.freeze(parsed);
}
function subscriptionRow(row) {
  return row && Object.freeze({
    orgId: row.org_id,
    lifecycleStatus: row.lifecycle_status,
    currentPlanId: row.current_plan_id || null,
    currentPlanVersion: row.current_plan_version == null ? null : Number(row.current_plan_version),
    currentPeriodId: row.current_period_id || null,
    billingAccessState: row.billing_access_state,
    billingSuspensionCause: row.billing_suspension_cause || null,
    restrictionDeadline: row.restriction_deadline == null ? null : instant(row.restriction_deadline, 'restrictionDeadline'),
    accessPolicy: parseObject(row.access_policy_json, 'accessPolicy'),
    version: Number(row.version),
    createdAt: instant(row.created_at, 'createdAt'),
    updatedAt: instant(row.updated_at, 'updatedAt'),
  });
}
function graceRow(row) {
  return row && Object.freeze({
    id: row.id, orgId: row.org_id, periodId: row.period_id,
    requestedUntil: instant(row.requested_until, 'requestedUntil'),
    justification: row.justification, requestedBy: row.requested_by, status: row.status,
    grantedUntil: row.granted_until == null ? null : instant(row.granted_until, 'grantedUntil'),
    version: Number(row.version), createdAt: instant(row.created_at, 'createdAt'),
    updatedAt: instant(row.updated_at, 'updatedAt'),
  });
}

/** Transaction-bound persistence for subscription access, period linkage and grace decisions. */
function createMysqlSubscriptionRepository() {
  async function getOrganizationSubscription(tx, { orgId, forUpdate = false }) {
    assertOrg(tx, orgId);
    const row = rowsOf(await tx.query(
      `SELECT org_id,lifecycle_status,current_plan_id,current_plan_version,current_period_id,
              billing_access_state,billing_suspension_cause,restriction_deadline,access_policy_json,
              version,created_at,updated_at
         FROM organization_subscriptions WHERE org_id=?${forUpdate ? ' FOR UPDATE' : ''}`,
      [orgId],
    ))[0];
    return subscriptionRow(row);
  }

  async function createOrganizationSubscription(tx, value) {
    assertOrg(tx, value?.orgId);
    for (const field of ['lifecycleStatus', 'billingAccessState']) validateId(value[field], field);
    if (!value.accessPolicy || typeof value.accessPolicy !== 'object' || Array.isArray(value.accessPolicy)) throw new TypeError('accessPolicy must be a JSON object.');
    if (value.currentPlanId != null) validateId(value.currentPlanId, 'currentPlanId');
    if (value.currentPlanVersion != null && (!Number.isSafeInteger(value.currentPlanVersion) || value.currentPlanVersion < 1)) throw new TypeError('currentPlanVersion must be a positive safe integer or null.');
    const now = instant(value.now, 'now');
    await tx.query(
      `INSERT INTO organization_subscriptions
         (org_id,lifecycle_status,current_plan_id,current_plan_version,current_period_id,billing_access_state,
          billing_suspension_cause,restriction_deadline,access_policy_json,version,created_at,updated_at)
       VALUES (?,?,?,?,NULL,?,?,?, ?,1,?,?)`,
      [value.orgId, value.lifecycleStatus, value.currentPlanId ?? null, value.currentPlanVersion ?? null,
        value.billingAccessState, value.billingSuspensionCause ?? null,
        value.restrictionDeadline == null ? null : instant(value.restrictionDeadline, 'restrictionDeadline'),
        JSON.stringify(value.accessPolicy), now, now],
    );
    return getOrganizationSubscription(tx, { orgId: value.orgId });
  }

  async function updateBillingAccess(tx, value) {
    assertOrg(tx, value?.orgId);
    validateId(value.billingAccessState, 'billingAccessState');
    if (!Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 1) throw new TypeError('expectedVersion must be a positive safe integer.');
    const now = instant(value.now, 'now');
    const deadline = value.restrictionDeadline == null ? null : instant(value.restrictionDeadline, 'restrictionDeadline');
    const result = await tx.query(
      `UPDATE organization_subscriptions
          SET billing_access_state=?,billing_suspension_cause=?,restriction_deadline=?,version=version+1,updated_at=?
        WHERE org_id=? AND version=?`,
      [value.billingAccessState, value.billingSuspensionCause ?? null, deadline, now, value.orgId, value.expectedVersion],
    );
    if (affectedRows(result) !== 1) return null;
    return getOrganizationSubscription(tx, { orgId: value.orgId });
  }

  async function linkPeriod(tx, value) {
    assertOrg(tx, value?.orgId);
    validateId(value.id, 'id');
    validateId(value.purpose, 'purpose');
    validateId(value.periodState || 'awaiting_payment', 'periodState');
    const now = instant(value.now, 'now');
    for (const field of ['periodId', 'quoteId', 'paymentRequestId', 'planId', 'supersedesPeriodId']) if (value[field] != null) validateId(value[field], field);
    if (value.planVersion != null && (!Number.isSafeInteger(value.planVersion) || value.planVersion < 1)) throw new TypeError('planVersion must be a positive safe integer or null.');
    await tx.query(
      `INSERT INTO billing_subscription_period_links
         (id,org_id,period_id,quote_id,payment_request_id,purpose,period_state,plan_id,plan_version,effective_at,
          supersedes_period_id,version,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      [value.id, value.orgId, value.periodId ?? null, value.quoteId ?? null, value.paymentRequestId ?? null,
        value.purpose, value.periodState || 'awaiting_payment', value.planId ?? null, value.planVersion ?? null,
        value.effectiveAt == null ? null : instant(value.effectiveAt, 'effectiveAt'), value.supersedesPeriodId ?? null, now, now],
    );
    return Object.freeze({ id: value.id, orgId: value.orgId, periodId: value.periodId ?? null,
      quoteId: value.quoteId ?? null, paymentRequestId: value.paymentRequestId ?? null,
      purpose: value.purpose, periodState: value.periodState || 'awaiting_payment',
      planId: value.planId ?? null, planVersion: value.planVersion ?? null,
      effectiveAt: value.effectiveAt == null ? null : instant(value.effectiveAt, 'effectiveAt'), version: 1 });
  }

  async function updatePeriodLink(tx, value) {
    assertOrg(tx, value?.orgId);
    validateId(value.linkId, 'linkId');
    if (!Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 1) throw new TypeError('expectedVersion must be a positive safe integer.');
    const current = rowsOf(await tx.query(
      `SELECT id,period_id,quote_id,payment_request_id,purpose,period_state,plan_id,plan_version,effective_at,
              supersedes_period_id,version
         FROM billing_subscription_period_links WHERE org_id=? AND id=? FOR UPDATE`,
      [value.orgId, value.linkId],
    ))[0];
    if (!current || Number(current.version) !== value.expectedVersion) return null;
    const transitions = {
      awaiting_payment: new Set(['scheduled', 'cancelled']),
      scheduled: new Set(['active', 'cancelled']),
      active: new Set(['expired']),
      expired: new Set(), cancelled: new Set(),
    };
    const nextState = value.periodState ?? current.period_state;
    if (!transitions[current.period_state]?.has(nextState) && nextState !== current.period_state) {
      throw new TypeError(`Cannot transition subscription period from ${current.period_state} to ${nextState}.`);
    }
    const fields = [];
    const params = [];
    for (const [input, column] of [['periodId', 'period_id'], ['paymentRequestId', 'payment_request_id']]) {
      if (value[input] !== undefined) {
        if (value[input] !== null) validateId(value[input], input);
        fields.push(`${column}=?`);
        params.push(value[input]);
      }
    }
    if (value.effectiveAt !== undefined) {
      fields.push('effective_at=?');
      params.push(value.effectiveAt === null ? null : instant(value.effectiveAt, 'effectiveAt'));
    }
    if (value.periodState !== undefined) {
      fields.push('period_state=?');
      params.push(nextState);
    }
    if (!fields.length) return Object.freeze({ id: current.id, orgId: value.orgId, periodId: current.period_id,
      quoteId: current.quote_id, paymentRequestId: current.payment_request_id, purpose: current.purpose,
      periodState: current.period_state, version: Number(current.version) });
    fields.push('version=version+1', 'updated_at=?');
    params.push(instant(value.now, 'now'), value.orgId, value.linkId, value.expectedVersion);
    const result = await tx.query(
      `UPDATE billing_subscription_period_links SET ${fields.join(',')} WHERE org_id=? AND id=? AND version=?`, params,
    );
    if (affectedRows(result) !== 1) return null;
    const updated = rowsOf(await tx.query(
      `SELECT id,org_id,period_id,quote_id,payment_request_id,purpose,period_state,plan_id,plan_version,
              effective_at,supersedes_period_id,version,created_at,updated_at
         FROM billing_subscription_period_links WHERE org_id=? AND id=?`, [value.orgId, value.linkId],
    ))[0];
    return updated && Object.freeze({ id: updated.id, orgId: updated.org_id, periodId: updated.period_id,
      quoteId: updated.quote_id, paymentRequestId: updated.payment_request_id, purpose: updated.purpose,
      periodState: updated.period_state, planId: updated.plan_id, planVersion: updated.plan_version == null ? null : Number(updated.plan_version),
      effectiveAt: updated.effective_at == null ? null : instant(updated.effective_at, 'effectiveAt'), version: Number(updated.version) });
  }

  async function fundPeriodLinkForQuote(tx, { orgId, quoteId, paymentRequestId, periodId, effectiveAt, now } = {}) {
    assertOrg(tx, orgId);
    for (const [field, value] of Object.entries({ quoteId, paymentRequestId, periodId })) validateId(value, field);
    const row = rowsOf(await tx.query(
      `SELECT id,period_state,version FROM billing_subscription_period_links
        WHERE org_id=? AND quote_id=? AND purpose IN ('initial_purchase','renewal','upgrade') FOR UPDATE`,
      [orgId, quoteId],
    ))[0];
    if (!row) return null; // Legacy subscription payments have no lifecycle link.
    if (row.period_state === 'scheduled') return Object.freeze({ id: row.id, periodId, periodState: 'scheduled', version: Number(row.version) });
    return updatePeriodLink(tx, { orgId, linkId: row.id, expectedVersion: Number(row.version),
      paymentRequestId, periodId, periodState: 'scheduled', effectiveAt, now });
  }

  async function activateLinkedPeriod(tx, { orgId, periodId, restrictionDeadline, now } = {}) {
    assertOrg(tx, orgId);
    validateId(periodId, 'periodId');
    const row = rowsOf(await tx.query(
      `SELECT id,period_state,version FROM billing_subscription_period_links
        WHERE org_id=? AND period_id=? FOR UPDATE`, [orgId, periodId],
    ))[0];
    if (!row) return null;
    if (row.period_state === 'scheduled') {
      await updatePeriodLink(tx, { orgId, linkId: row.id, expectedVersion: Number(row.version), periodState: 'active', now });
    } else if (row.period_state !== 'active') {
      throw new Error(`Linked subscription period is ${row.period_state}, expected scheduled or active.`);
    }
    const subscriptions = rowsOf(await tx.query(
      `SELECT lifecycle_status,billing_access_state,billing_suspension_cause,version
         FROM organization_subscriptions WHERE org_id=? FOR UPDATE`, [orgId],
    ))[0];
    if (!subscriptions) return { linkId: row.id, periodId, subscriptionUpdated: false };
    const permittedCause = subscriptions.billing_suspension_cause == null
      || ['initial_subscription_unpaid', 'subscription_payment_overdue', 'subscription_expired'].includes(subscriptions.billing_suspension_cause);
    const result = await tx.query(
      `UPDATE organization_subscriptions
          SET lifecycle_status='active',current_period_id=?,
              billing_access_state=IF(?,'operational',billing_access_state),
              billing_suspension_cause=IF(? ,NULL,billing_suspension_cause),
              restriction_deadline=?,version=version+1,updated_at=?
        WHERE org_id=? AND version=?`,
      [periodId, permittedCause ? 1 : 0, permittedCause ? 1 : 0,
        restrictionDeadline == null ? null : instant(restrictionDeadline, 'restrictionDeadline'),
        instant(now, 'now'), orgId, Number(subscriptions.version)],
    );
    return { linkId: row.id, periodId, subscriptionUpdated: affectedRows(result) === 1, accessRestored: permittedCause };
  }

  async function getGraceRequest(tx, { orgId, graceRequestId, forUpdate = false }) {
    assertOrg(tx, orgId);
    validateId(graceRequestId, 'graceRequestId');
    return graceRow(rowsOf(await tx.query(
      `SELECT id,org_id,period_id,requested_until,justification,requested_by,status,granted_until,version,created_at,updated_at
         FROM billing_subscription_grace_requests WHERE org_id=? AND id=?${forUpdate ? ' FOR UPDATE' : ''}`,
      [orgId, graceRequestId],
    ))[0]);
  }

  async function createGraceRequest(tx, value) {
    assertOrg(tx, value?.orgId);
    for (const field of ['id', 'periodId', 'requestedBy']) validateId(value[field], field);
    if (typeof value.justification !== 'string' || !value.justification.trim() || value.justification.length > 2000) throw new TypeError('justification must contain 1 to 2000 characters.');
    const requestedUntil = instant(value.requestedUntil, 'requestedUntil');
    const now = instant(value.now, 'now');
    await tx.query(
      `INSERT INTO billing_subscription_grace_requests
         (id,org_id,period_id,requested_until,justification,requested_by,status,granted_until,version,created_at,updated_at)
       VALUES (?,?,?,?,?,?,'requested',NULL,1,?,?)`,
      [value.id, value.orgId, value.periodId, requestedUntil, value.justification.trim(), value.requestedBy, now, now],
    );
    return getGraceRequest(tx, { orgId: value.orgId, graceRequestId: value.id });
  }

  async function recordGraceDecision(tx, value) {
    assertOrg(tx, value?.orgId);
    for (const field of ['id', 'graceRequestId', 'decision', 'decidedBy']) validateId(value[field], field);
    if (!['approve', 'deny', 'revoke'].includes(value.decision)) throw new TypeError('decision must be approve, deny or revoke.');
    if (!Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 1) throw new TypeError('expectedVersion must be a positive safe integer.');
    if (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 2000) throw new TypeError('reason must contain 1 to 2000 characters.');
    const now = instant(value.now, 'now');
    const request = await getGraceRequest(tx, { orgId: value.orgId, graceRequestId: value.graceRequestId, forUpdate: true });
    if (!request || request.version !== value.expectedVersion) return null;
    const allowed = value.decision === 'approve' || value.decision === 'deny'
      ? request.status === 'requested' : request.status === 'approved';
    if (!allowed) throw new TypeError(`Cannot ${value.decision} a grace request in ${request.status} state.`);
    const nextStatus = value.decision === 'approve' ? 'approved' : value.decision === 'deny' ? 'denied' : 'revoked';
    const grantedUntil = value.decision === 'approve' ? instant(value.grantedUntil, 'grantedUntil') : null;
    const sequence = request.version;
    await tx.query(
      `INSERT INTO billing_subscription_grace_decisions
         (id,org_id,grace_request_id,sequence_no,decision,reason,decided_by,granted_until,expected_version,decided_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [value.id, value.orgId, value.graceRequestId, sequence, value.decision, value.reason.trim(), value.decidedBy,
        grantedUntil, value.expectedVersion, now],
    );
    const updated = await tx.query(
      `UPDATE billing_subscription_grace_requests
          SET status=?,granted_until=?,version=version+1,updated_at=?
        WHERE org_id=? AND id=? AND version=?`,
      [nextStatus, grantedUntil, now, value.orgId, value.graceRequestId, value.expectedVersion],
    );
    if (affectedRows(updated) !== 1) throw new Error('Grace request changed while its decision was being recorded.');
    return getGraceRequest(tx, { orgId: value.orgId, graceRequestId: value.graceRequestId });
  }

  return Object.freeze({ getOrganizationSubscription, createOrganizationSubscription, updateBillingAccess,
    linkPeriod, updatePeriodLink, fundPeriodLinkForQuote, activateLinkedPeriod,
    getGraceRequest, createGraceRequest, recordGraceDecision });
}

module.exports = { createMysqlSubscriptionRepository };
