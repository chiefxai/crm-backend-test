'use strict';

const { assertTransactionContext } = require('../../../kernel/transactionContext');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../../contracts/errors');

function rowsOf(value) {
  const result = Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value;
  return Array.isArray(result) ? result : result?.rows || [];
}
function affectedRows(value) {
  const result = Array.isArray(value) && value.length === 2 ? value[0] : value;
  return Number(result?.affectedRows ?? result?.rowCount ?? 0);
}
function parseJson(value, label) {
  try { return typeof value === 'string' ? JSON.parse(value) : value; }
  catch (cause) { throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, `${label} is invalid JSON.`, { retryable: true, details: { cause: cause.message } }); }
}
function createMysqlPaymentDecisionRepository({ idSource, clock } = {}) {
  if (typeof idSource?.newId !== 'function' || typeof clock?.now !== 'function') throw new TypeError('Payment decision repository requires an ID source and clock.');

  async function getForUpdate(tx, { orgId, paymentRequestId }) {
    assertTransactionContext(tx);
    if (tx.metadata?.orgId !== orgId) throw new TypeError('Payment request organization must match transaction organization.');
    const row = rowsOf(await tx.query(
      `SELECT id,org_id,quote_id,period_id,invoice_id,purpose,status,expected_amount_units,
              received_amount_units,asset,scale,payment_reference,version,submitted_by,submitted_at
         FROM billing_payment_requests WHERE org_id=? AND id=? FOR UPDATE`, [orgId, paymentRequestId],
    ))[0];
    if (!row) return null;
    let quote = null;
    if (row.quote_id) {
      const quoteRow = rowsOf(await tx.query(
        `SELECT quote_type,status,total_units,asset,scale,valid_until,paid_at,terms_snapshot_json
           FROM billing_quotes WHERE org_id=? AND id=? FOR UPDATE`, [orgId, row.quote_id],
      ))[0];
      if (!quoteRow) throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Payment request references a missing quote.', { retryable: true });
      quote = Object.freeze({
        id: row.quote_id, type: quoteRow.quote_type, status: quoteRow.status,
        amount: { asset: quoteRow.asset, units: String(quoteRow.total_units), scale: Number(quoteRow.scale) },
        validUntil: quoteRow.valid_until, paidAt: quoteRow.paid_at,
        snapshot: parseJson(quoteRow.terms_snapshot_json, 'Payment quote snapshot'),
      });
    }
    return Object.freeze({
      id: row.id, orgId: row.org_id, quoteId: row.quote_id, periodId: row.period_id,
      invoiceId: row.invoice_id, purpose: row.purpose, status: row.status,
      expectedAmount: Object.freeze({ asset: row.asset, units: String(row.expected_amount_units), scale: Number(row.scale) }),
      receivedAmount: row.received_amount_units == null ? null : Object.freeze({ asset: row.asset, units: String(row.received_amount_units), scale: Number(row.scale) }),
      paymentReference: row.payment_reference, version: Number(row.version), submittedBy: row.submitted_by,
      submittedAt: row.submitted_at, quote,
    });
  }

  async function saveDecision(tx, { request, expectedVersion, decision, reason, receivedAmount, actorId, now }) {
    assertTransactionContext(tx);
    if (tx.metadata?.orgId !== request.orgId) throw new TypeError('Payment decision organization must match transaction organization.');
    const sequence = Number(rowsOf(await tx.query(
      `SELECT COALESCE(MAX(sequence_no),0)+1 AS next_sequence FROM billing_payment_decisions
        WHERE org_id=? AND payment_request_id=?`, [request.orgId, request.id],
    ))[0]?.next_sequence || 1);
    const decisionId = idSource.newId('billing-payment-decision');
    await tx.query(
      `INSERT INTO billing_payment_decisions
        (id,org_id,payment_request_id,sequence_no,request_version,decision,reason,received_amount_units,received_asset,received_scale,decided_by,decided_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [decisionId, request.orgId, request.id, sequence, expectedVersion, decision, reason || null,
        receivedAmount?.units ?? null, receivedAmount?.asset ?? null, receivedAmount?.scale ?? null,
        actorId, now, now],
    );
    const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'needs_clarification';
    const changed = await tx.query(
      `UPDATE billing_payment_requests
          SET status=?,received_amount_units=?,reviewed_at=?,updated_at=?,version=version+1
        WHERE org_id=? AND id=? AND version=? AND status='pending_verification'`,
      [status, receivedAmount?.units ?? null, now, now, request.orgId, request.id, expectedVersion],
    );
    if (affectedRows(changed) !== 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Payment request changed while the decision was being recorded.');
    return Object.freeze({
      id: decisionId, orgId: request.orgId, paymentRequestId: request.id,
      sequence, requestVersion: expectedVersion, decision, status, reason: reason || null,
      receivedAmount: receivedAmount || null, decidedBy: actorId, decidedAt: now,
      requestVersionAfter: expectedVersion + 1,
    });
  }

  async function markQuotePaid(tx, { orgId, quoteId, now }) {
    assertTransactionContext(tx);
    if (tx.metadata?.orgId !== orgId) throw new TypeError('Quote organization must match transaction organization.');
    const row = rowsOf(await tx.query(
      `SELECT status,paid_at FROM billing_quotes WHERE org_id=? AND id=? FOR UPDATE`, [orgId, quoteId],
    ))[0];
    if (!row) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Purchased quote was not found for this organization.');
    if (row.paid_at || String(row.status).toLowerCase() === 'paid') {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Quote has already funded a different payment request.');
    }
    if (String(row.status).toLowerCase() !== 'accepted') throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Only an accepted quote can be paid.');
    const changed = await tx.query(
      `UPDATE billing_quotes SET status='paid',paid_at=?,updated_at=?,version=version+1
        WHERE org_id=? AND id=? AND status='accepted' AND paid_at IS NULL`, [now, now, orgId, quoteId],
    );
    if (affectedRows(changed) !== 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Quote changed before payment approval.');
    return true;
  }

  async function createFulfillment(tx, { orgId, paymentRequestId, fulfillmentKind, targetId, result, now }) {
    assertTransactionContext(tx);
    if (tx.metadata?.orgId !== orgId) throw new TypeError('Fulfillment organization must match transaction organization.');
    const prior = rowsOf(await tx.query(
      `SELECT id,result_json FROM billing_payment_fulfillments
        WHERE org_id=? AND payment_request_id=? AND fulfillment_kind=? AND target_id=? FOR UPDATE`,
      [orgId, paymentRequestId, fulfillmentKind, targetId],
    ))[0];
    if (prior) {
      const priorResult = parseJson(prior.result_json, 'Payment fulfillment result');
      if (JSON.stringify(priorResult) !== JSON.stringify(result)) throw new BillingDomainError(DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, 'Payment fulfillment already exists with different result data.');
      return Object.freeze({ id: prior.id, alreadyFulfilled: true, ...priorResult });
    }
    const digest = require('node:crypto').createHash('sha256').update(`${orgId}\0${paymentRequestId}\0${fulfillmentKind}\0${targetId}`).digest('hex');
    const id = `billing-fulfillment-${digest}`;
    await tx.query(
      `INSERT INTO billing_payment_fulfillments
        (id,org_id,payment_request_id,fulfillment_kind,target_id,idempotency_key,result_json,fulfilled_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, orgId, paymentRequestId, fulfillmentKind, targetId, `${fulfillmentKind}-${digest}`, JSON.stringify(result), now, now],
    );
    return Object.freeze({ id, alreadyFulfilled: false, ...result });
  }

  return Object.freeze({ getForUpdate, saveDecision, markQuotePaid, createFulfillment });
}

module.exports = { createMysqlPaymentDecisionRepository, rowsOf, affectedRows, parseJson };
