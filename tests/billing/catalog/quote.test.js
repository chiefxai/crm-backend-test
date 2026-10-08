'use strict';

const { createQuote } = require('../../../src/billing/modules/catalog/quote');

const money = (units) => ({ asset: 'INR', units: String(units), scale: 6 });
const input = (overrides = {}) => ({
  quoteId: 'quote-1',
  version: 1,
  purpose: 'purchase',
  orgId: 'org-1',
  plan: {
    id: 'team',
    version: 3,
    terms: {
      schemaVersion: 1,
      currency: 'INR',
      billingInterval: { unit: 'month', count: 1 },
      subscriptionPrice: money('100000000'),
      structure: { mode: 'mixed_industry', includedWorkspaces: 1, includedDistinctIndustries: 1, maxWorkspaces: 20, maxDistinctIndustries: 5 },
      workspaceFees: { additionalWorkspace: money('20000000'), additionalDistinctIndustry: money('50000000') },
      includedCredits: money('500000000'),
      taxes: [{ code: 'GST', rateBps: 1800, appliesTo: ['subscription', 'additional_workspace', 'additional_industry'], inclusive: false }],
      postpaid: { eligible: true, workspaceModes: ['limited'], organizationExposureLimit: money('1000000000') },
      serviceAfterExpiry: { mode: 'grace', graceSeconds: 3600 },
    },
  },
  inventory: { workspaceCount: 3, industries: [{ code: 'health', count: 2 }, { code: 'retail', count: 1 }], version: 7 },
  createdAt: '2026-10-08T10:00:00Z',
  validUntil: '2026-10-15T10:00:00Z',
  adjustments: [{ code: 'promo', kind: 'percent', rateBps: 1000 }],
  ...overrides,
});

describe('billing catalog quotes', () => {
  test('prices snapshot counts, itemizes fees, discount, tax, and separates credits', () => {
    const quote = createQuote(input());
    expect(quote.lines.map((line) => line.code)).toEqual([
      'subscription_base', 'additional_workspace', 'additional_industry', 'discount_promo', 'tax_GST',
    ]);
    expect(quote.subtotal).toEqual(money('190000000'));
    expect(quote.discounts).toEqual(money('19000000'));
    expect(quote.totalTax).toEqual(money('30780000'));
    expect(quote.total).toEqual(money('201780000'));
    expect(quote.includedCredits).toEqual(money('500000000'));
    expect(quote.total).not.toEqual(quote.includedCredits);
    expect(quote.paymentIsCreditValue).toBe(false);
    expect(quote.plan.version).toBe(3);
    expect(quote.inventory.distinctIndustryCount).toBe(2);
    expect(Object.isFrozen(quote)).toBe(true);
    expect(Object.isFrozen(quote.lines[0])).toBe(true);
  });

  test('is deterministic and fingerprints plan and inventory snapshots', () => {
    const original = createQuote(input());
    expect(createQuote(input()).fingerprint).toBe(original.fingerprint);
    const changedInventory = createQuote(input({ inventory: { workspaceCount: 4, industries: [{ code: 'health', count: 2 }, { code: 'retail', count: 2 }], version: 8 } }));
    expect(changedInventory.fingerprint).not.toBe(original.fingerprint);
    const changedPlan = input();
    changedPlan.plan.terms.subscriptionPrice = money('110000000');
    expect(createQuote(changedPlan).fingerprint).not.toBe(original.fingerprint);
  });

  test('reports structure conflicts while retaining a priced snapshot', () => {
    const quote = createQuote(input({
      plan: { ...input().plan, terms: { ...input().plan.terms, structure: { mode: 'same_industry', includedWorkspaces: 1, includedDistinctIndustries: 1, maxWorkspaces: 2, maxDistinctIndustries: 1 } } },
    }));
    expect(quote.conflicts.map((conflict) => conflict.code)).toEqual([
      'MIXED_INDUSTRY_NOT_ALLOWED', 'WORKSPACE_LIMIT_EXCEEDED', 'INDUSTRY_LIMIT_EXCEEDED',
    ]);
  });

  test('applies explicit tax rounding and discounts only to their selected category', () => {
    const quote = createQuote(input({
      adjustments: [{ code: 'base-promo', kind: 'percent', rateBps: 1000, appliesTo: ['subscription'] }],
    }));
    expect(quote.discounts).toEqual(money('10000000'));
    expect(quote.totalTax).toEqual(money('32400000'));
    expect(quote.total).toEqual(money('212400000'));
  });

  test('supports arbitrary currency scales and independent monthly credit units', () => {
    const scaled = input();
    scaled.plan.terms.subscriptionPrice = { asset: 'INR', units: '10000', scale: 2 };
    scaled.plan.terms.workspaceFees = { additionalWorkspace: { asset: 'INR', units: '2000', scale: 2 }, additionalDistinctIndustry: { asset: 'INR', units: '5000', scale: 2 } };
    scaled.plan.terms.includedCredits = { asset: 'CREDITS', units: '500', scale: 0 };
    const quote = createQuote(scaled);
    expect(quote.total).toEqual({ asset: 'INR', units: '20178', scale: 2 });
    expect(quote.includedCredits).toEqual({ asset: 'CREDITS', units: '500', scale: 0 });
    expect(quote.plan.terms.billingInterval).toEqual({ unit: 'month', count: 1 });
  });

  test('rejects malformed inventory and mismatched quote currency', () => {
    expect(() => createQuote(input({ inventory: { workspaceCount: 2, industries: [{ code: 'retail', count: 1 }], version: 1 } }))).toThrow(/sum to inventory.workspaceCount/);
    const invalidInput = input();
    invalidInput.plan.terms.subscriptionPrice = { asset: 'USD', units: '1', scale: 2 };
    expect(() => createQuote(invalidInput)).toThrow(/match plan currency/);
  });
});
