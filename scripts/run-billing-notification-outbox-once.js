#!/usr/bin/env node
'use strict';

// Single bounded notification outbox tick. No recurring scheduler registered.
const { runBillingNotificationOutboxOnce } = require('../src/billing/notificationOutboxComposition');
const { closePool } = require('../src/db/pool');

async function main() {
  try {
    const raw = process.env.BILLING_NOTIFICATION_OUTBOX_BATCH_SIZE;
    const limit = raw === undefined ? 25 : Number(raw);
    const result = await runBillingNotificationOutboxOnce({ limit });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.unsupported || result.retryScheduled || result.ackFailed || result.settlementFailed) {
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(JSON.stringify({
      error: 'Billing notification outbox tick failed.',
      code: error.code || 'BILLING_NOTIFICATION_OUTBOX_FAILED',
    }) + '\n');
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

if (require.main === module) void main();
module.exports = { main };
