'use strict';

const crypto = require('node:crypto');
const { validatePostpaidPolicy, validateFundingModeChange } = require('../../contracts/commands');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../contracts/errors');
const { normalizePostpaidPolicy, ensurePostpaidEligibility } = require('./domain');

function createPostpaidPolicyService({ unitOfWork, repository, clock, authorize, resolveEligibility } = {}) {
  if (typeof unitOfWork?.runFinancial !== 'function') throw new TypeError('Postpaid policy service requires UnitOfWork.runFinancial().');
  if (typeof repository?.getWorkspacePolicyForUpdate !== 'function' || typeof repository?.setWorkspacePolicy !== 'function' || typeof repository?.setOrganizationFallbackMode !== 'function') throw new TypeError('Postpaid policy service requires a postpaid repository.');
  if (typeof clock?.now !== 'function' || typeof authorize !== 'function' || typeof resolveEligibility !== 'function') throw new TypeError('Postpaid policy service requires clock, authorization, and eligibility resolvers.');

  async function setWorkspacePolicy({ command, trustedContext } = {}) {
    const value = validatePostpaidPolicy(command, trustedContext);
    if (await authorize({ actor: value.context.actor, orgId: value.orgId, workspaceId: value.workspaceId, action: 'postpaid.policy.update' }) !== true) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Only an authorized organization administrator may configure workspace postpaid funding.');
    }
    const effectiveAt = clock.now();
    return unitOfWork.runFinancial({
      orgId: value.orgId, operationId: value.context.operationId,
      requestFingerprint: `sha256:${crypto.createHash('sha256').update(JSON.stringify({
        orgId: value.orgId, workspaceId: value.workspaceId, policy: value.policy, expectedVersion: value.expectedVersion,
      })).digest('hex')}`,
      expectedVersions: value.context.expectedVersions,
      callback: async (tx) => {
        const eligibility = await resolveEligibility({ tx, orgId: value.orgId, workspaceId: value.workspaceId, at: effectiveAt });
        if (!eligibility || typeof eligibility !== 'object') throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Postpaid eligibility resolver returned no policy.');
        const normalized = normalizePostpaidPolicy(value.policy, { asset: eligibility.asset, scale: eligibility.scale });
        ensurePostpaidEligibility({ policy: normalized, platformTerms: eligibility.terms, serviceAccess: eligibility.serviceAccess, workspaceId: value.workspaceId });
        if (value.cyclePeriodId && value.cyclePeriodId !== eligibility.periodId) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Postpaid policy period is stale.', { details: { expectedPeriodId: value.cyclePeriodId, actualPeriodId: eligibility.periodId || null } });
        return repository.setWorkspacePolicy(tx, {
          orgId: value.orgId, workspaceId: value.workspaceId, policy: normalized,
          asset: eligibility.asset, scale: eligibility.scale, effectiveAt,
          expectedVersion: value.expectedVersion,
        });
      },
    });
  }

  async function setFundingMode({ command, trustedContext } = {}) {
    const value = validateFundingModeChange(command, trustedContext);
    if (await authorize({ actor: value.context.actor, orgId: value.orgId, action: 'postpaid.funding_mode.update' }) !== true) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor is not authorized to change the organization funding mode.');
    }
    const effectiveAt = clock.now();
    return unitOfWork.runFinancial({
      orgId: value.orgId, operationId: value.context.operationId,
      requestFingerprint: `sha256:${crypto.createHash('sha256').update(JSON.stringify({ orgId: value.orgId, fallbackMode: value.fallbackMode, expectedVersion: value.expectedVersion })).digest('hex')}`,
      expectedVersions: value.context.expectedVersions,
      callback: async (tx) => {
        if (value.fallbackMode === 'postpaid') {
          const eligibility = await resolveEligibility({ tx, orgId: value.orgId, at: effectiveAt });
          if (!eligibility?.terms?.postpaid?.eligible) throw new BillingDomainError(DOMAIN_ERROR_CODES.POSTPAID_DISABLED, 'The active platform subscription does not permit postpaid funding.');
        }
        return repository.setOrganizationFallbackMode(tx, { orgId: value.orgId, fallbackMode: value.fallbackMode, expectedVersion: value.expectedVersion });
      },
    });
  }

  return Object.freeze({ setWorkspacePolicy, setFundingMode });
}

module.exports = { createPostpaidPolicyService };
