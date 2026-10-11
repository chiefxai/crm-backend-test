'use strict';

const { CONTRACT_VERSION, objectAt, id, text, enumValue, positiveInt, timestamp } = require('./validation');

// These are deliberately separate dimensions: payment workflow state does not
// imply that a subscription period is active or that operational access exists.
const SUBSCRIPTION_PERIOD_STATES = Object.freeze(['awaiting_payment', 'scheduled', 'active', 'expired', 'cancelled']);
const SUBSCRIPTION_PAYMENT_STATES = Object.freeze(['submitted', 'needs_information', 'approved', 'rejected', 'scheduled', 'fulfilled']);
const SUBSCRIPTION_ACCESS_STATES = Object.freeze(['operational', 'billing_recovery', 'billing_suspended', 'manual_suspended', 'security_suspended']);
const SUBSCRIPTION_GRACE_STATES = Object.freeze(['requested', 'approved', 'denied', 'revoked', 'expired']);
const SUBSCRIPTION_COMMANDS = Object.freeze([
  'CreateInitialPurchaseQuote', 'CreateRenewalQuote', 'CreateUpgradeQuote',
  'SubmitGraceRequest', 'DecideGraceRequest', 'RevokeGrace',
]);
const SUBSCRIPTION_EVENTS = Object.freeze([
  'SubscriptionPurchaseQuoted.v1', 'SubscriptionPaymentSubmitted.v1',
  'SubscriptionPaymentApproved.v1', 'SubscriptionPeriodScheduled.v1',
  'SubscriptionPeriodActivated.v1', 'SubscriptionRenewalDue.v1',
  'SubscriptionAccessRestricted.v1', 'SubscriptionAccessRestored.v1',
  'SubscriptionGraceRequested.v1', 'SubscriptionGraceApproved.v1',
  'SubscriptionGraceDenied.v1', 'SubscriptionGraceRevoked.v1',
  'SubscriptionPlanChangeScheduled.v1', 'SubscriptionPlanChanged.v1',
]);

function commandBase(value, fields, required, trustedContext) {
  objectAt(value, 'command', ['schemaVersion', ...fields], ['schemaVersion', ...required]);
  if (value.schemaVersion !== CONTRACT_VERSION) throw new TypeError(`schemaVersion must be ${CONTRACT_VERSION}.`);
  if (!trustedContext) throw new TypeError('authenticated operation context must be supplied by the server, separately from the command payload.');
  return { schemaVersion: CONTRACT_VERSION, context: require('./validation').operationContext(trustedContext) };
}

function orgPeriodBase(value, fields, required, trustedContext) {
  const base = commandBase(value, ['orgId', 'periodId', ...fields], ['orgId', ...required], trustedContext);
  return { ...base, orgId: id(value.orgId, 'orgId'), ...(value.periodId === undefined ? {} : { periodId: id(value.periodId, 'periodId') }) };
}

function validateInitialPurchaseQuoteCommand(value, trustedContext) {
  const base = commandBase(value, ['orgId', 'planId', 'planVersion'], ['orgId', 'planId', 'planVersion'], trustedContext);
  return Object.freeze({ ...base, orgId: id(value.orgId, 'orgId'), planId: id(value.planId, 'planId'), planVersion: positiveInt(value.planVersion, 'planVersion') });
}

function validateRenewalQuoteCommand(value, trustedContext) {
  const base = orgPeriodBase(value, [], ['periodId'], trustedContext);
  return Object.freeze({ ...base, periodId: id(value.periodId, 'periodId') });
}

function validateUpgradeQuoteCommand(value, trustedContext) {
  const base = orgPeriodBase(value, ['targetPlanId', 'targetPlanVersion', 'effectiveAt'], ['periodId', 'targetPlanId', 'targetPlanVersion', 'effectiveAt'], trustedContext);
  return Object.freeze({ ...base, periodId: id(value.periodId, 'periodId'), targetPlanId: id(value.targetPlanId, 'targetPlanId'),
    targetPlanVersion: positiveInt(value.targetPlanVersion, 'targetPlanVersion'),
    effectiveAt: enumValue(value.effectiveAt, ['immediate', 'renewal'], 'effectiveAt') });
}

function validateGraceRequestCommand(value, trustedContext) {
  const base = orgPeriodBase(value, ['requestedUntil', 'reason', 'expectedVersion'], ['periodId', 'requestedUntil', 'reason', 'expectedVersion'], trustedContext);
  return Object.freeze({ ...base, periodId: id(value.periodId, 'periodId'), requestedUntil: timestamp(value.requestedUntil, 'requestedUntil'),
    reason: text(value.reason, 'reason', { max: 2000 }), expectedVersion: positiveInt(value.expectedVersion, 'expectedVersion', { min: 0 }) });
}

function validateGraceDecisionCommand(value, trustedContext) {
  const base = commandBase(value, ['orgId', 'graceRequestId', 'decision', 'reason', 'expectedVersion'],
    ['orgId', 'graceRequestId', 'decision', 'reason', 'expectedVersion'], trustedContext);
  return Object.freeze({ ...base, orgId: id(value.orgId, 'orgId'), graceRequestId: id(value.graceRequestId, 'graceRequestId'),
    decision: enumValue(value.decision, ['approve', 'deny'], 'decision'), reason: text(value.reason, 'reason', { max: 2000 }),
    expectedVersion: positiveInt(value.expectedVersion, 'expectedVersion', { min: 0 }) });
}

function validateGraceRevocationCommand(value, trustedContext) {
  const base = commandBase(value, ['orgId', 'graceRequestId', 'reason', 'expectedVersion'],
    ['orgId', 'graceRequestId', 'reason', 'expectedVersion'], trustedContext);
  return Object.freeze({ ...base, orgId: id(value.orgId, 'orgId'), graceRequestId: id(value.graceRequestId, 'graceRequestId'),
    reason: text(value.reason, 'reason', { max: 2000 }), expectedVersion: positiveInt(value.expectedVersion, 'expectedVersion', { min: 0 }) });
}

module.exports = Object.freeze({
  SUBSCRIPTION_PERIOD_STATES, SUBSCRIPTION_PAYMENT_STATES, SUBSCRIPTION_ACCESS_STATES,
  SUBSCRIPTION_GRACE_STATES, SUBSCRIPTION_COMMANDS, SUBSCRIPTION_EVENTS,
  validateInitialPurchaseQuoteCommand, validateRenewalQuoteCommand, validateUpgradeQuoteCommand,
  validateGraceRequestCommand, validateGraceDecisionCommand, validateGraceRevocationCommand,
});
