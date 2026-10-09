'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decisionCommand, requireDecisionEnabled } = require('../../src/billing/platformPaymentDecisionRouter');
const { authorizedPlatformDecision } = require('../../src/billing/platformPaymentDecisionComposition');

function request(body = {}) {
  return { params: { orgId: 'org_123', paymentRequestId: 'payment_123' }, body };
}

test('operator decision command uses path scope, never client-controlled org or actor', () => {
  const command = decisionCommand(request({
    decision: 'approve', expectedVersion: 1, receivedAmount: { asset: 'INR', units: '1000', scale: 2 },
  }));
  assert.equal(command.orgId, 'org_123');
  assert.equal(command.paymentRequestId, 'payment_123');
  assert.equal(command.schemaVersion, 1);
});

test('operator decision rejects user-supplied identity and payment target', () => {
  for (const field of ['orgId', 'paymentRequestId', 'actor', 'context', 'receiptKey']) {
    assert.throws(() => decisionCommand(request({ [field]: 'spoof' })), { statusCode: 400 });
  }
  assert.throws(() => decisionCommand(request([])), { statusCode: 400 });
  assert.throws(() => decisionCommand({ ...request(), params: { orgId: '../other', paymentRequestId: 'payment_123' } }));
});

test('decision API flag defaults to disabled and returns 503', () => {
  const previous = process.env.BILLING_PAYMENT_DECISION_ENABLED;
  delete process.env.BILLING_PAYMENT_DECISION_ENABLED;
  try {
    let code;
    let nextCalled = false;
    requireDecisionEnabled({}, {
      status(value) { code = value; return this; },
      json(value) { assert.equal(value.code, 'BILLING_PAYMENT_DECISION_DISABLED'); },
    }, () => { nextCalled = true; });
    assert.equal(code, 503);
    assert.equal(nextCalled, false);
  } finally {
    if (previous === undefined) delete process.env.BILLING_PAYMENT_DECISION_ENABLED;
    else process.env.BILLING_PAYMENT_DECISION_ENABLED = previous;
  }
});

test('decision route remains inside the authenticated platform-admin router', () => {
  const platform = fs.readFileSync(path.join(__dirname, '../../src/routes/platform.js'), 'utf8');
  const billing = fs.readFileSync(path.join(__dirname, '../../src/billing/platformPaymentDecisionRouter.js'), 'utf8');
  assert.match(platform, /router\.use\(requireAuthIdentityOnly, requirePlatformAdmin\)/);
  assert.match(platform, /router\.use\(require\(['"]\.\.\/billing\/platformPaymentDecisionRouter['"]\)\.router\)/);
  assert.match(billing, /requireDecisionEnabled/);
});

test('decision service refuses actor and organization mismatches', () => {
  const req = { userId: 'operator_123', userEmail: 'not-a-platform-admin@example.invalid', authClaims: {} };
  const actor = { type: 'user', id: 'operator_123', organizationId: 'org_123' };
  assert.equal(authorizedPlatformDecision(req, actor, 'org_123'), false);
  assert.equal(authorizedPlatformDecision(req, { ...actor, id: 'other_user' }, 'org_123'), false);
  assert.equal(authorizedPlatformDecision(req, { ...actor, organizationId: 'other_org' }, 'org_123'), false);
});
