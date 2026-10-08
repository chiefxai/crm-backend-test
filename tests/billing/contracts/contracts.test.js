'use strict';

const contracts = require('../../../src/billing/contracts');

const amount = (units) => ({ asset: 'INR', units: String(units), scale: 6 });
const context = (actor = { type: 'user', id: 'user-1', organizationId: 'org-1' }) => ({
  schemaVersion: 1,
  operationId: 'op-1',
  requestFingerprint: `sha256:${'a'.repeat(64)}`,
  correlationId: 'corr-1',
  actor,
});

describe('billing command contracts', () => {
  test('requires server supplied actor context and rejects actor/platformAdmin in client DTO', () => {
    const request = {
      schemaVersion: 1,
      orgId: 'org-1',
      purpose: 'topup',
      expectedAmount: amount(100),
      paymentReference: 'txn-100',
      quoteId: 'quote-1',
    };

    expect(() => contracts.validatePaymentSubmission(request)).toThrow(/server/);
    expect(() => contracts.validatePaymentSubmission({ ...request, actor: { type: 'user', id: 'u', platformAdmin: true } }, context())).toThrow(/not allowed/);
    expect(contracts.validatePaymentSubmission(request, context()).context.actor).toEqual(context().actor);
  });

  test('subscription and top-up grants have distinct expiry requirements', () => {
    const base = {
      schemaVersion: 1,
      orgId: 'org-1',
      grantId: 'grant-1',
      sourceType: 'payment',
      sourceId: 'payment-1',
      accountScope: { orgId: 'org-1', ownerType: 'organization', ownerId: 'org-1' },
      amount: amount(100),
      effectiveAt: '2026-10-08T00:00:00Z',
      expectedVersion: 0,
    };

    expect(() => contracts.validateGrantIssue({ ...base, kind: 'subscription', expiresAt: null }, context())).toThrow(/require an expiry/);
    expect(() => contracts.validateGrantIssue({ ...base, kind: 'topup', expiresAt: '2026-11-08T00:00:00Z' }, context())).toThrow(/must not expire/);
    expect(contracts.validateGrantIssue({ ...base, kind: 'topup', expiresAt: null }, context()).expiresAt).toBeNull();
  });

  test('limited zero, unlimited and disabled postpaid policies remain distinct', () => {
    const base = { schemaVersion: 1, orgId: 'org-1', workspaceId: 'ws-1', expectedVersion: 0 };
    const disabled = contracts.validatePostpaidPolicy({ ...base, policy: { mode: 'disabled' } }, context());
    const unlimited = contracts.validatePostpaidPolicy({ ...base, policy: { mode: 'unlimited' } }, context());
    const zero = contracts.validatePostpaidPolicy({ ...base, policy: { mode: 'limited', cycleLimit: amount(0) } }, context());
    expect(disabled.policy).toEqual({ mode: 'disabled' });
    expect(unlimited.policy).toEqual({ mode: 'unlimited' });
    expect(zero.policy).toEqual({ mode: 'limited', cycleLimit: amount(0) });
    expect(() => contracts.validatePostpaidPolicy({ ...base, policy: { mode: 'limited', cycleLimit: null } }, context())).toThrow();
  });

  test('versioned event envelope validates operation and causal identities', () => {
    const event = contracts.validateEventEnvelope({
      eventId: 'evt-1',
      eventType: 'PaymentConfirmed.v1',
      schemaVersion: 1,
      operationId: 'op-1',
      orgId: 'org-1',
      aggregateType: 'Payment',
      aggregateId: 'payment-1',
      aggregateVersion: 2,
      occurredAt: '2026-10-08T10:20:30.000Z',
      correlationId: 'corr-1',
      causationId: 'cmd-1',
      payload: { paymentRequestId: 'payment-1' },
    });
    expect(event.causationId).toBe('cmd-1');
    expect(() => contracts.validateEventEnvelope({ ...event, schemaVersion: 2 })).toThrow(/must be 1/);
  });

  test('allocation rules reject duplicate workspace entries and percentages over 100 percent', () => {
    const base = { schemaVersion: 1, orgId: 'org-1', grantKind: 'subscription', ruleVersion: 1, expectedVersion: 0 };
    expect(() => contracts.validateAllocationRuleSet({ ...base, rules: [
      { workspaceId: 'ws-1', kind: 'percentage', basisPoints: 10000 },
      { workspaceId: 'ws-1', kind: 'fixed', amount: amount(1) },
    ] }, context())).toThrow(/duplicates/);
    expect(() => contracts.validateAllocationRuleSet({ ...base, rules: [
      { workspaceId: 'ws-1', kind: 'percentage', basisPoints: 10001 },
    ] }, context())).toThrow();
  });
});

describe('billing domain errors', () => {
  test('exposes a finite typed code set and rejects unknown codes', () => {
    const error = new contracts.BillingDomainError(contracts.DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'stale version');
    expect(contracts.isBillingDomainError(error, contracts.DOMAIN_ERROR_CODES.VERSION_CONFLICT)).toBe(true);
    expect(() => new contracts.BillingDomainError('ARBITRARY', 'no')).toThrow(/Unknown billing domain error code/);
  });
});
