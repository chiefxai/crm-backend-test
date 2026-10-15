'use strict';

/**
 * Resolve the allocation policy from the effective, persisted subscription
 * terms. Workspace inventory affects readiness and destination selection only;
 * it never changes automatic/manual mode.
 */
function resolveAllocationMode({ termsSnapshot, workspaces = [] } = {}) {
  const terms = termsSnapshot?.effectiveTerms || termsSnapshot?.terms || termsSnapshot;
  const structure = terms?.structure;
  const maxWorkspaces = structure?.maxWorkspaces;
  const validCapacity = maxWorkspaces === null
    || (Number.isSafeInteger(maxWorkspaces) && maxWorkspaces >= 1);
  const validMode = ['single', 'same_industry', 'mixed_industry'].includes(structure?.mode);

  if (!validCapacity || !validMode) {
    return Object.freeze({ allocationMode: 'unknown', maxWorkspaces: null,
      workspaceCount: workspaces.length, workspaceId: null,
      manualAllocationAllowed: false, status: 'unavailable' });
  }

  // Workspace mode defines the allocation policy. A multi-workspace plan can
  // still have a limit of one during setup or a temporary capacity constraint;
  // it remains a manual-allocation plan for its organization admin.
  if (structure.mode === 'single' && maxWorkspaces !== 1) {
    return Object.freeze({ allocationMode: 'unknown', maxWorkspaces,
      workspaceCount: workspaces.length, workspaceId: null,
      manualAllocationAllowed: false, status: 'unavailable' });
  }
  const mode = structure.mode === 'single' ? 'automatic' : 'manual';
  const active = workspaces.filter(workspace => String(workspace.status).toLowerCase() === 'active');
  const capacityConflict = maxWorkspaces !== null && workspaces.length > maxWorkspaces;
  if (mode === 'manual') {
    return Object.freeze({ allocationMode: mode, maxWorkspaces,
      workspaceCount: workspaces.length, workspaceId: null,
      manualAllocationAllowed: !capacityConflict, status: capacityConflict ? 'review_required' : 'ready' });
  }

  // A single-workspace entitlement must resolve to its only inventoried,
  // active destination. Never guess when inventory is missing or inconsistent.
  const ready = !capacityConflict && workspaces.length === 1 && active.length === 1;
  return Object.freeze({ allocationMode: mode, maxWorkspaces,
    workspaceCount: workspaces.length, workspaceId: ready ? active[0].id : null,
    manualAllocationAllowed: false, status: ready ? 'ready' : 'not_ready' });
}

module.exports = { resolveAllocationMode };
