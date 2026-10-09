'use strict';

const { DEFAULT_WORKSPACE_PLANS, normalizeWorkspacePlans } = require('../../../src/platform/billingSettings');

const plan = (overrides = {}) => ({
  id: 'growth-plus', name: 'Growth Plus', active: true, defaultMode: 'same_industry',
  pricing: {
    baseMonthlyInr: 5999, includedWorkspaces: 3,
    extraWorkspaceMonthlyInr: 400, additionalIndustryMonthlyInr: 0,
    monthlySubscriptionCreditsInr: 2500,
  },
  ...overrides,
});
const normalize = (plans) => normalizeWorkspacePlans({ expectedVersion: 1, plans }, 1);

describe('workspace plan subscription credit configuration', () => {
  test('accepts and persists monthly organization-level credit entitlement', () => {
    expect(normalize([plan()])[0].pricing.monthlySubscriptionCreditsInr).toBe(2500);
  });

  test('defaults older plans without the credit field to zero', () => {
    const oldPlan = plan();
    delete oldPlan.pricing.monthlySubscriptionCreditsInr;
    expect(normalize([oldPlan])[0].pricing.monthlySubscriptionCreditsInr).toBe(0);
  });

  test.each([-1, NaN, Infinity, 10.123, '100'])('rejects invalid credit amount %s', (value) => {
    expect(() => normalize([plan({ pricing: { ...plan().pricing, monthlySubscriptionCreditsInr: value } })])).toThrow(/monthly subscription credits/);
  });

  test('preserves nullable legacy base and workspace prices', () => {
    expect(normalize(DEFAULT_WORKSPACE_PLANS.plans)[0].pricing).toMatchObject({
      baseMonthlyInr: null, extraWorkspaceMonthlyInr: null, monthlySubscriptionCreditsInr: 0,
    });
  });

  test('rejects stale version to protect concurrent plan edits', () => {
    expect(() => normalizeWorkspacePlans({ expectedVersion: 0, plans: [plan()] }, 1)).toThrow(/Refresh before saving/);
  });
});
