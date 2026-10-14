'use strict';

/**
 * Compare immutable published subscription terms before accepting a change.
 * This is advisory for module access (records are NEVER deleted here), but
 * inventory limits are hard blockers: an existing workspace/seat cannot vanish
 * because someone chooses a smaller plan.
 */
function assessPlanTransition(current, target, inventory) {
  if (!current?.structure || !target?.structure || !target?.seats) {
    return { removedModules: [], conflicts: ['Plan entitlements are unavailable. Refresh before changing plans.'], isDowngrade: false };
  }
  const workspaceCount = Number(inventory?.workspaceCount);
  const seatCount = Number(inventory?.seatCount);
  const industries = [...new Set((inventory?.industries || []).map(entry => entry.code).filter(Boolean))];
  const conflicts = [];
  if (!Number.isSafeInteger(workspaceCount) || workspaceCount < 1 || !Number.isSafeInteger(seatCount)
      || seatCount < 0 || !industries.length) {
    conflicts.push('Workspace, industry and seat inventory cannot be verified.');
  } else {
    if (target.structure.mode === 'single' && workspaceCount > 1
        || target.structure.maxWorkspaces != null && workspaceCount > target.structure.maxWorkspaces) {
      conflicts.push(`The new plan supports fewer workspaces than your existing ${workspaceCount}.`);
    }
    if (target.structure.mode !== 'mixed_industry' && industries.length > 1
        || target.structure.maxDistinctIndustries != null && industries.length > target.structure.maxDistinctIndustries) {
      conflicts.push('The new plan cannot support all of your existing workspace industries.');
    }
    if (target.seats.max != null && seatCount > target.seats.max) {
      conflicts.push(`The new plan supports fewer members than your existing ${seatCount}.`);
    }
  }
  const currentModules = current.industryModules || {};
  const nextModules = target.industryModules || {};
  // An empty module map means legacy unrestricted terms; do not fabricate
  // a list of removed modules from an unknown old entitlement.
  const removedModules = Object.keys(currentModules).length && Object.keys(nextModules).length
    ? industries.flatMap(industry => (currentModules[industry] || [])
        .filter(key => !(nextModules[industry] || []).includes(key))
        .map(key => ({ industry, key })))
    : [];
  const from = current.subscriptionPrice;
  const to = target.subscriptionPrice;
  const comparable = from && to && from.asset === to.asset && from.scale === to.scale;
  if (!comparable) conflicts.push('The old and new plan prices cannot be compared.');
  return {
    removedModules,
    conflicts,
    isDowngrade: Boolean(comparable && BigInt(to.units) < BigInt(from.units)),
  };
}

module.exports = { assessPlanTransition };
