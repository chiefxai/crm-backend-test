'use strict';

const { createSingleWorkspaceCreditReconciliation, operationId } = require('../../src/billing/singleWorkspaceCreditReconciliation');
const { previewAutomaticAllocationReconciliation } = require('../../src/billing/automaticCreditAllocationService');

const snapshot = {
  allocation: { allocationMode: 'automatic', status: 'ready', workspaceId: 'workspace-a' },
  grants: [
    { id: 'grant-a', kind: 'subscription', available: { asset: 'INR', units: '1200', scale: 2 },
      held: { asset: 'INR', units: '300', scale: 2 }, expiresAt: '2026-11-01T00:00:00Z', positionVersion: 4 },
    { id: 'grant-b', kind: 'topup', available: { asset: 'INR', units: '0', scale: 2 },
      held: { asset: 'INR', units: '700', scale: 2 }, expiresAt: null, positionVersion: 2 },
  ],
};

describe('single-workspace credit reconciliation', () => {
  test('dry-run proposes exact, unreserved grant transfers and reports held-only grants', () => {
    expect(previewAutomaticAllocationReconciliation(snapshot)).toEqual({
      status: 'dry_run_ready', allocationMode: 'automatic', workspaceId: 'workspace-a',
      transfers: [{ grantId: 'grant-a', grantKind: 'subscription', amount: snapshot.grants[0].available,
        held: snapshot.grants[0].held, expiresAt: snapshot.grants[0].expiresAt,
        expectedPositionVersion: 4, workspaceId: 'workspace-a' }],
      skipped: [{ grantId: 'grant-b', reason: 'no_unreserved_balance' }],
    });
  });

  test('does not execute by default and reports the planned dry-run', async () => {
    const runFinancial = jest.fn();
    const service = createSingleWorkspaceCreditReconciliation({
      readSnapshot: async () => snapshot,
      unitOfWork: { runFinancial },
      automaticAllocationService: { allocateCreditsAutomatically: jest.fn() },
    });
    const result = await service.reconcile({ orgId: 'org-a' });
    expect(result).toMatchObject({ status: 'dry_run_ready', dryRun: true, orgId: 'org-a' });
    expect(runFinancial).not.toHaveBeenCalled();
  });

  test('keeps execution disabled without an organization allowlist', async () => {
    const runFinancial = jest.fn();
    const service = createSingleWorkspaceCreditReconciliation({
      readSnapshot: async () => snapshot,
      unitOfWork: { runFinancial },
      automaticAllocationService: { allocateCreditsAutomatically: jest.fn() },
      isEnabled: () => false,
    });
    expect(await service.reconcile({ orgId: 'org-a', dryRun: false }))
      .toMatchObject({ status: 'disabled', dryRun: false });
    expect(runFinancial).not.toHaveBeenCalled();
  });

  test('executes one deterministic financial operation per grant for safe retries', async () => {
    const transfer = jest.fn(async input => ({ status: 'allocated', grantId: input.grantId }));
    const calls = [];
    const service = createSingleWorkspaceCreditReconciliation({
      readSnapshot: async () => snapshot,
      unitOfWork: { runFinancial: async input => { calls.push(input); return input.callback({ metadata: { orgId: 'org-a' } }); } },
      automaticAllocationService: { allocateCreditsAutomatically: transfer },
      isEnabled: orgId => orgId === 'org-a',
    });
    const result = await service.reconcile({ orgId: 'org-a', dryRun: false });
    expect(result.status).toBe('completed');
    expect(calls).toHaveLength(1);
    expect(calls[0].operationId).toBe(operationId('org-a', 'grant-a'));
    expect(typeof calls[0].callback).toBe('function');
    expect(transfer).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-a', grantId: 'grant-a',
      sourceEvent: 'existing-balance-reconciliation' }));
  });
});
