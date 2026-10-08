'use strict';

const { validateAmount } = require('../../kernel/amount');

const TERMS_SCHEMA_VERSION = 1;
const STRUCTURE_MODES = Object.freeze(['single', 'same_industry', 'mixed_industry']);
const EXPIRY_MODES = Object.freeze(['suspend', 'grace', 'continue_postpaid']);
const TAX_APPLICABILITY = Object.freeze(['subscription', 'additional_workspace', 'additional_industry']);

function fail(path, reason) { throw new TypeError(`${path} ${reason}`); }
function record(value, path, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object.');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, 'is not allowed.');
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${path}.${key}`, 'is required.');
  return value;
}
function positiveInt(value, path, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(path, `must be an integer from ${min} to ${max}.`);
  return value;
}
function validAmount(value, path, { positive = false, asset } = {}) {
  let amount;
  try { amount = validateAmount(value); } catch (error) { fail(path, `must be a valid {asset, units, scale} amount (${error.message}).`); }
  const units = BigInt(amount.units);
  if (positive ? units <= 0n : units < 0n) fail(path, positive ? 'must be greater than zero.' : 'must not be negative.');
  if (asset && amount.asset !== asset) fail(`${path}.asset`, `must be ${asset}.`);
  return { asset: amount.asset, units: amount.units, scale: amount.scale };
}
function nullablePositiveInt(value, path) {
  return value === null ? null : positiveInt(value, path, { min: 1 });
}
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Normalize and validate the versioned, portable plan terms DTO. This shape is
 * persisted as JSON and copied into purchased terms; never mutate it in place.
 */
function normalizePlanTerms(value) {
  record(value, 'terms', [
    'schemaVersion', 'currency', 'billingInterval', 'subscriptionPrice', 'structure', 'workspaceFees',
    'includedCredits', 'taxes', 'postpaid', 'serviceAfterExpiry',
  ]);
  if (value.schemaVersion !== TERMS_SCHEMA_VERSION) fail('terms.schemaVersion', `must be ${TERMS_SCHEMA_VERSION}.`);
  if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)) fail('terms.currency', 'must be an ISO-style uppercase three-letter currency code.');
  record(value.billingInterval, 'terms.billingInterval', ['unit', 'count']);
  if (!['day', 'week', 'month', 'year'].includes(value.billingInterval.unit)) fail('terms.billingInterval.unit', 'must be day, week, month, or year.');
  const billingInterval = { unit: value.billingInterval.unit, count: positiveInt(value.billingInterval.count, 'terms.billingInterval.count', { min: 1, max: 120 }) };
  const subscriptionPrice = validAmount(value.subscriptionPrice, 'terms.subscriptionPrice', { positive: true, asset: value.currency });

  record(value.structure, 'terms.structure', [
    'mode', 'includedWorkspaces', 'includedDistinctIndustries', 'maxWorkspaces',
    'maxDistinctIndustries', 'orgAdminWorkspaceIndustry',
  ]);
  if (!STRUCTURE_MODES.includes(value.structure.mode)) fail('terms.structure.mode', `must be one of ${STRUCTURE_MODES.join(', ')}.`);
  const includedWorkspaces = positiveInt(value.structure.includedWorkspaces, 'terms.structure.includedWorkspaces', { min: 1 });
  const includedDistinctIndustries = positiveInt(value.structure.includedDistinctIndustries, 'terms.structure.includedDistinctIndustries', { min: 1 });
  const maxWorkspaces = nullablePositiveInt(value.structure.maxWorkspaces, 'terms.structure.maxWorkspaces');
  const maxDistinctIndustries = nullablePositiveInt(value.structure.maxDistinctIndustries, 'terms.structure.maxDistinctIndustries');
  if (value.structure.orgAdminWorkspaceIndustry !== 'primary_only') {
    fail('terms.structure.orgAdminWorkspaceIndustry', 'must be primary_only; organization administrators cannot create a different-industry workspace.');
  }
  if (value.structure.mode === 'single' && (maxWorkspaces !== 1 || maxDistinctIndustries !== 1)) {
    fail('terms.structure', 'single mode requires maxWorkspaces and maxDistinctIndustries to both be 1.');
  }
  if (value.structure.mode === 'same_industry' && maxDistinctIndustries !== 1) fail('terms.structure.maxDistinctIndustries', 'must be 1 for same_industry mode.');
  if (value.structure.mode === 'mixed_industry' && maxDistinctIndustries !== null && maxDistinctIndustries < 2) fail('terms.structure.maxDistinctIndustries', 'must be at least 2 or null for mixed_industry mode.');
  if (maxWorkspaces !== null && includedWorkspaces > maxWorkspaces) fail('terms.structure.includedWorkspaces', 'cannot exceed maxWorkspaces.');
  if (maxDistinctIndustries !== null && includedDistinctIndustries > maxDistinctIndustries) fail('terms.structure.includedDistinctIndustries', 'cannot exceed maxDistinctIndustries.');

  record(value.workspaceFees, 'terms.workspaceFees', ['additionalWorkspace', 'additionalDistinctIndustry']);
  const workspaceFees = {
    additionalWorkspace: validAmount(value.workspaceFees.additionalWorkspace, 'terms.workspaceFees.additionalWorkspace', { asset: value.currency }),
    additionalDistinctIndustry: validAmount(value.workspaceFees.additionalDistinctIndustry, 'terms.workspaceFees.additionalDistinctIndustry', { asset: value.currency }),
  };
  const includedCredits = validAmount(value.includedCredits, 'terms.includedCredits');
  if (!Array.isArray(value.taxes) || value.taxes.length > 50) fail('terms.taxes', 'must be an array of at most 50 tax definitions.');
  const taxCodes = new Set();
  const taxes = value.taxes.map((tax, index) => {
    const path = `terms.taxes[${index}]`;
    record(tax, path, ['code', 'rateBps', 'appliesTo', 'inclusive']);
    if (typeof tax.code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tax.code)) fail(`${path}.code`, 'must be a stable tax code.');
    if (taxCodes.has(tax.code)) fail(`${path}.code`, 'must be unique within a plan version.');
    taxCodes.add(tax.code);
    const rateBps = positiveInt(tax.rateBps, `${path}.rateBps`, { min: 0, max: 10000 });
    if (!Array.isArray(tax.appliesTo) || tax.appliesTo.length < 1 || tax.appliesTo.some((item) => !TAX_APPLICABILITY.includes(item))) {
      fail(`${path}.appliesTo`, `must include one or more of ${TAX_APPLICABILITY.join(', ')}.`);
    }
    if (new Set(tax.appliesTo).size !== tax.appliesTo.length) fail(`${path}.appliesTo`, 'must not contain duplicates.');
    if (typeof tax.inclusive !== 'boolean') fail(`${path}.inclusive`, 'must be a boolean.');
    return { code: tax.code, rateBps, appliesTo: [...tax.appliesTo].sort(), inclusive: tax.inclusive };
  }).sort((a, b) => a.code.localeCompare(b.code));

  record(value.postpaid, 'terms.postpaid', ['eligible', 'workspaceModes', 'organizationExposureLimit']);
  if (typeof value.postpaid.eligible !== 'boolean') fail('terms.postpaid.eligible', 'must be a boolean.');
  if (!Array.isArray(value.postpaid.workspaceModes) || value.postpaid.workspaceModes.some((mode) => !['limited', 'unlimited'].includes(mode))) {
    fail('terms.postpaid.workspaceModes', 'must contain only limited and/or unlimited.');
  }
  if (new Set(value.postpaid.workspaceModes).size !== value.postpaid.workspaceModes.length) fail('terms.postpaid.workspaceModes', 'must not contain duplicates.');
  if (!value.postpaid.eligible && value.postpaid.workspaceModes.length) fail('terms.postpaid.workspaceModes', 'must be empty when postpaid is not eligible.');
  const organizationExposureLimit = value.postpaid.organizationExposureLimit === null
    ? null : validAmount(value.postpaid.organizationExposureLimit, 'terms.postpaid.organizationExposureLimit', { asset: value.currency });
  const postpaid = { eligible: value.postpaid.eligible, workspaceModes: [...value.postpaid.workspaceModes].sort(), organizationExposureLimit };

  record(value.serviceAfterExpiry, 'terms.serviceAfterExpiry', ['mode', 'graceSeconds']);
  if (!EXPIRY_MODES.includes(value.serviceAfterExpiry.mode)) fail('terms.serviceAfterExpiry.mode', `must be one of ${EXPIRY_MODES.join(', ')}.`);
  let graceSeconds;
  if (value.serviceAfterExpiry.mode === 'grace') graceSeconds = positiveInt(value.serviceAfterExpiry.graceSeconds, 'terms.serviceAfterExpiry.graceSeconds', { min: 1, max: 31 * 24 * 60 * 60 });
  else if (value.serviceAfterExpiry.graceSeconds !== undefined && value.serviceAfterExpiry.graceSeconds !== 0) fail('terms.serviceAfterExpiry.graceSeconds', 'must be omitted or zero unless mode is grace.');
  else graceSeconds = 0;
  if (value.serviceAfterExpiry.mode === 'continue_postpaid' && !postpaid.eligible) fail('terms.serviceAfterExpiry.mode', 'requires postpaid eligibility.');

  return deepFreeze({
    schemaVersion: TERMS_SCHEMA_VERSION,
    currency: value.currency,
    billingInterval,
    subscriptionPrice,
    structure: {
      mode: value.structure.mode,
      includedWorkspaces,
      includedDistinctIndustries,
      maxWorkspaces,
      maxDistinctIndustries,
      orgAdminWorkspaceIndustry: value.structure.orgAdminWorkspaceIndustry,
    },
    workspaceFees,
    includedCredits,
    taxes,
    postpaid,
    serviceAfterExpiry: { mode: value.serviceAfterExpiry.mode, graceSeconds },
  });
}

/** Normalize an allowlisted partial terms override; omitted values remain inherited. */
function normalizePlanOverrides(value) {
  record(value, 'overrides', ['structure', 'workspaceFees', 'includedCredits', 'taxes', 'postpaid', 'serviceAfterExpiry', 'subscriptionPrice', 'currency', 'billingInterval'], []);
  const normalized = {};
  const allowedNested = {
    structure: ['mode', 'includedWorkspaces', 'includedDistinctIndustries', 'maxWorkspaces', 'maxDistinctIndustries', 'orgAdminWorkspaceIndustry'],
    workspaceFees: ['additionalWorkspace', 'additionalDistinctIndustry'],
    postpaid: ['eligible', 'workspaceModes', 'organizationExposureLimit'],
    serviceAfterExpiry: ['mode', 'graceSeconds'],
  };
  for (const [group, keys] of Object.entries(allowedNested)) {
    if (value[group] === undefined) continue;
    record(value[group], `overrides.${group}`, keys, []);
    if (group === 'structure' && value[group].orgAdminWorkspaceIndustry !== undefined && value[group].orgAdminWorkspaceIndustry !== 'primary_only') {
      fail('overrides.structure.orgAdminWorkspaceIndustry', 'must remain primary_only.');
    }
    normalized[group] = { ...value[group] };
  }
  for (const key of ['includedCredits', 'taxes', 'subscriptionPrice', 'currency']) {
    if (value[key] !== undefined) normalized[key] = value[key];
  }
  if (value.billingInterval !== undefined) {
    record(value.billingInterval, 'overrides.billingInterval', ['unit', 'count'], []);
    normalized.billingInterval = { ...value.billingInterval };
  }
  return deepFreeze(normalized);
}

function applyPlanOverrides(terms, overrides) {
  const normalizedTerms = normalizePlanTerms(terms);
  const partial = normalizePlanOverrides(overrides || {});
  const merged = {
    ...normalizedTerms,
    ...partial,
    structure: { ...normalizedTerms.structure, ...(partial.structure || {}) },
    workspaceFees: { ...normalizedTerms.workspaceFees, ...(partial.workspaceFees || {}) },
    postpaid: { ...normalizedTerms.postpaid, ...(partial.postpaid || {}) },
    serviceAfterExpiry: { ...normalizedTerms.serviceAfterExpiry, ...(partial.serviceAfterExpiry || {}) },
  };
  if (partial.currency && !partial.subscriptionPrice) fail('overrides.currency', 'requires an explicit subscriptionPrice override so amount assets remain aligned.');
  return normalizePlanTerms(merged);
}

module.exports = {
  TERMS_SCHEMA_VERSION,
  STRUCTURE_MODES,
  EXPIRY_MODES,
  TAX_APPLICABILITY,
  normalizePlanTerms,
  normalizePlanOverrides,
  applyPlanOverrides,
};
