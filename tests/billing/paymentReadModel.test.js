'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listPaymentRequests, decodeCursor, encodeCursor, parseLimit } = require('../../src/billing/paymentReadModel');

const makeRow = (id, createdCursor, overrides = {}) => ({
  id, purpose: 'subscription', status: 'pending_verification',
  expected_amount_units: '9007199254740993', received_amount_units: null,
  asset: 'INR', scale: 2, submitted_at: new Date('2026-10-09T12:00:00Z'),
  reviewed_at: null, created_at: new Date('2026-10-09T12:00:00Z'),
  created_cursor: createdCursor, ...overrides,
});

test('payment history is scoped by authenticated organization and capped', async () => {
  const calls = [];
  const pool = { async query(sql, args) {
    calls.push({ sql, args });
    return { rows: [
      makeRow('payment-2', '2026-10-09 12:00:00.000002'),
      makeRow('payment-1', '2026-10-09 12:00:00.000001'),
    ] };
  } };
  const page = await listPaymentRequests('org_123', { limit: '1' }, { pool });
  assert.equal(calls[0].args[0], 'org_123');
  assert.equal(calls[0].args.at(-1), 2);
  assert.match(calls[0].sql, /WHERE org_id=\?/);
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0].expectedAmount.units, '9007199254740993');
  assert.deepEqual(decodeCursor(page.nextCursor), {
    v: 1, createdAt: '2026-10-09 12:00:00.000002', id: 'payment-2',
  });
});

test('subsequent page continues from the full microsecond timestamp', async () => {
  const cursor = encodeCursor(makeRow('payment-2', '2026-10-09 12:00:00.000002'));
  const pool = { async query(sql, args) {
    assert.match(sql, /created_at<\?/);
    assert.equal(args[0], 'org_123');
    assert.equal(args[1], '2026-10-09 12:00:00.000002');
    assert.equal(args[2], '2026-10-09 12:00:00.000002');
    assert.equal(args[3], 'payment-2');
    return { rows: [makeRow('payment-1', '2026-10-09 12:00:00.000001')] };
  } };
  const page = await listPaymentRequests('org_123', { cursor, limit: '1' }, { pool });
  assert.equal(page.rows[0].id, 'payment-1');
  assert.equal(page.nextCursor, null);
});

test('rejects invalid pagination parameters before querying the database', async () => {
  for (const limit of ['0', '-1', '1.5', '101', 'abc', '']) {
    assert.throws(() => parseLimit(limit), { statusCode: 400 });
  }
  for (const cursor of ['%', 'not-json', Buffer.from(JSON.stringify({ v: 1, createdAt: '2026-10-09T12:00:00.000Z', id: 'payment-2' })).toString('base64url')]) {
    assert.throws(() => decodeCursor(cursor), { statusCode: 400 });
  }
});

test('maps persisted clarification status to the frontend status contract', async () => {
  const pool = { async query() { return { rows: [makeRow('payment-1', '2026-10-09 12:00:00.000001', { status: 'needs_clarification' })] }; } };
  const page = await listPaymentRequests('org_123', {}, { pool });
  assert.equal(page.rows[0].status, 'needs_information');
  assert.equal(page.rows[0].receivedAmount, null);
});
