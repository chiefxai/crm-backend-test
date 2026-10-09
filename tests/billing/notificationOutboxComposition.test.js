'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.MYSQL_HOST ||= '127.0.0.1';
process.env.MYSQL_DATABASE ||= 'billing_test';
process.env.MYSQL_USER ||= 'billing_test';

const { validateAllowedEventTypes, createMysqlOutboxStore } =
  require('../../src/billing/adapters/mysql/outboxStore');
const {
  HANDLED_EMAIL_EVENTS, restrictedOutbox, runBillingNotificationOutboxOnce,
} = require('../../src/billing/notificationOutboxComposition');

test('outbox event allowlists reject empty, duplicate and malformed values', () => {
  for (const types of [[], ['PaymentConfirmed.v1', 'PaymentConfirmed.v1'], ['bad type'], ['a'.repeat(129)]]) {
    assert.throws(() => validateAllowedEventTypes(types), TypeError);
  }
  assert.deepEqual(validateAllowedEventTypes(['PaymentConfirmed.v1']), ['PaymentConfirmed.v1']);
  assert.equal(validateAllowedEventTypes(undefined), null);
});

test('scoped worker forwards event allowlist to discovery and claim operations', async () => {
  const calls = [];
  const store = restrictedOutbox({
    async listReadyOrganizations(args) { calls.push(['list', args]); return []; },
    async claimBatch(args) { calls.push(['claim', args]); return []; },
    async ack(value) { calls.push(['ack', value]); },
    async fail(value, reason) { calls.push(['fail', value, reason]); },
  }, HANDLED_EMAIL_EVENTS);
  await store.listReadyOrganizations({ limit: 2 });
  await store.claimBatch({ limit: 1, orgId: 'org_1' });
  assert.deepEqual(calls[0][1].allowedEventTypes, HANDLED_EMAIL_EVENTS);
  assert.deepEqual(calls[1][1].allowedEventTypes, HANDLED_EMAIL_EVENTS);
  assert.ok(!HANDLED_EMAIL_EVENTS.includes('CreditGrantAllocationRequested.v1'));
  assert.ok(!HANDLED_EMAIL_EVENTS.includes('SubscriptionPeriodActivated.v1'));
});

test('database discover and claim queries filter by event type before leasing', async () => {
  const queries = [];
  const pool = { async connect() {
    return {
      async query(sql, args = []) {
        queries.push({ sql, args });
        return { rows: [] };
      },
      release() {},
    };
  } };
  const store = createMysqlOutboxStore({
    pool,
    clock: { now: () => '2026-10-09T00:00:00.000Z' },
    tokenSource: { newId: () => 'lease_1' },
  });
  await store.listReadyOrganizations({ limit: 5, allowedEventTypes: ['PaymentConfirmed.v1'] });
  await store.claimBatch({ orgId: 'org_1', workerId: 'worker_1', allowedEventTypes: ['PaymentConfirmed.v1'] });
  const selects = queries.filter(entry => entry.sql.includes('FROM billing_outbox') && entry.sql.includes('SELECT'));
  assert.equal(selects.length, 2);
  for (const select of selects) {
    assert.match(select.sql, /event_type IN \(\?\)/);
    assert.ok(select.args.includes('PaymentConfirmed.v1'));
  }
  assert.ok(queries.some(entry => entry.sql === 'COMMIT'));
});

test('worker is disabled by default without instantiating dependencies', async () => {
  let constructed = false;
  const result = await runBillingNotificationOutboxOnce({
    env: {}, workerFactory: () => { constructed = true; throw Error('must not run'); },
  });
  assert.equal(result.skipped, true);
  assert.equal(constructed, false);
});

test('worker requires key and dispatches one limited tick when enabled', async () => {
  const enabled = { BILLING_NOTIFICATION_OUTBOX_ENABLED: 'true', BILLING_EMAIL_PAYLOAD_KEY: 'x'.repeat(32) };
  await assert.rejects(() => runBillingNotificationOutboxOnce({
    env: { BILLING_NOTIFICATION_OUTBOX_ENABLED: 'true' },
    workerFactory: () => { throw Error('should not be created'); },
  }), { code: 'BILLING_EMAIL_CONFIG_MISSING' });
  const seen = [];
  const result = await runBillingNotificationOutboxOnce({
    env: enabled,
    limit: 3,
    workerFactory: args => ({ runOnce: async () => { seen.push(args.batchSize); return { claimed: 1, completed: 1 }; } }),
  });
  assert.equal(result.completed, 1);
  assert.deepEqual(seen, [3]);
});
