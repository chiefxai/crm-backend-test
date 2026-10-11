'use strict';

const { mapWorkspacePlanToTerms } = require('../../../src/billing/modules/catalog/workspacePlanMapper');
const { composeImmediateUpgradeQuote, roundHalfUp } = require('../../../src/billing/modules/catalog/subscriptionUpgradeQuote');

const policy = { includedDistinctIndustries: 1, maxDistinctIndustries: null, taxes: [],
  postpaid: { eligible: false, workspaceModes: [], organizationExposureLimit: null },
  serviceAfterExpiry: { mode: 'suspend', graceSeconds: 0 } };
function plan(id, price, credits, taxes = []) {
  return { id, planId: id, version: 1, status: 'published', effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null,
    terms: mapWorkspacePlanToTerms({ id, name: id, active: true, defaultMode: 'single', pricing: {
      baseMonthlyInr: price, includedWorkspaces: 1, maxWorkspaces: 1, extraWorkspaceMonthlyInr: 0,
      includedSeats: 1, maxSeats: null, extraSeatMonthlyInr: 0, additionalIndustryMonthlyInr: 0,
      monthlySubscriptionCreditsInr: credits,
    } }, { ...policy, taxes }) };
}
const inventory = { workspaceCount: 1, industries: [{ code: 'lending', count: 1 }], seatCount: 1, version: 'inventory-v1' };
const period = { periodId: 'period-1', status: 'active', startsAt: '2026-10-01T00:00:00.000Z',
  endsAt: '2026-11-01T00:00:00.000Z', planId: 'basic', planVersion: 1 };

describe('immediate subscription upgrade quote', () => {
  test('uses exact remaining milliseconds for fee and incremental credits and remains non-payable', () => {
    const quote = composeImmediateUpgradeQuote({ currentPeriod: period,
      currentTerms: plan('basic', 3000, 4000).terms,
      targetPlanVersion: plan('enterprise', 5000, 6000), orgId: 'org-1', inventory,
      quoteId: 'upgrade-1', createdAt: '2026-10-16T12:00:00.000Z', validUntil: '2026-10-16T13:00:00.000Z' });
    expect(quote.purpose).toBe('adjustment');
    expect(quote.subtotal).toEqual({ asset: 'INR', units: '100000', scale: 2 });
    expect(quote.adjustment.incrementalIncludedCredits).toEqual({ asset: 'INR', units: '100000', scale: 2 });
    expect(quote.adjustment.renewalAnchorAt).toBe(period.endsAt);
    expect(quote.adjustment.applicationStatus).toBe('awaiting_payment_approval');
    expect(quote.upgradePreview).toEqual({ payable: false, paymentSubmissionPath: null,
      reason: 'UPGRADE_ENTITLEMENT_INTEGRATION_NOT_IMPLEMENTED' });
    expect(Object.isFrozen(quote.adjustment)).toBe(true);
  });

  test('rounds half-up once at the smallest unit for fee and credit fractions', () => {
    expect(roundHalfUp('1', 1, 2)).toBe(1n);
    expect(roundHalfUp('5', 1, 2)).toBe(3n);
    expect(roundHalfUp('4', 1, 2)).toBe(2n);
  });

  test('applies target subscription tax to the prorated amount and snapshots the tax inputs', () => {
    const quote = composeImmediateUpgradeQuote({ currentPeriod: period,
      currentTerms: plan('basic', 3000, 4000).terms,
      targetPlanVersion: plan('enterprise', 5000, 6000, [{ code: 'GST', rateBps: 1800, appliesTo: ['subscription'], inclusive: false }]),
      orgId: 'org-1', inventory, quoteId: 'upgrade-tax', createdAt: '2026-10-16T12:00:00.000Z', validUntil: '2026-10-16T13:00:00.000Z' });
    expect(quote.totalTax).toEqual({ asset: 'INR', units: '18000', scale: 2 });
    expect(quote.total).toEqual({ asset: 'INR', units: '118000', scale: 2 });
    expect(quote.plan.terms.taxes[0]).toMatchObject({ code: 'GST', rateBps: 1800 });
  });

  test('rejects downgrades, expired periods and stale target versions', () => {
    const currentTerms = plan('basic', 3000, 4000).terms;
    expect(() => composeImmediateUpgradeQuote({ currentPeriod: period, currentTerms,
      targetPlanVersion: plan('lower', 2000, 3000), orgId: 'org-1', inventory, quoteId: 'q1',
      createdAt: '2026-10-16T12:00:00.000Z', validUntil: '2026-10-16T13:00:00.000Z' })).toThrow(/lower or equal recurring fee/);
    expect(() => composeImmediateUpgradeQuote({ currentPeriod: period, currentTerms,
      targetPlanVersion: plan('future', 5000, 6000), orgId: 'org-1', inventory, quoteId: 'q2',
      createdAt: '2026-11-01T00:00:00.000Z', validUntil: '2026-11-02T00:00:00.000Z' })).toThrow(/current paid period is not active/);
    const stale = { ...plan('expired', 5000, 6000), effectiveTo: '2026-10-01T00:00:00.000Z' };
    expect(() => composeImmediateUpgradeQuote({ currentPeriod: period, currentTerms, targetPlanVersion: stale,
      orgId: 'org-1', inventory, quoteId: 'q3', createdAt: '2026-10-16T12:00:00.000Z',
      validUntil: '2026-10-16T13:00:00.000Z' })).toThrow(/not effective/);
  });
});
