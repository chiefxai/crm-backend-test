'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBillingContext } = require('../../src/billing/httpContext');
const { CONTRACT_VERSION } = require('../../src/billing/contracts/validation');

function request(overrides = {}) {
  return {
    orgId: 'org_123',
    userId: 'user_123',
    method: 'POST',
    path: '/api/billing/payments',
    body: { purpose: 'topup' },
    get: (header) => header === 'Idempotency-Key' ? 'payment-attempt-1' : undefined,
    ...overrides,
  };
}

test('billing context derives actor and fingerprint from trusted request fields', () => {
  const ctx = buildBillingContext(request({ body: { actor: { id: 'attacker' } } }));
  assert.equal(ctx.schemaVersion, CONTRACT_VERSION);
  assert.equal(ctx.actor.id, 'user_123');
  assert.equal(ctx.actor.organizationId, 'org_123');
  assert.match(ctx.requestFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(ctx.operationId, 'payment-attempt-1');
});

test('billing context rejects absent or malformed idempotency keys', () => {
  for (const key of [undefined, '', 'bad key']) {
    assert.throws(() => buildBillingContext(request({ get: () => key })), { statusCode: 400 });
  }
});

test('billing context fingerprint changes when request body changes', () => {
  const first = buildBillingContext(request());
  const second = buildBillingContext(request({ body: { purpose: 'subscription' } }));
  assert.notEqual(first.requestFingerprint, second.requestFingerprint);
});
