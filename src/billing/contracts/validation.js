'use strict';

const { validateAmount } = require('../kernel/amount');
const { validateId, validateScope } = require('../kernel/scope');
const { DOMAIN_ERROR_CODES } = require('./errors');

const CONTRACT_VERSION = 1;
const ACTOR_TYPES = Object.freeze(['user', 'system']);
const OWNER_TYPES = Object.freeze(['organization', 'workspace']);
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

class ContractValidationError extends TypeError {
  constructor(path, reason, cause) {
    super(`${path || 'value'} ${reason}`);
    this.name = 'ContractValidationError';
    this.code = DOMAIN_ERROR_CODES.INVALID_CONTRACT;
    this.path = path || '';
    if (cause) this.cause = cause;
  }
}

function fail(path, reason, cause) {
  throw new ContractValidationError(path, reason, cause);
}

function objectAt(value, path, allowedKeys, requiredKeys = allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object.');
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(path ? `${path}.${key}` : key, 'is not allowed.');
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(path ? `${path}.${key}` : key, 'is required.');
  }
  return value;
}

function id(value, path) {
  try { return validateId(value, path); } catch (error) { fail(path, 'must be a valid billing identifier.', error); }
}

function text(value, path, { max = 255, min = 1, trim = true } = {}) {
  if (typeof value !== 'string') fail(path, 'must be a string.');
  const result = trim ? value.trim() : value;
  if (result.length < min || result.length > max) fail(path, `must contain ${min} to ${max} characters.`);
  return result;
}

function enumValue(value, values, path) {
  if (!values.includes(value)) fail(path, `must be one of ${values.join(', ')}.`);
  return value;
}

function positiveInt(value, path, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(path, `must be an integer from ${min} to ${max}.`);
  return value;
}

function timestamp(value, path) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(path, 'must be an ISO-8601 timestamp with an explicit timezone.');
  }
  return value;
}

function amount(value, path, { nonNegative = true } = {}) {
  try {
    const parsed = validateAmount(value);
    if (nonNegative && BigInt(parsed.units) < 0n) fail(path, 'must not be negative.');
    return parsed;
  } catch (error) {
    if (error instanceof ContractValidationError) throw error;
    fail(path, 'must be a valid {asset, units, scale} amount.', error);
  }
}

function scope(value, path = 'scope') {
  try { return validateScope(value); } catch (error) { fail(path, 'must be a valid organization or workspace scope.', error); }
}

/**
 * This actor is composed from trusted server authentication. HTTP body parsing
 * must never call this with a client-provided actor/role. Authorization itself
 * remains in the application boundary; there is intentionally no platformAdmin
 * field in this contract.
 */
function authenticatedActor(value, path = 'actor') {
  objectAt(value, path, ['type', 'id', 'organizationId', 'workspaceId'], ['type', 'id']);
  const type = enumValue(value.type, ACTOR_TYPES, `${path}.type`);
  const result = { type, id: id(value.id, `${path}.id`) };
  if (value.organizationId !== undefined) result.organizationId = id(value.organizationId, `${path}.organizationId`);
  if (value.workspaceId !== undefined) result.workspaceId = id(value.workspaceId, `${path}.workspaceId`);
  if (type === 'system' && (result.organizationId || result.workspaceId)) fail(path, 'system actor must not carry user tenant scope.');
  if (result.workspaceId && !result.organizationId) fail(`${path}.organizationId`, 'is required when workspaceId is set.');
  return Object.freeze(result);
}

function expectedVersions(value, path = 'expectedVersions') {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be a map of entity IDs to versions.');
  const entries = Object.entries(value);
  if (entries.length > 32) fail(path, 'must contain at most 32 entity versions.');
  const result = {};
  for (const [entityId, version] of entries) {
    result[id(entityId, `${path}.${entityId}`)] = positiveInt(version, `${path}.${entityId}`, { min: 0 });
  }
  return Object.freeze(result);
}

function operationContext(value, path = 'context') {
  objectAt(value, path,
    ['schemaVersion', 'operationId', 'requestFingerprint', 'correlationId', 'causationId', 'expectedVersions', 'actor'],
    ['schemaVersion', 'operationId', 'requestFingerprint', 'actor']);
  const schemaVersion = positiveInt(value.schemaVersion, `${path}.schemaVersion`);
  if (schemaVersion !== CONTRACT_VERSION) fail(`${path}.schemaVersion`, `must be ${CONTRACT_VERSION} for this contract.`);
  const requestFingerprint = text(value.requestFingerprint, `${path}.requestFingerprint`, { max: 71, min: 71 });
  if (!FINGERPRINT_PATTERN.test(requestFingerprint)) fail(`${path}.requestFingerprint`, 'must be sha256 followed by 64 lowercase hexadecimal characters.');
  const result = {
    schemaVersion,
    operationId: id(value.operationId, `${path}.operationId`),
    requestFingerprint,
    actor: authenticatedActor(value.actor, `${path}.actor`),
  };
  if (value.correlationId !== undefined) result.correlationId = id(value.correlationId, `${path}.correlationId`);
  if (value.causationId !== undefined) result.causationId = id(value.causationId, `${path}.causationId`);
  const versions = expectedVersions(value.expectedVersions, `${path}.expectedVersions`);
  if (versions !== undefined) result.expectedVersions = versions;
  return Object.freeze(result);
}

function assertOrgScopeMatches(scopeValue, orgId, path = 'scope') {
  if (scopeValue.orgId !== orgId) fail(path, 'orgId must match the command organization.');
}

function assertSameOrgScopes(fromScope, toScope) {
  if (fromScope.orgId !== toScope.orgId) fail('toScope.orgId', 'must match fromScope.orgId.');
}

module.exports = {
  CONTRACT_VERSION,
  ACTOR_TYPES,
  OWNER_TYPES,
  FINGERPRINT_PATTERN,
  ContractValidationError,
  objectAt,
  id,
  text,
  enumValue,
  positiveInt,
  timestamp,
  amount,
  scope,
  authenticatedActor,
  expectedVersions,
  operationContext,
  assertOrgScopeMatches,
  assertSameOrgScopes,
};
