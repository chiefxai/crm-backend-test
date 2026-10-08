'use strict';

const crypto = require('node:crypto');
const { DOMAIN_ERROR_CODES } = require('../../contracts/errors');

function stableId(prefix, value) { return `${prefix}-${crypto.createHash('sha256').update(value).digest('hex').slice(0, 40)}`; }
function fingerprint(value) { return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }

function createSubscriptionPeriodJobs({ unitOfWork, candidateRepository, activationService, outbox, clock } = {}) {
  if (typeof unitOfWork?.runLifecycle !== 'function') throw new TypeError('Subscription period jobs require UnitOfWork.runLifecycle().');
  for (const method of ['listDueActivations', 'listRenewalsDue']) {
    if (typeof candidateRepository?.[method] !== 'function') throw new TypeError(`Period candidate repository requires ${method}().`);
  }
  if (typeof activationService?.activatePeriod !== 'function') throw new TypeError('Period jobs require activatePeriod().');
  if (typeof outbox?.enqueue !== 'function') throw new TypeError('Period jobs require a transactional outbox.');
  if (typeof clock?.now !== 'function') throw new TypeError('Period jobs require a clock.');

  async function activateDuePeriods({ now = clock.now(), limit = 100, after } = {}) {
    const candidates = await candidateRepository.listDueActivations({ now, limit, after });
    const results = [];
    for (const candidate of candidates) {
      try {
        results.push({ periodId: candidate.id, status: 'activated', result: await activationService.activatePeriod({ orgId: candidate.orgId, periodId: candidate.id, now }) });
      } catch (error) {
        if (error?.retryable || error?.code === DOMAIN_ERROR_CODES.RETRYABLE_CONCURRENCY || error?.code === DOMAIN_ERROR_CODES.RETRYABLE_STORAGE) throw error;
        results.push({ periodId: candidate.id, status: 'blocked', errorCode: error?.code || DOMAIN_ERROR_CODES.PERIOD_INVALID });
      }
    }
    const last = candidates[candidates.length - 1];
    return Object.freeze({ scanned: candidates.length, results: Object.freeze(results), nextAfter: candidates.length === limit ? { startAt: last.startAt, id: last.id } : null });
  }

  async function queueDueRenewalEvents({ now = clock.now(), leadTimeSeconds = 7 * 86400, limit = 100, after } = {}) {
    const candidates = await candidateRepository.listRenewalsDue({ now, leadTimeSeconds, limit, after });
    const results = [];
    for (const period of candidates) {
      const opId = stableId('renewal-due', `${period.orgId}\0${period.id}\0${leadTimeSeconds}`);
      const requestFingerprint = fingerprint({ orgId: period.orgId, periodId: period.id, leadTimeSeconds, type: 'SubscriptionRenewalDue.v1' });
      const reminderAt = new Date(Date.parse(period.endAt) - leadTimeSeconds * 1000).toISOString();
      const event = {
        eventId: stableId('billing-event', `${period.orgId}\0renewal-due\0${period.id}\0${leadTimeSeconds}`),
        eventType: 'SubscriptionRenewalDue.v1', schemaVersion: 1, operationId: opId, orgId: period.orgId,
        aggregateType: 'BillingPeriod', aggregateId: period.id, aggregateVersion: 1,
        occurredAt: reminderAt, correlationId: opId,
        payload: {
          periodId: period.id, periodEndsAt: period.endAt, reminderAt, leadTimeSeconds,
          amount: period.renewalQuoteAmount || period.termsSnapshot?.terms?.subscriptionPrice || null,
          termsVersion: period.termsSnapshot?.termsVersion ?? null,
          pendingRenewalRequestId: period.pendingRenewalRequestId,
          pendingRenewalStatus: period.pendingRenewalStatus,
        },
      };
      await unitOfWork.runLifecycle({ orgId: period.orgId, operationId: opId, requestFingerprint, callback: async (tx) => {
        await outbox.enqueue(tx, { events: [event] });
        return { periodId: period.id, eventId: event.eventId, queued: true };
      } });
      results.push({ periodId: period.id, eventId: event.eventId, status: 'queued' });
    }
    const last = candidates[candidates.length - 1];
    return Object.freeze({ scanned: candidates.length, results: Object.freeze(results), nextAfter: candidates.length === limit ? { endAt: last.endAt, id: last.id } : null });
  }

  return Object.freeze({ activateDuePeriods, queueDueRenewalEvents });
}

module.exports = { createSubscriptionPeriodJobs, stableLifecycleJobId: stableId };
