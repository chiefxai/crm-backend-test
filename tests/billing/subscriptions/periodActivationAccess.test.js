'use strict';

const { createPeriodActivationService } = require('../../../src/billing/modules/subscriptions/periodActivationService');

describe('period activation and subscription access', () => {
  test('persists the next post-expiry restriction deadline and restores only billing access', async () => {
    const tx = { metadata: { orgId: 'org-1' } };
    const activateLinkedPeriod = jest.fn();
    const service = createPeriodActivationService({
      unitOfWork: { runFinancial: async ({ callback }) => callback(tx) },
      periodRepository: {
        getPeriod: async () => ({ id: 'period-1', orgId: 'org-1', periodKind: 'subscription', status: 'scheduled',
          startAt: '2026-01-01T00:00:00.000Z', endAt: '2026-02-01T00:00:00.000Z', termsSnapshot: { terms: { includedCredits: { asset: 'INR', units: '0', scale: 2 } } } }),
        getPeriodFunding: async () => ({ paymentRequestId: 'payment-1' }),
        listPeriods: async () => [],
        transitionPeriod: async (_tx, input) => ({ id: 'period-1', status: input.status, ...input.fields }),
      },
      creditRepository: { ensureAccount: jest.fn(), createGrant: jest.fn(), applyJournal: jest.fn() },
      subscriptionRepository: { activateLinkedPeriod },
      outbox: { enqueue: async () => {} },
      clock: { now: () => '2026-01-01T00:00:00.000Z' },
    });

    await service.activatePeriod({ orgId: 'org-1', periodId: 'period-1', now: '2026-01-01T00:00:00.000Z' });
    expect(activateLinkedPeriod).toHaveBeenCalledWith(tx, {
      orgId: 'org-1', periodId: 'period-1', restrictionDeadline: '2026-02-08T00:00:00.000Z', now: '2026-01-01T00:00:00.000Z',
    });
  });
});
