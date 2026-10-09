'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readCommand, requireBillingSubmitRole } = require('../../src/billing/paymentSubmissionRouter');
const { canSubmitPayment } = require('../../src/billing/paymentHttpComposition');

const original = { orgId: 'org_1', userId: 'user_1', authorization: { organizationRole: 'Billing Admin' } };
function request(command) { return { ...original, body: { command: JSON.stringify(command) } }; }

test('server assigns organization identity and contract version to payment command', () => {
  const command = readCommand(request({
    purpose: 'subscription', quoteId: 'quote_1', paymentReference: 'abc',
    expectedAmount: { asset: 'INR', units: '50000', scale: 2 },
  }));
  assert.equal(command.orgId, 'org_1');
  assert.equal(command.schemaVersion, 1);
});

test('untrusted organization, actor, context and storage keys are rejected', () => {
  for (const key of ['orgId', 'actor', 'context', 'receiptKey']) {
    assert.throws(() => readCommand(request({ [key]: 'unsafe' })), { statusCode: 400 });
  }
  assert.throws(() => readCommand({ ...original, body: { command: '{bad json' } }), { statusCode: 400 });
  assert.throws(() => readCommand({ ...original, body: { command: '[]' } }), { statusCode: 400 });
});

test('payment submission authorization requires matching tenant, actor and admin role', () => {
  const actor = { type: 'user', id: 'user_1', organizationId: 'org_1' };
  assert.equal(canSubmitPayment(original, actor, 'org_1'), true);
  assert.equal(canSubmitPayment(original, actor, 'org_2'), false);
  assert.equal(canSubmitPayment({ ...original, authorization: { organizationRole: 'Member' } }, actor, 'org_1'), false);
  assert.equal(canSubmitPayment(original, { ...actor, id: 'user_2' }, 'org_1'), false);
  assert.equal(canSubmitPayment(original, { ...actor, organizationId: 'org_2' }, 'org_1'), false);
});

test('billing submission route rejects non-admin organization roles', () => {
  let called = false;
  let status;
  requireBillingSubmitRole({ authorization: { organizationRole: 'Member' } }, {
    status(code) { status = code; return this; },
    json() {},
  }, () => { called = true; });
  assert.equal(status, 403);
  assert.equal(called, false);
});
