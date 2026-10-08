'use strict';

const { validateAmount } = require('../../kernel/amount');
const { validateScope } = require('../../kernel/scope');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../contracts/errors');

const { INVALID_CONTRACT, MIXED_ASSET, INSUFFICIENT_CREDITS, POSTPAID_DISABLED, WORKSPACE_LIMIT_REACHED } = DOMAIN_ERROR_CODES;

function fail(code, message, details) { throw new BillingDomainError(code, message, { details }); }
function time(value, label) {
  const result = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(result)) fail(INVALID_CONTRACT, `${label} must be a valid timestamp.`);
  return result;
}

function planFunding({ scope: scopeValue, amount: amountValue, positions, policy, now, validUntil }) {
  const scope = validateScope(scopeValue);
  if (scope.ownerType !== 'workspace') fail(INVALID_CONTRACT, 'Usage funding can only draw from a workspace scope.');
  const amount = validateAmount(amountValue);
  if (BigInt(amount.units) <= 0n) fail(INVALID_CONTRACT, 'Usage funding amount must be positive.');
  const currentTime = time(now, 'now');
  const reservationEnd = time(validUntil, 'validUntil');
  if (reservationEnd <= currentTime) fail(INVALID_CONTRACT, 'validUntil must be after now.');
  if (!policy || typeof policy !== 'object') fail(INVALID_CONTRACT, 'resolved funding policy is required.');
  if (policy.serviceAllowed !== true) fail(DOMAIN_ERROR_CODES.USAGE_NOT_ENTITLED, 'The workspace is not entitled to use this service.', { service: policy.serviceKey || null });
  if (!['prepaid', 'postpaid'].includes(policy.fallbackMode)) fail(INVALID_CONTRACT, 'fallbackMode must be prepaid or postpaid.');
  if (!Number.isSafeInteger(policy.version) || policy.version < 1) fail(INVALID_CONTRACT, 'policy.version must be a positive safe integer.');
  if (!Array.isArray(positions)) fail(INVALID_CONTRACT, 'locked workspace credit positions are required.');

  const eligible = positions.filter((item) => {
    if (!item || item.orgId !== scope.orgId || item.workspaceId !== scope.ownerId) return false;
    if (item.accountType !== 'workspace' || item.ownerId !== scope.ownerId || item.accountPurpose !== 'pool' || item.accountStatus !== 'active') return false;
    if (!['subscription', 'topup'].includes(item.grantKind) || item.grantStatus !== 'active') return false;
    if (item.grantKind === 'subscription' && item.expiresAt == null) return false;
    if (time(item.effectiveAt, 'grant.effectiveAt') > currentTime) return false;
    if (item.expiresAt != null && time(item.expiresAt, 'grant.expiresAt') <= currentTime) return false;
    // A reservation must never cross an expiring grant boundary. If this
    // grant cannot cover the requested window, skip it and use a later source.
    if (item.expiresAt != null && reservationEnd > time(item.expiresAt, 'grant.expiresAt')) return false;
    return true;
  }).map((item) => {
    if (item.amount.asset !== amount.asset || item.amount.scale !== amount.scale) return null;
    const balance = BigInt(item.balanceUnits);
    const held = BigInt(item.reservedUnits);
    if (balance < 0n || held < 0n || held > balance) fail(INVALID_CONTRACT, 'Credit position has invalid balance or held units.', { positionId: item.positionId });
    return { ...item, availableUnits: balance - held };
  }).filter((item) => item && item.availableUnits > 0n).sort((a, b) => {
    const kindOrder = (a.grantKind === 'subscription' ? 0 : 1) - (b.grantKind === 'subscription' ? 0 : 1);
    if (kindOrder !== 0) return kindOrder;
    if (a.grantKind === 'subscription') {
      const expiryOrder = time(a.expiresAt, 'grant.expiresAt') - time(b.expiresAt, 'grant.expiresAt');
      if (expiryOrder !== 0) return expiryOrder;
    }
    return a.grantId.localeCompare(b.grantId) || a.positionId.localeCompare(b.positionId);
  });

  if (policy.workspaceCycleCap) {
    const cap = validateAmount(policy.workspaceCycleCap);
    if (cap.asset !== amount.asset || cap.scale !== amount.scale) fail(MIXED_ASSET, 'Workspace cycle cap must use the requested credit asset and scale.');
    const used = nonNegativeUnits(policy.workspaceCycleUsedUnits || '0', 'workspaceCycleUsedUnits');
    const held = nonNegativeUnits(policy.workspaceCycleHeldUnits || '0', 'workspaceCycleHeldUnits');
    const requested = BigInt(amount.units);
    const availableCap = BigInt(cap.units) - used - held;
    if (requested > availableCap) fail(WORKSPACE_LIMIT_REACHED, 'Usage reservation exceeds the workspace cycle cap after current usage and holds.', {
      capUnits: cap.units, usedUnits: used.toString(), heldUnits: held.toString(), requestedUnits: amount.units,
      availableUnits: (availableCap > 0n ? availableCap : 0n).toString(), periodId: policy.cyclePeriodId || null,
    });
  }

  let remaining = BigInt(amount.units);
  const lines = [];
  for (const position of eligible) {
    if (remaining === 0n) break;
    const units = position.availableUnits < remaining ? position.availableUnits : remaining;
    lines.push(Object.freeze({
      fundingSource: position.grantKind === 'subscription' ? 'subscription_credit' : 'topup_credit',
      positionId: position.positionId,
      grantId: position.grantId,
      accountId: position.accountId,
      periodId: position.periodId || null,
      amount: Object.freeze({ asset: amount.asset, units: units.toString(), scale: amount.scale }),
      grantExpiresAt: position.expiresAt || null,
      fundingSnapshot: Object.freeze({
        grantKind: position.grantKind,
        grantEffectiveAt: position.effectiveAt,
        grantExpiresAt: position.expiresAt || null,
        grantPeriodId: position.periodId || null,
        positionVersion: position.version,
      }),
    }));
    remaining -= units;
  }

  if (remaining > 0n && policy.fallbackMode === 'postpaid') {
    const postpaid = policy.postpaidPolicy;
    if (!postpaid || postpaid.enabled !== true || !['limited', 'unlimited'].includes(postpaid.mode)) {
      fail(POSTPAID_DISABLED, 'Workspace postpaid funding is not enabled.', { workspaceId: scope.ownerId });
    }
    if (!policy.postpaidEligible || !policy.allowedPostpaidModes?.includes(postpaid.mode)) {
      fail(POSTPAID_DISABLED, 'The active platform subscription does not permit this workspace postpaid mode.', { workspaceId: scope.ownerId, mode: postpaid.mode });
    }
    if (!policy.postpaidPeriodId) fail(POSTPAID_DISABLED, 'No active billing period is available for postpaid usage.', { workspaceId: scope.ownerId });
    const postpaidCap = postpaid.mode === 'limited' ? validateAmount(postpaid.cycleLimit) : null;
    const orgCap = policy.organizationExposureLimit ? validateAmount(policy.organizationExposureLimit) : null;
    for (const cap of [postpaidCap, orgCap].filter(Boolean)) {
      if (cap.asset !== amount.asset || cap.scale !== amount.scale) fail(MIXED_ASSET, 'Postpaid exposure cap must use the requested credit asset and scale.');
    }
    if (postpaidCap && BigInt(policy.workspacePostpaidUsedUnits || '0') + BigInt(policy.workspacePostpaidHeldUnits || '0') + remaining > BigInt(postpaidCap.units)) {
      fail(DOMAIN_ERROR_CODES.POSTPAID_LIMIT_REACHED, 'Workspace postpaid cycle limit would be exceeded.', { workspaceId: scope.ownerId, capUnits: postpaidCap.units, usedUnits: policy.workspacePostpaidUsedUnits || '0', heldUnits: policy.workspacePostpaidHeldUnits || '0', requestedUnits: remaining.toString(), periodId: policy.postpaidPeriodId });
    }
    if (orgCap && BigInt(policy.organizationPostpaidUsedUnits || '0') + BigInt(policy.organizationPostpaidHeldUnits || '0') + remaining > BigInt(orgCap.units)) {
      fail(DOMAIN_ERROR_CODES.POSTPAID_LIMIT_REACHED, 'Organization postpaid exposure limit would be exceeded.', { capUnits: orgCap.units, usedUnits: policy.organizationPostpaidUsedUnits || '0', heldUnits: policy.organizationPostpaidHeldUnits || '0', requestedUnits: remaining.toString(), periodId: policy.postpaidPeriodId });
    }
    lines.push(Object.freeze({
      fundingSource: 'postpaid', positionId: null, grantId: null, accountId: null,
      periodId: policy.postpaidPeriodId,
      amount: Object.freeze({ asset: amount.asset, units: remaining.toString(), scale: amount.scale }),
      grantExpiresAt: null,
      fundingSnapshot: Object.freeze({ mode: postpaid.mode, policyVersion: postpaid.version, periodId: policy.postpaidPeriodId,
        organizationLimitApplied: Boolean(policy.organizationExposureLimit) }),
    }));
    remaining = 0n;
  }
  if (remaining > 0n) fail(INSUFFICIENT_CREDITS, 'Workspace allocated credits are insufficient for this reservation.', {
    requestedUnits: amount.units, availableUnits: (BigInt(amount.units) - remaining).toString(), missingUnits: remaining.toString(),
  });
  return Object.freeze({ scope, amount, lines: Object.freeze(lines), policyVersion: policy.version, fallbackMode: policy.fallbackMode });
}

function nonNegativeUnits(value, label) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) fail(INVALID_CONTRACT, `${label} must be a canonical non-negative integer string.`);
  return BigInt(value);
}

module.exports = { planFunding };
