'use strict';

const crypto = require('node:crypto');

const mockRunFinancial = jest.fn();
jest.mock('../../src/billing/adapters/mysql/unitOfWork', () => ({
  createMysqlUnitOfWork: () => ({ runFinancial: mockRunFinancial }),
}));
jest.mock('../../src/billing/modules/catalog/repositories/mysqlSubscriptionQuoteRepository', () => ({
  createMysqlSubscriptionQuoteRepository: () => ({}),
}));
jest.mock('../../src/billing/modules/subscriptions/repositories/mysqlSubscriptionRepository', () => ({
  createMysqlSubscriptionRepository: () => ({}),
}));
jest.mock('../../src/billing/subscriptionPurchaseComposition', () => ({
  inventoryFrom: () => ({ workspaceCount: 1, industries: [{ code: 'lending', count: 1 }], seatCount: 1, version: 'inventory-1' }),
  quoteTtlSeconds: () => 600,
}));
jest.mock('../../src/billing/modules/catalog/subscriptionQuoteComposition', () => ({
  composeSubscriptionQuote: () => ({ purpose: 'renewal', version: 1 }),
}));

const { createSubscriptionRenewalComposition } = require('../../src/billing/subscriptionRenewalComposition');

test('renewal quote supplies a full SHA-256 financial command fingerprint', async () => {
  const now = '2026-10-13T11:00:00.000Z';
  const plan = { planId: 'plan-1', version: 2, status: 'published' };
  const pool = {
    connect: jest.fn(),
    query: jest.fn(async (sql) => {
      if (sql.includes('FROM organization_subscriptions s')) {
        return { rows: [{
          lifecycle_status: 'active', billing_access_state: 'operational',
          current_plan_id: 'plan-1', current_plan_version: 2, subscription_version: 1,
          period_id: 'period-1', starts_at: '2026-10-01T00:00:00.000Z',
          ends_at: '2026-10-15T00:00:00.000Z', period_status: 'active',
          terms_snapshot_json: '{}',
          quote_id: null, grace_request: null, scheduled_renewal: null,
        }] };
      }
      if (sql.includes('SELECT id,industry FROM workspaces')) return { rows: [{ id: 'workspace-1', industry: 'lending' }] };
      if (sql.includes('COUNT(*) AS seat_count')) return { rows: [{ seat_count: 1 }] };
      if (sql.includes('FROM billing_workspace_addons')) return { rows: [] };
      throw new Error('Unexpected query: ' + sql);
    }),
  };
  const stopped = new Error('stop before database write');
  mockRunFinancial.mockRejectedValueOnce(stopped);
  const composition = createSubscriptionRenewalComposition({
    pool,
    getPlanVersion: jest.fn(async () => plan),
    clock: { now: () => now },
  });
  await expect(composition.createRenewalQuote({
    orgId: 'org-1', requestKey: 'renewal-test-key',
  })).rejects.toBe(stopped);
  expect(mockRunFinancial).toHaveBeenCalledTimes(1);
  const [{ requestFingerprint }] = mockRunFinancial.mock.calls[0];
  expect(requestFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(requestFingerprint).toHaveLength(71);
});
