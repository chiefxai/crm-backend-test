'use strict';

const { assertTransactionContext } = require('../../../kernel/transactionContext');
const { validateId } = require('../../../kernel/scope');
const { validateAmount } = require('../../../kernel/amount');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../../contracts/errors');

function rowsOf(value) { const result = Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value; return Array.isArray(result) ? result : result?.rows || []; }
function affected(value) { const result = Array.isArray(value) && value.length === 2 && !Array.isArray(value[0]) ? value[0] : value; return Number(result?.affectedRows ?? result?.rowCount ?? 0); }
function json(value, label) { try { return typeof value === 'string' ? JSON.parse(value) : value || {}; } catch (cause) { throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, `${label} contains invalid JSON.`, { retryable: true, details: { cause: cause.message } }); } }
function key(prefix, value) { return `${prefix}:${require('node:crypto').createHash('sha256').update(value).digest('hex')}`; }
function assertOrg(tx, orgId) { assertTransactionContext(tx); validateId(orgId, 'orgId'); if (tx.metadata?.orgId !== orgId) throw new TypeError('Invoice organization must match transaction organization.'); }
function mapInvoice(row) {
  if (!row) return null;
  return Object.freeze({ id: row.id, orgId: row.org_id, number: row.invoice_number, periodId: row.period_id,
    status: row.status, amount: Object.freeze({ subtotalUnits: String(row.subtotal_units), taxUnits: String(row.tax_units), totalUnits: String(row.total_units), paidUnits: String(row.paid_units), asset: row.asset, scale: Number(row.scale) }),
    issuedAt: row.issued_at || null, dueAt: row.due_at || null, paidAt: row.paid_at || null, version: Number(row.version), termsSnapshot: json(row.terms_snapshot_json, 'Invoice terms snapshot') });
}

function createMysqlInvoiceRepository({ idSource, clock, postpaidRepository } = {}) {
  if (typeof idSource?.newId !== 'function' || typeof clock?.now !== 'function') throw new TypeError('Invoice repository requires ID source and clock.');
  for (const method of ['reverseSettledExposure', 'recordDebtJournal']) {
    if (typeof postpaidRepository?.[method] !== 'function') throw new TypeError(`Invoice repository requires postpaidRepository.${method}().`);
  }

  async function getForUpdate(tx, { orgId, invoiceId }) {
    assertOrg(tx, orgId);
    return mapInvoice(rowsOf(await tx.query(`SELECT id,org_id,invoice_number,period_id,status,asset,scale,subtotal_units,tax_units,total_units,paid_units,issued_at,due_at,paid_at,version,terms_snapshot_json
      FROM billing_invoices WHERE org_id=? AND id=? FOR UPDATE`, [orgId, validateId(invoiceId, 'invoiceId')]))[0]);
  }

  async function closePeriod(tx, { orgId, periodId, invoiceNumber, dueAt, termsSnapshot }) {
    assertOrg(tx, orgId); validateId(periodId, 'periodId');
    const prior = rowsOf(await tx.query(`SELECT id,org_id,invoice_number,period_id,status,asset,scale,subtotal_units,tax_units,total_units,paid_units,issued_at,due_at,paid_at,version,terms_snapshot_json
      FROM billing_invoices WHERE org_id=? AND period_id=? AND status IN ('open','partially_paid','overdue') FOR UPDATE`, [orgId, periodId]))[0];
    const journals = rowsOf(await tx.query(`SELECT j.id,j.workspace_id,j.period_id,j.reservation_id,j.entry_key,j.entry_type,j.amount_units,j.asset,j.scale,j.occurred_at,j.metadata_json
      FROM billing_postpaid_journals j LEFT JOIN billing_invoice_lines l ON l.org_id=j.org_id AND l.source_type='postpaid_journal' AND l.source_id=j.id
      WHERE j.org_id=? AND j.period_id=? AND j.entry_type IN ('usage_charge','usage_adjustment') AND l.id IS NULL
      ORDER BY j.occurred_at,j.id FOR UPDATE`, [orgId, periodId]));
    if (!journals.length) {
      if (prior) return mapInvoice(prior);
      const latest = rowsOf(await tx.query(`SELECT id,org_id,invoice_number,period_id,status,asset,scale,subtotal_units,tax_units,total_units,paid_units,issued_at,due_at,paid_at,version,terms_snapshot_json
        FROM billing_invoices WHERE org_id=? AND period_id=? ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`, [orgId, periodId]))[0];
      return mapInvoice(latest);
    }
    const amountAsset = journals[0].asset; const scale = Number(journals[0].scale);
    if (journals.some((row) => row.asset !== amountAsset || Number(row.scale) !== scale)) throw new BillingDomainError(DOMAIN_ERROR_CODES.MIXED_ASSET, 'An invoice cannot combine postpaid charges with different assets or scales.');
    if (prior && (prior.asset !== amountAsset || Number(prior.scale) !== scale)) throw new BillingDomainError(DOMAIN_ERROR_CODES.MIXED_ASSET, 'Late postpaid charges must match the existing invoice asset and scale.');
    const delta = journals.reduce((sum, row) => sum + BigInt(row.amount_units), 0n);
    const priorOutstanding = prior ? BigInt(prior.total_units) - BigInt(prior.paid_units) : 0n;
    const canAppend = prior && (delta >= 0n || -delta <= priorOutstanding);
    if (canAppend) {
      const nextTotal = BigInt(prior.total_units) + delta;
      const paid = BigInt(prior.paid_units);
      const nextStatus = nextTotal === paid ? 'paid' : paid > 0n ? 'partially_paid' : 'open';
      const changed = await tx.query(`UPDATE billing_invoices SET subtotal_units=subtotal_units+?,total_units=total_units+?,status=?,paid_at=?,updated_at=?,version=version+1 WHERE org_id=? AND id=? AND version=?`,
      [delta.toString(), delta.toString(), nextStatus, nextStatus === 'paid' ? clock.now() : null, clock.now(), orgId, prior.id, prior.version]);
      if (affected(changed) !== 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Invoice changed while late postpaid items were being added.');
      await insertLines(tx, { orgId, invoiceId: prior.id, existingCount: await countLines(tx, orgId, prior.id), journals, now: clock.now() });
      return getForUpdate(tx, { orgId, invoiceId: prior.id });
    }
    const now = clock.now(); const id = idSource.newId('billing-invoice');
    const status = delta < 0n ? 'credit_note' : 'open';
    await tx.query(`INSERT INTO billing_invoices (id,org_id,invoice_number,period_id,status,asset,scale,subtotal_units,tax_units,total_units,paid_units,issued_at,due_at,terms_snapshot_json,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,0,?,0,?,?,?,1,?,?)`,
    [id, orgId, invoiceNumber, periodId, status, amountAsset, scale, delta.toString(), delta.toString(), now, dueAt, JSON.stringify(termsSnapshot || {}), now, now]);
    await insertLines(tx, { orgId, invoiceId: id, existingCount: 0, journals, now });
    return getForUpdate(tx, { orgId, invoiceId: id });
  }

  async function countLines(tx, orgId, invoiceId) {
    return Number(rowsOf(await tx.query('SELECT COUNT(*) AS count FROM billing_invoice_lines WHERE org_id=? AND invoice_id=?', [orgId, invoiceId]))[0]?.count || 0);
  }

  async function insertLines(tx, { orgId, invoiceId, existingCount, journals, now }) {
    for (let index = 0; index < journals.length; index += 1) {
      const row = journals[index]; const metadata = json(row.metadata_json, 'Postpaid journal metadata');
      const lineSnapshot = { schemaVersion: 1, postpaidJournalId: row.id, periodId: row.period_id, reservationId: row.reservation_id,
        eventId: metadata.eventId || null, pricingSnapshot: metadata.pricingSnapshot || null,
        organizationLimitApplied: metadata.organizationLimitApplied === true, entryType: row.entry_type };
      await tx.query(`INSERT INTO billing_invoice_lines (id,org_id,invoice_id,line_number,line_key,workspace_id,source_type,source_id,source_revision,description_snapshot,workspace_snapshot_json,line_snapshot_json,amount_units,asset,scale,created_at)
        VALUES (?,?,?,?,?,?, 'postpaid_journal',?,'1',?,?,?,?,?,?,?)`,
      [idSource.newId('billing-invoice-line'), orgId, invoiceId, existingCount + index + 1, key('postpaid', row.id), row.workspace_id, row.id,
        row.entry_type === 'usage_adjustment' ? 'Usage correction' : 'Pay as you go usage', JSON.stringify({ workspaceId: row.workspace_id }), JSON.stringify(lineSnapshot), String(row.amount_units), row.asset, Number(row.scale), now]);
    }
  }

  async function applyPayment(tx, { orgId, invoiceId, paymentRequestId, amount, now }) {
    assertOrg(tx, orgId); const normalized = validateAmount(amount);
    const invoice = await getForUpdate(tx, { orgId, invoiceId });
    if (!invoice || !['open', 'partially_paid', 'overdue'].includes(invoice.status)) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'An unpaid invoice was not found.');
    if (normalized.asset !== invoice.amount.asset || normalized.scale !== invoice.amount.scale || BigInt(normalized.units) <= 0n) throw new BillingDomainError(DOMAIN_ERROR_CODES.PAYMENT_AMOUNT_MISMATCH, 'Invoice payment asset, scale, and amount must be valid.');
    const paymentKey = key('payment-request', paymentRequestId);
    const prior = rowsOf(await tx.query(`SELECT id,amount_units,asset,scale,status FROM billing_invoice_payments WHERE org_id=? AND idempotency_key=? FOR UPDATE`, [orgId, paymentKey]))[0];
    if (prior) {
      if (prior.status !== 'applied' || String(prior.amount_units) !== normalized.units || prior.asset !== normalized.asset || Number(prior.scale) !== normalized.scale) throw new BillingDomainError(DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, 'Invoice payment request was already applied with different content.');
      return Object.freeze({ invoice, duplicate: true, paymentId: prior.id });
    }
    const outstanding = BigInt(invoice.amount.totalUnits) - BigInt(invoice.amount.paidUnits);
    if (BigInt(normalized.units) > outstanding) throw new BillingDomainError(DOMAIN_ERROR_CODES.PAYMENT_AMOUNT_MISMATCH, 'Payment exceeds the invoice outstanding balance.');
    const lines = rowsOf(await tx.query(`SELECT id,workspace_id,amount_units,asset,scale,line_snapshot_json,source_id FROM billing_invoice_lines
      WHERE org_id=? AND invoice_id=? AND amount_units>0 ORDER BY line_number FOR UPDATE`, [orgId, invoiceId]));
    let remainingPayment = BigInt(normalized.units);
    for (const line of lines) {
      if (remainingPayment <= 0n) break;
      const snapshot = json(line.line_snapshot_json, 'Invoice line snapshot');
      if (!snapshot.postpaidJournalId || !snapshot.periodId) continue;
      const appliedRows = rowsOf(await tx.query(`SELECT COALESCE(-SUM(amount_units),0) AS applied_units FROM billing_postpaid_journals
        WHERE org_id=? AND entry_type IN ('invoice_payment_application','credit_note_application') AND JSON_UNQUOTE(JSON_EXTRACT(metadata_json,'$.invoiceLineId'))=?`, [orgId, line.id]))[0] || {};
      const already = BigInt(appliedRows.applied_units || '0');
      const openLine = BigInt(line.amount_units) - already;
      if (openLine <= 0n) continue;
      const units = openLine < remainingPayment ? openLine : remainingPayment;
      const amountPart = { asset: line.asset, units: units.toString(), scale: Number(line.scale) };
      const debtReduction = await postpaidRepository.reverseSettledExposure(tx, { orgId, workspaceId: line.workspace_id, periodId: snapshot.periodId, amount: amountPart, organizationLimitApplied: snapshot.organizationLimitApplied === true });
      if (debtReduction.reducedUnits !== units.toString()) throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Invoice payment does not match outstanding postpaid debt.');
      await postpaidRepository.recordDebtJournal(tx, { orgId, workspaceId: line.workspace_id, periodId: snapshot.periodId,
        operationId: key('invoice-payment', paymentRequestId), entryKey: key('invoice-payment-line', `${paymentRequestId}\0${line.id}`),
        entryType: 'invoice_payment_application', amount: { ...amountPart, units: (-units).toString() }, occurredAt: now, actorId: null,
        metadata: { invoiceId, invoiceLineId: line.id, paymentRequestId } });
      remainingPayment -= units;
    }
    if (remainingPayment > 0n) throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Invoice payment exceeds the remaining itemized postpaid charges.');
    const paymentId = idSource.newId('billing-invoice-payment');
    await tx.query(`INSERT INTO billing_invoice_payments (id,org_id,invoice_id,payment_request_id,idempotency_key,amount_units,asset,scale,status,applied_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,'applied',?,?)`, [paymentId, orgId, invoiceId, paymentRequestId, paymentKey, normalized.units, normalized.asset, normalized.scale, now, now]);
    const paid = BigInt(invoice.amount.paidUnits) + BigInt(normalized.units);
    const status = paid === BigInt(invoice.amount.totalUnits) ? 'paid' : 'partially_paid';
    const result = await tx.query(`UPDATE billing_invoices SET paid_units=?,status=?,paid_at=?,updated_at=?,version=version+1 WHERE org_id=? AND id=? AND version=?`,
      [paid.toString(), status, status === 'paid' ? now : null, now, orgId, invoiceId, invoice.version]);
    if (affected(result) !== 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Invoice changed while payment was being applied.');
    return Object.freeze({ invoice: await getForUpdate(tx, { orgId, invoiceId }), duplicate: false, paymentId });
  }

  async function addCreditNote(tx, { orgId, invoiceId, operationId, amount, reason, actorId, invoiceLineId, now }) {
    assertOrg(tx, orgId); const credit = validateAmount(amount); const invoice = await getForUpdate(tx, { orgId, invoiceId });
    if (!invoice || !['open', 'partially_paid', 'overdue'].includes(invoice.status)) throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Credit notes can only adjust an unpaid or partially paid invoice.');
    if (credit.asset !== invoice.amount.asset || credit.scale !== invoice.amount.scale || BigInt(credit.units) <= 0n) throw new BillingDomainError(DOMAIN_ERROR_CODES.MIXED_ASSET, 'Credit note amount must be positive and match invoice asset and scale.');
    const outstanding = BigInt(invoice.amount.totalUnits) - BigInt(invoice.amount.paidUnits);
    if (BigInt(credit.units) > outstanding) throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Credit note cannot exceed the unpaid invoice balance.');
    const params = [orgId, invoiceId];
    const filter = invoiceLineId ? 'AND id=?' : '';
    if (invoiceLineId) params.push(invoiceLineId);
    const lines = rowsOf(await tx.query(`SELECT id,workspace_id,source_id,amount_units,asset,scale,line_snapshot_json FROM billing_invoice_lines
      WHERE org_id=? AND invoice_id=? AND amount_units>0 ${filter} ORDER BY line_number FOR UPDATE`, params));
    if (!lines.length) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'No eligible invoice line was found for the credit note.');
    let left = BigInt(credit.units); const nowValue = now || clock.now(); const inserted = [];
    for (const line of lines) {
      if (left <= 0n) break;
      const snapshot = json(line.line_snapshot_json, 'Invoice line snapshot');
      const appliedRows = rowsOf(await tx.query(`SELECT COALESCE(-SUM(amount_units),0) AS applied_units FROM billing_postpaid_journals
        WHERE org_id=? AND entry_type IN ('invoice_payment_application','credit_note_application') AND JSON_UNQUOTE(JSON_EXTRACT(metadata_json,'$.invoiceLineId'))=?`, [orgId, line.id]))[0] || {};
      const available = BigInt(line.amount_units) - BigInt(appliedRows.applied_units || '0');
      if (available <= 0n) continue;
      const units = available < left ? available : left;
      const part = { asset: line.asset, units: units.toString(), scale: Number(line.scale) };
      if (snapshot.postpaidJournalId && snapshot.periodId) {
        const debtReduction = await postpaidRepository.reverseSettledExposure(tx, { orgId, workspaceId: line.workspace_id, periodId: snapshot.periodId, amount: part, organizationLimitApplied: snapshot.organizationLimitApplied === true });
        if (debtReduction.reducedUnits !== units.toString()) throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Credit note does not match outstanding postpaid debt.');
        await postpaidRepository.recordDebtJournal(tx, { orgId, workspaceId: line.workspace_id, periodId: snapshot.periodId,
          operationId, entryKey: key('credit-note-journal', `${operationId}\0${line.id}`), entryType: 'credit_note_application', amount: { ...part, units: (-units).toString() },
          occurredAt: nowValue, actorId, reversalOfId: snapshot.postpaidJournalId,
          metadata: { invoiceId, invoiceLineId: line.id, operationId, reason, organizationLimitApplied: snapshot.organizationLimitApplied === true } });
      }
      const count = await countLines(tx, orgId, invoiceId);
      const creditLineId = idSource.newId('billing-invoice-line');
      await tx.query(`INSERT INTO billing_invoice_lines (id,org_id,invoice_id,line_number,line_key,workspace_id,source_type,source_id,source_revision,description_snapshot,workspace_snapshot_json,line_snapshot_json,amount_units,asset,scale,created_at)
        VALUES (?,?,?,?,?,?,'credit_note',?,?,?,?,?,?,?,?,?)`,
      [creditLineId, orgId, invoiceId, count + 1, key('credit-note-line', `${operationId}\0${line.id}`), line.workspace_id, operationId, line.id,
        `Credit note: ${reason}`.slice(0, 512), JSON.stringify({ workspaceId: line.workspace_id }), JSON.stringify({ schemaVersion: 1, originalInvoiceLineId: line.id, originalPostpaidJournalId: snapshot.postpaidJournalId || null, periodId: snapshot.periodId || null, reason, actorId, operationId }), (-units).toString(), line.asset, Number(line.scale), nowValue]);
      inserted.push(creditLineId); left -= units;
    }
    if (left > 0n) throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Credit note exceeds remaining eligible invoice line balances.');
    const newTotal = BigInt(invoice.amount.totalUnits) - BigInt(credit.units);
    const status = newTotal === BigInt(invoice.amount.paidUnits) ? 'paid' : (BigInt(invoice.amount.paidUnits) > 0n ? 'partially_paid' : 'open');
    const result = await tx.query(`UPDATE billing_invoices SET subtotal_units=subtotal_units-?,total_units=total_units-?,status=?,paid_at=?,updated_at=?,version=version+1 WHERE org_id=? AND id=? AND version=?`,
      [credit.units, credit.units, status, status === 'paid' ? nowValue : null, nowValue, orgId, invoiceId, invoice.version]);
    if (affected(result) !== 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Invoice changed while credit note was being applied.');
    return Object.freeze({ invoice: await getForUpdate(tx, { orgId, invoiceId }), creditLineIds: Object.freeze(inserted), amount: credit });
  }

  return Object.freeze({ getForUpdate, closePeriod, applyPayment, addCreditNote });
}

module.exports = { createMysqlInvoiceRepository, mapInvoice };
