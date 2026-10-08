'use strict';

const { createMysqlConsumerRunner } = require('../../src/billing/adapters/mysql/consumerRunner');
const { assertTransactionContext } = require('../../src/billing/kernel/transactionContext');

function fakePool(failFirstQuery) {
  const connections = [];
  return {
    connections,
    async connect() {
      const connection = {
        calls: [],
        released: false,
        async query(sql, params) {
          this.calls.push({ sql, params });
          if (failFirstQuery) return failFirstQuery(this.calls.length, sql);
          return { rows: [], affectedRows: 1 };
        },
        release() { this.released = true; },
      };
      connections.push(connection);
      return connection;
    },
  };
}

describe('MySQL consumer runner', () => {
  test('commits branded transaction callbacks without requiring an active billing account', async () => {
    const pool = fakePool();
    const runner = createMysqlConsumerRunner({ pool });
    const result = await runner.runConsumer({
      orgId: 'org-1', operationId: 'event-1', requestFingerprint: `sha256:${'a'.repeat(64)}`,
      callback: async (tx) => {
        assertTransactionContext(tx);
        expect(tx.metadata).toEqual({ orgId: 'org-1', operationId: 'event-1', requestFingerprint: `sha256:${'a'.repeat(64)}` });
        await tx.query('INSERT INTO billing_consumer_inbox (org_id) VALUES (?)', ['org-1']);
        return { processed: true };
      },
    });

    expect(result).toEqual({ processed: true });
    expect(pool.connections[0].calls.map(({ sql }) => sql)).toEqual([
      'START TRANSACTION',
      'INSERT INTO billing_consumer_inbox (org_id) VALUES (?)',
      'COMMIT',
    ]);
    expect(pool.connections[0].released).toBe(true);
  });

  test('rolls back callback failures and retries a deadlock in a fresh transaction', async () => {
    let callbackAttempts = 0;
    const pool = fakePool((callNumber) => {
      if (pool.connections.length === 1 && callNumber === 2) throw Object.assign(new Error('deadlock'), { errno: 1213 });
      return { rows: [], affectedRows: 1 };
    });
    const runner = createMysqlConsumerRunner({ pool, sleep: async () => {}, random: () => 0 });
    await expect(runner.runConsumer({
      orgId: 'org-1', operationId: 'event-2', requestFingerprint: `sha256:${'b'.repeat(64)}`,
      callback: async (tx) => {
        assertTransactionContext(tx);
        callbackAttempts += 1;
        await tx.query('UPDATE consumer_state SET value=1');
        return { ok: true };
      },
    })).resolves.toEqual({ ok: true });

    expect(callbackAttempts).toBe(2);
    expect(pool.connections[0].calls.map(({ sql }) => sql)).toEqual(['START TRANSACTION', 'UPDATE consumer_state SET value=1', 'ROLLBACK']);
    expect(pool.connections[1].calls.map(({ sql }) => sql)).toEqual(['START TRANSACTION', 'UPDATE consumer_state SET value=1', 'COMMIT']);
    expect(pool.connections.every((connection) => connection.released)).toBe(true);
  });

  test('rejects missing callbacks and malformed fingerprints', async () => {
    const runner = createMysqlConsumerRunner({ pool: fakePool() });
    await expect(runner.runConsumer({ orgId: 'org-1', operationId: 'event-3', requestFingerprint: 'bad', callback: async () => ({}) })).rejects.toThrow(/requestFingerprint/);
    await expect(runner.runConsumer({ orgId: 'org-1', operationId: 'event-3', requestFingerprint: `sha256:${'c'.repeat(64)}` })).rejects.toThrow(/callback/);
  });
});
