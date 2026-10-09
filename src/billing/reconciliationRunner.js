'use strict';

const { validateId } = require('./kernel/scope');
const { reconcileOrganizationBilling } = require('./reconciliationReadModel');

async function runBillingReconciliation({
  orgId, limit = 25, env = process.env, reconcile = reconcileOrganizationBilling,
} = {}) {
  // Fail closed before creating a DB connection.
  if (env.BILLING_RECONCILIATION_ENABLED !== 'true') {
    return Object.freeze({ skipped: true, reason: 'disabled', findings: [] });
  }
  validateId(orgId, 'orgId');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('limit must be between 1 and 100.');
  }
  return reconcile(orgId, { limit });
}

module.exports = { runBillingReconciliation };
