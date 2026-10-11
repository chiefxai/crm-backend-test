'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBillingEmailEventHandlers } = require('../../src/billing/adapters/delivery/eventHandlers');

test('lifecycle event handlers create actionable organization notifications', async () => {
  const notifications = [];
  const handlers = createBillingEmailEventHandlers({
    notificationRepository: { async createNotification(_tx, value) { notifications.push(value); return { status: 'created' }; } },
    deliveryRepository: { async enqueuePrivate() { throw new Error('not used'); } },
    clock: { now: () => '2026-10-11T12:00:00.000Z' },
  });
  const event = (eventType, payload, aggregateVersion = 1) => ({ eventId: `event-${aggregateVersion}`, eventType,
    orgId: 'org-1', aggregateId: 'aggregate-1', aggregateVersion, occurredAt: '2026-10-11T11:00:00.000Z', payload });

  await handlers.handlePeriodActivated({}, event('SubscriptionPeriodActivated.v1', { periodId: 'period-1', paymentRequestId: 'pay-1' }));
  await handlers.handleAccessRestricted({}, event('SubscriptionAccessRestricted.v1', { restrictionDeadline: '2026-10-11T10:00:00.000Z' }));
  await handlers.handleGraceOutcome({}, event('SubscriptionGraceRequested.v1', { graceRequestId: 'grace-1', requestedUntil: '2026-10-15T00:00:00.000Z' }));
  await handlers.handleGraceOutcome({}, event('SubscriptionGraceApproved.v1', { graceRequestId: 'grace-1', grantedUntil: '2026-10-15T00:00:00.000Z' }));
  await handlers.handleGraceOutcome({}, event('SubscriptionGraceDenied.v1', { graceRequestId: 'grace-2', reason: 'Insufficient details' }));

  assert.deepEqual(notifications.map(({ notification }) => notification.eventKey), [
    'subscription.period_activated', 'subscription.access_restricted', 'subscription.grace_requested',
    'subscription.grace_approved', 'subscription.grace_denied',
  ]);
  assert.ok(notifications.every(({ notification }) => notification.actionPath === '/settings/billing'));
});
