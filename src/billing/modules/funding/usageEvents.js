'use strict';

// Canonical immutable usage-event contract shared by provider adapters and the
// funding planner. Provider measurements and legacy INR estimates are not
// credits. Only an explicit, versioned credit rating can produce payable usage.
const crypto = require('node:crypto');
const { validateAmount } = require('../../kernel/amount');
const { validateId, validateScope } = require('../../kernel/scope');

const EVENT_SCHEMA_VERSION = 1;
const EVENT_STATUSES = Object.freeze(['payable', 'estimated', 'excluded']);

function invalid(message, code = 'INVALID_USAGE_EVENT') {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid(`${field} must be a valid timestamp.`);
  return new Date(value).toISOString();
}

function jsonSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('pricingSnapshot must be an object.');
  let encoded;
  try { encoded = JSON.stringify(value); } catch (_) { invalid('pricingSnapshot must be JSON serializable.'); }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 256 * 1024) invalid('pricingSnapshot must be JSON serializable and at most 256 KiB.');
  return deepFreeze(JSON.parse(encoded));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function deterministicUsageEventId({ orgId, sourceType, sourceId, componentKey, revision }) {
  const digest = crypto.createHash('sha256')
    .update([orgId, sourceType, sourceId, componentKey, revision].join('\0'))
    .digest('hex');
  return `usage-${digest}`;
}

function normalizeUsageEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('usage event must be an object.');
  const scope = validateScope(input.scope);
  const operationId = validateId(input.operationId, 'operationId');
  const sourceType = validateId(input.sourceType, 'sourceType');
  const sourceId = validateId(input.sourceId, 'sourceId');
  const componentKey = validateId(input.componentKey, 'componentKey');
  if (!Number.isSafeInteger(input.revision) || input.revision < 1 || input.revision > 4294967295) invalid('revision must be a positive 32-bit integer.');
  if (!EVENT_STATUSES.includes(input.status)) invalid(`status must be one of ${EVENT_STATUSES.join(', ')}.`);
  if (!input.quantity || typeof input.quantity !== 'object' || Array.isArray(input.quantity)) invalid('quantity must contain units and scale.');
  if (typeof input.quantity.units !== 'string' || !/^(0|[1-9]\d*)$/.test(input.quantity.units)
    || BigInt(input.quantity.units) > 9223372036854775807n) invalid('quantity.units must be a non-negative signed 64-bit integer string.');
  if (!Number.isInteger(input.quantity.scale) || input.quantity.scale < 0 || input.quantity.scale > 18) invalid('quantity.scale must be an integer from 0 to 18.');
  let amount;
  try { amount = validateAmount(input.amount); } catch (error) { invalid(`amount is invalid: ${error.message}`); }
  if (BigInt(amount.units) < 0n) invalid('amount must not be negative.');

  const pricingSnapshot = jsonSnapshot(input.pricingSnapshot);
  if (pricingSnapshot.schemaVersion !== EVENT_SCHEMA_VERSION) invalid(`pricingSnapshot.schemaVersion must be ${EVENT_SCHEMA_VERSION}.`);
  if (pricingSnapshot.operationId !== operationId) invalid('pricingSnapshot.operationId must match operationId.');
  if (input.status === 'payable') {
    if (BigInt(amount.units) <= 0n) invalid('payable usage requires a positive rated amount.');
    if (pricingSnapshot.kind !== 'credit_rate' || pricingSnapshot.estimated !== false) {
      invalid('payable usage requires an explicit, non-estimated credit_rate snapshot.');
    }
    validateId(pricingSnapshot.rateVersion, 'pricingSnapshot.rateVersion');
  } else if (BigInt(amount.units) !== 0n) {
    invalid('estimated and excluded usage must store zero payable amount; preserve reporting cost in pricingSnapshot.');
  }
  const workspaceId = scope.ownerType === 'workspace' ? scope.ownerId : validateId(input.workspaceId, 'workspaceId');
  if (input.workspaceId !== undefined && input.workspaceId !== workspaceId) invalid('workspaceId must match the workspace scope.');
  const result = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: deterministicUsageEventId({ orgId: scope.orgId, sourceType, sourceId, componentKey, revision: input.revision }),
    orgId: scope.orgId,
    workspaceId,
    operationId,
    periodId: input.periodId == null ? null : validateId(input.periodId, 'periodId'),
    sourceType,
    sourceId,
    componentKey,
    revision: input.revision,
    status: input.status,
    quantity: Object.freeze({ units: input.quantity.units, scale: input.quantity.scale }),
    amount,
    pricingSnapshot,
    occurredAt: timestamp(input.occurredAt, 'occurredAt'),
    recordedAt: timestamp(input.recordedAt, 'recordedAt'),
  };
  return Object.freeze(result);
}

function sameUsageEvent(left, right) {
  const leftContent = Object.fromEntries(Object.entries(left).filter(([key]) => key !== 'recordedAt'));
  const rightContent = Object.fromEntries(Object.entries(right).filter(([key]) => key !== 'recordedAt'));
  return canonical(leftContent) === canonical(rightContent);
}

module.exports = {
  EVENT_SCHEMA_VERSION,
  EVENT_STATUSES,
  normalizeUsageEvent,
  deterministicUsageEventId,
  sameUsageEvent,
};
