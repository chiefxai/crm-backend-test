'use strict';

const crypto = require('node:crypto');
const { automaticAllocationsEnabled, previewAutomaticAllocationReconciliation } = require('./automaticCreditAllocationService');

function operationId(orgId, grantId) {
  return `reconcile-auto-credit-${crypto.createHash('sha256').update(`${orgId}\0${grantId}\0v1`).digest('hex').slice(0, 40)}`;
}
function requestFingerprint(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/**
 * Read-only by default. Execution transfers each grant in its own financial
 * operation so an interrupted run can safely retry already completed grants.
 */
function createSingleWorkspaceCreditReconciliation({ readSnapshot, unitOfWork, automaticAllocationService,
  isEnabled = orgId => automaticAllocationsEnabled(orgId) } = {}) {
  if (typeof readSnapshot !== 'function') throw new TypeError('Reconciliation requires readSnapshot().');
  if (typeof unitOfWork?.runFinancial !== 'function') throw new TypeError('Reconciliation requires UnitOfWork.runFinancial().');
  if (typeof automaticAllocationService?.allocateCreditsAutomatically !== 'function') {
    throw new TypeError('Reconciliation requires the automatic allocation service.');
  }

  return Object.freeze({
    async reconcile({ orgId, dryRun = true, now = new Date().toISOString() } = {}) {
      if (typeof orgId !== 'string' || !orgId.trim()) throw new TypeError('orgId is required.');
      if (typeof dryRun !== 'boolean') throw new TypeError('dryRun must be a boolean.');
      const snapshot = await readSnapshot(orgId, { now: new Date(now) });
      if (!snapshot) return Object.freeze({ status: 'not_found', dryRun, orgId, transfers: [], results: [] });
      const preview = previewAutomaticAllocationReconciliation(snapshot);
      if (dryRun) return Object.freeze({ ...preview, dryRun: true, orgId, results: [] });
      if (!isEnabled(orgId)) return Object.freeze({ ...preview, status: 'disabled', dryRun: false, orgId, results: [] });
      if (preview.status !== 'dry_run_ready') {
        return Object.freeze({ ...preview, dryRun: false, orgId, results: [] });
      }

      const results = [];
      for (const item of preview.transfers) {
        const commandId = operationId(orgId, item.grantId);
        const fingerprint = requestFingerprint({ orgId, grantId: item.grantId, workspaceId: item.workspaceId,
          allocationMode: 'automatic', action: 'single_workspace_credit_reconciliation_v1' });
        const result = await unitOfWork.runFinancial({ orgId, operationId: commandId, requestFingerprint: fingerprint,
          callback: tx => automaticAllocationService.allocateCreditsAutomatically({
            tx, orgId, grantId: item.grantId, sourceEvent: 'existing-balance-reconciliation', now,
          }),
        });
        results.push(result);
      }
      return Object.freeze({ ...preview, status: 'completed', dryRun: false, orgId, results: Object.freeze(results) });
    },
  });
}

module.exports = { createSingleWorkspaceCreditReconciliation, operationId, requestFingerprint };
