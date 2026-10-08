'use strict';

const crypto = require('node:crypto');

const DEFAULTS = Object.freeze({
  batchSize: 50,
  leaseMs: 60_000,
  maxOrganizations: 500,
  maxAttempts: 8,
  baseDelayMs: 1_000,
  maxDelayMs: 15 * 60_000,
});

function boundedInteger(value, name, min = 1, max = 10_000) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function normalizeOrgId(value) {
  const id = typeof value === 'string' ? value : value?.orgId;
  if (typeof id !== 'string' || id.length === 0 || id.length > 191) return null;
  return id;
}

function errorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : 'HANDLER_FAILED';
  return /^[A-Z][A-Z0-9_]{0,95}$/.test(code) ? code : 'HANDLER_FAILED';
}

function canonical(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function eventEnvelope(event) {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    schemaVersion: event.schemaVersion,
    orgId: event.orgId,
    operationId: event.operationId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateVersion: event.aggregateVersion,
    occurredAt: event.occurredAt,
    correlationId: event.correlationId,
    causationId: event.causationId ?? null,
    payload: event.payload,
  };
}

function eventFingerprint(event) {
  return `sha256:${crypto.createHash('sha256').update(canonical(eventEnvelope(event))).digest('hex')}`;
}

function eventOperationId(event) {
  const digest = crypto.createHash('sha256').update(`${event.orgId}\0${event.eventId}`).digest('hex');
  return `billing-event:${digest}`;
}

function validateDependencies({ outboxStore, registry, workerId, consumerRunner, inboxStore, idSource, clock }) {
  for (const method of ['listReadyOrganizations', 'claimBatch', 'ack', 'fail']) {
    if (typeof outboxStore?.[method] !== 'function') throw new TypeError(`Billing worker outbox store requires ${method}().`);
  }
  if (typeof registry?.resolve !== 'function') throw new TypeError('Billing worker requires a dispatch registry.');
  if (typeof consumerRunner?.runConsumer !== 'function') throw new TypeError('Billing worker requires a transaction-bound consumer runner.');
  if (typeof inboxStore?.process !== 'function') throw new TypeError('Billing worker requires a transactional inbox store.');
  if (typeof idSource?.newId !== 'function') throw new TypeError('Billing worker requires idSource.newId().');
  if (typeof clock?.now !== 'function') throw new TypeError('Billing worker requires clock.now().');
  if (typeof workerId !== 'string' || workerId.trim() === '' || workerId.length > 191) {
    throw new TypeError('Billing worker requires a non-empty workerId of at most 191 characters.');
  }
}

/**
 * Create a single bounded worker tick. Persistence owns lease safety; this
 * runner only dispatches and settles claims. No timers or scheduler definitions
 * are created here, so existing scheduler wiring can invoke runOnce later.
 */
function createBillingJobWorker({
  outboxStore,
  registry,
  workerId,
  consumerRunner,
  inboxStore,
  idSource,
  clock,
  batchSize = DEFAULTS.batchSize,
  leaseMs = DEFAULTS.leaseMs,
  maxOrganizations = DEFAULTS.maxOrganizations,
  maxPerOrganization,
  maxAttempts = DEFAULTS.maxAttempts,
  baseDelayMs = DEFAULTS.baseDelayMs,
  maxDelayMs = DEFAULTS.maxDelayMs,
  logger = { error() {} },
} = {}) {
  validateDependencies({ outboxStore, registry, workerId, consumerRunner, inboxStore, idSource, clock });
  boundedInteger(batchSize, 'batchSize', 1, 1_000);
  boundedInteger(leaseMs, 'leaseMs', 1_000, 24 * 60 * 60_000);
  boundedInteger(maxOrganizations, 'maxOrganizations', 1, 10_000);
  maxPerOrganization = maxPerOrganization ?? batchSize;
  boundedInteger(maxPerOrganization, 'maxPerOrganization', 1, batchSize);
  boundedInteger(maxAttempts, 'maxAttempts', 1, 100);
  boundedInteger(baseDelayMs, 'baseDelayMs', 1, 24 * 60 * 60_000);
  boundedInteger(maxDelayMs, 'maxDelayMs', baseDelayMs, 7 * 24 * 60 * 60_000);

  // This cursor advances the bounded candidate scan across all eligible orgs,
  // including sets larger than maxOrganizations. The claim store remains the
  // authority for deciding which jobs are ready and fencing their leases.
  let afterOrgId = null;

  async function claimFairBatch() {
    const scanArgs = () => afterOrgId === null
      ? { limit: maxOrganizations }
      : { limit: maxOrganizations, afterOrgId };
    let candidates = await outboxStore.listReadyOrganizations(scanArgs());
    if (!Array.isArray(candidates)) throw new TypeError('Billing outbox listReadyOrganizations() must return an array.');
    if (candidates.length === 0 && afterOrgId !== null) {
      afterOrgId = null;
      candidates = await outboxStore.listReadyOrganizations(scanArgs());
      if (!Array.isArray(candidates)) throw new TypeError('Billing outbox listReadyOrganizations() must return an array.');
    }
    if (candidates.length === 0) return [];
    const orgIds = [...new Set(candidates.map(normalizeOrgId).filter(Boolean))];
    if (orgIds.length === 0) return [];
    const ordered = orgIds;
    const claimed = [];

    // Round-robin quota: each org gets a bounded first share before any org can
    // consume another. Repeating rounds fills spare capacity without allowing a
    // single backlog to monopolize the batch.
    for (let round = 0; round < maxPerOrganization && claimed.length < batchSize; round += 1) {
      let madeProgress = false;
      for (const orgId of ordered) {
        if (claimed.length >= batchSize) break;
        const rows = await outboxStore.claimBatch({
          orgId,
          workerId,
          limit: Math.min(1, batchSize - claimed.length),
          leaseMs,
        });
        if (!Array.isArray(rows)) throw new TypeError('Billing outbox claimBatch() must return an array.');
        for (const row of rows) {
          if (!row || row.orgId !== orgId) throw new TypeError('Billing outbox returned a claim for the wrong organization.');
          claimed.push(row);
          madeProgress = true;
          if (claimed.length >= batchSize) break;
        }
      }
      if (!madeProgress) break;
    }
    // Continue after the last org that actually received a claim. Persisting
    // the end of the candidate page would repeatedly drain its first batch and
    // starve candidates later in the same page when batchSize < maxOrganizations.
    afterOrgId = claimed.length ? claimed[claimed.length - 1].orgId : orgIds[orgIds.length - 1];
    return claimed;
  }

  async function settleFailure(event, failure, permanent = false) {
    const code = errorCode(failure);
    try {
      await outboxStore.fail({
        eventId: event.eventId,
        workerId,
        leaseToken: event.leaseToken,
        fencingToken: event.fencingToken,
      }, {
        errorCode: permanent ? 'UNSUPPORTED_EVENT_TYPE' : code,
        maxAttempts: permanent ? 1 : maxAttempts,
        baseDelayMs,
        maxDelayMs,
      });
      return true;
    } catch (settlementError) {
      logger.error('Billing job failure settlement failed', {
        eventId: event.eventId,
        errorCode: errorCode(settlementError),
      });
      return false;
    }
  }

  async function processClaim(event) {
    const handler = registry.resolve(event.eventType);
    if (!handler) {
      await settleFailure(event, new Error('No billing event handler registered.'), true);
      return { status: 'unsupported', eventId: event.eventId };
    }

    try {
      const envelope = eventEnvelope(event);
      await consumerRunner.runConsumer({
        orgId: event.orgId,
        operationId: eventOperationId(event),
        requestFingerprint: eventFingerprint(event),
        callback: async (tx) => {
          const inboxResult = await inboxStore.process(tx, {
            id: idSource.newId('billing-inbox'),
            orgId: event.orgId,
            consumerKey: event.eventType,
            eventId: event.eventId,
            eventType: event.eventType,
            now: clock.now(),
          }, async (inboxTx) => handler(envelope, inboxTx));
          return {
            processed: Boolean(inboxResult.processed),
            duplicate: Boolean(inboxResult.duplicate),
            resultReference: inboxResult.resultReference ?? null,
          };
        },
      });
    } catch (failure) {
      const settled = await settleFailure(event, failure);
      return { status: settled ? 'retry_scheduled' : 'settlement_failed', eventId: event.eventId };
    }

    try {
      await outboxStore.ack({
        eventId: event.eventId,
        workerId,
        leaseToken: event.leaseToken,
        fencingToken: event.fencingToken,
      });
      return { status: 'completed', eventId: event.eventId };
    } catch (failure) {
      // The handler may already have committed side effects. The event will be
      // reclaimed after lease expiry; consumers must use inbox/idempotency.
      logger.error('Billing job acknowledgement failed', { eventId: event.eventId, errorCode: errorCode(failure) });
      return { status: 'ack_failed', eventId: event.eventId };
    }
  }

  async function runOnce() {
    const events = await claimFairBatch();
    const results = [];
    for (const event of events) results.push(await processClaim(event));
    return {
      workerId,
      claimed: events.length,
      completed: results.filter((result) => result.status === 'completed').length,
      retryScheduled: results.filter((result) => result.status === 'retry_scheduled').length,
      unsupported: results.filter((result) => result.status === 'unsupported').length,
      ackFailed: results.filter((result) => result.status === 'ack_failed').length,
      settlementFailed: results.filter((result) => result.status === 'settlement_failed').length,
      results,
    };
  }

  return Object.freeze({ runOnce });
}

/** Small invocation entrypoint intended for later scheduler composition. */
function createBillingJobWorkerEntrypoint(dependencies) {
  const worker = createBillingJobWorker(dependencies);
  return Object.freeze({ runBillingJobsOnce: () => worker.runOnce() });
}

module.exports = {
  createBillingJobWorker,
  createBillingJobWorkerEntrypoint,
  eventEnvelope,
  eventFingerprint,
  eventOperationId,
  DEFAULTS,
};
