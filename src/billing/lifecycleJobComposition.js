'use strict';

const crypto = require('node:crypto');
const { getPool } = require('../db/pool');
const operationStore = require('./adapters/mysql/commandOperationRepository');
const { createMysqlUnitOfWork } = require('./adapters/mysql/unitOfWork');
const { createMysqlOutboxStore } = require('./adapters/mysql/outboxStore');
const { createMysqlPeriodRepository } = require('./modules/subscriptions/repositories/mysqlPeriodRepository');
const { createMysqlCreditRepository } = require('./modules/credits/repositories/mysqlCreditRepository');
const { createMysqlPeriodJobRepository } = require('./adapters/jobs/period/mysqlPeriodJobRepository');
const { createMysqlSubscriptionAccessJobRepository } = require('./adapters/jobs/subscriptionAccess/mysqlSubscriptionAccessJobRepository');
const { createPeriodActivationService } = require('./modules/subscriptions/periodActivationService');
const { createSubscriptionPeriodJobs } = require('./modules/subscriptions/periodJobs');
const { createMysqlSubscriptionRepository } = require('./modules/subscriptions/repositories/mysqlSubscriptionRepository');
const { createSubscriptionAccessJobs } = require('./modules/subscriptions/accessJobs');
const { resolveSubscriptionPolicy } = require('./modules/subscriptions/policy');
const { createAutomaticCreditAllocationService, automaticAllocationsEnabled } = require('./automaticCreditAllocationService');

/**
 * Compose existing billing lifecycle services for an explicit bounded tick.
 * No timers, HTTP endpoints or automatic scheduling are registered here.
 */
function createBillingLifecycleJobs({
  pool = getPool(),
  clock = { now: () => new Date().toISOString() },
  idSource = { newId: prefix => `${prefix}-${crypto.randomUUID()}` },
} = {}) {
  const unitOfWork = createMysqlUnitOfWork({ pool, operationStore, clock, idSource });
  const outbox = createMysqlOutboxStore({ pool, clock, tokenSource: idSource });
  const policy = resolveSubscriptionPolicy();
  const creditRepository = createMysqlCreditRepository({ idSource, clock });
  const automaticAllocationService = createAutomaticCreditAllocationService({ creditRepository, clock });
  const activationService = createPeriodActivationService({
    unitOfWork,
    periodRepository: createMysqlPeriodRepository(),
    creditRepository,
    automaticAllocationService,
    automaticAllocationEnabled: orgId => automaticAllocationsEnabled(orgId),
    subscriptionRepository: createMysqlSubscriptionRepository(),
    outbox,
    clock,
    subscriptionPolicy: policy,
  });
  const periodJobs = createSubscriptionPeriodJobs({
    unitOfWork,
    candidateRepository: createMysqlPeriodJobRepository({ pool }),
    activationService,
    outbox,
    clock,
  });
  const accessJobs = createSubscriptionAccessJobs({
    unitOfWork,
    candidateRepository: createMysqlSubscriptionAccessJobRepository({ pool }),
    subscriptionRepository: createMysqlSubscriptionRepository(),
    outbox,
    clock,
    policy,
  });
  return Object.freeze({ ...periodJobs, ...accessJobs });
}

const LIFECYCLE_MODES = Object.freeze(['activate', 'renewal-reminders', 'enforce-access', 'product-notifications']);
function validateRunOptions({ mode, limit = 25, now = new Date().toISOString(), leadTimeSeconds = 7 * 86400 } = {}) {
  if (!LIFECYCLE_MODES.includes(mode)) throw new TypeError(`mode must be one of ${LIFECYCLE_MODES.join(', ')}.`);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit must be between 1 and 100.');
  if (typeof now !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(now)
    || !Number.isFinite(Date.parse(now))) throw new TypeError('now must be a UTC ISO-8601 timestamp.');
  if (!Number.isSafeInteger(leadTimeSeconds) || leadTimeSeconds < 1 || leadTimeSeconds > 90 * 86400) {
    throw new TypeError('leadTimeSeconds must be between 1 and 7776000.');
  }
  return Object.freeze({ mode, limit, now, leadTimeSeconds });
}

function lifecycleFlag(mode) {
  if (mode === 'activate') return 'BILLING_SUBSCRIPTION_ACTIVATION_ENABLED';
  if (mode === 'renewal-reminders') return 'BILLING_RENEWAL_REMINDERS_ENABLED';
  if (mode === 'product-notifications') return 'BILLING_PRODUCT_NOTIFICATIONS_ENABLED';
  return 'BILLING_SUBSCRIPTION_ACCESS_ENFORCEMENT_ENABLED';
}

async function runBillingLifecycleOnce(options, {
  env = process.env,
  jobsFactory = createBillingLifecycleJobs,
} = {}) {
  const run = validateRunOptions(options);
  if (env[lifecycleFlag(run.mode)] !== 'true') {
    return Object.freeze({ skipped: true, reason: 'disabled', mode: run.mode, scanned: 0, results: [] });
  }
  if (run.mode === 'product-notifications') return require('../notifications/billingScanner').scanProductNotifications({ now: run.now, limit: run.limit, leadDays: Math.ceil(run.leadTimeSeconds/86400) });
  const jobs = jobsFactory();
  if (run.mode === 'activate') return jobs.activateDuePeriods({ now: run.now, limit: run.limit });
  if (run.mode === 'renewal-reminders') return jobs.queueDueRenewalEvents({ now: run.now, limit: run.limit, leadTimeSeconds: run.leadTimeSeconds });
  return jobs.enforceExpiredAccess({ now: run.now, limit: run.limit });
}

module.exports = { createBillingLifecycleJobs, runBillingLifecycleOnce, validateRunOptions, lifecycleFlag };
