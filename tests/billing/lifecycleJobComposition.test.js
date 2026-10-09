'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// The pool factory requires config at import, but no connection is established
// by these tests: all business services are replaced by injected doubles.
process.env.MYSQL_HOST ||= '127.0.0.1';
process.env.MYSQL_DATABASE ||= 'billing_test';
process.env.MYSQL_USER ||= 'billing_test';
const {
  runBillingLifecycleOnce, validateRunOptions, lifecycleFlag,
} = require('../../src/billing/lifecycleJobComposition');

test('subscription activation and reminders both fail closed by default', async () => {
  let constructed = 0;
  const jobsFactory = () => { constructed++; throw new Error('Jobs should not be constructed'); };
  for (const mode of ['activate', 'renewal-reminders']) {
    const result = await runBillingLifecycleOnce({ mode }, { env: {}, jobsFactory });
    assert.equal(result.skipped, true);
    assert.equal(result.scanned, 0);
  }
  assert.equal(constructed, 0);
});

test('activation tick stays bounded and delegates only to activation service', async () => {
  const calls = [];
  const jobsFactory = () => ({
    activateDuePeriods: async input => { calls.push(['activate', input]); return { scanned: 1, results: [] }; },
    queueDueRenewalEvents: async input => { calls.push(['renewals', input]); throw Error('wrong mode'); },
  });
  const response = await runBillingLifecycleOnce({
    mode: 'activate', limit: 2, now: '2026-10-09T12:00:00.000Z',
  }, { env: { BILLING_SUBSCRIPTION_ACTIVATION_ENABLED: 'true' }, jobsFactory });
  assert.equal(response.scanned, 1);
  assert.deepEqual(calls, [['activate', { now: '2026-10-09T12:00:00.000Z', limit: 2 }]]);
});

test('reminder tick requires a different flag and uses selected lead time', async () => {
  const calls = [];
  const jobsFactory = () => ({
    activateDuePeriods: async () => { throw Error('wrong mode'); },
    queueDueRenewalEvents: async input => { calls.push(input); return { scanned: 0, results: [] }; },
  });
  await runBillingLifecycleOnce({
    mode: 'renewal-reminders', limit: 5, leadTimeSeconds: 172800,
    now: '2026-10-09T12:00:00.000Z',
  }, { env: { BILLING_RENEWAL_REMINDERS_ENABLED: 'true' }, jobsFactory });
  assert.deepEqual(calls, [{ now: '2026-10-09T12:00:00.000Z', limit: 5, leadTimeSeconds: 172800 }]);
});

test('invalid modes, batch sizes and timestamps are rejected', async () => {
  for (const input of [
    { mode: 'all' }, { mode: 'activate', limit: 0 }, { mode: 'activate', limit: 501 },
    { mode: 'renewal-reminders', leadTimeSeconds: 0 }, { mode: 'activate', now: 'invalid' },
  ]) {
    assert.throws(() => validateRunOptions(input), TypeError);
  }
  assert.equal(lifecycleFlag('activate'), 'BILLING_SUBSCRIPTION_ACTIVATION_ENABLED');
  assert.equal(lifecycleFlag('renewal-reminders'), 'BILLING_RENEWAL_REMINDERS_ENABLED');
});
