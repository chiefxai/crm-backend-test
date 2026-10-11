'use strict';

jest.mock('../../src/middleware/auth', () => ({
  requireAuth: (_req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
}));

const { purchaseResponse, readKey, FEATURE_FLAG } = require('../../src/billing/subscriptionPurchaseRouter');

describe('subscription purchase HTTP contract', () => {
  test('keeps fee and included credits separate and marks expired quotes unpayable', () => {
    const result = purchaseResponse({
      lifecycleStatus: 'onboarding', billingAccessState: 'billing_recovery',
      quoteId: 'quote-1', quoteStatus: 'draft', quoteVersion: 1,
      paymentAmount: { asset: 'INR', units: '300000', scale: 2 },
      includedCredits: { asset: 'INR', units: '400000', scale: 2 },
      validUntil: '2020-01-01T00:00:00.000Z',
    });
    expect(result.subscription).toMatchObject({ lifecycleStatus: 'onboarding', accessState: 'billing_recovery' });
    expect(result.quote.paymentAmount.units).toBe('300000');
    expect(result.quote.includedCredits.units).toBe('400000');
    expect(result.quote.expired).toBe(true);
    expect(result.quote.payable).toBe(false);
    expect(result.payment).toMatchObject({ purpose: 'subscription', submissionPath: '/api/billing/payments' });
  });

  test('uses a dedicated opt-in feature flag and requires a valid request key', () => {
    expect(FEATURE_FLAG).toBe('BILLING_SUBSCRIPTION_PURCHASE_ENABLED');
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    expect(readKey({ get: () => undefined }, res)).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(readKey({ get: () => 'initial-quote-1' }, res)).toBe('initial-quote-1');
  });

});
