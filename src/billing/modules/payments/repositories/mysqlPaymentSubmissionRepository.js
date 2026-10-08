'use strict';

const { assertTransactionContext } = require('../../../kernel/transactionContext');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../../contracts/errors');

function rowsOf(value) {
  const result = Array.isArray(value) && value.length === 2 && Array.isArray(value[0]) ? value[0] : value;
  return Array.isArray(result) ? result : result?.rows || [];
}
function affectedRows(value) {
  const result = Array.isArray(value) && value.length === 2 ? value[0] : value;
  return Number(result?.affectedRows ?? result?.rowCount ?? 0);
}
function fromRow(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id, orgId: row.org_id, quoteId: row.quote_id, periodId: row.period_id, invoiceId: row.invoice_id,
    purpose: row.purpose, status: row.status,
    expectedAmount: Object.freeze({ asset: row.asset, units: String(row.expected_amount_units), scale: Number(row.scale) }),
    paymentReference: row.payment_reference, proofObjectKey: row.proof_object_key,
    proofSha256: row.proof_sha256, proofContentType: row.proof_content_type, payerNote: row.payer_note || null,
    version: Number(row.version), submittedBy: row.submitted_by,
    submittedAt: row.submitted_at, createdAt: row.created_at, updatedAt: row.updated_at,
  });
}
function createMysqlPaymentSubmissionRepository({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Payment submission repository requires pool.connect().');
  async function getQuoteForUpdate(tx, { orgId, quoteId }) {
    assertTransactionContext(tx);
    if (tx.metadata?.orgId !== orgId) throw new TypeError('Payment quote organization must match the transaction.');
    const rows = rowsOf(await tx.query(
      `SELECT id,org_id,quote_type,status,total_units,asset,scale,valid_until,paid_at
         FROM billing_quotes WHERE org_id=? AND id=? FOR UPDATE`, [orgId, quoteId],
    ));
    const row = rows[0];
    if (!row) return null;
    return Object.freeze({
      id: row.id, orgId: row.org_id, quoteType: row.quote_type, status: row.status,
      amount: Object.freeze({ asset: row.asset, units: String(row.total_units), scale: Number(row.scale) }),
      validUntil: row.valid_until, paidAt: row.paid_at,
    });
  }

  async function create(tx, record) {
    assertTransactionContext(tx);
    if (tx.metadata?.orgId !== record.orgId) throw new TypeError('Payment request organization must match the transaction.');
    const quote = record.quoteId ? await getQuoteForUpdate(tx, { orgId: record.orgId, quoteId: record.quoteId }) : null;
    const invoice = record.invoiceId ? rowsOf(await tx.query(
      `SELECT id,status,asset,scale,total_units,paid_units FROM billing_invoices WHERE org_id=? AND id=? FOR UPDATE`,
      [record.orgId, record.invoiceId],
    ))[0] : null;
    if (record.purpose === 'invoice') {
      if (!invoice || !['open', 'partially_paid', 'overdue'].includes(String(invoice.status).toLowerCase())) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'An open invoice for this organization was not found.');
      }
      const outstanding = BigInt(invoice.total_units) - BigInt(invoice.paid_units);
      if (BigInt(record.expectedAmount.units) <= 0n || BigInt(record.expectedAmount.units) > outstanding
        || record.expectedAmount.asset !== invoice.asset || record.expectedAmount.scale !== Number(invoice.scale)) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.PAYMENT_AMOUNT_MISMATCH, 'Submitted amount exceeds or does not match the current invoice balance.');
      }
    } else {
      if (!quote) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'The selected quote was not found for this organization.');
      record.validateQuote(quote);
      if (String(quote.status).toLowerCase() === 'draft') {
        await tx.query(
          `UPDATE billing_quotes SET status='accepted',accepted_at=?,accepted_by=?,updated_at=?,version=version+1
            WHERE org_id=? AND id=? AND status='draft'`,
          [record.now, record.actorId, record.now, record.orgId, record.quoteId],
        );
      }
    }
    try {
      await tx.query(
        `INSERT INTO billing_payment_requests
          (id,org_id,quote_id,period_id,invoice_id,purpose,status,expected_amount_units,asset,scale,payment_reference,
           proof_object_key,proof_sha256,proof_content_type,idempotency_key,version,submitted_by,payer_note,submitted_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,'pending_verification',?,?,?,?,?,?,?,?,1,?,?,?,?,?)`,
        [record.id, record.orgId, record.quoteId || null, record.periodId || null, record.invoiceId || null, record.purpose,
          record.expectedAmount.units, record.expectedAmount.asset, record.expectedAmount.scale,
          record.paymentReference, record.proofObjectKey, record.proof.sha256, record.proof.contentType, record.idempotencyKey,
          record.actorId, record.payerNote || null, record.now, record.now, record.now],
      );
      await insertProofVersion(tx, record, 1);
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.DUPLICATE_PAYMENT_REFERENCE, 'This payment reference or idempotency key has already been submitted for this organization.');
      }
      throw error;
    }
    return Object.freeze({
      id: record.id, orgId: record.orgId, quoteId: record.quoteId || null, periodId: record.periodId || null,
      purpose: record.purpose, status: 'pending_verification', expectedAmount: record.expectedAmount,
      paymentReference: record.paymentReference, version: 1, submittedBy: record.actorId,
      submittedAt: record.now, createdAt: record.now, updatedAt: record.now,
    });
  }

  async function insertProofVersion(tx, record, version) {
    await tx.query(
      `INSERT INTO billing_payment_proof_versions
        (id,org_id,payment_request_id,version,object_key,proof_sha256,content_type,submitted_by,submitted_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [record.proofVersionId || `${record.id}:proof:${version}`, record.orgId, record.id, version,
        record.proofObjectKey, record.proof.sha256, record.proof.contentType, record.actorId, record.now],
    );
  }

  async function resubmit(tx, record) {
    assertTransactionContext(tx);
    if (tx.metadata?.orgId !== record.orgId) throw new TypeError('Payment request organization must match the transaction.');
    const row = rowsOf(await tx.query(
      `SELECT id,purpose,quote_id,invoice_id,status,version FROM billing_payment_requests
        WHERE org_id=? AND id=? FOR UPDATE`, [record.orgId, record.paymentRequestId],
    ))[0];
    if (!row) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Payment request was not found for this organization.');
    if (!['needs_clarification', 'clarification_requested'].includes(String(row.status).toLowerCase())) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.PAYMENT_NOT_PENDING, 'Payment request is not awaiting clarification resubmission.');
    }
    if (row.purpose !== record.purpose || (row.quote_id || null) !== (record.quoteId || null) || (row.invoice_id || null) !== (record.invoiceId || null)) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'A resubmission cannot change its original quote, invoice, or payment purpose.');
    }
    if (record.quoteId) {
      const quote = await getQuoteForUpdate(tx, { orgId: record.orgId, quoteId: record.quoteId });
      record.validateQuote(quote);
    } else {
      const invoice = rowsOf(await tx.query(
        `SELECT status,asset,scale,total_units,paid_units FROM billing_invoices WHERE org_id=? AND id=? FOR UPDATE`,
        [record.orgId, record.invoiceId],
      ))[0];
      if (!invoice || !['open', 'partially_paid', 'overdue'].includes(String(invoice.status).toLowerCase())) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'An open invoice for this organization was not found.');
      }
      const outstanding = BigInt(invoice.total_units) - BigInt(invoice.paid_units);
      if (record.expectedAmount.asset !== invoice.asset || record.expectedAmount.scale !== Number(invoice.scale)
        || BigInt(record.expectedAmount.units) <= 0n || BigInt(record.expectedAmount.units) > outstanding) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.PAYMENT_AMOUNT_MISMATCH, 'Resubmitted amount exceeds or does not match the current invoice balance.');
      }
    }
    const nextVersion = Number(row.version) + 1;
    let changed;
    try {
      changed = await tx.query(
        `UPDATE billing_payment_requests
            SET status='pending_verification',expected_amount_units=?,received_amount_units=NULL,asset=?,scale=?,payment_reference=?,
                proof_object_key=?,proof_sha256=?,proof_content_type=?,submitted_by=?,payer_note=?,submitted_at=?,updated_at=?,version=version+1
          WHERE org_id=? AND id=? AND version=? AND status IN ('needs_clarification','clarification_requested')`,
        [record.expectedAmount.units, record.expectedAmount.asset, record.expectedAmount.scale, record.paymentReference,
          record.proofObjectKey, record.proof.sha256, record.proof.contentType, record.actorId, record.payerNote || null,
          record.now, record.now, record.orgId, record.paymentRequestId, row.version],
      );
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.DUPLICATE_PAYMENT_REFERENCE, 'This payment reference is already attached to another request for this organization.');
      }
      throw error;
    }
    if (affectedRows(changed) !== 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Payment request changed before resubmission.');
    await insertProofVersion(tx, { ...record, id: record.paymentRequestId }, nextVersion);
    return Object.freeze({
      id: record.paymentRequestId, orgId: record.orgId, quoteId: record.quoteId || null,
      invoiceId: record.invoiceId || null, purpose: record.purpose, status: 'pending_verification',
      expectedAmount: record.expectedAmount, paymentReference: record.paymentReference,
      version: nextVersion, submittedBy: record.actorId, submittedAt: record.now, updatedAt: record.now,
    });
  }

  async function getReceiptReference({ orgId, paymentRequestId }) {
    const connection = await pool.connect();
    try {
      const row = rowsOf(await connection.query(
        `SELECT id,org_id,purpose,status,proof_object_key FROM billing_payment_requests WHERE org_id=? AND id=?`,
        [orgId, paymentRequestId],
      ))[0];
      return row ? Object.freeze({ id: row.id, orgId: row.org_id, purpose: row.purpose, status: row.status, proofObjectKey: row.proof_object_key }) : null;
    } finally { connection.release(); }
  }

  return Object.freeze({ getQuoteForUpdate, create, resubmit, getReceiptReference });
}

module.exports = { createMysqlPaymentSubmissionRepository, rowsOf, affectedRows, fromRow };
