'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.MYSQL_HOST ||= '127.0.0.1';
process.env.MYSQL_USER ||= 'billing_test';
process.env.MYSQL_DATABASE ||= 'billing_test';
const { reconcileOrganizationBilling, CHECKS } = require('../../src/billing/reconciliationReadModel');
const { runBillingReconciliation } = require('../../src/billing/reconciliationRunner');

function fixture(results, failAt = null) {
  const calls = [];
  let index = 0;
  const pool = { async connect() {
    return {
      async query(sql, params) {
        calls.push({ sql, params });
        if (failAt === index) throw new Error('Injected storage failure');
        if (sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'
          || sql === 'START TRANSACTION READ ONLY' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [] };
        }
        return { rows: results[index++] ?? [] };
      },
      release() { calls.push({ sql: 'RELEASE' }); },
    };
  } };
  return { pool, calls };
}

test('only the intended bounded tenant is audited inside a read-only snapshot', async () => {
  const { pool, calls } = fixture([
    [{ org_id: 'org_1' }],
    [{ org_id: 'org_1', entity_id: 'period_1' }],
    [], [], [], [],
  ]);
  const result = await reconcileOrganizationBilling('org_1', { pool, limit: 2, checkedAt: '2026-10-09T00:00:00.000Z' });
  assert.equal(result.initialized, true);
  assert.equal(result.complete, true);
  assert.deepEqual(result.findings, [{
    code: 'ACTIVE_SUBSCRIPTION_UNFUNDED', severity: 'critical', entityId: 'period_1',
  }]);
  assert.equal(calls.filter(x => x.params).length, CHECKS.length + 1);
  for (const call of calls.filter(x => x.params)) assert.equal(call.params[0], 'org_1');
  assert.ok(calls.some(x => x.sql === 'START TRANSACTION READ ONLY'));
  assert.ok(calls.some(x => x.sql === 'COMMIT'));
  assert.equal(calls.at(-1).sql, 'RELEASE');
  assert.ok(calls.filter(x => x.params).every(x => /^(SELECT|\s*SELECT)/.test(x.sql)));
});

test('limit truncation is explicit, never silently considered a clean report', async () => {
  const { pool } = fixture([
    [{ org_id: 'org_1' }],
    [{ org_id: 'org_1', entity_id: 'p_1' }, { org_id: 'org_1', entity_id: 'p_2' }],
    [], [], [], [],
  ]);
  const result = await reconcileOrganizationBilling('org_1', { pool, limit: 1 });
  assert.equal(result.complete, false);
  assert.equal(result.findings.length, 1);
});

test('uninitialized account is not falsely classified as healthy', async () => {
  const { pool, calls } = fixture([[]]);
  const result = await reconcileOrganizationBilling('org_1', { pool });
  assert.equal(result.initialized, false);
  assert.equal(result.findings.length, 0);
  assert.equal(calls.filter(x => x.params).length, 1);
});

test('rollback and release preserve original storage error', async () => {
  const { pool, calls } = fixture([[{ org_id: 'org_1' }]], 1);
  await assert.rejects(() => reconcileOrganizationBilling('org_1', { pool }), /Injected storage failure/);
  assert.ok(calls.some(x => x.sql === 'ROLLBACK'));
  assert.equal(calls.at(-1).sql, 'RELEASE');
});

test('unexpected cross-org rows fail closed', async () => {
  const { pool } = fixture([[{ org_id: 'org_1' }], [{ org_id: 'org_2', entity_id: 'p_1' }]]);
  await assert.rejects(() => reconcileOrganizationBilling('org_1', { pool }), /unexpected organization/);
});

test('disabled reconciliation creates no read model and no database session', async () => {
  let called = false;
  const result = await runBillingReconciliation({
    env: {}, reconcile: async () => { called = true; throw Error('never'); },
  });
  assert.equal(result.skipped, true);
  assert.equal(called, false);
});

test('enabled reconciliation validates requested organization before invocation', async () => {
  const calls = [];
  const reconcile = async (orgId, options) => {
    calls.push({ orgId, options });
    return { orgId, findings: [] };
  };
  const env = { BILLING_RECONCILIATION_ENABLED: 'true' };
  await assert.rejects(() => runBillingReconciliation({ env, orgId: '../wrong', reconcile }));
  await assert.rejects(() => runBillingReconciliation({ env, orgId: 'org_1', limit: 101, reconcile }), TypeError);
  const result = await runBillingReconciliation({ env, orgId: 'org_1', limit: 5, reconcile });
  assert.equal(result.orgId, 'org_1');
  assert.deepEqual(calls, [{ orgId: 'org_1', options: { limit: 5 } }]);
});
