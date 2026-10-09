'use strict';

// Organizations request immutable, 1:1 INR credit quotes. Creating a quote never
// records a payment or credits a wallet. Approval remains in payment decisions.
const crypto = require('node:crypto');
const router = require('express').Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const { getPool } = require('../db/pool');
const { createTopupQuote } = require('./modules/catalog/quote');
const { BILLING_SUBMIT_ROLES } = require('./paymentHttpComposition');

function parseTopupInr(value) {
  if (typeof value !== 'string' || !/^(?:[1-9][0-9]{0,5})(?:\\.[0-9]{1,2})?$/.test(value)) {
    throw new TypeError('Enter an amount from ₹1 to ₹999,999.99, with at most two decimal places.');
  }
  const [rupees, paise = ''] = value.split('.');
  const units = BigInt(rupees) * 100n + BigInt((paise + '00').slice(0, 2));
  return { asset: 'INR', units: units.toString(), scale: 2 };
}

function quoteResponse(row) {
  return { quoteId: row.id, purpose: 'topup', status: row.status,
    paymentAmount: { asset: row.asset, units: String(row.total_units), scale: Number(row.scale) },
    topupCredits: { asset: row.asset, units: String(row.total_units), scale: Number(row.scale) },
    validUntil: row.valid_until };
}

router.post('/topup-quotes', requireAuth, requirePermission('billing.read'), async (req, res) => {
  if (process.env.BILLING_TOPUP_QUOTE_ENABLED !== 'true'
    || process.env.BILLING_PAYMENT_SUBMISSION_ENABLED !== 'true') {
    return res.status(503).json({ error: 'Credit top-ups are not enabled.' });
  }
  if (!BILLING_SUBMIT_ROLES.has(req.authorization?.organizationRole)) {
    return res.status(403).json({ error: 'Organization billing administrator access is required.' });
  }
  const key = req.get('Idempotency-Key');
  if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
    return res.status(400).json({ error: 'A valid Idempotency-Key header is required.' });
  }
  let amount;
  try { amount = parseTopupInr(req.body?.amountInr); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const pool = getPool();
  try {
    const existing = await pool.query(
      'SELECT id,status,total_units,asset,scale,valid_until FROM billing_quotes WHERE org_id=? AND idempotency_key=?',
      [req.orgId, key],
    );
    if (existing.rows.length) {
      const row = existing.rows[0];
      if (row.quote_type && row.quote_type !== 'topup' || row.asset !== amount.asset
        || String(row.total_units) !== amount.units || Number(row.scale) !== 2) {
        return res.status(409).json({ error: 'This request key was already used for a different amount.' });
      }
      return res.json(quoteResponse(row));
    }
    const now = new Date();
    const createdAt = now.toISOString();
    const validUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const quoteId = `billing-topup-quote-${crypto.randomUUID()}`;
    const quote = createTopupQuote({
      quoteId, orgId: req.orgId, version: 1, createdAt, validUntil,
      paymentAmount: amount, topupCredits: amount,
    });
    await pool.query(
      `INSERT INTO billing_quotes (id,org_id,quote_type,status,version,idempotency_key,
        terms_snapshot_json,context_json,total_units,asset,scale,valid_until,created_at,updated_at)
       VALUES (?,?,'topup','draft',1,?,?,NULL,?,?,?, ?,?,?)`,
      [quoteId, req.orgId, key, JSON.stringify(quote), amount.units,
        amount.asset, amount.scale, validUntil, createdAt, createdAt],
    );
    return res.status(201).json({
      quoteId, purpose: 'topup', status: 'draft',
      paymentAmount: amount, topupCredits: amount, validUntil,
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      const retry = await pool.query(
        'SELECT id,quote_type,status,total_units,asset,scale,valid_until FROM billing_quotes WHERE org_id=? AND idempotency_key=?',
        [req.orgId, key],
      ).catch(() => ({ rows: [] }));
      if (retry.rows.length && retry.rows[0].quote_type === 'topup'
          && String(retry.rows[0].total_units) === amount.units) return res.json(quoteResponse(retry.rows[0]));
      return res.status(409).json({ error: 'Credit top-up already exists with different details.' });
    }
    return res.status(500).json({ error: 'Could not create the top-up request.' });
  }
});

module.exports = { router, parseTopupInr };
