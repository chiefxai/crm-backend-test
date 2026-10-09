'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toPaymentApiStatus } = require('../../src/billing/paymentStatus');
const { toPayment } = require('../../src/billing/paymentReadModel');

test('legacy payment database states map to the frontend status contract', () => {
  const cases = {
    pending: 'pending_verification',
    pending_verification: 'pending_verification',
    needs_clarification: 'needs_information',
    clarification_requested: 'needs_information',
    needs_information: 'needs_information',
    approved: 'approved',
    rejected: 'rejected',
    cancelled: 'cancelled',
  };
  for (const [stored, expected] of Object.entries(cases)) {
    assert.equal(toPaymentApiStatus(stored), expected, stored);
    const row = {
      id: 'payment_1', purpose: 'subscription', status: stored,
      asset: 'INR', scale: 2, expected_amount_units: '100',
      received_amount_units: null, submitted_at: '2026-10-09 12:00:00',
      created_at: '2026-10-09 12:00:00', reviewed_at: null,
    };
    assert.equal(toPayment(row).status, expected, `history: ${stored}`);
  }
});

test('unknown stored payment status fails closed', () => {
  for (const value of ['waiting', 'PENDING', '', null, undefined, 1]) {
    assert.throws(() => toPaymentApiStatus(value), /Unknown persisted billing payment status/);
  }
});
