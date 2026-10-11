'use strict';

const crypto = require('node:crypto');
const amountMath = require('../../kernel/amount');
const { normalizePlanTerms } = require('./terms');

function fail(message, code = 'INVALID_UPGRADE_QUOTE') {
  throw Object.assign(new TypeError(message), { code });
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function utcInstant(value, name) {
  const input = value instanceof Date ? value.toISOString() : String(value);
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(input)
    ? `${input.replace(' ', 'T').replace(/\.(\d{3})\d+$/, '.$1')}Z` : input;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) fail(`${name} must be a valid instant.`);
  return new Date(ms).toISOString();
}
function roundHalfUp(units, numerator, denominator) {
  const n = BigInt(units) * BigInt(numerator);
  const d = BigInt(denominator);
  if (d <= 0n) fail('Proration denominator must be positive.');
  const quotient = n / d;
  const remainder = n % d;
  if ((remainder < 0n ? -remainder : remainder) * 2n >= d) return quotient + (n < 0n ? -1n : 1n);
  return quotient;
}
function proratePositiveDelta(current, target, remainingMs, totalMs, label) {
  const from = amountMath.validateAmount(current);
  const to = amountMath.validateAmount(target);
  if (from.asset !== to.asset || from.scale !== to.scale) fail(`${label} currencies must match.`, 'MIXED_CURRENCY');
  const difference = BigInt(to.units) - BigInt(from.units);
  if (difference <= 0n) return amountMath.createAmount(from.asset, '0', from.scale);
  return amountMath.createAmount(from.asset, roundHalfUp(difference, remainingMs, totalMs), from.scale);
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function assertTargetFitsInventory(current, target, inventory) {
  const workspaceCount = Number(inventory?.workspaceCount);
  const seatCount = Number(inventory?.seatCount);
  const industryCodes = Array.isArray(inventory?.industries) ? inventory.industries.map((item) => item.code) : [];
  if (!Number.isSafeInteger(workspaceCount) || !Number.isSafeInteger(seatCount) || !industryCodes.length) {
    fail('Upgrade preview requires a complete workspace, seat, and industry inventory.', 'UPGRADE_INVENTORY_UNAVAILABLE');
  }
  if (target.structure.mode === 'single' && workspaceCount > 1
      || target.structure.maxWorkspaces != null && workspaceCount > target.structure.maxWorkspaces) {
    fail('Current workspace inventory exceeds the target plan limits.', 'UPGRADE_ENTITLEMENT_CONFLICT');
  }
  const distinctIndustries = new Set(industryCodes).size;
  if (target.structure.mode !== 'mixed_industry' && distinctIndustries > 1
      || target.structure.maxDistinctIndustries != null && distinctIndustries > target.structure.maxDistinctIndustries) {
    fail('Current industry inventory exceeds the target plan limits.', 'UPGRADE_ENTITLEMENT_CONFLICT');
  }
  if (target.seats.max != null && seatCount > target.seats.max) {
    fail('Current seat inventory exceeds the target plan limits.', 'UPGRADE_ENTITLEMENT_CONFLICT');
  }
  for (const industry of industryCodes) {
    const currentModules = current.industryModules[industry] || [];
    const targetModules = target.industryModules[industry] || [];
    if (currentModules.some((module) => !targetModules.includes(module))) {
      fail(`Target plan removes one or more modules currently required by industry ${industry}.`, 'UPGRADE_ENTITLEMENT_CONFLICT');
    }
  }
}

/** Build an immutable quote-only preview; it cannot be submitted or fulfilled. */
function composeImmediateUpgradeQuote({ currentPeriod, currentTerms, targetPlanVersion, orgId, inventory,
  quoteId, version = 1, createdAt, validUntil }) {
  if (!currentPeriod || currentPeriod.status !== 'active') fail('An active paid subscription period is required.', 'UPGRADE_NOT_AVAILABLE');
  const now = utcInstant(createdAt, 'createdAt');
  const startsAt = utcInstant(currentPeriod.startsAt, 'currentPeriod.startsAt');
  const endsAt = utcInstant(currentPeriod.endsAt, 'currentPeriod.endsAt');
  const startMs = Date.parse(startsAt), endMs = Date.parse(endsAt), nowMs = Date.parse(now);
  if (nowMs < startMs || nowMs >= endMs) fail('The current paid period is not active at the quote time.', 'UPGRADE_NOT_AVAILABLE');
  const totalMs = endMs - startMs;
  const remainingMs = endMs - nowMs;
  if (totalMs <= 0 || remainingMs <= 0) fail('The current billing period has no remaining service time.', 'UPGRADE_NOT_AVAILABLE');
  if (!targetPlanVersion || targetPlanVersion.status !== 'published') fail('A published target plan version is required.', 'INVALID_PLAN_VERSION');
  if (targetPlanVersion.planId == null || !Number.isSafeInteger(targetPlanVersion.version) || targetPlanVersion.version < 1) fail('Target plan version identity is invalid.', 'INVALID_PLAN_VERSION');
  const effectiveFrom = targetPlanVersion.effectiveFrom == null ? NaN : Date.parse(targetPlanVersion.effectiveFrom);
  const effectiveTo = targetPlanVersion.effectiveTo == null ? null : Date.parse(targetPlanVersion.effectiveTo);
  if (!Number.isFinite(effectiveFrom) || nowMs < effectiveFrom
      || (effectiveTo !== null && (!Number.isFinite(effectiveTo) || nowMs >= effectiveTo))) {
    fail('Target plan version is not effective at the quote time.', 'VERSION_CONFLICT');
  }
  if (!Number.isSafeInteger(version) || version < 1) fail('Quote version must be a positive integer.');
  if (typeof orgId !== 'string' || !orgId || typeof quoteId !== 'string' || !quoteId) fail('Quote identity is required.');
  const terms = normalizePlanTerms(targetPlanVersion.terms);
  const current = normalizePlanTerms(currentTerms);
  assertTargetFitsInventory(current, terms, inventory);
  if (targetPlanVersion.planId === currentPeriod.planId && targetPlanVersion.version === currentPeriod.planVersion) {
    fail('The target plan is already active.', 'UPGRADE_NOT_AVAILABLE');
  }
  if (terms.currency !== current.currency || terms.subscriptionPrice.asset !== current.subscriptionPrice.asset
      || terms.subscriptionPrice.scale !== current.subscriptionPrice.scale) fail('Current and target subscription fees must use the same currency and scale.', 'MIXED_CURRENCY');
  if (BigInt(terms.subscriptionPrice.units) <= BigInt(current.subscriptionPrice.units)) {
    fail('A target plan with a lower or equal recurring fee is not an immediate upgrade.', 'DOWNGRADE_REQUIRES_RENEWAL');
  }
  // Immediate fulfillment currently applies the versioned plan to future renewal
  // pricing and adds only the prorated subscription-price delta. Reject a target
  // that would also increase metered inventory fees, or reduce existing limits,
  // rather than silently undercharging or applying a breaking entitlement.
  const sameAmount = (a, b) => a.asset === b.asset && a.scale === b.scale && BigInt(a.units) === BigInt(b.units);
  if (!sameAmount(terms.workspaceFees.additionalWorkspace, current.workspaceFees.additionalWorkspace)
      || !sameAmount(terms.workspaceFees.additionalDistinctIndustry, current.workspaceFees.additionalDistinctIndustry)
      || !sameAmount(terms.seats.additionalSeat, current.seats.additionalSeat)) {
    fail('Immediate upgrades require unchanged workspace, industry, and extra-seat fees until those charges can be prorated.', 'UPGRADE_PRICING_COMPONENT_UNSUPPORTED');
  }
  for (const key of ['includedWorkspaces', 'includedDistinctIndustries', 'maxWorkspaces', 'maxDistinctIndustries']) {
    const before = current.structure[key]; const after = terms.structure[key];
    if (before === null || before === undefined) continue;
    if (after !== null && after !== undefined && after < before) fail('Immediate upgrades cannot reduce workspace or industry limits.', 'UPGRADE_ENTITLEMENT_REDUCTION_UNSUPPORTED');
  }
  if (terms.seats.included < current.seats.included
      || (current.seats.max != null && terms.seats.max != null && terms.seats.max < current.seats.max)) {
    fail('Immediate upgrades cannot reduce seat entitlements.', 'UPGRADE_ENTITLEMENT_REDUCTION_UNSUPPORTED');
  }
  const amountDue = proratePositiveDelta(current.subscriptionPrice, terms.subscriptionPrice, remainingMs, totalMs, 'Subscription fee');
  if (terms.includedCredits.asset !== current.includedCredits.asset || terms.includedCredits.scale !== current.includedCredits.scale) {
    fail('Current and target included credits must use the same asset and scale.', 'MIXED_CURRENCY');
  }
  const creditDifference = BigInt(terms.includedCredits.units) - BigInt(current.includedCredits.units);
  const incrementalIncludedCredits = creditDifference > 0n
    ? amountMath.createAmount(terms.includedCredits.asset, roundHalfUp(creditDifference, remainingMs, totalMs), terms.includedCredits.scale)
    : amountMath.createAmount(terms.includedCredits.asset, '0', terms.includedCredits.scale);
  const zero = amountMath.createAmount(amountDue.asset, '0', amountDue.scale);
  const lines = [];
  if (BigInt(amountDue.units) > 0n) lines.push({ lineId: 'upgrade_proration', code: 'upgrade_proration', label: 'Prorated subscription plan upgrade',
    quantity: 1, unitAmount: amountDue, amount: amountDue, taxable: true, discountable: false });
  let totalTax = zero;
  let exclusiveTax = zero;
  for (const tax of terms.taxes) {
    if (!tax.appliesTo.includes('subscription') || tax.rateBps === 0 || BigInt(amountDue.units) === 0n) continue;
    const numerator = BigInt(amountDue.units) * BigInt(tax.rateBps);
    const denominator = tax.inclusive ? 10000n + BigInt(tax.rateBps) : 10000n;
    const units = (numerator + denominator / 2n) / denominator;
    const taxAmount = amountMath.createAmount(amountDue.asset, units, amountDue.scale);
    totalTax = amountMath.add(totalTax, taxAmount);
    if (!tax.inclusive) exclusiveTax = amountMath.add(exclusiveTax, taxAmount);
    lines.push({ lineId: `tax_${tax.code}`, code: `tax_${tax.code}`, label: `Tax ${tax.code}`, quantity: 1,
      unitAmount: taxAmount, amount: taxAmount, taxable: false, discountable: false,
      taxCode: tax.code, rateBps: tax.rateBps, inclusive: tax.inclusive });
  }
  const total = amountMath.add(amountDue, exclusiveTax);
  const expiresAt = utcInstant(validUntil, 'validUntil');
  if (Date.parse(expiresAt) <= nowMs) fail('validUntil must be later than createdAt.');
  const snapshot = {
    schemaVersion: 1, quoteId, version, purpose: 'adjustment', orgId,
    plan: { id: targetPlanVersion.planId, version: targetPlanVersion.version, terms },
    inventory, createdAt: now, validUntil: expiresAt, conflicts: [], lines,
    subtotal: amountDue, discounts: zero, totalTax, total,
    includedCredits: terms.includedCredits, paymentIsCreditValue: false,
    adjustment: {
      kind: 'immediate_upgrade', currentPeriodId: currentPeriod.periodId,
      currentPlan: { id: currentPeriod.planId, version: currentPeriod.planVersion },
      targetPlan: { id: targetPlanVersion.planId, version: targetPlanVersion.version },
      effectiveAt: now, renewalAnchorAt: endsAt, periodStartAt: startsAt, periodEndAt: endsAt,
      remainingMilliseconds: String(remainingMs), totalMilliseconds: String(totalMs),
      currentRecurringPrice: current.subscriptionPrice, targetRecurringPrice: terms.subscriptionPrice,
      prorationAmount: amountDue,
      currentIncludedCredits: current.includedCredits, targetIncludedCredits: terms.includedCredits,
      includedCreditDelta: amountMath.createAmount(terms.includedCredits.asset, creditDifference, terms.includedCredits.scale),
      incrementalIncludedCredits,
      creditDecreaseApplied: false,
      applicationStatus: 'awaiting_payment_approval',
    },
    upgradePreview: { payable: false, paymentSubmissionPath: null,
      reason: 'UPGRADE_ENTITLEMENT_INTEGRATION_NOT_IMPLEMENTED' },
  };
  snapshot.fingerprint = `sha256:${crypto.createHash('sha256').update(canonical(snapshot)).digest('hex')}`;
  return deepFreeze(snapshot);
}

module.exports = { composeImmediateUpgradeQuote, roundHalfUp, proratePositiveDelta, assertTargetFitsInventory };
