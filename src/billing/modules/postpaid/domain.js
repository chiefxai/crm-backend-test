'use strict';

const { validateAmount } = require('../../kernel/amount');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../contracts/errors');

function normalizePostpaidPolicy(policy, { asset, scale }) {
  if (!policy || !['disabled', 'limited', 'unlimited'].includes(policy.mode)) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Postpaid policy mode must be disabled, limited, or unlimited.');
  }
  if (policy.mode !== 'limited') {
    if (policy.cycleLimit !== undefined) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Only limited postpaid policies may have a cycle limit.');
    return Object.freeze({ mode: policy.mode, cycleLimit: null });
  }
  const cycleLimit = validateAmount(policy.cycleLimit);
  if (cycleLimit.asset !== asset || cycleLimit.scale !== scale) throw new BillingDomainError(DOMAIN_ERROR_CODES.MIXED_ASSET, 'Postpaid cycle limit must match the organization billing asset and scale.');
  return Object.freeze({ mode: 'limited', cycleLimit });
}

function ensurePostpaidEligibility({ policy, platformTerms, serviceAccess, workspaceId }) {
  if (policy.mode === 'disabled') return;
  if (!platformTerms?.postpaid?.eligible || !serviceAccess?.allowed) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.POSTPAID_DISABLED, 'The active platform subscription does not permit postpaid funding.');
  }
  if (!platformTerms.postpaid.workspaceModes?.includes(policy.mode)) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.POSTPAID_DISABLED, 'The active platform subscription does not permit this workspace postpaid mode.', { details: { workspaceId, mode: policy.mode } });
  }
}

module.exports = { normalizePostpaidPolicy, ensurePostpaidEligibility };
