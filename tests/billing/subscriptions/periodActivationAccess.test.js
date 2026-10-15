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

  test('keeps grant issuance and opted-in automatic allocation in the same financial transaction', async () => {
    const tx = { metadata: { orgId: 'org-1' } };
    const events = [];
    const automaticAllocationService = { allocateCreditsAutomatically: jest.fn(async input => ({
      status: 'allocated', allocationMode: 'automatic', grantId: input.grantId, workspaceId: 'workspace-1',
    })) };
    const creditRepository = {
      ensureAccount: jest.fn(async (_tx, input) => ({ id: input.accountPurpose === 'pool' ? 'pool-1' : 'clearing-1' })),
      createGrant: jest.fn(async () => {}),
      applyJournal: jest.fn(async () => ({ journalId: 'journal-1' })),
    };
    const termsSnapshot = {
      terms: { structure: { mode: 'single', maxWorkspaces: 1 }, includedCredits: { asset: 'INR', units: '2000', scale: 2 } },
    };
    const service = createPeriodActivationService({
      unitOfWork: { runFinancial: async ({ callback }) => callback(tx) },
      periodRepository: {
        getPeriod: async () => ({ id: 'period-1', orgId: 'org-1', periodKind: 'subscription', status: 'scheduled',
          startAt: '2026-01-01T00:00:00.000Z', endAt: '2026-02-01T00:00:00.000Z', termsSnapshot }),
        getPeriodFunding: async () => ({ paymentRequestId: 'payment-1' }),
        listPeriods: async () => [],
        transitionPeriod: async (_tx, input) => ({ id: 'period-1', status: input.status, ...input.fields }),
      },
      creditRepository,
      automaticAllocationService,
      automaticAllocationEnabled: true,
      outbox: { enqueue: async (_tx, input) => { events.push(...input.events); } },
      clock: { now: () => '2026-01-01T00:00:00.000Z' },
    });

    const result = await service.activatePeriod({ orgId: 'org-1', periodId: 'period-1', now: '2026-01-01T00:00:00.000Z' });
    expect(automaticAllocationService.allocateCreditsAutomatically).toHaveBeenCalledWith(expect.objectContaining({
      tx, orgId: 'org-1', grantId: result.grant.grantId, termsSnapshot, sourceEvent: 'subscription-period-activation',
    }));
    expect(result.grant.journalId).toBe('journal-1');
    expect(events[0].payload.automaticAllocation.status).toBe('allocated');
  });
});
