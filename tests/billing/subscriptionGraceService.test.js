'use strict';

const { createSubscriptionGraceService } = require('../../src/billing/subscriptionGraceService');

function harness({ accessState = 'billing_recovery', cause = 'subscription_payment_overdue', deadline = null } = {}) {
  const calls = []; const events = [];
  const tx = { query: jest.fn(async () => ({ rows: [{ id: 'period-1', starts_at: '2026-10-01 00:00:00', ends_at: '2026-11-01 00:00:00', status: 'active' }] })) };
  const subscription = { orgId: 'org-1', currentPeriodId: 'period-1', billingAccessState: accessState,
    billingSuspensionCause: cause, restrictionDeadline: deadline, version: 4 };
  const request = { id: 'grace-1', orgId: 'org-1', periodId: 'period-1', requestedUntil: '2026-11-05T00:00:00.000Z',
    status: 'requested', version: 1 };
  const repository = {
    getOrganizationSubscription: jest.fn(async () => ({ ...subscription })),
    createGraceRequest: jest.fn(async (_tx, value) => { calls.push(['create', value]); return { ...request, ...value }; }),
    getGraceRequest: jest.fn(async () => ({ ...request })),
    recordGraceDecision: jest.fn(async (_tx, value) => { calls.push(['decision', value]); return { ...request, status: value.decision === 'approve' ? 'approved' : 'denied', grantedUntil: value.grantedUntil, version: 2 }; }),
    updateBillingAccess: jest.fn(async (_tx, value) => { calls.push(['access', value]); return { ...subscription, ...value, version: 5 }; }),
  };
  const unitOfWork = { runLifecycle: jest.fn(async ({ callback }) => callback(tx)) };
  const service = createSubscriptionGraceService({ unitOfWork, repository, pool: { query: jest.fn() }, idSource: { newId: (p) => `${p}-generated` },
    clock: { now: () => '2026-10-29T00:00:00.000Z' }, outbox: { async enqueue(_tx, value) { events.push(...value.events); } } });
  return { service, repository, unitOfWork, calls, events, subscription };
}

test('organization grace request is bounded by policy and does not mutate access', async () => {
  const h = harness();
  const result = await h.service.createRequest({ orgId: 'org-1', actorId: 'user-1', periodId: 'period-1',
    requestedUntil: '2026-11-05T00:00:00.000Z', justification: 'Invoice is processing', expectedVersion: 4, operationId: 'grace-request-1' });
  expect(result.status).toBe('requested');
  expect(h.repository.createGraceRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestedBy: 'user-1' }));
  expect(h.repository.updateBillingAccess).not.toHaveBeenCalled();
  expect(h.events[0]).toMatchObject({ eventType: 'SubscriptionGraceRequested.v1', aggregateId: 'subscription-grace-generated' });
});

test('grace request cannot exceed the maximum or use a stale subscription version', async () => {
  const h = harness();
  await expect(h.service.createRequest({ orgId: 'org-1', actorId: 'user-1', periodId: 'period-1', requestedUntil: '2026-11-09T00:00:00Z',
    justification: 'Need time', expectedVersion: 4, operationId: 'grace-request-2' })).rejects.toMatchObject({ code: 'GRACE_MAXIMUM_EXCEEDED' });
  await expect(h.service.createRequest({ orgId: 'org-1', actorId: 'user-1', periodId: 'period-1', requestedUntil: '2026-11-05T00:00:00Z',
    justification: 'Need time', expectedVersion: 3, operationId: 'grace-request-3' })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
});

test('approval writes an immutable decision and moves only billing-suspended access back to operational', async () => {
  const h = harness({ accessState: 'billing_suspended', cause: 'subscription_payment_overdue' });
  const value = await h.service.decide({ orgId: 'org-1', graceRequestId: 'grace-1', actorId: 'platform-1', decision: 'approve', reason: 'Bank transfer confirmed',
    expectedVersion: 1, grantedUntil: '2026-11-05T00:00:00Z', operationId: 'grace-decision-1' });
  expect(value.status).toBe('approved');
  expect(h.repository.recordGraceDecision).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ decidedBy: 'platform-1' }));
  expect(h.repository.updateBillingAccess).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    billingAccessState: 'operational', billingSuspensionCause: null, restrictionDeadline: '2026-11-05T00:00:00.000Z', expectedVersion: 4,
  }));
  expect(h.events[0]).toMatchObject({ eventType: 'SubscriptionGraceApproved.v1', aggregateId: 'grace-1' });
});

test('approval updates the deadline for a billing recovery subscription but preserves manual suspension', async () => {
  const h = harness({ accessState: 'billing_recovery', cause: 'initial_subscription_unpaid' });
  await h.service.decide({ orgId: 'org-1', graceRequestId: 'grace-1', actorId: 'platform-1', decision: 'approve', reason: 'Review approved',
    expectedVersion: 1, grantedUntil: '2026-11-05T00:00:00Z', operationId: 'grace-decision-2' });
  expect(h.repository.updateBillingAccess).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ billingAccessState: 'billing_recovery' }));

  const manual = harness({ accessState: 'billing_suspended', cause: 'manual_suspension' });
  await expect(manual.service.decide({ orgId: 'org-1', graceRequestId: 'grace-1', actorId: 'platform-1', decision: 'approve', reason: 'Review approved',
    expectedVersion: 1, grantedUntil: '2026-11-05T00:00:00Z', operationId: 'grace-decision-3' })).rejects.toMatchObject({ code: 'NON_BILLING_SUSPENSION' });
  expect(manual.repository.recordGraceDecision).not.toHaveBeenCalled();
});
