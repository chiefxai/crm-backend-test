'use strict';

const { assertTransactionContext } = require('../../../kernel/transactionContext');

function rowsOf(value) {
  const result = Array.isArray(value) && value.length === 2 && Array.isArray(value[0]) ? value[0] : value;
  return Array.isArray(result) ? result : result?.rows || [];
}

function mapQuote(row) {
  if (!row) return null;
  const snapshot = typeof row.terms_snapshot_json === 'string' ? JSON.parse(row.terms_snapshot_json) : row.terms_snapshot_json;
  return Object.freeze({
    id: row.id, orgId: row.org_id, type: row.quote_type, status: row.status,
    version: Number(row.version), idempotencyKey: row.idempotency_key,
    snapshot, amount: Object.freeze({ asset: row.asset, units: String(row.total_units), scale: Number(row.scale) }),
    validUntil: row.valid_until == null ? null : row.valid_until,
    createdAt: row.created_at,
  });
}

/** Transaction-bound persistence for immutable subscription quote snapshots. */
function createMysqlSubscriptionQuoteRepository() {
  function assertOrg(tx, orgId) {
    assertTransactionContext(tx);
    if (tx.metadata?.orgId !== orgId) throw new TypeError('Quote orgId must match transaction orgId.');
  }

  async function getByIdempotencyKey(tx, { orgId, idempotencyKey, forUpdate = false }) {
    assertOrg(tx, orgId);
    const row = rowsOf(await tx.query(
      `SELECT id,org_id,quote_type,status,version,idempotency_key,terms_snapshot_json,total_units,asset,scale,valid_until,created_at
         FROM billing_quotes WHERE org_id=? AND idempotency_key=?${forUpdate ? ' FOR UPDATE' : ''}`,
      [orgId, idempotencyKey],
    ))[0];
    return mapQuote(row);
  }

  async function create(tx, { orgId, id, idempotencyKey, quote, createdBy = null }) {
    assertOrg(tx, orgId);
    if (quote.orgId !== orgId || quote.quoteId !== id || !['purchase', 'renewal', 'adjustment'].includes(quote.purpose)) {
      throw new TypeError('Subscription quote identity does not match its persisted owner and purpose.');
    }
    const total = quote.total;
    await tx.query(
      `INSERT INTO billing_quotes
         (id,org_id,quote_type,status,version,idempotency_key,terms_snapshot_json,context_json,total_units,asset,scale,
          valid_until,accepted_at,accepted_by,paid_at,created_at,updated_at)
       VALUES (?,?,?,'draft',?, ?,?,NULL,?,?,?, ?,NULL,NULL,NULL,?,?)`,
      [id, orgId, quote.purpose, quote.version, idempotencyKey, JSON.stringify(quote), total.units, total.asset, total.scale,
        quote.validUntil, quote.createdAt, quote.createdAt],
    );
    for (let index = 0; index < quote.lines.length; index += 1) {
      const line = quote.lines[index];
      await tx.query(
        `INSERT INTO billing_quote_lines
          (id,org_id,quote_id,line_number,line_type,description,quantity_units,quantity_scale,unit_price_units,
           amount_asset,amount_scale,line_total_units,metadata_json,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [`${id}:line:${index + 1}`, orgId, id, index + 1, line.code, line.label,
          String(line.quantity), 0, line.unitAmount.units, line.amount.asset, line.amount.scale,
          line.amount.units, JSON.stringify({ code: line.code, taxable: line.taxable, discountable: line.discountable }), quote.createdAt],
      );
    }
    return Object.freeze({ id, orgId, type: quote.purpose, status: 'draft', version: quote.version,
      idempotencyKey, snapshot: quote, amount: total, validUntil: quote.validUntil, createdAt: quote.createdAt, createdBy });
  }

  return Object.freeze({ getByIdempotencyKey, create });
}

module.exports = { createMysqlSubscriptionQuoteRepository, mapSubscriptionQuoteRow: mapQuote };
