const crypto = require('crypto');
const MODES = ['single', 'same_industry', 'mixed_industry'];
function invalid(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode, expose: true }); }
function json(value) { if (typeof value === 'string') { try { return JSON.parse(value); } catch { return {}; } } return value || {}; }
function validatePolicy(input, primaryIndustry, industries) {
  if (!input || !MODES.includes(input.mode)) throw invalid('Select a valid organization workspace structure.');
  if (!industries.includes(primaryIndustry)) throw invalid('Select a supported primary industry.');
  const pricing = input.pricing;
  if (!pricing || typeof pricing !== 'object') throw invalid('Configure monthly workspace pricing.');
  const result = {};
  for (const key of ['baseMonthlyInr', 'extraWorkspaceMonthlyInr', 'extraSeatMonthlyInr', 'additionalIndustryMonthlyInr']) {
    if (typeof pricing[key] !== 'number' || !Number.isFinite(pricing[key]) || pricing[key] < 0 || pricing[key] > 100000000) throw invalid('Monthly prices must be non-negative INR amounts.');
    result[key] = Math.round(pricing[key] * 100) / 100;
  }
  const includedWorkspaces = input.mode === 'single' ? 1 : pricing.includedWorkspaces;
  if (!Number.isInteger(includedWorkspaces) || includedWorkspaces < 1 || includedWorkspaces > 1000) throw invalid('Included workspaces must be between 1 and 1000 for a multi-workspace plan.');
  result.includedWorkspaces = includedWorkspaces;
  result.maxWorkspaces = input.mode === 'single' ? 1 : pricing.maxWorkspaces == null ? null : pricing.maxWorkspaces;
  result.includedSeats = pricing.includedSeats;
  result.maxSeats = pricing.maxSeats == null ? null : pricing.maxSeats;
  if ((result.maxWorkspaces !== null && (!Number.isInteger(result.maxWorkspaces) || result.maxWorkspaces < includedWorkspaces || result.maxWorkspaces > 1000))
    || !Number.isInteger(result.includedSeats) || result.includedSeats < 1 || result.includedSeats > 100000
    || (result.maxSeats !== null && (!Number.isInteger(result.maxSeats) || result.maxSeats < result.includedSeats || result.maxSeats > 100000))) {
    throw invalid('Workspace and seat allowances must be valid whole numbers.');
  }
  const policy = { mode: input.mode, primaryIndustry, pricing: result };
  if (input.industryModules !== undefined) {
    const { getIndustryDefinition } = require('../platform/industry');
    if (!input.industryModules || typeof input.industryModules !== 'object' || Array.isArray(input.industryModules)) throw invalid('Industry module entitlements are invalid.');
    for (const [industry, configured] of Object.entries(input.industryModules)) {
      if (!industries.includes(industry)) throw invalid('Industry module entitlements are invalid.');
      const allowed = new Set(getIndustryDefinition(industry).modules.map(module => module.key));
      if (!Array.isArray(configured) || configured.some(module => !allowed.has(module)) || new Set(configured).size !== configured.length) throw invalid('Industry module entitlements are invalid.');
    }
    policy.industryModules = input.industryModules;
  }
  if (input.planId !== undefined) {
    if (typeof input.planId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.planId)) throw invalid('Workspace plan ID is invalid.');
    policy.planId = input.planId;
  }
  if (input.planVersion !== undefined) {
    if (!Number.isSafeInteger(input.planVersion) || input.planVersion < 1) throw invalid('Workspace plan version is invalid.');
    policy.planVersion = input.planVersion;
  }
  return policy;
}
function effectivePolicy(org, workspaces) {
  const settings = json(org.settings);
  const stored = settings.workspacePolicy || org.workspacePolicy;
  const primaryIndustry = stored?.primaryIndustry || org.industry || 'lending';
  const mode = MODES.includes(stored?.mode) ? stored.mode : workspaces.some(w => w.industry !== primaryIndustry)
    ? 'mixed_industry' : workspaces.length > 1 ? 'same_industry' : 'single';
  const previousPricing = stored?.pricing;
  const pricing = previousPricing ? {
    ...previousPricing,
    maxWorkspaces: previousPricing.maxWorkspaces === undefined ? (mode === 'single' ? 1 : previousPricing.includedWorkspaces) : previousPricing.maxWorkspaces,
    extraWorkspaceMonthlyInr: previousPricing.extraWorkspaceMonthlyInr ?? 0,
    includedSeats: previousPricing.includedSeats ?? 1,
    maxSeats: previousPricing.maxSeats ?? null,
    extraSeatMonthlyInr: previousPricing.extraSeatMonthlyInr ?? 0,
  } : null;
  return { mode, primaryIndustry, planId: stored?.planId || null, planVersion: stored?.planVersion || null, pricing, industryModules: stored?.industryModules || null };
}
function quote(policy, workspaces, seatCount = 1) {
  if (!policy.pricing) return null;
  const p = policy.pricing;
  const additionalIndustries = new Set(workspaces.map(w => w.industry).filter(i => i !== policy.primaryIndustry)).size;
  const additionalWorkspaces = Math.max(0, workspaces.length - p.includedWorkspaces);
  const additionalSeats = Math.max(0, seatCount - p.includedSeats);
  const totalMonthlyInr = Math.round((p.baseMonthlyInr + additionalWorkspaces * p.extraWorkspaceMonthlyInr
    + additionalSeats * p.extraSeatMonthlyInr + additionalIndustries * p.additionalIndustryMonthlyInr) * 100) / 100;
  return { currency: 'INR', baseMonthlyInr: p.baseMonthlyInr, workspaceCount: workspaces.length,
    includedWorkspaces: p.includedWorkspaces, additionalWorkspaces, extraWorkspaceMonthlyInr: p.extraWorkspaceMonthlyInr,
    seatCount, includedSeats: p.includedSeats, additionalSeats, extraSeatMonthlyInr: p.extraSeatMonthlyInr,
    additionalIndustries, additionalIndustryMonthlyInr: p.additionalIndustryMonthlyInr, totalMonthlyInr,
    usageIncluded: false };
}
function branchQuote(policy, workspaces, seatCount = 1) {
  if (!policy.pricing || (policy.pricing.maxWorkspaces !== null && workspaces.length >= policy.pricing.maxWorkspaces)) return null;
  const next = quote(policy, [...workspaces, { industry: policy.primaryIndustry }], seatCount);
  if (!next) return null;
  const token = crypto.createHash('sha256').update(JSON.stringify({ policy, workspaces: workspaces.map(w => [w.id, w.industry]).sort(), next })).digest('hex');
  return { ...next, upgradesToMultipleBranches: policy.mode === 'single', token };
}
function validateIndustryChange(currentIndustry, nextIndustry) {
  if (nextIndustry !== undefined && nextIndustry !== currentIndustry) throw invalid('Workspace industry is fixed. Ask a platform administrator to provision a workspace for another industry.', 403);
}
function authorizeCreation(policy,workspaces,{industry,platformAdmin=false,pricingAcceptanceToken,seatCount=1}) {
  if (!policy.pricing || (policy.pricing.maxWorkspaces !== null && workspaces.length >= policy.pricing.maxWorkspaces)) {
    throw invalid(`This subscription allows up to ${policy.pricing?.maxWorkspaces || 0} workspaces. Upgrade the subscription to add another workspace.`, 409);
  }
  if (industry !== policy.primaryIndustry && (!platformAdmin || policy.mode !== 'mixed_industry')) {
    throw invalid('Only platform administrators can add a different industry, and only for mixed-industry organizations.',403);
  }
  if (!platformAdmin) {
    const offered=branchQuote(policy,workspaces,seatCount);
    if (!offered) throw invalid('Ask a platform administrator to configure branch pricing before adding a workspace.',409);
    if (pricingAcceptanceToken!==offered.token) throw invalid('Workspace pricing changed. Refresh and accept the current monthly price.',409);
  }
  return policy;
}
module.exports = { MODES, json, invalid, validatePolicy, effectivePolicy, quote, branchQuote, validateIndustryChange, authorizeCreation };
