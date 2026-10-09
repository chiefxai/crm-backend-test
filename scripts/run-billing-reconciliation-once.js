#!/usr/bin/env node
'use strict';

// Audits one explicitly named organization. Never changes ledger balances.
const { closePool } = require('../src/db/pool');
const { runBillingReconciliation } = require('../src/billing/reconciliationRunner');

async function main() {
  try {
    const result = await runBillingReconciliation({
      orgId: process.env.BILLING_RECONCILIATION_ORG_ID,
      limit: process.env.BILLING_RECONCILIATION_LIMIT === undefined
        ? 25 : Number(process.env.BILLING_RECONCILIATION_LIMIT),
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.findings?.length || result.complete === false) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(JSON.stringify({
      error: 'Billing reconciliation failed.',
      code: error.code || 'BILLING_RECONCILIATION_FAILED',
    }) + '\n');
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
if (require.main === module) void main();
module.exports = { main };
