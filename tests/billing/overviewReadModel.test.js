'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readBillingOverview, aggregateBalances } = require('../../src/billing/overviewReadModel');

function fixture(results) {
  const history = [];
  let index = 0;
  const connection = {
    async query(sql, params) {
      history.push({ sql, params });
      if (/START TRANSACTION|COMMIT|ROLLBACK/.test(sql)) return { rows: [] };
      return { rows: results[index++] || [] };
    },
    release() { history.push({ sql: 'RELEASE' }); },
  };
  return { pool: { async connect() { return connection; } }, history };
}

test('aggregates credit units precisely without floating point arithmetic', () => {
  const large = '9007199254740993';
  const balances = aggregateBalances([
    { grant_kind: 'topup', asset: 'CREDIT', scale: 0, expires_at: null, balance_units: large, reserved_units: '2' },
    { grant_kind: 'topup', asset: 'CREDIT', scale: 0, expires_at: null, balance_units: '7', reserved_units: '1' },
  ]);
  assert.equal(balances[0].available.units, '9007199254740997');
  assert.equal(balances[0].held.units, '3');
});

test('returns a typed, tenant-scoped billing overview', async () => {
  const { pool, history } = fixture([
    [{ org_id: 'org_123', fallback_mode: 'prepaid' }],
    [{ id: 'period-1', starts_at: '2026-10-01 00:00:00', ends_at: '2026-11-01 00:00:00', status: 'active', terms_version: 1 }],
    [{ id: 'payment-1', purpose: 'subscription', status: 'approved', expected_amount_units: '1000',
      received_amount_units: '1000', asset: 'INR', scale: 2, submitted_at: '2026-10-01 00:00:00',
      reviewed_at: '2026-10-01 10:00:00' }],
    [{ id: 'invoice-1', status: 'open', total_units: '700', paid_units: '0', asset: 'INR',
      scale: 2, issued_at: '2026-10-01 00:00:00', due_at: '2026-11-01 00:00:00' }],
    [{ grant_kind: 'subscription', asset: 'CREDIT', scale: 0, expires_at: null,
      balance_units: '30', reserved_units: '5' }],
    [{ terms_snapshot_json: '{"plan":"standard"}' }],
  ]);
  const result = await readBillingOverview('org_123', {
    pool, orgReader: async () => ({ billingMethod: 'recharge_based' }), now: new Date('2026-10-09T00:00:00Z'),
  });
  assert.equal(result.orgId, 'org_123');
  assert.equal(result.billingMethod, 'recharge_based');
  assert.equal(result.activePeriod.id, 'period-1');
  assert.equal(result.balances[0].available.units, '25');
  assert.equal(result.balances[0].held.units, '5');
  assert.equal(result.outstandingInvoices[0].total.units, '700');
  assert.equal(result.recentPayments[0].receivedAmount.units, '1000');
  assert.deepEqual(result.subscriptionTerms, { plan: 'standard' });
  assert.ok(history.some(q => q.sql === 'COMMIT'));
  for (const entry of history.filter(q => q.params)) assert.equal(entry.params[0], 'org_123');
});

test('uninitialized organization does not inherit legacy INR balance', async () => {
  const { pool, history } = fixture([[]]);
  const result = await readBillingOverview('org_123', {
    pool, orgReader: async () => ({ billingMethod: 'recharge_based' }),
  });
  assert.deepEqual(result, { uninitialized: true });
  assert.ok(history.some(q => q.sql === 'COMMIT'));
  assert.ok(!history.some(q => /billing_credit_positions/.test(q.sql)));
});

test('connection rolls back and releases on read errors', async () => {
  const { pool, history } = fixture([[{ org_id: 'org_123', fallback_mode: 'prepaid' }]]);
  await assert.rejects(() => readBillingOverview('org_123', {
    pool, orgReader: async () => ({ billingMethod: 'pay_as_you_go' }), now: 'not-a-timestamp',
  }));
  assert.ok(history.some(q => q.sql === 'ROLLBACK'));
  assert.equal(history.at(-1).sql, 'RELEASE');
});


test('maps persisted clarification status to the frontend payment contract', async () => {
  const { pool } = fixture([
    [{ org_id: 'org_123', fallback_mode: 'prepaid' }],
    [],
    [{ id: 'payment_1', purpose: 'topup', status: 'needs_clarification',
      expected_amount_units: '100', received_amount_units: null, asset: 'INR', scale: 2,
      submitted_at: '2026-10-09 00:00:00', reviewed_at: null }],
    [], [], [],
  ]);
  const overview = await readBillingOverview('org_123', {
    pool, orgReader: async () => ({ billingMethod: 'recharge_based' }),
  });
  assert.equal(overview.recentPayments[0].status, 'needs_information');
});

test('snapshot queries are awaited one at a time on the same connection', async () => {
  let inFlight = false;
  let overlapped = false;
  const calls = [];
  const connection = {
    async query(sql) {
      if (inFlight) overlapped = true;
      inFlight = true;
      await Promise.resolve();
      calls.push(sql);
      inFlight = false;
      return { rows: sql.includes('FROM organization_billing_accounts')
        ? [{ org_id: 'org_123', fallback_mode: 'prepaid' }] : [] };
    },
    release() {},
  };
  await readBillingOverview('org_123', {
    pool: { async connect() { return connection; } },
    orgReader: async () => ({ billingMethod: 'recharge_based' }),
  });
  assert.equal(overlapped, false);
  assert.equal(calls.filter(sql => /^SELECT/.test(sql)).length, 6);
  assert.equal(calls.at(-1), 'COMMIT');
});

test('new account fallback mode wins over a contradictory legacy organization billing method', async () => {
  const { pool } = fixture([
    [{ org_id: 'org_123', fallback_mode: 'postpaid' }],
    [], [], [], [], [],
  ]);
  const overview = await readBillingOverview('org_123', {
    pool, orgReader: async () => ({ billingMethod: 'recharge_based' }),
  });
  assert.equal(overview.billingMethod, 'pay_as_you_go');
});

test('unknown new billing account mode fails closed rather than inventing pay-as-you-go', async () => {
  const { pool, history } = fixture([[{ org_id: 'org_123', fallback_mode: 'invalid' }], [], [], [], [], []]);
  await assert.rejects(
    () => readBillingOverview('org_123', { pool, orgReader: async () => ({ billingMethod: 'pay_as_you_go' }) }),
    /Unrecognized billing account fallback mode/,
  );
  assert.ok(history.some(item => item.sql === 'ROLLBACK'));
});
