'use strict';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OWNER_TYPES = new Set(['organization', 'workspace']);

class ScopeValidationError extends TypeError {
  constructor(message, code = 'INVALID_BILLING_SCOPE') {
    super(message);
    this.name = 'ScopeValidationError';
    this.code = code;
  }
}

function invalid(message, code) {
  throw new ScopeValidationError(message, code);
}

function validateId(id, field) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    invalid(`${field} must be a non-empty identifier containing only letters, numbers, dot, underscore, colon, or hyphen.`, 'INVALID_BILLING_ID');
  }
  return id;
}

function validateScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    invalid('scope must be an object.');
  }
  const keys = Object.keys(scope).sort();
  if (keys.length !== 3 || keys[0] !== 'orgId' || keys[1] !== 'ownerId' || keys[2] !== 'ownerType') {
    invalid('scope must contain exactly orgId, ownerType, and ownerId.');
  }
  const orgId = validateId(scope.orgId, 'orgId');
  const ownerId = validateId(scope.ownerId, 'ownerId');
  if (!OWNER_TYPES.has(scope.ownerType)) {
    invalid("ownerType must be 'organization' or 'workspace'.", 'INVALID_BILLING_OWNER_TYPE');
  }
  if (scope.ownerType === 'organization' && ownerId !== orgId) {
    invalid('organization scope ownerId must equal orgId.', 'INVALID_BILLING_OWNERSHIP');
  }
  return Object.freeze({ orgId, ownerType: scope.ownerType, ownerId });
}

function organizationScope(orgId) {
  const id = validateId(orgId, 'orgId');
  return validateScope({ orgId: id, ownerType: 'organization', ownerId: id });
}

function workspaceScope(orgId, workspaceId) {
  return validateScope({ orgId, ownerType: 'workspace', ownerId: workspaceId });
}

module.exports = {
  ScopeValidationError,
  OWNER_TYPES: Object.freeze(Array.from(OWNER_TYPES)),
  validateId,
  validateScope,
  organizationScope,
  workspaceScope
};
