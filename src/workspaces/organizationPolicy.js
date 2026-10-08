const crypto = require('crypto');
const MODES = ['single', 'same_industry', 'mixed_industry'];
function invalid(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function json(value) { if (typeof value === 'string') { try { return JSON.parse(value); } catch { return {}; } } return value || {}; }
function validatePolicy(input, primaryIndustry, industries) {
  if (!input || !MODES.includes(input.mode)) throw invalid('Select a valid organization workspace structure.');
  if (!industries.includes(primaryIndustry)) throw invalid('Select a supported primary industry.');
  const pricing = input.pricing;
  if (!pricing || typeof pricing !== 'object') throw invalid('Configure monthly workspace pricing.');
  const result = {};
  for (const key of ['baseMonthlyInr', 'extraWorkspaceMonthlyInr', 'additionalIndustryMonthlyInr']) {
    if (typeof pricing[key] !== 'number' || !Number.isFinite(pricing[key]) || pricing[key] < 0 || pricing[key] > 100000000) throw invalid('Monthly prices must be non-negative INR amounts.');
    result[key] = Math.round(pricing[key] * 100) / 100;
  }
  if (!Number.isInteger(pricing.includedWorkspaces) || pricing.includedWorkspaces < 1 || pricing.includedWorkspaces > 1000) throw invalid('Included workspaces must be between 1 and 1000.');
  result.includedWorkspaces = pricing.includedWorkspaces;
  return { mode: input.mode, primaryIndustry, pricing: result };
}
function effectivePolicy(org, workspaces) {
  const settings = json(org.settings);
  const stored = settings.workspacePolicy || org.workspacePolicy;
  const primaryIndustry = stored?.primaryIndustry || org.industry || 'lending';
  const mode = MODES.includes(stored?.mode) ? stored.mode : workspaces.some(w => w.industry !== primaryIndustry)
    ? 'mixed_industry' : workspaces.length > 1 ? 'same_industry' : 'single';
  return { mode, primaryIndustry, pricing: stored?.pricing || null };
}
function quote(policy, workspaces) {
  if (!policy.pricing) return null;
  const p = policy.pricing;
  const extraWorkspaces = Math.max(0, workspaces.length - p.includedWorkspaces);
  const additionalIndustries = new Set(workspaces.map(w => w.industry).filter(i => i !== policy.primaryIndustry)).size;
  const totalMonthlyInr = Math.round((p.baseMonthlyInr + extraWorkspaces * p.extraWorkspaceMonthlyInr + additionalIndustries * p.additionalIndustryMonthlyInr) * 100) / 100;
  return { currency: 'INR', baseMonthlyInr: p.baseMonthlyInr, workspaceCount: workspaces.length,
    includedWorkspaces: p.includedWorkspaces, extraWorkspaces, extraWorkspaceMonthlyInr: p.extraWorkspaceMonthlyInr,
    additionalIndustries, additionalIndustryMonthlyInr: p.additionalIndustryMonthlyInr, totalMonthlyInr,
    usageIncluded: false };
}
function branchQuote(policy, workspaces) {
  const next = quote(policy, [...workspaces, { industry: policy.primaryIndustry }]);
  if (!next) return null;
  const token = crypto.createHash('sha256').update(JSON.stringify({ policy, workspaces: workspaces.map(w => [w.id, w.industry]).sort(), next })).digest('hex');
  return { ...next, upgradesToMultipleBranches: policy.mode === 'single', token };
}
function validateIndustryChange(currentIndustry, nextIndustry) {
  if (nextIndustry !== undefined && nextIndustry !== currentIndustry) throw invalid('Workspace industry is fixed. Ask a platform administrator to provision a workspace for another industry.', 403);
}
function authorizeCreation(policy,workspaces,{industry,platformAdmin=false,pricingAcceptanceToken}) {
  if (industry !== policy.primaryIndustry && (!platformAdmin || policy.mode !== 'mixed_industry')) {
    throw invalid('Only platform administrators can add a different industry, and only for mixed-industry organizations.',403);
  }
  if (!platformAdmin) {
    const offered=branchQuote(policy,workspaces);
    if (!offered) throw invalid('Ask a platform administrator to configure branch pricing before adding a workspace.',409);
    if (pricingAcceptanceToken!==offered.token) throw invalid('Workspace pricing changed. Refresh and accept the current monthly price.',409);
  }
  return {...policy,mode:policy.mode==='single'?'same_industry':policy.mode};
}
module.exports = { MODES, json, invalid, validatePolicy, effectivePolicy, quote, branchQuote, validateIndustryChange, authorizeCreation };
