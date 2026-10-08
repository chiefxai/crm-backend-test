'use strict';

const crypto = require('node:crypto');

const SCOPES = Object.freeze(['organization', 'workspace']);
function invalid(message) { const error = new TypeError(message); error.code = 'INVALID_NOTIFICATION_POLICY'; throw error; }
function naturalUnits(value, field, { positive = false } = {}) {
  if (value == null) return null;
  const text = String(value);
  if (!/^(0|[1-9]\d*)$/.test(text)) invalid(`${field} must be a non-negative integer string.`);
  if (positive && BigInt(text) === 0n) invalid(`${field} must be greater than zero.`);
  if (BigInt(text) > 9223372036854775807n) invalid(`${field} exceeds signed 64-bit storage.`);
  return text;
}
function basisPoints(value, field) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 1 || value > 10000) invalid(`${field} must be an integer from 1 to 10000 basis points.`);
  return value;
}
function normalizePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('policy must be an object.');
  if (!SCOPES.includes(value.scopeType)) invalid('scopeType must be organization or workspace.');
  if (typeof value.scopeOwnerId !== 'string' || !value.scopeOwnerId.trim() || value.scopeOwnerId.length > 191) invalid('scopeOwnerId is required.');
  if (typeof value.eventKey !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/.test(value.eventKey)) invalid('eventKey is invalid.');
  const amount = naturalUnits(value.amountThresholdUnits, 'amountThresholdUnits', { positive: true });
  const percentage = basisPoints(value.percentageThresholdBps, 'percentageThresholdBps');
  const recoveryAmount = naturalUnits(value.recoveryAmountUnits, 'recoveryAmountUnits');
  const recoveryPercentage = basisPoints(value.recoveryPercentageBps, 'recoveryPercentageBps');
  if (amount == null && percentage == null) invalid('At least one amount or percentage threshold is required.');
  if (recoveryAmount != null && amount == null) invalid('An amount recovery threshold requires an amount threshold.');
  if (recoveryPercentage != null && percentage == null) invalid('A percentage recovery threshold requires a percentage threshold.');
  if (amount != null && recoveryAmount != null && BigInt(recoveryAmount) >= BigInt(amount)) invalid('Recovery amount must be lower than its alert threshold.');
  if (percentage != null && recoveryPercentage != null && recoveryPercentage >= percentage) invalid('Recovery percentage must be lower than its alert threshold.');
  const cooldownSeconds = value.cooldownSeconds ?? 0;
  if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > 31536000) invalid('cooldownSeconds must be from 0 to 31536000.');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') invalid('enabled must be boolean.');
  const preferences = value.preferences && typeof value.preferences === 'object' && !Array.isArray(value.preferences) ? value.preferences : {};
  if (Buffer.byteLength(JSON.stringify(preferences), 'utf8') > 16 * 1024) invalid('preferences must not exceed 16 KiB.');
  const direction = value.direction || preferences.direction || 'at_or_above';
  if (!['at_or_above', 'at_or_below'].includes(direction)) invalid('direction must be at_or_above or at_or_below.');
  return Object.freeze({ scopeType: value.scopeType, scopeOwnerId: value.scopeOwnerId.trim(), eventKey: value.eventKey,
    amountThresholdUnits: amount, percentageThresholdBps: percentage, recoveryAmountUnits: recoveryAmount,
    recoveryPercentageBps: recoveryPercentage, cooldownSeconds, enabled: value.enabled !== false, direction,
    preferences: Object.freeze({ ...preferences, direction }) });
}

function compareThreshold({ observedUnits, limitUnits, amountThresholdUnits, percentageThresholdBps, direction = 'at_or_above' }) {
  const observed = BigInt(naturalUnits(observedUnits, 'observedUnits') || '0');
  const limit = limitUnits == null ? null : BigInt(naturalUnits(limitUnits, 'limitUnits') || '0');
  const amountReached = amountThresholdUnits != null && (direction === 'at_or_below'
    ? observed <= BigInt(amountThresholdUnits) : observed >= BigInt(amountThresholdUnits));
  // Unlimited thresholds have no percentage denominator. Amount thresholds
  // still work for unlimited scopes.
  const percentageReached = percentageThresholdBps != null && limit != null && limit > 0n
    && (direction === 'at_or_below' ? observed * 10000n <= limit * BigInt(percentageThresholdBps)
      : observed * 10000n >= limit * BigInt(percentageThresholdBps));
  return Object.freeze({ reached: amountReached || percentageReached, amountReached, percentageReached,
    percentageBps: limit != null && limit > 0n ? Number((observed * 10000n) / limit) : null });
}

function availableUnits(balanceUnits, heldUnits) {
  const balance = BigInt(naturalUnits(balanceUnits, 'balanceUnits') || '0');
  const held = BigInt(naturalUnits(heldUnits, 'heldUnits') || '0');
  if (held > balance) invalid('heldUnits cannot exceed balanceUnits.');
  return (balance - held).toString();
}

function evaluateAlert({ policy, state, observedUnits, limitUnits, now }) {
  policy = normalizePolicy(policy);
  const currentState = state?.state || 'clear';
  const observed = naturalUnits(observedUnits, 'observedUnits') || '0';
  const limit = limitUnits == null ? null : naturalUnits(limitUnits, 'limitUnits');
  const crossed = compareThreshold({ observedUnits: observed, limitUnits: limit,
    amountThresholdUnits: policy.amountThresholdUnits, percentageThresholdBps: policy.percentageThresholdBps, direction: policy.direction });
  const at = new Date(now);
  if (!Number.isFinite(at.getTime())) invalid('now must be a valid timestamp.');
  if (!policy.enabled) return Object.freeze({ action: currentState === 'triggered' ? 'recover' : 'none', nextState: 'clear', observedUnits: observed, limitUnits: limit });
  if (currentState === 'triggered') {
    const amountBoundary = policy.recoveryAmountUnits ?? policy.amountThresholdUnits;
    const percentageBoundary = policy.recoveryPercentageBps ?? policy.percentageThresholdBps;
    const amountRecovery = policy.amountThresholdUnits == null || (policy.direction === 'at_or_below'
      ? BigInt(observed) > BigInt(amountBoundary) : BigInt(observed) < BigInt(amountBoundary));
    const percentRecovery = policy.percentageThresholdBps == null || limit == null || limit <= 0n
      || (policy.direction === 'at_or_below' ? observed * 10000n > limit * BigInt(percentageBoundary)
        : observed * 10000n < limit * BigInt(percentageBoundary));
    const recoveredByConfiguredThreshold = amountRecovery && percentRecovery;
    if (recoveredByConfiguredThreshold) return Object.freeze({ action: 'recover', nextState: 'clear', observedUnits: observed, limitUnits: limit });
    return Object.freeze({ action: 'none', nextState: 'triggered', observedUnits: observed, limitUnits: limit });
  }
  if (!crossed.reached) return Object.freeze({ action: 'none', nextState: 'clear', observedUnits: observed, limitUnits: limit });
  const nextEligible = state?.nextEligibleAt ? new Date(state.nextEligibleAt) : null;
  if (nextEligible && Number.isFinite(nextEligible.getTime()) && at < nextEligible) {
    return Object.freeze({ action: 'none', nextState: 'clear', observedUnits: observed, limitUnits: limit });
  }
  return Object.freeze({ action: 'trigger', nextState: 'triggered', observedUnits: observed, limitUnits: limit,
    thresholdReached: { amount: crossed.amountReached, percentage: crossed.percentageReached, percentageBps: crossed.percentageBps } });
}

function notificationKey({ orgId, scopeType, scopeOwnerId, eventKey, thresholdKey, crossingSequence }) {
  const raw = [orgId, scopeType, scopeOwnerId, eventKey, thresholdKey, crossingSequence].join('\0');
  return `billing-alert:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

module.exports = { SCOPES, normalizePolicy, compareThreshold, availableUnits, evaluateAlert, notificationKey };
