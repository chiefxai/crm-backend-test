'use strict';

const crypto = require('node:crypto');
const { getPool } = require('../db/pool');
const operationStore = require('./adapters/mysql/commandOperationRepository');
const { createMysqlUnitOfWork } = require('./adapters/mysql/unitOfWork');
const { createMysqlOutboxStore } = require('./adapters/mysql/outboxStore');
const { createMysqlPeriodRepository } = require('./modules/subscriptions/repositories/mysqlPeriodRepository');
const { createMysqlCreditRepository } = require('./modules/credits/repositories/mysqlCreditRepository');
const { createMysqlPeriodJobRepository } = require('./adapters/jobs/period/mysqlPeriodJobRepository');
const { createPeriodActivationService } = require('./modules/subscriptions/periodActivationService');
const { createSubscriptionPeriodJobs } = require('./modules/subscriptions/periodJobs');

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
  const activationService = createPeriodActivationService({
    unitOfWork,
    periodRepository: createMysqlPeriodRepository(),
    creditRepository: createMysqlCreditRepository({ idSource, clock }),
    outbox,
    clock,
  });
  return createSubscriptionPeriodJobs({
    unitOfWork,
    candidateRepository: createMysqlPeriodJobRepository({ pool }),
    activationService,
    outbox,
    clock,
  });
}

const LIFECYCLE_MODES = Object.freeze(['activate', 'renewal-reminders']);
function validateRunOptions({ mode, limit = 25, now = new Date().toISOString(), leadTimeSeconds = 7 * 86400 } = {}) {
  if (!LIFECYCLE_MODES.includes(mode)) throw new TypeError('mode must be activate or renewal-reminders.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit must be between 1 and 100.');
  if (typeof now !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(now)
    || !Number.isFinite(Date.parse(now))) throw new TypeError('now must be a UTC ISO-8601 timestamp.');
  if (!Number.isSafeInteger(leadTimeSeconds) || leadTimeSeconds < 1 || leadTimeSeconds > 90 * 86400) {
    throw new TypeError('leadTimeSeconds must be between 1 and 7776000.');
  }
  return Object.freeze({ mode, limit, now, leadTimeSeconds });
}

function lifecycleFlag(mode) {
  return mode === 'activate' ? 'BILLING_SUBSCRIPTION_ACTIVATION_ENABLED' : 'BILLING_RENEWAL_REMINDERS_ENABLED';
}

async function runBillingLifecycleOnce(options, {
  env = process.env,
  jobsFactory = createBillingLifecycleJobs,
} = {}) {
  const run = validateRunOptions(options);
  if (env[lifecycleFlag(run.mode)] !== 'true') {
    return Object.freeze({ skipped: true, reason: 'disabled', mode: run.mode, scanned: 0, results: [] });
  }
  const jobs = jobsFactory();
  if (run.mode === 'activate') return jobs.activateDuePeriods({ now: run.now, limit: run.limit });
  return jobs.queueDueRenewalEvents({ now: run.now, limit: run.limit, leadTimeSeconds: run.leadTimeSeconds });
}

module.exports = { createBillingLifecycleJobs, runBillingLifecycleOnce, validateRunOptions, lifecycleFlag };
