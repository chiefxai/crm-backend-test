'use strict';

const { previewSubscriptionReconciliation, classify } = require('../../src/billing/subscriptionReconciliationPreview');
const { createSubscriptionReconciliationRouter } = require('../../src/billing/subscriptionReconciliationRouter');

describe('subscription reconciliation preview', () => {
  test('classifies only evidence and never treats legacy balance or plan selection as payment', () => {
    const versioned = classify({ settings: JSON.stringify({ workspacePolicy: { planId: 'starter', planVersion: 4 } }),
      recharge_balance_inr: '5000', recharge_reserved_inr: '0', period_count: 0, payment_count: 0,
      grant_count: 0, active_period_count: 0, active_grant_count: 0 });
    expect(versioned.classification).toBe('versioned_plan_no_billing_evidence');
    expect(versioned.reviewRequired).toBe(true);
    expect(classify({ billing_account_id: 'o1', settings: JSON.stringify({ workspacePolicy: { planId: 'starter', planVersion: 4 } }),
      period_count: 0, payment_count: 0, grant_count: 0 })).toMatchObject({
      classification: 'versioned_plan_no_billing_evidence', reviewRequired: true,
    });
    expect(classify({ settings: '{}', period_count: 0, payment_count: 0, grant_count: 0 }))
      .toMatchObject({ classification: 'legacy_plan_unverified', reviewRequired: true });
    expect(classify({ settings: '{}', period_count: 1, payment_count: 0, grant_count: 0 }))
      .toMatchObject({ classification: 'existing_billing_history_review', reviewRequired: true });
    expect(classify({ settings: '{}', active_period_count: 1, active_grant_count: 1 }))
      .toMatchObject({ classification: 'active_billing_evidence', reviewRequired: true });
  });

  test('uses a bounded read-only page and reports that no values are inferred', async () => {
    const calls = [];
    const pool = { query: async (sql, params) => {
      calls.push({ sql, params });
      return [[{ org_id: 'o1', organization_name: 'Org', subscription_plan: 'Starter', settings: '{}',
        recharge_balance_inr: '2500', recharge_reserved_inr: '0', period_count: 0, active_period_count: 0,
        payment_count: 0, grant_count: 0, active_grant_count: 0 }], []];
    } };
    const result = await previewSubscriptionReconciliation({ pool, limit: 1000, offset: -1 });
    expect(calls[0].params).toEqual([100, 0]);
    expect(calls[0].sql).toMatch(/^\s*SELECT/);
    expect(result).toMatchObject({ mode: 'read_only_preview', mutatesData: false, returned: 1 });
    expect(result.candidates[0].legacyBalanceEvidence.note).toMatch(/not evidence of subscription payment/);
    expect(result.notice).toMatch(/No payment, entitlement, period/);
    expect(calls[0].sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  test('registers only a GET platform preview endpoint', () => {
    const router = createSubscriptionReconciliationRouter({ preview: async () => ({ mode: 'read_only_preview' }) });
    const route = router.stack.find((layer) => layer.route)?.route;
    expect(route.path).toBe('/billing/subscription-reconciliation/preview');
    expect(route.methods).toEqual({ get: true });
  });
});
