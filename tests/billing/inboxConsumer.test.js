'use strict';

const inbox = require('../../src/billing/adapters/mysql/inboxConsumer');
const { createTransactionContext } = require('../../src/billing/kernel/transactionContext');
const { DOMAIN_ERROR_CODES } = require('../../src/billing/contracts/errors');

function txFor(handler) {
  const calls = [];
  const tx = createTransactionContext({
    async query(sql, params) {
      calls.push({ sql, params });
      return handler(sql, params, calls.length);
    },
  }, { orgId: 'org-1' });
  return { tx, calls };
}

const args = {
  id: 'inbox-1', orgId: 'org-1', consumerKey: 'billing.period.activate',
  eventId: 'evt-1', eventType: 'period.activate', now: '2026-10-08 00:00:00',
};

describe('billing MySQL inbox consumer', () => {
  test('runs callback and marks processed using the caller transaction', async () => {
    const { tx, calls } = txFor(async (sql) => {
      if (/^SELECT/.test(sql)) return { rows: [] };
      return { rows: [], affectedRows: 1 };
    });
    const sideEffect = jest.fn(async (boundTx) => {
      expect(boundTx).toBe(tx);
      await boundTx.query('UPDATE billing_periods SET status=?', ['active']);
      return { periodId: 'period-1' };
    });

    await expect(inbox.process(tx, args, sideEffect)).resolves.toEqual({
      processed: true, duplicate: false, resultReference: null, result: { periodId: 'period-1' },
    });
    expect(sideEffect).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.sql)).toEqual(expect.arrayContaining([
      expect.stringMatching(/INSERT INTO billing_consumer_inbox/),
      expect.stringMatching(/UPDATE billing_periods/),
      expect.stringMatching(/SET status='processed'/),
    ]));
  });

  test('skips side effects when event is already processed', async () => {
    const { tx, calls } = txFor(async () => ({ rows: [{
      id: 'inbox-1', org_id: 'org-1', consumer_key: args.consumerKey,
      event_id: args.eventId, status: 'processed', result_reference: 'period-1',
    }] }));
    const handler = jest.fn();

    await expect(inbox.process(tx, args, handler)).resolves.toEqual({
      processed: false, duplicate: true, resultReference: 'period-1',
    });
    expect(handler).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  test('retries a persisted received event and increments attempt count before callback', async () => {
    const { tx, calls } = txFor(async (sql) => {
      if (/^SELECT/.test(sql)) return { rows: [{ status: 'received' }] };
      return { rows: [], affectedRows: 1 };
    });
    const handler = jest.fn(async () => 'done');

    await expect(inbox.process(tx, args, handler)).resolves.toMatchObject({ processed: true, duplicate: false, result: 'done' });
    expect(calls.find((call) => /attempt_count=attempt_count\+1/.test(call.sql))).toBeDefined();
    expect(calls.find((call) => /SET status='processed'/.test(call.sql))).toBeDefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('handles concurrent insert winner by locking and recognizing its completed row', async () => {
    let selects = 0;
    const { tx, calls } = txFor(async (sql) => {
      if (/^SELECT/.test(sql)) {
        selects += 1;
        return selects === 1 ? { rows: [] } : { rows: [{ status: 'processed', result_reference: null }] };
      }
      if (/^INSERT/.test(sql)) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
      return { rows: [], affectedRows: 1 };
    });
    const handler = jest.fn();

    await expect(inbox.process(tx, args, handler)).resolves.toMatchObject({ processed: false, duplicate: true });
    expect(calls.filter((call) => /^SELECT/.test(call.sql))).toHaveLength(2);
    expect(handler).not.toHaveBeenCalled();
  });

  test('does not mark processed if consumer callback fails; transaction owner receives error to roll back', async () => {
    const failure = new Error('side effect failed');
    const { tx, calls } = txFor(async (sql) => {
      if (/^SELECT/.test(sql)) return { rows: [] };
      return { rows: [], affectedRows: 1 };
    });

    await expect(inbox.process(tx, args, async () => { throw failure; })).rejects.toBe(failure);
    expect(calls.some((call) => /SET status='processed'/.test(call.sql))).toBe(false);
  });

  test('rejects invalid consumer key and unbranded transaction contexts', async () => {
    const { tx } = txFor(async () => ({ rows: [] }));
    await expect(inbox.process(tx, { ...args, consumerKey: 'x'.repeat(129) }, async () => {}))
      .rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.INVALID_CONTRACT });
    await expect(inbox.process({ query: async () => ({ rows: [] }) }, args, async () => {}))
      .rejects.toThrow(/transaction context created by UnitOfWork/);
  });
});
