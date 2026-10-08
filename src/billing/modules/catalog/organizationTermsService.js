'use strict';

const { assertTransactionContext } = require('../../kernel/transactionContext');
const { normalizePlanTerms, normalizePlanOverrides, applyPlanOverrides } = require('./terms');

function requiredId(value, path) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(value)) throw new TypeError(`${path} must be a valid identifier.`);
  return value;
}
function timestamp(value, path) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${path} must be an ISO-8601 timestamp with an explicit timezone.`);
  }
  return new Date(value).toISOString();
}
function assertOrgTransaction(tx, orgId) {
  assertTransactionContext(tx);
  if (tx.metadata?.orgId !== orgId) throw new TypeError('transaction orgId must match organization terms orgId.');
}
function validatePlanVersion(planVersion, effectiveAt) {
  if (!planVersion || typeof planVersion !== 'object' || Array.isArray(planVersion)) throw new TypeError('published planVersion is required.');
  if (planVersion.status !== 'published') throw new TypeError('organization terms must reference a published plan version.');
  const result = {
    id: requiredId(planVersion.id, 'planVersion.id'),
    planId: requiredId(planVersion.planId, 'planVersion.planId'),
    version: planVersion.version,
    effectiveFrom: timestamp(planVersion.effectiveFrom, 'planVersion.effectiveFrom'),
    effectiveTo: planVersion.effectiveTo == null ? null : timestamp(planVersion.effectiveTo, 'planVersion.effectiveTo'),
    terms: normalizePlanTerms(planVersion.terms),
  };
  if (!Number.isSafeInteger(result.version) || result.version < 1) throw new TypeError('planVersion.version must be positive.');
  if (Date.parse(effectiveAt) < Date.parse(result.effectiveFrom)
    || (result.effectiveTo && Date.parse(effectiveAt) >= Date.parse(result.effectiveTo))) {
    throw new TypeError('effectiveAt must fall within the referenced published plan version window.');
  }
  return Object.freeze(result);
}

/**
 * Organization term snapshots are created only inside the shared per-org
 * UnitOfWork transaction. Platform authorization and actor authentication live
 * at the application/HTTP boundary.
 */
function createOrganizationTermsService({ repository, idSource, clock }) {
  if (!repository || typeof repository.insertEffectiveTerms !== 'function' || typeof repository.getEffectiveTerms !== 'function'
    || typeof idSource?.newId !== 'function' || typeof clock?.now !== 'function') {
    throw new TypeError('Organization terms service requires repository, ID source, and clock ports.');
  }

  async function setEffectiveTerms(tx, { orgId, planVersion, overrides = {}, effectiveAt, actorId, changeReason }) {
    orgId = requiredId(orgId, 'orgId');
    assertOrgTransaction(tx, orgId);
    actorId = requiredId(actorId, 'actorId');
    effectiveAt = timestamp(effectiveAt, 'effectiveAt');
    const normalizedPlan = validatePlanVersion(planVersion, effectiveAt);
    const normalizedOverrides = normalizePlanOverrides(overrides);
    const effectiveTerms = applyPlanOverrides(normalizedPlan.terms, normalizedOverrides);
    const now = timestamp(clock.now(), 'clock.now()');
    if (changeReason !== undefined && (typeof changeReason !== 'string' || changeReason.length > 1000)) throw new TypeError('changeReason must be at most 1000 characters.');
    return repository.insertEffectiveTerms(tx, {
      id: requiredId(idSource.newId('organization-billing-terms'), 'termsId'),
      orgId,
      planVersion: normalizedPlan,
      overrides: normalizedOverrides,
      effectiveTerms,
      effectiveAt,
      actorId,
      changeReason: changeReason?.trim() || null,
      now,
    });
  }

  async function getEffectiveTerms(tx, { orgId, at }) {
    orgId = requiredId(orgId, 'orgId');
    assertOrgTransaction(tx, orgId);
    return repository.getEffectiveTerms(tx, { orgId, at: timestamp(at || clock.now(), 'at') });
  }

  return Object.freeze({ setEffectiveTerms, getEffectiveTerms });
}

module.exports = { createOrganizationTermsService, validatePlanVersion };
