'use strict';

const repository = require('../../src/billing/adapters/mysql/commandOperationRepository');
const { createTransactionContext } = require('../../src/billing/kernel/transactionContext');
const { DOMAIN_ERROR_CODES } = require('../../src/billing/contracts/errors');

const digest = 'a'.repeat(64);
const fingerprint = `sha256:${digest}`;

function makeTx(handler) {
  return createTransactionContext({ query: handler });
}

describe('MySQL command operation repository', () => {
  test('findForUpdate maps an absent row to null and locks by organization and operation key', async () => {
    const calls = [];
    const tx = makeTx(async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    });

    await expect(repository.findForUpdate(tx, { orgId: 'org-1', operationId: 'cmd-1' })).resolves.toBeNull();
    expect(calls[0].sql).toMatch(/WHERE org_id=\? AND idempotency_key=\?\s+FOR UPDATE/);
    expect(calls[0].params).toEqual(['org-1', 'cmd-1']);
  });

  test('maps an existing row and restores the sha256 prefix while decoding JSON result', async () => {
    const tx = makeTx(async () => ({ rows: [{
      id: 'row-1', org_id: 'org-1', idempotency_key: 'cmd-1', request_fingerprint: digest,
      status: 'completed', result_json: '{"ok":true,"count":2}', version: '2',
      created_at: 'created', updated_at: 'updated', completed_at: 'completed',
    }] }));

    await expect(repository.findForUpdate(tx, { orgId: 'org-1', operationId: 'cmd-1' })).resolves.toEqual({
      id: 'row-1', orgId: 'org-1', operationId: 'cmd-1', requestFingerprint: fingerprint,
      status: 'completed', result: { ok: true, count: 2 }, version: 2,
      createdAt: 'created', updatedAt: 'updated', completedAt: 'completed',
    });
  });

  test('start stores only the fingerprint digest and inserts processing state', async () => {
    let call;
    const tx = makeTx(async (sql, params) => {
      call = { sql, params };
      return { rows: [], affectedRows: 1 };
    });
    const started = await repository.start(tx, {
      id: 'row-1', orgId: 'org-1', operationId: 'cmd-1', requestFingerprint: fingerprint, now: '2026-10-08 00:00:00',
    });

    expect(call.sql).toMatch(/INSERT INTO billing_command_operations/);
    expect(call.params).toEqual(['row-1', 'org-1', 'billing.command', 'cmd-1', digest, '2026-10-08 00:00:00', '2026-10-08 00:00:00']);
    expect(started).toMatchObject({ requestFingerprint: fingerprint, status: 'processing', result: null, version: 1 });
  });

  test('start maps duplicate key conflicts to a typed idempotency error', async () => {
    const tx = makeTx(async () => { throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' }); });
    await expect(repository.start(tx, {
      id: 'row-1', orgId: 'org-1', operationId: 'cmd-1', requestFingerprint: fingerprint, now: new Date(),
    })).rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT });
  });

  test('complete JSON encodes the result and only updates a processing row', async () => {
    let call;
    const tx = makeTx(async (sql, params) => {
      call = { sql, params };
      return { rows: [], affectedRows: 1 };
    });
    const result = await repository.complete(tx, {
      orgId: 'org-1', operationId: 'cmd-1', result: { accepted: true }, now: '2026-10-08 00:00:00',
    });

    expect(call.sql).toMatch(/status='completed'/);
    expect(call.sql).toMatch(/WHERE org_id=\? AND idempotency_key=\? AND status='processing'/);
    expect(JSON.parse(call.params[0])).toEqual({ accepted: true });
    expect(call.params.slice(1)).toEqual(['2026-10-08 00:00:00', '2026-10-08 00:00:00', 'org-1', 'cmd-1']);
    expect(result).toMatchObject({ status: 'completed', result: { accepted: true } });
  });

  test('complete rejects an unserializable result and detects a failed guarded update', async () => {
    const tx = makeTx(async () => ({ rows: [], affectedRows: 0 }));
    const circular = {};
    circular.self = circular;
    await expect(repository.complete(tx, { orgId: 'org-1', operationId: 'cmd-1', result: circular, now: new Date() }))
      .rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.INVALID_CONTRACT });
    await expect(repository.complete(tx, { orgId: 'org-1', operationId: 'cmd-1', result: {}, now: new Date() }))
      .rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.VERSION_CONFLICT });
  });

  test('rejects corrupt stored JSON and unbranded transaction objects', async () => {
    const badRowTx = makeTx(async () => ({ rows: [{
      id: 'row-1', org_id: 'org-1', idempotency_key: 'cmd-1', request_fingerprint: digest,
      status: 'completed', result_json: '{bad', version: 2,
    }] }));
    await expect(repository.findForUpdate(badRowTx, { orgId: 'org-1', operationId: 'cmd-1' }))
      .rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.INVALID_CONTRACT });
    await expect(repository.findForUpdate({ query: async () => ({ rows: [] }) }, { orgId: 'org-1', operationId: 'cmd-1' }))
      .rejects.toThrow(/transaction context created by UnitOfWork/);
  });

  test('uses typed billing errors for malformed fingerprints', async () => {
    const tx = makeTx(async () => ({ rows: [] }));
    await expect(repository.start(tx, {
      id: 'row-1', orgId: 'org-1', operationId: 'cmd-1', requestFingerprint: `sha256:${'A'.repeat(64)}`, now: new Date(),
    })).rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.INVALID_CONTRACT });
  });
});
