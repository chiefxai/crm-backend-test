'use strict';

const { listGraceRequests, readOrganizationGraceEligibility } = require('../../src/billing/subscriptionGraceReadModel');

test('organization eligibility exposes current version and server-calculated maximum grace date', async () => {
  const pool = { query: jest.fn(async () => ({ rows: [{ current_period_id: 'period-1', version: '8', billing_access_state: 'billing_recovery',
    billing_suspension_cause: 'subscription_payment_overdue', restriction_deadline: '2026-11-08 00:00:00.000000',
    period_ends_at: '2026-11-01 00:00:00.000000', period_status: 'active', grace_request_id: null }] })) };
  const eligibility = await readOrganizationGraceEligibility(pool, { orgId: 'org-1', maxDaysPerPeriod: 7 });
  expect(eligibility).toMatchObject({ subscriptionVersion: 8, currentPeriodId: 'period-1', currentPeriodEndsAt: '2026-11-01T00:00:00.000Z',
    currentRestrictionDeadline: '2026-11-08T00:00:00.000Z', maximumUntil: '2026-11-15T00:00:00.000Z', requestEligible: true, currentRequest: null });
});

test('platform grace queue is bounded and rejects unsupported status filters', async () => {
  const pool = { query: jest.fn(async () => ({ rows: [] })) };
  expect(await listGraceRequests(pool, { status: 'requested', limit: 1000 })).toEqual([]);
  expect(pool.query.mock.calls[0][1]).toEqual(['requested', 100]);
  await expect(listGraceRequests(pool, { status: 'pending' })).rejects.toThrow('Invalid grace request status');
});
