'use strict';

const { createPaymentDecisionService } = require('../../src/billing/modules/payments/decisions');

describe('subscription upgrade payment approval', () => {
  afterEach(() => { delete process.env.BILLING_SUBSCRIPTION_UPGRADE_FULFILLMENT_ENABLED; });

  test('rejects a direct/manual adjustment approval before it pays the quote or mutates the subscription', async () => {
    process.env.BILLING_SUBSCRIPTION_UPGRADE_FULFILLMENT_ENABLED = 'true';
    const mutations = [];
    const service = createPaymentDecisionService({
      unitOfWork: { async runFinancial({ callback }) { return callback({}); } },
      repository: {
        async getForUpdate() { return { id: 'payment-1', orgId: 'org-1', quoteId: 'quote-1', purpose: 'subscription',
          status: 'pending_verification', expectedAmount: { asset: 'INR', units: '1250', scale: 0 }, version: 1,
          quote: { type: 'adjustment', status: 'accepted', paidAt: null,
            amount: { asset: 'INR', units: '1250', scale: 0 }, snapshot: { schemaVersion: 1, purpose: 'adjustment' } } }; },
        async markQuotePaid() { mutations.push('quote-paid'); },
        async saveDecision() { mutations.push('payment-approved'); },
        async createFulfillment() { mutations.push('fulfillment'); },
      },
      creditRepository: { async ensureAccount() { mutations.push('account'); }, async createGrant() { mutations.push('grant'); }, async applyJournal() { mutations.push('journal'); } },
      periodLifecycle: { async schedulePaidRenewalInTransaction() { mutations.push('period'); } },
      subscriptionRepository: { async applyApprovedUpgrade() { mutations.push('subscription'); } },
      outbox: { async enqueue() { mutations.push('outbox'); } },
      idSource: { newId: (kind) => `${kind}-1` }, clock: { now: () => '2026-06-15T00:00:00.000Z' },
      authorizeDecision: async () => true,
    });
    const actor = { type: 'user', id: 'platform-1', organizationId: 'org-1' };
    const trustedContext = { schemaVersion: 1, operationId: 'decision-op-1', requestFingerprint: `sha256:${'a'.repeat(64)}`, actor };
    const command = { schemaVersion: 1, orgId: 'org-1', paymentRequestId: 'payment-1', decision: 'approve',
      expectedVersion: 1, receivedAmount: { asset: 'INR', units: '1250', scale: 0 } };
    await expect(service.decide({ command, trustedContext })).rejects.toThrow(/effective workspace and member entitlements/);
    expect(mutations).toEqual([]);
  });
});
