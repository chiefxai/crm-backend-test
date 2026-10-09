'use strict';

const crypto = require('node:crypto');
const { getPool } = require('../db/pool');
const { createMysqlEmailDeliveryRepository } = require('./adapters/delivery/mysqlEmailDeliveryRepository');
const { createEmailDeliveryWorker } = require('./adapters/delivery/emailDeliveryWorker');

function checkEmailDeliveryConfig(env = process.env) {
  // The existing mailer treats absent SMTP settings as skipped_unconfigured.
  // That is not an acceptable terminal state for queued billing email.
  const required = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'BILLING_EMAIL_PAYLOAD_KEY'];
  const missing = required.filter(key => !env[key] || !String(env[key]).trim());
  if (String(env.BILLING_EMAIL_PAYLOAD_KEY || '').length < 32 && !missing.includes('BILLING_EMAIL_PAYLOAD_KEY')) missing.push('BILLING_EMAIL_PAYLOAD_KEY');
  if (missing.length) {
    const error = new Error('Billing email delivery dependencies are not configured.');
    error.code = 'BILLING_EMAIL_CONFIG_MISSING';
    error.missing = missing;
    throw error;
  }
}

function createBillingEmailDeliveryTick({
  pool = getPool(),
  clock = { now: () => new Date().toISOString() },
  mailer = require('../email/mailer'),
  workerId = `billing-email-${crypto.randomUUID()}`,
  batchSize = 25,
} = {}) {
  return createEmailDeliveryWorker({
    repository: createMysqlEmailDeliveryRepository({ pool, clock }),
    mailer, workerId, clock, batchSize,
  });
}

async function runBillingEmailDeliveryOnce({
  env = process.env,
  workerFactory = createBillingEmailDeliveryTick,
  limit = 25,
} = {}) {
  if (env.BILLING_EMAIL_DELIVERY_ENABLED !== 'true') {
    return Object.freeze({ skipped: true, reason: 'disabled', processed: 0, outcomes: [] });
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('Email delivery limit must be an integer from 1 to 100.');
  }
  checkEmailDeliveryConfig(env);
  return workerFactory({ batchSize: limit }).runOnce({ limit });
}

module.exports = { checkEmailDeliveryConfig, createBillingEmailDeliveryTick, runBillingEmailDeliveryOnce };
