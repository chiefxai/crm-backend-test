'use strict';

const { createMysqlUnitOfWork } = require('../../src/billing/adapters/mysql/unitOfWork');
const { assertTransactionContext } = require('../../src/billing/kernel/transactionContext');
const { DOMAIN_ERROR_CODES } = require('../../src/billing/contracts/errors');

const orgId = 'org-1';
const operationId = 'request-1';
const requestFingerprint = `sha256:${'a'.repeat(64)}`;

function createHarness({ account = { org_id: orgId, status: 'active', hold_reason: null, version: 1 }, prior = null, onCallback, queryError } = {}) {
  const calls = [];
  let connectionNumber = 0;
  const operationCalls = [];
  const connection = {
    async query(sql, params = []) {
      calls.push({ type: 'query', sql: String(sql).trim(), params, connectionNumber });
      if (queryError) {
        const error = queryError({ sql: String(sql).trim(), params, connectionNumber });
        if (error) throw error;
      }
      if (/SELECT org_id, status, hold_reason, version/i.test(sql)) {
        return { rows: account ? [account] : [] };
      }
      return { rows: [], affectedRows: 1 };
    },
    async release() { calls.push({ type: 'release', connectionNumber }); },
  };
  const pool = {
    async connect() {
      connectionNumber += 1;
      calls.push({ type: 'connect', connectionNumber });
      return connection;
    },
  };
  const operationStore = {
    async findForUpdate(tx, args) {
      assertTransactionContext(tx);
      operationCalls.push({ method: 'findForUpdate', args });
      return prior;
    },
    async start(tx, args) {
      assertTransactionContext(tx);
      operationCalls.push({ method: 'start', args });
    },
    async complete(tx, args) {
      assertTransactionContext(tx);
      operationCalls.push({ method: 'complete', args });
    },
  };
  const uow = createMysqlUnitOfWork({
    pool,
    operationStore,
    idSource: { newId: () => 'operation-row-1' },
    clock: { now: () => '2026-10-08 12:00:00.000' },
    sleep: async () => {},
    random: () => 0,
  });
  return { calls, operationCalls, uow, onCallback };
}

describe('MySQL billing UnitOfWork', () => {
  test('locks an active organization before idempotency lookup, callback, completion and commit', async () => {
    const harness = createHarness();
    const callback = jest.fn(async (tx) => {
      assertTransactionContext(tx);
      expect(Object.keys(tx)).toEqual(['metadata', 'query']);
      expect(tx.metadata).toEqual({
        orgId, operationId, billingAccountVersion: 1, expectedVersions: { 'credit-account': 3 },
      });
      await tx.query('UPDATE billing_credit_positions SET version=version+1 WHERE org_id=?', [orgId]);
      return { accepted: true, amount: '1250000' };
    });

    await expect(harness.uow.runFinancial({
      orgId, operationId, requestFingerprint, expectedVersions: { 'credit-account': 3 }, callback,
    }))
      .resolves.toEqual({ accepted: true, amount: '1250000' });

    const sql = harness.calls.filter((call) => call.type === 'query').map((call) => call.sql);
    expect(sql[0]).toBe('START TRANSACTION');
    expect(sql[1]).toMatch(/FROM organization_billing_accounts[\s\S]+WHERE org_id = \?[\s\S]+FOR UPDATE/);
    expect(harness.operationCalls.map((call) => call.method)).toEqual(['findForUpdate', 'start', 'complete']);
    expect(harness.operationCalls[1].args).toMatchObject({
      id: 'operation-row-1', orgId, operationId, requestFingerprint,
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(sql.at(-1)).toBe('COMMIT');
    expect(harness.calls.at(-1).type).toBe('release');
  });

  test('returns the stored JSON result for a duplicate key without repeating its callback', async () => {
    const stored = { id: 'result-7', status: 'accepted' };
    const harness = createHarness({ prior: { requestFingerprint, status: 'completed', result: stored } });
    const callback = jest.fn();

    await expect(harness.uow.runFinancial({ orgId, operationId, requestFingerprint, callback })).resolves.toEqual(stored);
    expect(callback).not.toHaveBeenCalled();
    expect(harness.operationCalls.map((call) => call.method)).toEqual(['findForUpdate']);
    expect(harness.calls.filter((call) => call.type === 'query').at(-1).sql).toBe('COMMIT');
    expect(harness.calls.at(-1).type).toBe('release');
  });

  test('rejects a reused idempotency key with a different fingerprint and rolls back', async () => {
    const harness = createHarness({ prior: { requestFingerprint: `sha256:${'b'.repeat(64)}`, status: 'completed', result: {} } });
    const callback = jest.fn();

    await expect(harness.uow.runFinancial({ orgId, operationId, requestFingerprint, callback }))
      .rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT });
    expect(callback).not.toHaveBeenCalled();
    expect(harness.calls.filter((call) => call.type === 'query').at(-1).sql).toBe('ROLLBACK');
    expect(harness.calls.at(-1).type).toBe('release');
  });

  test.each([
    ['missing', null, DOMAIN_ERROR_CODES.NOT_FOUND],
    ['held', { org_id: orgId, status: 'active', hold_reason: 'review', version: 2 }, DOMAIN_ERROR_CODES.CONFLICT],
    ['inactive', { org_id: orgId, status: 'suspended', hold_reason: null, version: 2 }, DOMAIN_ERROR_CODES.CONFLICT],
  ])('rejects a %s billing account before operation lookup', async (_label, account, code) => {
    const harness = createHarness({ account });

    await expect(harness.uow.runFinancial({ orgId, operationId, requestFingerprint, callback: async () => ({ ok: true }) }))
      .rejects.toMatchObject({ code });
    expect(harness.operationCalls).toHaveLength(0);
    expect(harness.calls.filter((call) => call.type === 'query').at(-1).sql).toBe('ROLLBACK');
    expect(harness.calls.at(-1).type).toBe('release');
  });

  test('rolls back and releases when a financial callback fails', async () => {
    const harness = createHarness();
    const failure = new Error('journal write failed');

    await expect(harness.uow.runFinancial({
      orgId, operationId, requestFingerprint,
      callback: async () => { throw failure; },
    })).rejects.toBe(failure);
    expect(harness.operationCalls.map((call) => call.method)).toEqual(['findForUpdate', 'start']);
    expect(harness.calls.filter((call) => call.type === 'query').at(-1).sql).toBe('ROLLBACK');
    expect(harness.calls.at(-1).type).toBe('release');
  });

  test('retries a deadlocked transaction with a fresh attempt and bounded retry count', async () => {
    let failuresRemaining = 1;
    const harness = createHarness({ queryError: ({ sql }) => {
      if (/UPDATE billing_credit_positions/.test(sql) && failuresRemaining-- > 0) {
        return Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 });
      }
      return null;
    } });
    const callback = jest.fn(async (tx) => {
      await tx.query('UPDATE billing_credit_positions SET version=version+1 WHERE org_id=?', [orgId]);
      return { ok: true };
    });

    await expect(harness.uow.runFinancial({ orgId, operationId, requestFingerprint, callback })).resolves.toEqual({ ok: true });
    expect(callback).toHaveBeenCalledTimes(2);
    expect(harness.calls.filter((call) => call.type === 'connect')).toHaveLength(2);
    expect(harness.calls.filter((call) => call.type === 'query' && call.sql === 'ROLLBACK')).toHaveLength(1);
    expect(harness.calls.filter((call) => call.type === 'query' && call.sql === 'COMMIT')).toHaveLength(1);
    expect(harness.calls.filter((call) => call.type === 'release')).toHaveLength(2);
  });

  test('rejects malformed fingerprints before acquiring a connection', async () => {
    const harness = createHarness();
    await expect(harness.uow.runFinancial({ orgId, operationId, requestFingerprint: 'bad', callback: async () => ({}) }))
      .rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.INVALID_CONTRACT });
    expect(harness.calls).toHaveLength(0);
  });
});
