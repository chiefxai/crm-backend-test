'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// No MySQL connection is used; the factory is injected for isolation.
process.env.MYSQL_HOST ||= '127.0.0.1';
process.env.MYSQL_DATABASE ||= 'billing_test';
process.env.MYSQL_USER ||= 'billing_test';
const { checkEmailDeliveryConfig, runBillingEmailDeliveryOnce } =
  require('../../src/billing/emailDeliveryComposition');

const env = {
  BILLING_EMAIL_DELIVERY_ENABLED: 'true',
  SMTP_HOST: 'localhost', SMTP_USER: 'test', SMTP_PASS: 'test',
  SMTP_FROM: 'billing@example.test',
  BILLING_EMAIL_PAYLOAD_KEY: 'a'.repeat(32),
};

test('email worker does not instantiate services when disabled', async () => {
  let constructed = false;
  const result = await runBillingEmailDeliveryOnce({
    env: {}, workerFactory: () => { constructed = true; throw Error('should not run'); },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.processed, 0);
  assert.equal(constructed, false);
});

test('email delivery fails closed if SMTP or payload encryption key is absent', async () => {
  assert.throws(() => checkEmailDeliveryConfig({ ...env, SMTP_HOST: '' }), {
    code: 'BILLING_EMAIL_CONFIG_MISSING',
  });
  assert.throws(() => checkEmailDeliveryConfig({ ...env, BILLING_EMAIL_PAYLOAD_KEY: 'short' }), {
    code: 'BILLING_EMAIL_CONFIG_MISSING',
  });
  let constructed = false;
  await assert.rejects(() => runBillingEmailDeliveryOnce({
    env: { ...env, SMTP_USER: '' },
    workerFactory: () => { constructed = true; throw Error('should not run'); },
  }), { code: 'BILLING_EMAIL_CONFIG_MISSING' });
  assert.equal(constructed, false);
});

test('enabled delivery invokes exactly one bounded worker tick', async () => {
  const observed = [];
  const result = await runBillingEmailDeliveryOnce({
    env, limit: 2, workerFactory: ({ batchSize }) => ({
      runOnce: async ({ limit }) => {
        observed.push([batchSize, limit]);
        return { processed: 1, outcomes: [{ status: 'submitted', resultStatus: 'submitted' }] };
      },
    }),
  });
  assert.equal(result.processed, 1);
  assert.deepEqual(observed, [[2, 2]]);
});

test('invalid batch size rejected before touching delivery store', async () => {
  let invoked = false;
  await assert.rejects(() => runBillingEmailDeliveryOnce({
    env, limit: 101, workerFactory: () => { invoked = true; },
  }), TypeError);
  assert.equal(invoked, false);
});
