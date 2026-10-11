'use strict';

const { fromDecimal } = require('../../kernel/amount');
const { normalizePlanTerms } = require('./terms');

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'INVALID_PLAN_MAPPING';
  throw error;
}

function decimalAmount(value, path) {
  // Platform plan settings are validated decimal numbers for legacy workspace
  // pricing. Convert their canonical decimal spelling immediately to integer
  // units; all quote arithmetic then stays in BigInt-backed amount values.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
      || Math.round(value * 100) / 100 !== value) {
    invalid(`${path} must be a non-negative INR amount with at most two decimal places.`);
  }
  return fromDecimal('INR', String(value), 2);
}

function requiredPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    invalid('An explicit billingPolicy is required to map platform plans into purchased billing terms.');
  }
  for (const field of ['includedDistinctIndustries', 'maxDistinctIndustries', 'taxes', 'postpaid', 'serviceAfterExpiry']) {
    if (!Object.prototype.hasOwnProperty.call(policy, field)) {
      invalid(`billingPolicy.${field} must be explicitly configured; the workspace plan does not define it.`);
    }
  }
  if (policy.billingInterval !== undefined
      && (policy.billingInterval.unit !== 'month' || policy.billingInterval.count !== 1)) {
    invalid('The workspace-plan source represents monthly pricing; billingPolicy.billingInterval must be one month.');
  }
  return policy;
}

/**
 * Map a platform workspace plan into versioned financial terms.
 *
 * The old platform plan editor does not own tax, postpaid, expiry, or included
 * distinct-industry policy. Those values must be supplied explicitly; this
 * mapper intentionally refuses to invent them. The recurring fee and monthly
 * usage-credit allowance are mapped independently.
 */
function mapWorkspacePlanToTerms(plan, billingPolicy) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) invalid('plan must be a platform workspace plan.');
  const policy = requiredPolicy(billingPolicy);
  if (!plan.id || typeof plan.id !== 'string') invalid('plan.id is required.');
  if (plan.active !== true) invalid(`Plan ${plan.id} is inactive and cannot be quoted.`);
  const pricing = plan.pricing;
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) invalid(`Plan ${plan.id} has no pricing configuration.`);
  if (pricing.baseMonthlyInr == null) invalid(`Plan ${plan.id} has no configured monthly subscription fee.`);
  if (!['single', 'same_industry', 'mixed_industry'].includes(plan.defaultMode)) invalid(`Plan ${plan.id} has an unsupported workspace mode.`);

  const includedWorkspaces = plan.defaultMode === 'single' ? 1 : pricing.includedWorkspaces;
  const maxWorkspaces = plan.defaultMode === 'single' ? 1 : (pricing.maxWorkspaces ?? null);
  const maxDistinctIndustries = plan.defaultMode === 'single' || plan.defaultMode === 'same_industry'
    ? 1 : policy.maxDistinctIndustries;
  const terms = {
    schemaVersion: 1,
    currency: 'INR',
    billingInterval: { unit: 'month', count: 1 },
    subscriptionPrice: decimalAmount(pricing.baseMonthlyInr, `Plan ${plan.id} monthly subscription fee`),
    structure: {
      mode: plan.defaultMode,
      includedWorkspaces,
      includedDistinctIndustries: policy.includedDistinctIndustries,
      maxWorkspaces,
      maxDistinctIndustries,
      orgAdminWorkspaceIndustry: 'primary_only',
    },
    workspaceFees: {
      additionalWorkspace: decimalAmount(pricing.extraWorkspaceMonthlyInr, `Plan ${plan.id} additional workspace fee`),
      additionalDistinctIndustry: decimalAmount(pricing.additionalIndustryMonthlyInr, `Plan ${plan.id} additional industry fee`),
    },
    seats: {
      included: pricing.includedSeats,
      max: pricing.maxSeats ?? null,
      additionalSeat: decimalAmount(pricing.extraSeatMonthlyInr, `Plan ${plan.id} additional seat fee`),
    },
    industryModules: plan.industryModules || {},
    includedCredits: decimalAmount(pricing.monthlySubscriptionCreditsInr ?? 0, `Plan ${plan.id} monthly usage credits`),
    taxes: policy.taxes,
    postpaid: policy.postpaid,
    serviceAfterExpiry: policy.serviceAfterExpiry,
  };
  return normalizePlanTerms(terms);
}

/** Build the catalog service input for a specific platform plan revision. */
function workspacePlanCatalogInput(plan, billingPolicy) {
  if (!plan || typeof plan !== 'object') invalid('plan is required.');
  return {
    code: plan.id,
    displayName: plan.name,
    terms: mapWorkspacePlanToTerms(plan, billingPolicy),
  };
}

module.exports = { mapWorkspacePlanToTerms, workspacePlanCatalogInput };
