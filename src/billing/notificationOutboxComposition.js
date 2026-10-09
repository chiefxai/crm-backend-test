'use strict';

const crypto = require('node:crypto');
const { getPool } = require('../db/pool');
const { createMysqlOutboxStore } = require('./adapters/mysql/outboxStore');
const { createMysqlConsumerRunner } = require('./adapters/mysql/consumerRunner');
const inboxStore = require('./adapters/mysql/inboxConsumer');
const { createBillingJobWorker } = require('./adapters/jobs/worker');
const { createBillingJobDispatchRegistry } = require('./adapters/jobs/dispatchRegistry');
const { createBillingEmailEventHandlers } = require('./adapters/delivery/eventHandlers');
const { createMysqlNotificationRepository } = require('./modules/notifications/repositories/mysqlNotificationRepository');
const { createMysqlEmailDeliveryRepository } = require('./adapters/delivery/mysqlEmailDeliveryRepository');

const HANDLED_EMAIL_EVENTS = Object.freeze([
  'BillingContactVerificationRequested.v1',
  'SubscriptionRenewalDue.v1',
  'PaymentConfirmed.v1',
]);

function restrictedOutbox(store, allowedEventTypes) {
  if (!Array.isArray(allowedEventTypes) || allowedEventTypes.length === 0) {
    throw new TypeError('A non-empty event allowlist is required.');
  }
  const allowed = Object.freeze([...allowedEventTypes]);
  return Object.freeze({
    listReadyOrganizations: options => store.listReadyOrganizations({ ...options, allowedEventTypes: allowed }),
    claimBatch: options => store.claimBatch({ ...options, allowedEventTypes: allowed }),
    ack: claim => store.ack(claim),
    fail: (claim, options) => store.fail(claim, options),
  });
}

/**
 * Only known notification events are claimed; other financial event types are
 * never leased by this worker and remain available for their own processors.
 */
function createBillingNotificationOutboxWorker({
  pool = getPool(),
  clock = { now: () => new Date().toISOString() },
  idSource = { newId: prefix => `${prefix}-${crypto.randomUUID()}` },
  workerId = `billing-notification-${crypto.randomUUID()}`,
  batchSize = 25,
} = {}) {
  const handlers = createBillingEmailEventHandlers({
    notificationRepository: createMysqlNotificationRepository({ idSource, clock }),
    deliveryRepository: createMysqlEmailDeliveryRepository({ pool, clock }),
    clock,
  });
  const registry = createBillingJobDispatchRegistry({
    'BillingContactVerificationRequested.v1': (event, tx) => handlers.handleContactVerification(tx, event),
    'SubscriptionRenewalDue.v1': (event, tx) => handlers.handleRenewalDue(tx, event),
    'PaymentConfirmed.v1': (event, tx) => handlers.handlePaymentConfirmed(tx, event),
  });
  const baseOutbox = createMysqlOutboxStore({ pool, clock, tokenSource: idSource });
  return createBillingJobWorker({
    outboxStore: restrictedOutbox(baseOutbox, HANDLED_EMAIL_EVENTS),
    registry,
    workerId,
    consumerRunner: createMysqlConsumerRunner({ pool }),
    inboxStore,
    idSource,
    clock,
    batchSize,
  });
}

async function runBillingNotificationOutboxOnce({
  env = process.env,
  workerFactory = createBillingNotificationOutboxWorker,
  limit = 25,
} = {}) {
  if (env.BILLING_NOTIFICATION_OUTBOX_ENABLED !== 'true') {
    return Object.freeze({ skipped: true, reason: 'disabled', claimed: 0, completed: 0 });
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('Notification outbox limit must be 1 to 100.');
  }
  if (String(env.BILLING_EMAIL_PAYLOAD_KEY || '').length < 32) {
    const error = new Error('Billing notification encryption configuration is missing.');
    error.code = 'BILLING_EMAIL_CONFIG_MISSING';
    throw error;
  }
  return workerFactory({ batchSize: limit }).runOnce();
}

module.exports = {
  HANDLED_EMAIL_EVENTS,
  restrictedOutbox,
  createBillingNotificationOutboxWorker,
  runBillingNotificationOutboxOnce,
};
