'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listPlatformPaymentReviews, parseCursor, parsePage } = require('../../src/billing/platformPaymentReviewReadModel');

function record(id, stamp) {
  return {
    id, org_id: 'org_1', purpose: 'subscription', status: 'pending_verification',
    version: 2, expected_amount_units: '9007199254740993', received_amount_units: null,
    asset: 'INR', scale: 2, payment_reference: 'ABC', proof_object_key: 'private-path',
    created_at: '2026-10-09 12:00:00', created_cursor: stamp,
  };
}
test('review queue paginates using microsecond timestamps and includes expected version', async () => {
  const calls = [];
  const pool = { async query(sql, args) {
    calls.push({ sql, args });
    return { rows: [
      record('payment_2', '2026-10-09 12:00:00.000002'),
      record('payment_1', '2026-10-09 12:00:00.000001'),
    ] };
  } };
  const result = await listPlatformPaymentReviews({ limit: '1' }, { pool });
  assert.equal(result.rows[0].version, 2);
  assert.equal(result.rows[0].expectedAmount.units, '9007199254740993');
  assert.equal(result.rows[0].proofAvailable, true);
  assert.equal(result.rows[0].proofObjectKey, undefined);
  assert.deepEqual(parseCursor(result.nextCursor), {
    v: 1, createdAt: '2026-10-09 12:00:00.000002', id: 'payment_2',
  });
  assert.equal(calls[0].args[0], 'pending_verification');
  assert.equal(calls[0].args.at(-1), 2);
});

test('review queue applies optional organization filter, never to browser-controlled decisions', async () => {
  let parameters;
  const pool = { async query(_sql, args) { parameters = args; return { rows: [] }; } };
  await listPlatformPaymentReviews({ orgId: 'org_1', status: 'all' }, { pool });
  assert.equal(parameters[0], 'org_1');
});

test('invalid page sizes and cursors are rejected', () => {
  for (const size of ['0', '101', 'bogus']) assert.throws(() => parsePage(size), { statusCode: 400 });
  for (const raw of ['invalid%%', 'a']) assert.throws(() => parseCursor(raw), { statusCode: 400 });
});

test('review and private receipt routes inherit the platform-admin middleware', () => {
  const root = path.join(__dirname, '../../src/routes/platform.js');
  const child = path.join(__dirname, '../../src/billing/platformPaymentDecisionRouter.js');
  assert.match(fs.readFileSync(root, 'utf8'), /router\.use\(requireAuthIdentityOnly, requirePlatformAdmin\)/);
  assert.match(fs.readFileSync(child, 'utf8'), /router\.get\('\/billing\/payment-reviews', requireDecisionEnabled/);
  assert.match(fs.readFileSync(child, 'utf8'), /router\.get\('\/billing\/organizations\/:orgId\/payments\/:paymentRequestId\/proof'/);
});
