'use strict';

const { resolveAllocationMode } = require('../../src/billing/allocationModeResolver');

const workspace = (id, status = 'active') => ({ id, status });
const terms = (maxWorkspaces, mode = maxWorkspaces === 1 ? 'single' : 'same_industry') => ({
  schemaVersion: 1, structure: { mode, maxWorkspaces },
});

describe('resolveAllocationMode', () => {
  test('uses single-workspace entitlement and resolves its only active destination', () => {
    expect(resolveAllocationMode({ termsSnapshot: terms(1), workspaces: [workspace('ws-1')] }))
      .toEqual({ allocationMode: 'automatic', maxWorkspaces: 1, workspaceCount: 1,
        workspaceId: 'ws-1', manualAllocationAllowed: false, status: 'ready' });
  });

  test('reads the effective terms from the persisted organization-terms snapshot', () => {
    expect(resolveAllocationMode({
      termsSnapshot: { schemaVersion: 1, effectiveTerms: terms(1) },
      workspaces: [workspace('ws-1')],
    })).toMatchObject({ allocationMode: 'automatic', workspaceId: 'ws-1', status: 'ready' });
  });

  test('multi-workspace and unlimited entitlements remain manual with one current workspace', () => {
    for (const max of [5, null]) {
      expect(resolveAllocationMode({ termsSnapshot: terms(max), workspaces: [workspace('ws-1')] }))
        .toMatchObject({ allocationMode: 'manual', maxWorkspaces: max,
          workspaceId: null, manualAllocationAllowed: true, status: 'ready' });
    }
  });

  test('current inventory never changes a multi-workspace subscription to automatic', () => {
    expect(resolveAllocationMode({ termsSnapshot: terms(5), workspaces: [workspace('ws-1', 'inactive')] }))
      .toMatchObject({ allocationMode: 'manual', manualAllocationAllowed: true });
  });

  test.each([
    ['missing inventory', []],
    ['multiple workspaces', [workspace('ws-1'), workspace('ws-2', 'inactive')]],
    ['inactive destination', [workspace('ws-1', 'inactive')]],
  ])('single-workspace plan is not ready with %s', (_label, workspaces) => {
    expect(resolveAllocationMode({ termsSnapshot: terms(1), workspaces }))
      .toMatchObject({ allocationMode: 'automatic', workspaceId: null,
        manualAllocationAllowed: false, status: 'not_ready' });
  });

  test('missing or malformed effective terms fail closed', () => {
    expect(resolveAllocationMode({ workspaces: [workspace('ws-1')] }))
      .toMatchObject({ allocationMode: 'unknown', manualAllocationAllowed: false, status: 'unavailable' });
    expect(resolveAllocationMode({ termsSnapshot: terms(0), workspaces: [] }))
      .toMatchObject({ allocationMode: 'unknown', manualAllocationAllowed: false, status: 'unavailable' });
  });

  test('capacity conflicts require review without changing the entitlement mode', () => {
    expect(resolveAllocationMode({ termsSnapshot: terms(1), workspaces: [workspace('ws-1'), workspace('ws-2')] }))
      .toMatchObject({ allocationMode: 'automatic', manualAllocationAllowed: false, status: 'not_ready' });
    expect(resolveAllocationMode({ termsSnapshot: terms(2), workspaces: [workspace('ws-1'), workspace('ws-2'), workspace('ws-3')] }))
      .toMatchObject({ allocationMode: 'manual', manualAllocationAllowed: false, status: 'review_required' });
  });
});
