'use strict';

const { createQuote } = require('./quote');
const { normalizePlanTerms } = require('./terms');

function invalid(message, code = 'INVALID_PLAN_VERSION') {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}

/**
 * Compose a purchase/renewal/upgrade quote from a published catalog version.
 * The catalog lookup and tenant authorization belong to the calling adapter;
 * this boundary rechecks the returned immutable version and effective window.
 */
function composeSubscriptionQuote({ planVersion, purpose, orgId, inventory, quoteId, version = 1, createdAt, validUntil, adjustments }) {
  if (!planVersion || typeof planVersion !== 'object' || Array.isArray(planVersion)) invalid('A versioned plan record is required.');
  if (planVersion.status !== 'published') invalid('Only a published plan version can be quoted.');
  if (!Number.isSafeInteger(planVersion.version) || planVersion.version < 1
      || typeof planVersion.planId !== 'string' || !planVersion.planId) invalid('The selected plan version identity is invalid.');
  const now = Date.parse(createdAt);
  const effectiveFrom = Date.parse(planVersion.effectiveFrom);
  const effectiveTo = planVersion.effectiveTo == null ? null : Date.parse(planVersion.effectiveTo);
  if (!Number.isFinite(now) || !Number.isFinite(effectiveFrom)
      || (planVersion.effectiveTo != null && !Number.isFinite(effectiveTo))
      || now < effectiveFrom || (effectiveTo !== null && now >= effectiveTo)) {
    invalid('The selected plan version is stale or is not effective at the quote time.', 'VERSION_CONFLICT');
  }
  return createQuote({
    quoteId, version, purpose, orgId,
    plan: { id: planVersion.planId, version: planVersion.version, terms: normalizePlanTerms(planVersion.terms) },
    inventory, createdAt, validUntil, ...(adjustments === undefined ? {} : { adjustments }),
  });
}

module.exports = { composeSubscriptionQuote };
