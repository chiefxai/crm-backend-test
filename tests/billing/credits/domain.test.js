'use strict';

const {
  planIssueGrant, planTransfer, planReserve, planConsume, planRelease, planExpire, planReverse,
} = require('../../../src/billing/modules/credits/domain');
const { organizationScope, workspaceScope } = require('../../../src/billing/kernel/scope');

const orgId = 'org-1';
const now = '2026-10-08T12:00:00.000Z';
const actor = Object.freeze({ type: 'user', id: 'admin-1', organizationId: orgId });
const amount = (units) => Object.freeze({ asset: 'CREDIT', units: String(units), scale: 0 });
const grant = (overrides = {}) => ({
  id: 'grant-1', orgId, kind: 'subscription', sourceType: 'payment', sourceId: 'payment-1',
  sourceEventKey: 'approved-1', amount: amount(100), accountScope: organizationScope(orgId),
  effectiveAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-11-01T00:00:00.000Z', status: 'active',
  ...overrides,
});
const position = (overrides = {}) => ({ accountId: 'account-1', grantId: 'grant-1', balanceUnits: '100', reservedUnits: '0', ...overrides });

describe('credit ledger domain planners', () => {
  test('issues only to organization admin pool with immutable provenance and a balanced funding entry', () => {
    const plan = planIssueGrant({
      orgId, operationId: 'op-issue', grant: grant(), adminAccountId: 'admin-pool',
      fundingClearingAccountId: 'funding', actor, now,
    });

    expect(plan.grant).toMatchObject({ id: 'grant-1', sourceType: 'payment', sourceId: 'payment-1', sourceEventKey: 'approved-1', expiresAt: '2026-11-01T00:00:00.000Z' });
    expect(plan.journal.entries.map((line) => line.amountUnits)).toEqual(['100', '-100']);
    expect(plan.journal.entries.reduce((sum, line) => sum + BigInt(line.amountUnits), 0n)).toBe(0n);
    expect(plan.positionDeltas).toEqual([{ accountId: 'admin-pool', grantId: 'grant-1', asset: 'CREDIT', scale: 0, balanceDeltaUnits: '100', reservedDeltaUnits: '0' }]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.journal.entries[0])).toBe(true);
  });

  test('transfer conserves the same grant and does not change its expiry', () => {
    const source = position({ accountId: 'admin-pool', balanceUnits: '75', reservedUnits: '15' });
    const plan = planTransfer({
      orgId, operationId: 'op-transfer', grant: grant(), from: source,
      to: { accountId: 'workspace-pool' }, fromScope: organizationScope(orgId),
      toScope: workspaceScope(orgId, 'workspace-1'), amount: amount(60), actor, now,
    });

    expect(plan.journal.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: 'admin-pool', grantId: 'grant-1', amountUnits: '-60' }),
      expect.objectContaining({ accountId: 'workspace-pool', grantId: 'grant-1', amountUnits: '60' }),
    ]));
    expect(plan.positionDeltas.reduce((sum, delta) => sum + BigInt(delta.balanceDeltaUnits), 0n)).toBe(0n);
    expect(plan.grant.expiresAt).toBe(grant().expiresAt);
    expect(() => planTransfer({
      orgId, operationId: 'op-insufficient', grant: grant(), from: source,
      to: { accountId: 'workspace-pool' }, fromScope: organizationScope(orgId),
      toScope: workspaceScope(orgId, 'workspace-1'), amount: amount(61), actor, now,
    })).toThrow(expect.objectContaining({ code: 'BILLING_INSUFFICIENT_CREDITS' }));
  });

  test('reserve changes held units only; release restores availability without minting', () => {
    const reserved = planReserve({ orgId, operationId: 'op-reserve', grant: grant(), position: position(), amount: amount(30), reservationId: 'reservation-1', actor, now });
    expect(reserved.positionDeltas).toEqual([{ accountId: 'account-1', grantId: 'grant-1', asset: 'CREDIT', scale: 0, balanceDeltaUnits: '0', reservedDeltaUnits: '30' }]);
    expect(reserved.journal.entries.reduce((sum, line) => sum + BigInt(line.amountUnits), 0n)).toBe(0n);

    const released = planRelease({ orgId, operationId: 'op-release', grant: grant(), position: position({ reservedUnits: '30' }), amount: amount(30), reservationId: 'reservation-1', expiryClearingAccountId: 'expiry', actor, now });
    expect(released.positionDeltas).toEqual([{ accountId: 'account-1', grantId: 'grant-1', asset: 'CREDIT', scale: 0, balanceDeltaUnits: '0', reservedDeltaUnits: '-30' }]);
    expect(released.journal.entries.reduce((sum, line) => sum + BigInt(line.amountUnits), 0n)).toBe(0n);
  });

  test('consume debits both remaining and held balance when settled from a reservation', () => {
    const plan = planConsume({
      orgId, operationId: 'op-consume', grant: grant(), position: position({ reservedUnits: '25' }),
      amount: amount(25), reservationId: 'reservation-1', usageClearingAccountId: 'usage', actor, now,
    });
    expect(plan.positionDeltas).toEqual([{ accountId: 'account-1', grantId: 'grant-1', asset: 'CREDIT', scale: 0, balanceDeltaUnits: '-25', reservedDeltaUnits: '-25' }]);
    expect(plan.journal.entries.reduce((sum, line) => sum + BigInt(line.amountUnits), 0n)).toBe(0n);
  });

  test('expiry removes only available value and keeps held value quarantined', () => {
    const plan = planExpire({
      orgId, operationId: 'op-expire', grant: grant(),
      position: position({ balanceUnits: '100', reservedUnits: '20' }), expiryClearingAccountId: 'expiry',
      actor, now: '2026-11-01T00:00:00.000Z',
    });
    expect(plan.grantPatch).toEqual({ grantId: 'grant-1', status: 'expired', expectedStatus: 'active' });
    expect(plan.positionDeltas).toEqual([{ accountId: 'account-1', grantId: 'grant-1', asset: 'CREDIT', scale: 0, balanceDeltaUnits: '-80', reservedDeltaUnits: '0' }]);
    expect(plan.journal.entries.map((line) => line.amountUnits)).toEqual(['-80', '80']);
  });

  test('releasing a quarantined expired hold burns it instead of restoring availability', () => {
    const plan = planRelease({
      orgId, operationId: 'op-release-expired', grant: grant({ status: 'expired' }),
      position: position({ balanceUnits: '20', reservedUnits: '20' }), amount: amount(20), reservationId: 'reservation-1',
      expiryClearingAccountId: 'expiry', actor, now: '2026-11-02T00:00:00.000Z',
    });
    expect(plan.positionDeltas).toEqual([{ accountId: 'account-1', grantId: 'grant-1', asset: 'CREDIT', scale: 0, balanceDeltaUnits: '-20', reservedDeltaUnits: '-20' }]);
    expect(plan.journal.entries.map((line) => line.amountUnits)).toEqual(['-20', '20']);
  });

  test('expired holds settle only when usage occurred before expiry', () => {
    const args = {
      orgId, operationId: 'op-late-usage', grant: grant({ status: 'expired' }),
      position: position({ balanceUnits: '20', reservedUnits: '20' }), amount: amount(20), reservationId: 'reservation-1',
      usageClearingAccountId: 'usage', actor, now: '2026-11-02T00:00:00.000Z',
    };
    expect(() => planConsume(args)).toThrow(expect.objectContaining({ code: 'BILLING_GRANT_EXPIRED' }));
    const plan = planConsume({ ...args, usageOccurredAt: '2026-10-31T23:59:59.000Z' });
    expect(plan.positionDeltas).toEqual([{ accountId: 'account-1', grantId: 'grant-1', asset: 'CREDIT', scale: 0, balanceDeltaUnits: '-20', reservedDeltaUnits: '-20' }]);
  });

  test('reversal is compensating, rejects spent transfers and cannot revive expired grants', () => {
    const originalJournal = { orgId, operationId: 'op-old', operationType: 'credit_transfer', entries: [
      { accountId: 'admin-pool', grantId: 'grant-1', amountUnits: '-40', asset: 'CREDIT', scale: 0 },
      { accountId: 'workspace-pool', grantId: 'grant-1', amountUnits: '40', asset: 'CREDIT', scale: 0 },
    ] };
    const plan = planReverse({
      orgId, operationId: 'op-reverse', originalJournal, grant: grant(), actor, now,
      positions: [position({ accountId: 'admin-pool', balanceUnits: '60' }), position({ accountId: 'workspace-pool', balanceUnits: '40' })],
    });
    expect(plan.journal.entries.map((line) => line.amountUnits)).toEqual(['40', '-40']);
    expect(() => planReverse({
      orgId, operationId: 'op-reverse-expired', originalJournal, grant: grant({ status: 'expired' }), actor,
      now: '2026-11-02T00:00:00.000Z', positions: [position({ accountId: 'admin-pool', balanceUnits: '60' }), position({ accountId: 'workspace-pool', balanceUnits: '40' })],
    })).toThrow(expect.objectContaining({ code: 'BILLING_GRANT_EXPIRED' }));
    expect(() => planReverse({
      orgId, operationId: 'op-reverse-spent', originalJournal, grant: grant(), actor, now,
      positions: [position({ accountId: 'admin-pool', balanceUnits: '100' }), position({ accountId: 'workspace-pool', balanceUnits: '0' })],
    })).toThrow(expect.objectContaining({ code: 'BILLING_INSUFFICIENT_CREDITS' }));
  });

  test('reversing an issue reclaims only unheld admin-pool value and marks its grant reversed', () => {
    const originalJournal = { orgId, operationId: 'issue-original', operationType: 'credit_issue', entries: [
      { accountId: 'admin-pool', grantId: 'grant-1', amountUnits: '100', asset: 'CREDIT', scale: 0, entryType: 'grant_issue' },
      { accountId: 'funding-clearing', grantId: 'grant-1', amountUnits: '-100', asset: 'CREDIT', scale: 0, entryType: 'funding_clearing' },
    ] };
    const plan = planReverse({ orgId, operationId: 'reverse-issue', originalJournal, grant: grant(),
      positions: [position({ accountId: 'admin-pool', balanceUnits: '100' })], actor, now });
    expect(plan.grantPatch).toEqual({ grantId: 'grant-1', status: 'reversed', expectedStatus: 'active' });
    expect(plan.positionDeltas).toEqual([{ accountId: 'admin-pool', grantId: 'grant-1', asset: 'CREDIT', scale: 0, balanceDeltaUnits: '-100', reservedDeltaUnits: '0' }]);
    expect(plan.journal.entries.map((line) => line.amountUnits)).toEqual(['-100', '100']);
    expect(() => planReverse({ orgId, operationId: 'reverse-held-issue', originalJournal, grant: grant(),
      positions: [position({ accountId: 'admin-pool', balanceUnits: '100', reservedUnits: '1' })], actor, now }))
      .toThrow(expect.objectContaining({ code: 'BILLING_INSUFFICIENT_CREDITS' }));
  });
});
