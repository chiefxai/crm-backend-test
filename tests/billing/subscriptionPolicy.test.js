'use strict';

const contracts = require('../../src/billing/contracts');
const policy = require('../../src/billing/modules/subscriptions/policy');

const context = () => ({ schemaVersion: 1, operationId: 'op-1', requestFingerprint: `sha256:${'a'.repeat(64)}`, actor: { type: 'user', id: 'user-1', organizationId: 'org-1' } });

describe('subscription lifecycle policy contract', () => {
  test('provides explicit injectable defaults and rejects invalid overrides', () => {
    expect(policy.resolveSubscriptionPolicy().renewalNoticeDays).toBe(7);
    expect(policy.resolveSubscriptionPolicy().initialUnpaidAccess).toBe('billing_recovery');
    expect(policy.resolveSubscriptionPolicy({ grace: { maxDaysPerPeriod: 3 } }).grace.maxCumulativeDays).toBe(7);
    expect(() => policy.resolveSubscriptionPolicy({ renewalNoticeDays: -1 })).toThrow(/non-negative/);
  });

  test('clock returns defensive valid dates and supports deterministic injection', () => {
    const clock = policy.createSubscriptionClock(() => '2026-10-11T00:00:00Z');
    expect(clock.now().toISOString()).toBe('2026-10-11T00:00:00.000Z');
    expect(() => policy.createSubscriptionClock(() => 'bad').now()).toThrow(/invalid timestamp/);
  });

  test('subscription command contracts keep server actor and scope out of client authority', () => {
    const command = { schemaVersion: 1, orgId: 'org-1', periodId: 'period-1', requestedUntil: '2026-10-20T00:00:00Z', reason: 'Temporary delay', expectedVersion: 0 };
    expect(contracts.validateGraceRequestCommand(command, context()).orgId).toBe('org-1');
    expect(() => contracts.validateGraceRequestCommand({ ...command, actor: { type: 'user', id: 'attacker' } }, context())).toThrow(/not allowed/);
    expect(() => contracts.validateGraceDecisionCommand({ schemaVersion: 1, orgId: 'org-1', graceRequestId: 'grace-1', decision: 'approve', expectedVersion: 0 }, context())).toThrow(/reason/);
  });

  test('state dimensions are distinct', () => {
    expect(contracts.SUBSCRIPTION_PERIOD_STATES).toContain('active');
    expect(contracts.SUBSCRIPTION_PAYMENT_STATES).toContain('submitted');
    expect(contracts.SUBSCRIPTION_ACCESS_STATES).toContain('billing_recovery');
    expect(contracts.SUBSCRIPTION_GRACE_STATES).toContain('approved');
    expect(contracts.SUBSCRIPTION_EVENTS).toContain('SubscriptionPaymentApproved.v1');
  });
});
