'use strict';

const crypto = require('node:crypto');
const { createMysqlUnitOfWork } = require('./adapters/mysql/unitOfWork');
const operationStore = require('./adapters/mysql/commandOperationRepository');
const { createMysqlSubscriptionRepository } = require('./modules/subscriptions/repositories/mysqlSubscriptionRepository');
const { resolveSubscriptionPolicy } = require('./modules/subscriptions/policy');
const { shiftCalendarDays } = require('./modules/subscriptions/periodMath');

const BILLING_CAUSES = new Set(['initial_subscription_unpaid', 'subscription_payment_overdue', 'subscription_expired']);
const NON_BILLING_CAUSES = new Set(['manual', 'security', 'manual_suspension', 'security_suspension']);
const rowsOf = (value) => Array.isArray(value) && Array.isArray(value[0]) ? value[0] : Array.isArray(value) ? value : value?.rows || [];
const iso = (value) => {
  const normalized = value instanceof Date ? value.toISOString() : String(value).replace(' ', 'T').replace(/(\.\d{3})\d+$/, '$1');
  const date = new Date(/^\d{4}-\d\d-\d\dT/.test(normalized) && !/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? `${normalized}Z` : normalized);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Stored subscription date is invalid.');
  return date.toISOString();
};
function fingerprint(value) { return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function domainError(code, message, statusCode = 409) { return Object.assign(new Error(message), { code, statusCode, expose: true }); }
function assertRequestedUntil(requestedUntil, base, maxDays, now, timeZone = 'UTC') {
  const requested = Date.parse(requestedUntil);
  const minimum = Date.parse(base);
  if (!Number.isFinite(requested) || requested <= minimum || requested <= now) {
    throw domainError('GRACE_DEADLINE_INVALID', 'Requested grace must be in the future and later than the current billing deadline.', 400);
  }
  if (requested > Date.parse(shiftCalendarDays(base, maxDays, { timeZone }))) {
    throw domainError('GRACE_MAXIMUM_EXCEEDED', `Grace cannot exceed ${maxDays} days beyond the current billing deadline.`, 400);
  }
  return new Date(requested).toISOString();
}

function createSubscriptionGraceService({ unitOfWork, repository, pool, idSource, clock, policy, outbox } = {}) {
  const resolvedPolicy = resolveSubscriptionPolicy(policy || {});
  if (!unitOfWork || typeof unitOfWork.runLifecycle !== 'function' || !repository
    || typeof repository.getOrganizationSubscription !== 'function' || typeof repository.createGraceRequest !== 'function'
    || typeof repository.getGraceRequest !== 'function' || typeof repository.recordGraceDecision !== 'function'
    || typeof repository.updateBillingAccess !== 'function' || !pool || typeof pool.query !== 'function'
    || typeof idSource?.newId !== 'function' || typeof clock?.now !== 'function') {
    throw new TypeError('Subscription grace service dependencies are incomplete.');
  }

  async function createRequest({ orgId, actorId, periodId, requestedUntil, justification, expectedVersion, operationId }) {
    const now = iso(clock.now());
    const nowMs = Date.parse(now);
    return unitOfWork.runLifecycle({ orgId, operationId, requestFingerprint: fingerprint({ orgId, actorId, periodId, requestedUntil, justification, expectedVersion }), callback: async (tx) => {
      const subscription = await repository.getOrganizationSubscription(tx, { orgId, forUpdate: true });
      if (!subscription) throw domainError('SUBSCRIPTION_NOT_FOUND', 'Organization subscription was not found.', 404);
      if (subscription.version !== expectedVersion) throw domainError('VERSION_CONFLICT', 'Subscription changed; refresh and try again.');
      if (subscription.currentPeriodId !== periodId) throw domainError('PERIOD_NOT_CURRENT', 'Grace can only be requested for the current subscription period.');
      const period = rowsOf(await tx.query('SELECT id,starts_at,ends_at,status FROM billing_periods WHERE org_id=? AND id=? FOR UPDATE', [orgId, periodId]))[0];
      if (!period || !['active', 'scheduled'].includes(String(period.status).toLowerCase())) throw domainError('PERIOD_NOT_FOUND', 'Current billing period was not found.', 404);
      const endAt = iso(period.ends_at);
      const existingDeadline = subscription.restrictionDeadline;
      const base = existingDeadline && Date.parse(existingDeadline) > Date.parse(endAt) ? existingDeadline : endAt;
      const until = assertRequestedUntil(requestedUntil, base, resolvedPolicy.grace.maxDaysPerPeriod, nowMs, resolvedPolicy.billingTimeZone);
      const created = await repository.createGraceRequest(tx, { id: idSource.newId('subscription-grace'), orgId, periodId,
        requestedUntil: until, justification, requestedBy: actorId, now });
      if (typeof outbox?.enqueue === 'function') await outbox.enqueue(tx, { events: [{
        eventId: idSource.newId('billing-event'), eventType: 'SubscriptionGraceRequested.v1', schemaVersion: 1,
        operationId, orgId, aggregateType: 'SubscriptionGraceRequest', aggregateId: created.id, aggregateVersion: 1,
        occurredAt: now, correlationId: operationId,
        payload: { graceRequestId: created.id, periodId, requestedUntil: until },
      }] });
      return created;
    }});
  }

  async function decide({ orgId, graceRequestId, actorId, decision, reason, expectedVersion, grantedUntil, operationId }) {
    const now = iso(clock.now());
    const nowMs = Date.parse(now);
    return unitOfWork.runLifecycle({ orgId, operationId, requestFingerprint: fingerprint({ orgId, graceRequestId, actorId, decision, reason, expectedVersion, grantedUntil }), callback: async (tx) => {
      const request = await repository.getGraceRequest(tx, { orgId, graceRequestId, forUpdate: true });
      if (!request) throw domainError('GRACE_REQUEST_NOT_FOUND', 'Grace request was not found.', 404);
      if (request.version !== expectedVersion) throw domainError('VERSION_CONFLICT', 'Grace request changed; refresh and try again.');
      const subscription = await repository.getOrganizationSubscription(tx, { orgId, forUpdate: true });
      if (!subscription) throw domainError('SUBSCRIPTION_NOT_FOUND', 'Organization subscription was not found.', 404);
      const cause = subscription.billingSuspensionCause;
      if (NON_BILLING_CAUSES.has(cause) || (subscription.billingAccessState === 'billing_suspended' && !BILLING_CAUSES.has(cause))) {
        throw domainError('NON_BILLING_SUSPENSION', 'Grace decisions cannot alter manual or security suspensions.');
      }
      let grant = null;
      if (decision === 'approve') {
        const period = rowsOf(await tx.query('SELECT ends_at FROM billing_periods WHERE org_id=? AND id=? FOR UPDATE', [orgId, request.periodId]))[0];
        if (!period) throw domainError('PERIOD_NOT_FOUND', 'Grace request billing period was not found.', 404);
        const endAt = iso(period.ends_at);
        const base = subscription.restrictionDeadline && Date.parse(subscription.restrictionDeadline) > Date.parse(endAt)
          ? subscription.restrictionDeadline : endAt;
        grant = assertRequestedUntil(grantedUntil || request.requestedUntil, base, resolvedPolicy.grace.maxDaysPerPeriod, nowMs, resolvedPolicy.billingTimeZone);
        if (Date.parse(grant) > Date.parse(request.requestedUntil)) throw domainError('GRANT_EXCEEDS_REQUEST', 'Approved grace cannot exceed the organization requested deadline.', 400);
      }
      const updatedRequest = await repository.recordGraceDecision(tx, { id: idSource.newId('subscription-grace-decision'), orgId,
        graceRequestId, decision, reason, decidedBy: actorId, expectedVersion, grantedUntil: grant, now });
      if (!updatedRequest) throw domainError('VERSION_CONFLICT', 'Grace request changed while the decision was recorded.');
      if (decision === 'approve') {
        const billingSuspended = subscription.billingAccessState === 'billing_suspended' && BILLING_CAUSES.has(cause);
        const next = await repository.updateBillingAccess(tx, { orgId, expectedVersion: subscription.version,
          billingAccessState: billingSuspended ? 'operational' : subscription.billingAccessState,
          billingSuspensionCause: billingSuspended ? null : cause,
          restrictionDeadline: grant, now });
        if (!next) throw domainError('VERSION_CONFLICT', 'Subscription changed while grace was approved.');
      }
      if (typeof outbox?.enqueue === 'function') await outbox.enqueue(tx, { events: [{
        eventId: idSource.newId('billing-event'), eventType: decision === 'approve' ? 'SubscriptionGraceApproved.v1' : 'SubscriptionGraceDenied.v1', schemaVersion: 1,
        operationId, orgId, aggregateType: 'SubscriptionGraceRequest', aggregateId: graceRequestId,
        aggregateVersion: updatedRequest.version, occurredAt: now, correlationId: operationId,
        payload: { graceRequestId, periodId: request.periodId, decision, grantedUntil: grant, reason },
      }] });
      return updatedRequest;
    }});
  }
  async function grantPlatformGrace({ orgId, actorId, days, reason, operationId }) {
    const now = iso(clock.now());
    const nowMs = Date.parse(now);
    if (!Number.isSafeInteger(days) || days < 1 || days > resolvedPolicy.grace.maxDaysPerPeriod) {
      throw domainError('GRACE_DAYS_INVALID', 'Platform grace must be from 1 to ' + resolvedPolicy.grace.maxDaysPerPeriod + ' days.', 400);
    }
    return unitOfWork.runLifecycle({
      orgId, operationId, requestFingerprint: fingerprint({ orgId, actorId, days, reason, operationId }),
      callback: async (tx) => {
        const subscription = await repository.getOrganizationSubscription(tx, { orgId, forUpdate: true });
        if (!subscription) throw domainError('SUBSCRIPTION_NOT_FOUND', 'Organization subscription was not found.', 404);
        const cause = subscription.billingSuspensionCause;
        if (subscription.billingAccessState === 'security_suspended' || cause === 'security' || cause === 'security_suspension') {
          throw domainError('SECURITY_SUSPENSION', 'A security suspension must be cleared through the security review process.');
        }
        if (!subscription.currentPeriodId) throw domainError('PERIOD_NOT_FOUND', 'An active subscription period is required to grant access grace.');
        const period = rowsOf(await tx.query('SELECT ends_at,status FROM billing_periods WHERE org_id=? AND id=? FOR UPDATE', [orgId, subscription.currentPeriodId]))[0];
        if (!period || !['active', 'scheduled', 'expired'].includes(String(period.status).toLowerCase())) {
          throw domainError('PERIOD_NOT_FOUND', 'A current subscription billing period is required to grant access grace.');
        }
        const periodEnd = Date.parse(iso(period.ends_at));
        const currentDeadline = subscription.restrictionDeadline ? Date.parse(subscription.restrictionDeadline) : 0;
        const base = new Date(Math.max(nowMs, periodEnd, currentDeadline)).toISOString();
        const grantedUntil = shiftCalendarDays(base, days, { timeZone: resolvedPolicy.billingTimeZone });
        const updated = await repository.updateBillingAccess(tx, { orgId, expectedVersion: subscription.version,
          billingAccessState: 'operational', billingSuspensionCause: null, restrictionDeadline: grantedUntil, now });
        if (!updated) throw domainError('VERSION_CONFLICT', 'Subscription changed while platform grace was being granted.');
        // Keep organization access and billing grace in the same transaction.
        await tx.query("UPDATE organizations SET status='Active' WHERE id=?", [orgId]);
        return { orgId, days, grantedUntil, reason: String(reason || '').trim(), subscription: updated };
      },
    });
  }
  return Object.freeze({ createRequest, decide, grantPlatformGrace });
}

function createConfiguredSubscriptionGraceService({ pool, idSource = { newId: (prefix) => `${prefix}-${crypto.randomUUID()}` }, clock = { now: () => new Date().toISOString() }, policy } = {}) {
  const db = pool || require('../db/pool').getPool();
  const { createMysqlOutboxStore } = require('./adapters/mysql/outboxStore');
  return createSubscriptionGraceService({ unitOfWork: createMysqlUnitOfWork({ pool: db, operationStore, idSource, clock }),
    repository: createMysqlSubscriptionRepository(), pool: db, idSource, clock, policy,
    outbox: createMysqlOutboxStore({ pool: db, clock, tokenSource: idSource }) });
}

module.exports = { createSubscriptionGraceService, createConfiguredSubscriptionGraceService, assertRequestedUntil, BILLING_CAUSES, NON_BILLING_CAUSES };
