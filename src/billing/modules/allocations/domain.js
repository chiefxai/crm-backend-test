'use strict';

const crypto = require('node:crypto');
const { validateAmount } = require('../../kernel/amount');
const { validateId } = require('../../kernel/scope');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../contracts/errors');

function fail(code, message, details) { throw new BillingDomainError(code, message, { details }); }
function sameAsset(left, right) { return left.asset === right.asset && left.scale === right.scale; }

function normalizeRules(value, grantKind) {
  if (!['subscription', 'topup'].includes(grantKind)) fail(DOMAIN_ERROR_CODES.ALLOCATION_INVALID, 'grantKind must be subscription or topup.');
  if (!Array.isArray(value) || value.length > 1000) fail(DOMAIN_ERROR_CODES.ALLOCATION_INVALID, 'rules must contain at most 1000 workspace rules.');
  const seen = new Set();
  let totalBasisPoints = 0;
  const rules = value.map((rule, index) => {
    const workspaceId = validateId(rule?.workspaceId, `rules[${index}].workspaceId`);
    if (seen.has(workspaceId)) fail(DOMAIN_ERROR_CODES.ALLOCATION_INVALID, 'A workspace may appear only once in an allocation rule set.', { workspaceId });
    seen.add(workspaceId);
    if (rule.kind === 'fixed') {
      let amount;
      try { amount = validateAmount(rule.amount); } catch (cause) { fail(DOMAIN_ERROR_CODES.ALLOCATION_INVALID, 'Fixed allocation amount is invalid.', { workspaceId, cause: cause.message }); }
      if (BigInt(amount.units) < 0n) fail(DOMAIN_ERROR_CODES.ALLOCATION_INVALID, 'Fixed allocation amount cannot be negative.', { workspaceId });
      return Object.freeze({ workspaceId, kind: 'fixed', amount });
    }
    if (rule.kind === 'percentage') {
      if (!Number.isInteger(rule.basisPoints) || rule.basisPoints < 0 || rule.basisPoints > 10000) fail(DOMAIN_ERROR_CODES.ALLOCATION_INVALID, 'Percentage allocation must be an integer from 0 to 10000 basis points.', { workspaceId });
      totalBasisPoints += rule.basisPoints;
      return Object.freeze({ workspaceId, kind: 'percentage', basisPoints: rule.basisPoints });
    }
    fail(DOMAIN_ERROR_CODES.ALLOCATION_INVALID, 'Allocation rule kind must be fixed or percentage.', { workspaceId });
  }).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
  if (totalBasisPoints > 10000) fail(DOMAIN_ERROR_CODES.ALLOCATION_INVALID, 'Combined percentage allocations cannot exceed 10000 basis points.', { totalBasisPoints });
  return Object.freeze(rules);
}

function checksum(value) { return crypto.createHash('sha256').update(stableJson(value)).digest('hex'); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function previewAllocation({ grant, adminPosition, rules, workspaces }) {
  if (!grant || !adminPosition) fail(DOMAIN_ERROR_CODES.ALLOCATION_INVALID, 'Grant and admin-pool position snapshots are required.');
  const grantAmount = validateAmount(grant.amount);
  const adminAmount = adminPosition.amount ? validateAmount(adminPosition.amount) : { ...grantAmount, units: String(adminPosition.balanceUnits) };
  if (!sameAsset(grantAmount, adminAmount)) fail(DOMAIN_ERROR_CODES.MIXED_ASSET, 'Admin pool position currency does not match the grant.');
  const reserved = BigInt(adminPosition.reservedUnits || '0');
  const balance = BigInt(adminAmount.units);
  if (reserved < 0n || reserved > balance) fail(DOMAIN_ERROR_CODES.ALLOCATION_INVALID, 'Admin pool reserved balance is invalid.');
  const available = balance - reserved;
  const normalizedRules = normalizeRules(rules, grant.grantKind || grant.kind);
  const workspaceMap = new Map((workspaces || []).map((workspace) => [workspace.id, workspace]));
  if (workspaceMap.size !== (workspaces || []).length) fail(DOMAIN_ERROR_CODES.ALLOCATION_INVALID, 'Workspace inventory contains duplicate IDs.');
  for (const rule of normalizedRules) {
    const workspace = workspaceMap.get(rule.workspaceId);
    if (!workspace) fail(DOMAIN_ERROR_CODES.NOT_FOUND, 'An allocation rule references a workspace outside this organization.', { workspaceId: rule.workspaceId });
    if (workspace.orgId !== undefined && workspace.orgId !== grant.orgId) fail(DOMAIN_ERROR_CODES.FORBIDDEN, 'An allocation rule references a workspace outside this organization.', { workspaceId: rule.workspaceId });
  }
  const allocations = [];
  let configured = 0n;
  let allocated = 0n;
  let skipped = 0n;
  for (const rule of normalizedRules) {
    const workspace = workspaceMap.get(rule.workspaceId);
    let units;
    if (rule.kind === 'fixed') {
      if (!sameAsset(rule.amount, grantAmount)) fail(DOMAIN_ERROR_CODES.MIXED_ASSET, 'Fixed allocation amount currency must match the grant.', { workspaceId: rule.workspaceId });
      units = BigInt(rule.amount.units);
    } else {
      // Percentages always use the original grant amount; floor each share
      // once and leave all division remainder in the organization pool.
      units = BigInt(grantAmount.units) * BigInt(rule.basisPoints) / 10000n;
    }
    configured += units;
    const active = ['active', 'enabled'].includes(String(workspace.status || '').toLowerCase());
    if (active) allocated += units;
    else skipped += units;
    allocations.push(Object.freeze({
      workspaceId: rule.workspaceId, workspaceName: workspace.name || rule.workspaceId,
      kind: rule.kind, ...(rule.basisPoints === undefined ? {} : { basisPoints: rule.basisPoints }),
      units: units.toString(), status: active ? (units === 0n ? 'zero' : 'planned') : 'skipped_suspended',
    }));
  }
  if (configured > BigInt(grantAmount.units)) fail(DOMAIN_ERROR_CODES.ALLOCATION_INVALID, 'Configured fixed and percentage shares exceed the original grant amount.', { configuredUnits: configured.toString(), grantUnits: grantAmount.units });
  if (allocated > available) fail(DOMAIN_ERROR_CODES.INSUFFICIENT_CREDITS, 'Active workspace allocations exceed the admin pool available balance.', { availableUnits: available.toString(), requestedUnits: allocated.toString() });
  return Object.freeze({
    grantId: grant.id, grantKind: grant.grantKind || grant.kind,
    asset: grantAmount.asset, scale: grantAmount.scale, grantUnits: grantAmount.units,
    availableUnits: available.toString(), totalUnits: allocated.toString(),
    skippedUnits: skipped.toString(), remainingAdminUnits: (balance - allocated).toString(),
    allocations: Object.freeze(allocations), rules: normalizedRules,
  });
}

module.exports = { normalizeRules, previewAllocation, checksum, stableJson };
