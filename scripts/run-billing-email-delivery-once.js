#!/usr/bin/env node
'use strict';

// One bounded staging-only delivery tick. No recurring timer is installed.
const { runBillingEmailDeliveryOnce } = require('../src/billing/emailDeliveryComposition');
const { closePool } = require('../src/db/pool');

async function main() {
  try {
    const raw = process.env.BILLING_EMAIL_DELIVERY_BATCH_SIZE;
    const limit = raw === undefined ? 25 : Number(raw);
    const result = await runBillingEmailDeliveryOnce({ limit });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.outcomes?.some(x => x.resultStatus !== 'submitted')) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(JSON.stringify({
      error: 'Billing email delivery tick failed.',
      code: error.code || 'BILLING_EMAIL_DELIVERY_FAILED',
    }) + '\n');
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

if (require.main === module) void main();
module.exports = { main };
