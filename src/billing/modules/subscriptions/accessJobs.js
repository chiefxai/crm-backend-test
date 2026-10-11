'use strict';

const crypto = require('node:crypto');
const { DOMAIN_ERROR_CODES } = require('../../contracts/errors');

function stableId(prefix, value) {
  return `${prefix}-${crypto.createHash('sha256').update(value).digest('hex').slice(0, 40)}`;
}
function fingerprint(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

const ELIGIBLE_ACCESS_STATES = new Set(['operational', 'billing_recovery']);
const NON_BILLING_CAUSES = new Set(['manual', 'security', 'manual_suspension', 'security_suspension']);

function createSubscriptionAccessJobs({ unitOfWork, candidateRepository, subscriptionRepository, outbox, clock, policy } = {}) {
  if (typeof unitOfWork?.runLifecycle !== 'function') throw new TypeError('Subscription access jobs require UnitOfWork.runLifecycle().');
  if (typeof candidateRepository?.listDueAccessRestrictions !== 'function') throw new TypeError('Subscription access jobs require listDueAccessRestrictions().');
  if (typeof subscriptionRepository?.getOrganizationSubscription !== 'function'
      || typeof subscriptionRepository?.updateBillingAccess !== 'function') {
    throw new TypeError('Subscription access jobs require subscription access persistence methods.');
  }
  if (typeof clock?.now !== 'function') throw new TypeError('Subscription access jobs require a clock.');
  if (!policy || !Number.isSafeInteger(policy.postExpiryGraceDays) || policy.postExpiryGraceDays < 0) {
    throw new TypeError('Subscription access jobs require a resolved subscription policy.');
  }

  async function enforceExpiredAccess({ now = clock.now(), limit = 100, afterOrgId } = {}) {
    const nowIso = new Date(now).toISOString();
    if (!Number.isFinite(Date.parse(nowIso))) throw new TypeError('now must be a valid timestamp.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('limit must be between 1 and 500.');
    const candidates = await candidateRepository.listDueAccessRestrictions({ now: nowIso, limit, afterOrgId });
    const results = [];
    for (const candidate of candidates) {
      const orgId = candidate.orgId;
      const operationId = stableId('subscription-access-expiry', `${orgId}\0${candidate.restrictionDeadline}`);
      const requestFingerprint = fingerprint({ orgId, restrictionDeadline: candidate.restrictionDeadline, policyVersion: policy.schemaVersion || 1 });
      const result = await unitOfWork.runLifecycle({ orgId, operationId, requestFingerprint, callback: async (tx) => {
        const current = await subscriptionRepository.getOrganizationSubscription(tx, { orgId, forUpdate: true });
        if (!current || !ELIGIBLE_ACCESS_STATES.has(current.billingAccessState)
            || NON_BILLING_CAUSES.has(current.billingSuspensionCause)
            || !current.restrictionDeadline || Date.parse(current.restrictionDeadline) > Date.parse(nowIso)) {
          return { orgId, status: 'unchanged' };
        }
        const updated = await subscriptionRepository.updateBillingAccess(tx, {
          orgId,
          billingAccessState: 'billing_suspended',
          billingSuspensionCause: 'subscription_expired',
          restrictionDeadline: current.restrictionDeadline,
          expectedVersion: current.version,
          now: nowIso,
        });
        if (!updated) return { orgId, status: 'changed_concurrently' };
        if (typeof outbox?.enqueue === 'function') {
          const occurredAt = nowIso;
          const eventId = stableId('billing-event', `${orgId}\0access-restricted\0${current.version + 1}`);
          await outbox.enqueue(tx, { events: [{ eventId, eventType: 'SubscriptionAccessRestricted.v1', schemaVersion: 1,
            operationId, orgId, aggregateType: 'Subscription', aggregateId: orgId, aggregateVersion: current.version + 1,
            occurredAt, correlationId: operationId,
            payload: { restrictionDeadline: updated.restrictionDeadline, cause: 'subscription_expired' } }] });
        }
        return { orgId, status: 'suspended', restrictionDeadline: updated.restrictionDeadline };
      } });
      results.push(result);
    }
    return Object.freeze({ scanned: candidates.length, results: Object.freeze(results),
      nextAfter: candidates.length === limit ? { orgId: candidates[candidates.length - 1].orgId } : null });
  }

  return Object.freeze({ enforceExpiredAccess });
}

module.exports = { createSubscriptionAccessJobs, stableSubscriptionAccessJobId: stableId };
