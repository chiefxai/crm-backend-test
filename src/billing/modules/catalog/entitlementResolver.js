'use strict';

const crypto = require('crypto');
const { normalizePlanTerms, applyPlanOverrides } = require('./terms');

// This module is deliberately pure. Callers pass the immutable published plan
// version and the effective-dated organization override snapshot they read
// under the organization billing lock. It does not read mutable policy tables.

const DELETED_STATUSES = new Set(['deleted', 'archived']);

function fail(message, code = 'INVALID_ENTITLEMENT_INPUT') {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function mergeEffectiveTerms(planTerms, orgOverrides = {}) {
  if (!planTerms || typeof planTerms !== 'object' || Array.isArray(planTerms)) fail('Published plan terms are required.');
  if (orgOverrides == null) orgOverrides = {};
  if (!orgOverrides || typeof orgOverrides !== 'object' || Array.isArray(orgOverrides)) fail('Organization overrides must be an object.');
  try {
    return applyPlanOverrides(normalizePlanTerms(planTerms), orgOverrides);
  } catch (error) {
    if (error && !error.code) error.code = 'INVALID_ENTITLEMENT_TERMS';
    throw error;
  }
}

function isCountedWorkspace(workspace) {
  return workspace && !workspace.deletedAt && !DELETED_STATUSES.has(String(workspace.status || '').toLowerCase());
}

function getIndustry(workspace) {
  const value = workspace.industryCode ?? workspace.industry;
  if (typeof value !== 'string' || !value.trim()) fail('Each workspace must have an industryCode.');
  return value.trim();
}

function computeInventory(workspaces, primaryIndustryCode, seatCount = 1) {
  if (!Array.isArray(workspaces)) fail('workspaces must be an array.');
  if (!Number.isSafeInteger(seatCount) || seatCount < 0) fail('seatCount must be a non-negative integer.');
  const included = workspaces.filter(isCountedWorkspace);
  const canonical = included.map(workspace => {
    const id = workspace.id ?? workspace.workspaceId;
    if (typeof id !== 'string' || !id.trim()) fail('Each workspace must have a stable id.');
    return {
      id: id.trim(),
      industryCode: getIndustry(workspace),
      status: String(workspace.status || 'active').toLowerCase()
    };
  }).sort((a, b) => a.id.localeCompare(b.id) || a.industryCode.localeCompare(b.industryCode) || a.status.localeCompare(b.status));
  const counts = new Map();
  for (const workspace of canonical) counts.set(workspace.industryCode, (counts.get(workspace.industryCode) || 0) + 1);
  const industries = [...counts.keys()].sort();
  const industryCounts = Object.fromEntries(industries.map(code => [code, counts.get(code)]));
  return {
    workspaceCount: included.length,
    seatCount,
    distinctIndustryCount: industries.length,
    industryCodes: industries,
    industryCounts,
    industries: industries.map(code => ({ code, count: counts.get(code) })),
    additionalDistinctIndustryCount: industries.filter(code => code !== primaryIndustryCode).length,
    sourceVersion: `sha256:${crypto.createHash('sha256').update(JSON.stringify({ primaryIndustryCode, seatCount, workspaces: canonical })).digest('hex')}`
  };
}

function getStructuralConflicts(terms, inventory, primaryIndustryCode) {
  const conflicts = [];
  const { structure } = terms;
  const industryCodes = inventory.industryCodes;
  if (!primaryIndustryCode) {
    conflicts.push({ code: 'PRIMARY_INDUSTRY_REQUIRED', actual: null });
  } else if (industryCodes.some(code => code !== primaryIndustryCode) && structure.mode !== 'mixed_industry') {
    conflicts.push({ code: 'STRUCTURE_MODE_CONFLICT', mode: structure.mode, industryCodes });
  }
  if (structure.mode === 'single' && inventory.workspaceCount > 1) {
    conflicts.push({ code: 'MAX_WORKSPACES_EXCEEDED', limit: 1, actual: inventory.workspaceCount });
  } else if (structure.maxWorkspaces !== null && inventory.workspaceCount > structure.maxWorkspaces) {
    conflicts.push({ code: 'MAX_WORKSPACES_EXCEEDED', limit: structure.maxWorkspaces, actual: inventory.workspaceCount });
  }
  const effectiveIndustryLimit = structure.mode === 'single' || structure.mode === 'same_industry'
    ? 1 : structure.maxDistinctIndustries;
  if (effectiveIndustryLimit !== null && inventory.distinctIndustryCount > effectiveIndustryLimit) {
    conflicts.push({ code: 'MAX_INDUSTRIES_EXCEEDED', limit: effectiveIndustryLimit, actual: inventory.distinctIndustryCount });
  }
  return conflicts;
}

function parseDate(value, label) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) fail(`${label} must be a valid date.`);
    return value;
  }
  if (typeof value !== 'string' || !value) fail(`${label} must be an ISO date string or Date.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail(`${label} must be a valid date.`);
  return date;
}

function resolveServiceAccess(terms, organization, effectiveAt) {
  const expiresAtValue = organization.subscriptionEndsAt ?? organization.expiresAt ?? organization.subscription?.endsAt ?? null;
  if (expiresAtValue == null) return { state: 'active', allowed: true, expiresAt: null, postpaidRequired: false };
  const expiresAt = parseDate(expiresAtValue, 'organization.subscriptionEndsAt');
  const now = parseDate(effectiveAt, 'effectiveAt');
  if (now < expiresAt) return { state: 'active', allowed: true, expiresAt: expiresAt.toISOString(), postpaidRequired: false };

  const policy = terms.serviceAfterExpiry;
  if (policy.mode === 'grace') {
    const graceUntil = new Date(expiresAt.getTime() + policy.graceSeconds * 1000);
    if (now < graceUntil) return { state: 'grace', allowed: true, expiresAt: expiresAt.toISOString(), graceUntil: graceUntil.toISOString(), postpaidRequired: false };
  }
  if (policy.mode === 'continue_postpaid' && terms.postpaid.eligible) {
    return { state: 'postpaid', allowed: true, expiresAt: expiresAt.toISOString(), postpaidRequired: true };
  }
  return { state: 'suspended', allowed: false, expiresAt: expiresAt.toISOString(), postpaidRequired: false };
}

function resolveEntitlements({ planVersion, orgOverrides = {}, organization = {}, workspaces = [], seatCount = 1, effectiveAt }) {
  if (!planVersion || typeof planVersion !== 'object' || typeof planVersion.id !== 'string' || !planVersion.id.trim()) fail('planVersion with a stable id is required.');
  if (!organization || typeof organization !== 'object' || Array.isArray(organization)) fail('organization must be an object.');
  const terms = mergeEffectiveTerms(planVersion.terms, orgOverrides);
  const rawPrimaryIndustryCode = organization.primaryIndustryCode ?? organization.primaryIndustry ?? organization.industry ?? null;
  if (rawPrimaryIndustryCode !== null && (typeof rawPrimaryIndustryCode !== 'string' || !rawPrimaryIndustryCode.trim())) fail('organization primary industry must be a non-empty string or null.');
  const primaryIndustryCode = rawPrimaryIndustryCode === null ? null : rawPrimaryIndustryCode.trim();
  const inventory = computeInventory(workspaces, primaryIndustryCode, seatCount);
  const conflicts = getStructuralConflicts(terms, inventory, primaryIndustryCode);
  if (terms.seats.max !== null && seatCount > terms.seats.max) {
    conflicts.push({ code: 'MAX_SEATS_EXCEEDED', limit: terms.seats.max, actual: seatCount });
  }
  const serviceAccess = resolveServiceAccess(terms, organization, effectiveAt);
  return deepFreeze({
    planVersionId: planVersion.id,
    planVersion: planVersion.version ?? null,
    effectiveAt: parseDate(effectiveAt, 'effectiveAt').toISOString(),
    currency: terms.currency,
    primaryIndustryCode,
    terms,
    inventory,
    conflicts,
    serviceAccess
  });
}

function authorizeSeatAddition(entitlements) {
  if (!entitlements?.terms?.seats || !entitlements.inventory) fail('Resolved entitlements are required.');
  if (!entitlements.serviceAccess.allowed) return { allowed: false, reason: 'SERVICE_EXPIRED' };
  const max = entitlements.terms.seats.max;
  if (max !== null && entitlements.inventory.seatCount + 1 > max) return { allowed: false, reason: 'MAX_SEATS_EXCEEDED', limit: max };
  return { allowed: true, reason: null };
}

function hasIndustryModule(entitlements, industryCode, moduleKey) {
  if (!entitlements?.terms) fail('Resolved entitlements are required.');
  const modules = entitlements.terms.industryModules;
  if (!Object.keys(modules).length) return true; // Legacy published terms predate module entitlements.
  return Array.isArray(modules[industryCode]) && modules[industryCode].includes(moduleKey);
}

function authorizeWorkspaceCreation(entitlements, { industryCode, actorRole }) {
  if (!entitlements || !entitlements.terms || !entitlements.inventory) fail('Resolved entitlements are required.');
  if (typeof industryCode !== 'string' || !industryCode.trim()) fail('industryCode is required.');
  const role = String(actorRole || '').toLowerCase();
  const isPlatformAdmin = role === 'platform_admin' || role === 'super_admin';
  const isOrgAdmin = role === 'organization_admin' || role === 'org_admin';
  if (!isPlatformAdmin && !isOrgAdmin) return { allowed: false, reason: 'ACTOR_NOT_AUTHORIZED' };
  const { terms, inventory, primaryIndustryCode } = entitlements;
  const industry = industryCode.trim();
  if (!primaryIndustryCode) return { allowed: false, reason: 'PRIMARY_INDUSTRY_REQUIRED' };
  if (isOrgAdmin && industry !== primaryIndustryCode) return { allowed: false, reason: 'ORG_ADMIN_PRIMARY_INDUSTRY_ONLY' };
  if (industry !== primaryIndustryCode && terms.structure.mode !== 'mixed_industry') {
    return { allowed: false, reason: 'MIXED_INDUSTRY_NOT_ENTITLED' };
  }
  if (entitlements.conflicts.length) return { allowed: false, reason: 'EXISTING_ENTITLEMENT_CONFLICT', conflicts: entitlements.conflicts };
  const { structure } = terms;
  const nextWorkspaceCount = inventory.workspaceCount + 1;
  if (structure.mode === 'single' && nextWorkspaceCount > 1) return { allowed: false, reason: 'MAX_WORKSPACES_EXCEEDED', limit: 1 };
  if (structure.maxWorkspaces !== null && nextWorkspaceCount > structure.maxWorkspaces) {
    return { allowed: false, reason: 'MAX_WORKSPACES_EXCEEDED', limit: structure.maxWorkspaces };
  }
  const nextIndustries = new Set(inventory.industryCodes);
  nextIndustries.add(industry);
  const industryLimit = structure.mode === 'mixed_industry' ? structure.maxDistinctIndustries : 1;
  if (industryLimit !== null && nextIndustries.size > industryLimit) {
    return { allowed: false, reason: 'MAX_INDUSTRIES_EXCEEDED', limit: industryLimit };
  }
  if (!entitlements.serviceAccess.allowed) return { allowed: false, reason: 'SERVICE_EXPIRED' };
  return { allowed: true, reason: null };
}

module.exports = {
  mergeEffectiveTerms,
  resolveEntitlements,
  authorizeWorkspaceCreation,
  authorizeSeatAddition,
  hasIndustryModule,
  computeInventory,
  getStructuralConflicts,
  resolveServiceAccess
};
