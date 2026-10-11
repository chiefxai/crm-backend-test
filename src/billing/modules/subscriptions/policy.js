'use strict';

// Conservative rollout defaults. Keep these values injectable per deployment;
// an environment must explicitly opt into lifecycle enforcement.
const DEFAULT_SUBSCRIPTION_POLICY = Object.freeze({
  schemaVersion: 1,
  currency: 'INR',
  billingTimeZone: 'UTC',
  renewalNoticeDays: 7,
  postExpiryGraceDays: 7,
  suspensionDeadline: 'period_end_plus_post_expiry_grace',
  initialUnpaidAccess: 'billing_recovery',
  paymentReviewHoldDays: 0,
  grace: Object.freeze({ maxDaysPerPeriod: 7, maxCumulativeDays: 7, maxRequestsPerPeriod: 1, pendingExtendsAccess: false, revokeAllowed: true }),
  renewal: Object.freeze({ earlyStartsAt: 'current_period_end', lateStartsAt: 'payment_approval_time', latePaymentRestoresAccess: true }),
  upgrade: Object.freeze({ defaultEffectiveAt: 'immediate', proration: 'remaining_milliseconds_half_up', includedCredits: 'incremental_remaining_fraction_half_up' }),
  downgrade: Object.freeze({ effectiveAt: 'next_renewal', resolveInventoryConflictsBeforeApproval: true }),
});

function resolveSubscriptionPolicy(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new TypeError('subscription policy overrides must be an object.');
  const policy = {
    ...DEFAULT_SUBSCRIPTION_POLICY,
    ...overrides,
    grace: { ...DEFAULT_SUBSCRIPTION_POLICY.grace, ...(overrides.grace || {}) },
    renewal: { ...DEFAULT_SUBSCRIPTION_POLICY.renewal, ...(overrides.renewal || {}) },
    upgrade: { ...DEFAULT_SUBSCRIPTION_POLICY.upgrade, ...(overrides.upgrade || {}) },
    downgrade: { ...DEFAULT_SUBSCRIPTION_POLICY.downgrade, ...(overrides.downgrade || {}) },
  };
  for (const field of ['renewalNoticeDays', 'postExpiryGraceDays', 'paymentReviewHoldDays']) {
    if (!Number.isSafeInteger(policy[field]) || policy[field] < 0) throw new TypeError(`${field} must be a non-negative integer.`);
  }
  for (const field of ['maxDaysPerPeriod', 'maxCumulativeDays', 'maxRequestsPerPeriod']) {
    if (!Number.isSafeInteger(policy.grace[field]) || policy.grace[field] < 0) throw new TypeError(`grace.${field} must be a non-negative integer.`);
  }
  if (!/^[A-Z]{3}$/.test(policy.currency)) throw new TypeError('currency must be an uppercase three-letter currency code.');
  try { new Intl.DateTimeFormat('en', { timeZone: policy.billingTimeZone }); } catch { throw new TypeError('billingTimeZone must be a supported IANA timezone.'); }
  return Object.freeze({ ...policy, grace: Object.freeze(policy.grace), renewal: Object.freeze(policy.renewal),
    upgrade: Object.freeze(policy.upgrade), downgrade: Object.freeze(policy.downgrade) });
}

function createSubscriptionClock(now = () => new Date()) {
  if (typeof now !== 'function') throw new TypeError('now must be a function returning a Date or timestamp.');
  return Object.freeze({ now: () => {
    const value = now();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError('clock returned an invalid timestamp.');
    return date;
  } });
}

module.exports = { DEFAULT_SUBSCRIPTION_POLICY, resolveSubscriptionPolicy, createSubscriptionClock };
