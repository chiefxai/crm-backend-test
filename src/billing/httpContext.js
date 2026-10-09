'use strict';

const crypto = require('node:crypto');
const { validateId } = require('./contracts/validation');
const { CONTRACT_VERSION } = require('./contracts/validation');

/** Trusted billing context: never accept actor, fingerprint or operation ID from JSON body. */
function buildBillingContext(req) {
  const orgId = validateId(req.orgId, 'orgId');
  const userId = validateId(req.userId, 'userId');
  const rawKey = req.get('Idempotency-Key');
  if (typeof rawKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(rawKey)) {
    const error = new TypeError('Idempotency-Key must be a valid identifier (maximum 128 characters).');
    error.statusCode = 400;
    throw error;
  }
  const requestFingerprint = 'sha256:' + crypto.createHash('sha256')
    .update(JSON.stringify({ orgId, userId, method: req.method, path: req.path, body: req.body }))
    .digest('hex');
  return Object.freeze({
    schemaVersion: CONTRACT_VERSION,
    operationId: rawKey,
    requestFingerprint,
    actor: Object.freeze({ type: 'user', id: userId, organizationId: orgId }),
  });
}

module.exports = { buildBillingContext };
