'use strict';

const { validateQuoteForSubmission } = require('../../src/billing/modules/payments/domain');

describe('subscription upgrade payment submission stays disabled until entitlement application is wired', () => {
  const amount = { asset: 'INR', units: '1250', scale: 0 };
  const quote = { quoteType: 'adjustment', status: 'draft', amount, validUntil: '2026-07-01T00:00:00Z', paidAt: null };

  afterEach(() => { delete process.env.BILLING_SUBSCRIPTION_UPGRADE_FULFILLMENT_ENABLED; });

  test('keeps adjustment quotes unavailable while fulfillment is disabled', () => {
    expect(() => validateQuoteForSubmission({ purpose: 'subscription', quote, amount, now: '2026-06-15T00:00:00Z' }))
      .toThrow(/purpose does not match/);
  });

  test('remains unavailable even if an accidental fulfillment flag is set', () => {
    process.env.BILLING_SUBSCRIPTION_UPGRADE_FULFILLMENT_ENABLED = 'true';
    expect(() => validateQuoteForSubmission({ purpose: 'subscription', quote, amount, now: '2026-06-15T00:00:00Z' }))
      .toThrow(/purpose does not match/);
  });
});
