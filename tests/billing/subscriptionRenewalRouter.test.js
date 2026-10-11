'use strict';

jest.mock('../../src/middleware/auth', () => ({
  requireAuth: (_req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
}));

const { createSubscriptionRenewalRouter, renewalResponse } = require('../../src/billing/subscriptionRenewalRouter');
const { createSubscriptionRenewalComposition, renewalQuotePayable } = require('../../src/billing/subscriptionRenewalComposition');
const { requireFeature } = require('../../src/billing/subscriptionPurchaseRouter');

describe('subscription renewal HTTP contract', () => {
  const oldFlag = process.env.BILLING_SUBSCRIPTION_PURCHASE_ENABLED;
  afterEach(() => { if (oldFlag === undefined) delete process.env.BILLING_SUBSCRIPTION_PURCHASE_ENABLED; else process.env.BILLING_SUBSCRIPTION_PURCHASE_ENABLED = oldFlag; });

  test('reports renewal eligibility and directs payment to the existing payment route', () => {
    const result = renewalResponse({ subscription: { lifecycleStatus: 'active' }, period: { renewalEligible: true }, quote: null });
    expect(result.period.renewalEligible).toBe(true);
    expect(result.payment).toMatchObject({ purpose: 'subscription', submissionPath: '/api/billing/payments' });
  });

  test('an approved and paid renewal quote is never reported payable', () => {
    expect(renewalQuotePayable({ status: 'paid', validUntil: '2099-01-01T00:00:00.000Z', paidAt: '2026-10-11T00:00:00.000Z', now: Date.parse('2026-10-11T00:00:01.000Z') })).toBe(false);
  });

  test('keeps the renewal router mounted and uses the existing opt-in gate', () => {
    process.env.BILLING_SUBSCRIPTION_PURCHASE_ENABLED = 'false';
    expect(createSubscriptionRenewalRouter()).toBeTruthy();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    requireFeature({}, res, () => { throw new Error('must not advance'); });
    expect(res.status).toHaveBeenCalledWith(503);
  });

  test('does not accept a parallel payment service in renewal response', () => {
    process.env.BILLING_SUBSCRIPTION_PURCHASE_ENABLED = 'true';
    const result = renewalResponse({ subscription: {}, period: {}, quote: null });
    expect(result.payment.submissionPath).toBe('/api/billing/payments');
    expect(result.payment.purpose).toBe('subscription');
  });
});

describe('renewal repository type support', () => {
  test('requires direct version lookup and canonical plan identity for quote creation', () => {
    expect(() => createSubscriptionRenewalComposition({ getPlanVersion: null })).toThrow('canonical plan version reader');
  });
});
