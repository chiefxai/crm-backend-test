'use strict';

const mockTx = { query: jest.fn(async () => ({ rows: [], affectedRows: 1 })) };

jest.mock('../../src/billing/adapters/mysql/unitOfWork', () => ({
  createMysqlUnitOfWork: () => ({
    runFinancial: async ({ callback }) => {
      const result = await callback(mockTx);
      const encoded = JSON.stringify(result);
      if (encoded === undefined) throw new Error('Financial command result must be a JSON object.');
      const parsed = JSON.parse(encoded);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Financial command result must be a JSON object.');
      }
      return parsed;
    },
  }),
}));
jest.mock('../../src/billing/adapters/mysql/commandOperationRepository', () => ({}));
jest.mock('../../src/billing/modules/catalog/repositories/mysqlSubscriptionQuoteRepository', () => ({
  createMysqlSubscriptionQuoteRepository: () => ({}),
}));
jest.mock('../../src/billing/modules/subscriptions/repositories/mysqlSubscriptionRepository', () => ({
  createMysqlSubscriptionRepository: () => ({
    getOrganizationSubscription: jest.fn(async () => null),
    createOrganizationSubscription: jest.fn(async () => ({})),
  }),
}));
jest.mock('../../src/billing/modules/credits/repositories/mysqlCreditRepository', () => ({
  createMysqlCreditRepository: () => ({
    ensureAccount: jest.fn(async (_tx, input) => ({ id: `${input.accountPurpose}-account` })),
    createGrant: jest.fn(async () => ({})),
    applyJournal: jest.fn(async () => ({})),
  }),
}));
jest.mock('../../src/billing/modules/credits/domain', () => ({
  planIssueGrant: () => ({ grant: {}, journal: {}, positionDeltas: [] }),
}));
jest.mock('../../src/billing/modules/subscriptions/initialPurchaseService', () => ({
  createInitialPurchaseService: () => ({}),
}));
jest.mock('../../src/billing/modules/subscriptions/policy', () => ({
  resolveSubscriptionPolicy: () => ({}),
}));

const { createSubscriptionPurchaseComposition } = require('../../src/billing/subscriptionPurchaseComposition');

describe('free trial subscription provisioning', () => {
  test('returns a JSON object from its financial transaction for the unit of work', async () => {
    const orgId = '4b31cd5f-84a3-4a0f-bf97-c0d443a95a64';
    const pool = {
      query: jest.fn(async () => ({ rows: [{
        id: orgId,
        subscription_plan: 'Starter',
        settings: JSON.stringify({ workspacePolicy: { planId: 'starter', planVersion: 1 } }),
      }] })),
      connect: jest.fn(),
    };
    const composition = createSubscriptionPurchaseComposition({
      pool,
      resolvePlanVersion: async () => ({ planId: 'starter', version: 1, status: 'published', terms: { currency: 'INR' } }),
      clock: { now: () => '2026-10-12T00:00:00.000Z' },
      idSource: { newId: (kind) => `${kind}-test-id` },
    });

    await expect(composition.provisionFreeTrial({ orgId, days: 7, creditsInr: 750 })).resolves.toMatchObject({
      periodId: 'billing-trial-period-test-id',
      startsAt: '2026-10-12T00:00:00.000Z',
      endsAt: '2026-10-19T00:00:00.000Z',
      days: 7,
      creditsInr: 750,
      alreadyProvisioned: false,
    });
    const trialInsert = mockTx.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO billing_periods'));
    expect(JSON.stringify(trialInsert[1])).toContain('75000');
    await expect(composition.provisionFreeTrial({ orgId, days: 7, creditsInr: -1 })).rejects.toMatchObject({code:'INVALID_TRIAL_CREDITS'});
  });
});
