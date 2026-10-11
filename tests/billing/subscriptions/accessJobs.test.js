'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSubscriptionAccessJobs } = require('../../../src/billing/modules/subscriptions/accessJobs');
const { resolveSubscriptionPolicy } = require('../../../src/billing/modules/subscriptions/policy');

const now = '2026-10-11T12:00:00.000Z';
const policy = resolveSubscriptionPolicy();

function makeJobs({ candidates, subscription, updated = [], callbacks = [], events = [] }) {
  const candidateRepository = { async listDueAccessRestrictions(args) { callbacks.push(['scan', args]); return candidates; } };
  const subscriptionRepository = {
    async getOrganizationSubscription(_tx, args) { callbacks.push(['read', args]); return subscription; },
    async updateBillingAccess(_tx, args) { callbacks.push(['update', args]); updated.push(args); return { restrictionDeadline: args.restrictionDeadline }; },
  };
  const unitOfWork = { async runLifecycle(args) { callbacks.push(['lifecycle', args.orgId, args.operationId]); return args.callback({}); } };
  return createSubscriptionAccessJobs({ unitOfWork, candidateRepository, subscriptionRepository,
    outbox: { async enqueue(_tx, value) { events.push(...value.events); }, }, clock: { now: () => now }, policy });
}

test('enforces only a due billing restriction using the stored deadline and expected version', async () => {
  const updated = [];
  const callbacks = [];
  const jobs = makeJobs({
    candidates: [{ orgId: 'org-1', restrictionDeadline: '2026-10-11T11:00:00.000Z' }],
    subscription: { orgId: 'org-1', billingAccessState: 'billing_recovery', billingSuspensionCause: 'initial_subscription_unpaid',
      restrictionDeadline: '2026-10-11T11:00:00.000Z', version: 4 },
    updated, callbacks,
  });
  const result = await jobs.enforceExpiredAccess({ now, limit: 5 });
  assert.deepEqual(result.results, [{ orgId: 'org-1', status: 'suspended', restrictionDeadline: '2026-10-11T11:00:00.000Z' }]);
  assert.deepEqual(updated[0], { orgId: 'org-1', billingAccessState: 'billing_suspended', billingSuspensionCause: 'subscription_expired',
    restrictionDeadline: '2026-10-11T11:00:00.000Z', expectedVersion: 4, now });
  assert.equal(callbacks[1][0], 'lifecycle');
});

test('expired billing access emits a transactional restriction event', async () => {
  const events = [];
  const jobs = makeJobs({ candidates: [{ orgId: 'org-1', restrictionDeadline: '2026-10-11T11:00:00.000Z' }],
    subscription: { billingAccessState: 'billing_recovery', billingSuspensionCause: 'initial_subscription_unpaid',
      restrictionDeadline: '2026-10-11T11:00:00.000Z', version: 4 }, events });
  await jobs.enforceExpiredAccess({ now });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'SubscriptionAccessRestricted.v1');
  assert.equal(events[0].aggregateVersion, 5);
  assert.deepEqual(events[0].payload, { cause: 'subscription_expired', restrictionDeadline: '2026-10-11T11:00:00.000Z' });
});

test('rechecks access state and deadline under the org lock; does not overwrite manual/security suspension', async () => {
  for (const subscription of [
    { billingAccessState: 'manual_suspended', billingSuspensionCause: 'manual', restrictionDeadline: '2026-10-11T10:00:00.000Z', version: 2 },
    { billingAccessState: 'security_suspended', billingSuspensionCause: 'security', restrictionDeadline: '2026-10-11T10:00:00.000Z', version: 2 },
    { billingAccessState: 'operational', billingSuspensionCause: null, restrictionDeadline: '2026-10-11T12:00:01.000Z', version: 2 },
  ]) {
    const updated = [];
    const jobs = makeJobs({ candidates: [{ orgId: 'org-1', restrictionDeadline: '2026-10-11T10:00:00.000Z' }], subscription, updated });
    const result = await jobs.enforceExpiredAccess({ now });
    assert.deepEqual(result.results, [{ orgId: 'org-1', status: 'unchanged' }]);
    assert.equal(updated.length, 0);
  }
});

test('reports a stale-version race without claiming suspension', async () => {
  const jobs = createSubscriptionAccessJobs({
    unitOfWork: { async runLifecycle(args) { return args.callback({}); } },
    candidateRepository: { async listDueAccessRestrictions() { return [{ orgId: 'org-1', restrictionDeadline: '2026-10-11T10:00:00Z' }]; } },
    subscriptionRepository: {
      async getOrganizationSubscription() { return { billingAccessState: 'operational', restrictionDeadline: '2026-10-11T10:00:00Z', version: 1 }; },
      async updateBillingAccess() { return null; },
    }, clock: { now: () => now }, policy,
  });
  const result = await jobs.enforceExpiredAccess({ now });
  assert.deepEqual(result.results, [{ orgId: 'org-1', status: 'changed_concurrently' }]);
});

