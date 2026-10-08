'use strict';

const { createMysqlOutboxStore } = require('../../src/billing/adapters/mysql/outboxStore');
const { createTransactionContext } = require('../../src/billing/kernel/transactionContext');
const { DOMAIN_ERROR_CODES } = require('../../src/billing/contracts/errors');

const NOW = new Date('2026-10-08T09:00:00.000Z');
const event = (overrides = {}) => ({
  eventId: 'event-1', eventType: 'CreditsAllocated.v1', schemaVersion: 1,
  operationId: 'operation-1', orgId: 'org-1', aggregateType: 'CreditAccount', aggregateId: 'account-1',
  aggregateVersion: 2, occurredAt: '2026-10-08T08:59:00.000Z', correlationId: 'correlation-1',
  payload: { amount: { asset: 'credits', units: '100', scale: 0 } }, ...overrides,
});

function storeFor(query) {
  const connections = [];
  const pool = { connect: async () => {
    const connection = { query: jest.fn(query), release: jest.fn() };
    connections.push(connection);
    return connection;
  } };
  let id = 0;
  const store = createMysqlOutboxStore({
    pool,
    clock: { now: () => new Date(NOW) },
    tokenSource: { newId: () => `lease-${++id}` },
    random: () => 0,
  });
  return { store, connections };
}

function tx(query, orgId = 'org-1') {
  return createTransactionContext({ query }, { orgId, operationId: 'operation-1' });
}

describe('MySQL durable outbox store', () => {
  test('enqueues the validated event in the caller transaction with a stable event key and bounded partition', async () => {
    let call;
    const { store } = storeFor();
    const transaction = tx(async (sql, params) => { call = { sql, params }; return { affectedRows: 1, rows: [] }; });

    await expect(store.enqueue(transaction, { events: [event()] })).resolves.toEqual([
      { eventId: 'event-1', orgId: 'org-1', status: 'pending', duplicate: false },
    ]);
    expect(call.sql).toMatch(/INSERT INTO billing_outbox/);
    expect(call.sql).toMatch(/'pending'/);
    expect(call.params.slice(0, 4)).toEqual(['event-1', 'org-1', 'event-1', 'CreditsAllocated.v1']);
    expect(call.params[8]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(call.params[11])).toEqual(event());
    expect(call.params[12]).toEqual(NOW);
  });

  test('rejects events outside the transaction organization and oversized batches', async () => {
    const { store } = storeFor();
    await expect(store.enqueue(tx(async () => ({ rows: [] })), { events: [event({ orgId: 'org-2' })] }))
      .rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.INVALID_CONTRACT });
    await expect(store.enqueue(tx(async () => ({ rows: [] })), { events: Array(501).fill(event()) }))
      .rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.INVALID_CONTRACT });
  });

  test('treats an identical duplicate as idempotent and conflicts on changed contents', async () => {
    const { store } = storeFor(async (sql) => {
      if (/^INSERT INTO billing_outbox/.test(sql)) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
      return { rows: [{
        id: 'event-1', org_id: 'org-1', event_key: 'event-1', event_type: 'CreditsAllocated.v1', schema_version: 1,
        aggregate_type: 'CreditAccount', aggregate_id: 'account-1', aggregate_version: 2,
        correlation_id: 'correlation-1', causation_id: null,
        payload_json: JSON.stringify(event()), created_at: new Date(NOW),
      }] };
    });
    const duplicateTx = createTransactionContext({ query: async (sql) => {
      if (/^INSERT INTO billing_outbox/.test(sql)) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
      return { rows: [{
        id: 'event-1', org_id: 'org-1', event_key: 'event-1', event_type: 'CreditsAllocated.v1', schema_version: 1,
        aggregate_type: 'CreditAccount', aggregate_id: 'account-1', aggregate_version: 2,
        correlation_id: 'correlation-1', causation_id: null,
        payload_json: JSON.stringify(event()), created_at: new Date(NOW),
      }] };
    } }, { orgId: 'org-1' });
    await expect(store.enqueue(duplicateTx, { events: [event()] })).resolves.toMatchObject([{ duplicate: true, eventId: 'event-1' }]);
    await expect(store.enqueue(duplicateTx, { events: [event({ payload: { changed: true } })] }))
      .rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT });
  });

  test('claims bounded ready rows under a transaction and increments attempts and fencing token', async () => {
    const calls = [];
    const { store, connections } = storeFor(async (sql, params) => {
      calls.push({ sql, params });
      if (/^SELECT id,org_id,event_type/.test(sql)) return { rows: [{
        id: 'event-1', org_id: 'org-1', event_type: 'CreditsAllocated.v1', schema_version: 1,
        aggregate_type: 'CreditAccount', aggregate_id: 'account-1', aggregate_version: 2, partition_key: 'p'.repeat(64),
        correlation_id: 'correlation-1', causation_id: null, payload_json: JSON.stringify(event()),
        status: 'pending', attempts: 0, lease_token: null, fencing_token: 4, lease_expires_at: null,
        created_at: new Date(event().occurredAt),
      }] };
      if (/^UPDATE billing_outbox/.test(sql)) return { affectedRows: 1, rows: [] };
      return { affectedRows: 0, rows: [] };
    });
    const claimed = await store.claimBatch({ orgId: 'org-1', workerId: 'worker-1', limit: 1, leaseMs: 3000 });

    expect(connections[0].query).toHaveBeenCalledWith('START TRANSACTION');
    expect(connections[0].query.mock.calls[1][0]).toMatch(/LIMIT \? FOR UPDATE SKIP LOCKED/);
    expect(connections[0].query.mock.calls[1][1]).toEqual([NOW, NOW, 'org-1', 1]);
    expect(calls[2].params).toEqual(['worker-1', 'lease-1', '5', new Date(NOW.getTime() + 3000), NOW, 'org-1', 'event-1', 4]);
    expect(claimed[0]).toMatchObject({ eventId: 'event-1', attempts: 1, leaseOwner: 'worker-1', leaseToken: 'lease-1', fencingToken: '5' });
    expect(connections[0].query).toHaveBeenCalledWith('COMMIT');
  });

  test('rotates eligible organization listing and supports org scoped leases', async () => {
    const calls = [];
    const { store } = storeFor(async (sql, params) => { calls.push({ sql, params }); return { rows: [{ org_id: 'org-2' }] }; });
    await expect(store.listReadyOrganizations({ limit: 5, afterOrgId: 'org-1' })).resolves.toEqual(['org-2']);
    expect(calls[0].sql).toMatch(/org_id>\?/);
    expect(calls[0].params).toEqual([NOW, NOW, 'org-1', 5]);
  });

  test('acks only the matching lease and fencing token', async () => {
    let call;
    const { store } = storeFor(async (sql, params) => { call = { sql, params }; return { affectedRows: 1, rows: [] }; });
    await expect(store.ack({ eventId: 'event-1', workerId: 'worker-1', leaseToken: 'lease-1', fencingToken: 5 }))
      .resolves.toEqual({ eventId: 'event-1', status: 'completed' });
    expect(call.sql).toMatch(/lease_owner=\? AND lease_token=\? AND fencing_token=\?/);
    expect(call.params.slice(2)).toEqual(['event-1', 'worker-1', 'lease-1', '5', NOW]);
  });

  test('retries with bounded exponential jitter, then dead-letters at the configured attempt limit', async () => {
    let attempt = 1;
    const calls = [];
    const { store } = storeFor(async (sql, params) => {
      calls.push({ sql, params });
      if (/^SELECT attempts/.test(sql)) return { rows: [{ attempts: attempt }] };
      return { affectedRows: 1, rows: [] };
    });
    const claim = { eventId: 'event-1', workerId: 'worker-1', leaseToken: 'lease-1', fencingToken: 5 };
    await expect(store.fail(claim, { errorCode: 'EMAIL_TIMEOUT', maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 5000 }))
      .resolves.toMatchObject({ status: 'pending', attempts: 1, availableAt: new Date(NOW.getTime() + 500) });
    expect(calls[2].params[0]).toBe('pending');
    expect(calls[2].params[2]).toBe('EMAIL_TIMEOUT');
    attempt = 2;
    await expect(store.fail(claim, { errorCode: 'EMAIL_TIMEOUT', maxAttempts: 2 }))
      .resolves.toMatchObject({ status: 'dead_letter', attempts: 2, availableAt: null });
    expect(calls[6].params[0]).toBe('dead_letter');
  });

  test('rejects stale lease acknowledgement and rolls back failure state if ownership changed', async () => {
    const { store, connections } = storeFor(async (sql) => {
      if (/^SELECT attempts/.test(sql)) return { rows: [] };
      return { affectedRows: 0, rows: [] };
    });
    await expect(store.ack({ eventId: 'event-1', workerId: 'worker-1', leaseToken: 'old', fencingToken: 3 }))
      .rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.VERSION_CONFLICT });
    await expect(store.fail({ eventId: 'event-1', workerId: 'worker-1', leaseToken: 'old', fencingToken: 3 }))
      .rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.VERSION_CONFLICT });
    expect(connections[1].query).toHaveBeenCalledWith('ROLLBACK');
  });
});
