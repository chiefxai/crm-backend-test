#!/usr/bin/env node
'use strict';

// Operator-triggered single bounded tick. Intentionally not wired into
// server startup, cron, or external queues while financial tests are pending.
const { closePool } = require('../src/db/pool');
const { runBillingLifecycleOnce } = require('../src/billing/lifecycleJobComposition');

function argumentsFromEnv(env) {
  const mode = env.BILLING_LIFECYCLE_MODE;
  const limit = env.BILLING_LIFECYCLE_BATCH_SIZE === undefined ? 25 : Number(env.BILLING_LIFECYCLE_BATCH_SIZE);
  const leadTimeSeconds = env.BILLING_RENEWAL_LEAD_SECONDS === undefined
    ? 7 * 86400 : Number(env.BILLING_RENEWAL_LEAD_SECONDS);
  return { mode, limit, leadTimeSeconds, now: new Date().toISOString() };
}

async function main() {
  try {
    const result = await runBillingLifecycleOnce(argumentsFromEnv(process.env));
    process.stdout.write(JSON.stringify(result) + '\n');
    // A non-retryable candidate may be blocked. Do not report that as
    // a successful activation; require operator inspection.
    if (result.results?.some(item => item.status === 'blocked')) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(JSON.stringify({
      error: 'Billing lifecycle tick failed.',
      code: error.code || 'LIFECYCLE_RUN_FAILED',
    }) + '\n');
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

if (require.main === module) void main();
module.exports = { argumentsFromEnv, main };
