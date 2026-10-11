'use strict';

const { mapWorkspacePlanToTerms, workspacePlanCatalogInput } = require('../../../src/billing/modules/catalog/workspacePlanMapper');
const { composeSubscriptionQuote } = require('../../../src/billing/modules/catalog/subscriptionQuoteComposition');

const policy = {
  includedDistinctIndustries: 1,
  maxDistinctIndustries: null,
  taxes: [],
  postpaid: { eligible: false, workspaceModes: [], organizationExposureLimit: null },
  serviceAfterExpiry: { mode: 'suspend', graceSeconds: 0 },
};

const enterprise = {
  id: 'enterprise', name: 'Enterprise', active: true, defaultMode: 'mixed_industry',
  industryModules: { lending: ['campaigns'] },
  pricing: {
    baseMonthlyInr: 3000, includedWorkspaces: 2, maxWorkspaces: 10,
    extraWorkspaceMonthlyInr: 125.5, includedSeats: 20, maxSeats: null,
    extraSeatMonthlyInr: 25, additionalIndustryMonthlyInr: 500,
    monthlySubscriptionCreditsInr: 4000,
  },
};

describe('workspace plan to subscription catalog mapping', () => {
  test('keeps the subscription fee separate from included monthly credits', () => {
    const terms = mapWorkspacePlanToTerms(enterprise, policy);
    expect(terms.subscriptionPrice).toEqual({ asset: 'INR', units: '300000', scale: 2 });
    expect(terms.includedCredits).toEqual({ asset: 'INR', units: '400000', scale: 2 });
    expect(terms.workspaceFees.additionalWorkspace).toEqual({ asset: 'INR', units: '12550', scale: 2 });
    expect(terms.seats.additionalSeat).toEqual({ asset: 'INR', units: '2500', scale: 2 });
  });

  test('rejects an unpriced plan and missing non-pricing policy instead of guessing', () => {
    expect(() => mapWorkspacePlanToTerms({ ...enterprise, pricing: { ...enterprise.pricing, baseMonthlyInr: null } }, policy))
      .toThrow(/no configured monthly subscription fee/);
    expect(() => mapWorkspacePlanToTerms(enterprise, { taxes: [], postpaid: policy.postpaid, serviceAfterExpiry: policy.serviceAfterExpiry }))
      .toThrow(/includedDistinctIndustries must be explicitly configured/);
  });

  test('creates a quote snapshot from the published plan version and its independent allowance', () => {
    const { terms } = workspacePlanCatalogInput(enterprise, policy);
    const quote = composeSubscriptionQuote({
      planVersion: { planId: 'enterprise', version: 3, status: 'published', effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null, terms },
      purpose: 'purchase', orgId: 'org-1', quoteId: 'quote-1',
      inventory: { workspaceCount: 1, industryCodes: ['lending'], version: 1 },
      createdAt: '2026-10-11T00:00:00Z', validUntil: '2026-10-12T00:00:00Z',
    });
    expect(quote.plan).toMatchObject({ id: 'enterprise', version: 3 });
    expect(quote.total).toEqual({ asset: 'INR', units: '300000', scale: 2 });
    expect(quote.includedCredits).toEqual({ asset: 'INR', units: '400000', scale: 2 });
    expect(quote.fingerprint).toMatch(/^sha256:/);
    expect(Object.isFrozen(quote.plan.terms)).toBe(true);
  });

  test('rejects a quote from a stale/unpublished catalog version', () => {
    const { terms } = workspacePlanCatalogInput(enterprise, policy);
    const version = { planId: 'enterprise', version: 3, status: 'published', effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-10-01T00:00:00Z', terms };
    expect(() => composeSubscriptionQuote({ planVersion: version, purpose: 'purchase', orgId: 'org-1', quoteId: 'quote-1',
      inventory: { workspaceCount: 1, industryCodes: ['lending'] }, createdAt: '2026-10-11T00:00:00Z', validUntil: '2026-10-12T00:00:00Z' }))
      .toThrow(/stale or is not effective/);
  });
});
