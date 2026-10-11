const crypto = require("crypto");

function paymentError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function normalizePaymentInput({ amount, idempotencyKey }) {
  const numericAmount = typeof amount === "number" || typeof amount === "string" ? Number(amount) : NaN;
  const amountInPaise = numericAmount * 100;
  if (!Number.isFinite(numericAmount) || numericAmount <= 0 || numericAmount > 999999999999.99
    || Math.abs(amountInPaise - Math.round(amountInPaise)) > 1e-7) {
    throw paymentError("Payment amount must be a positive INR amount with at most two decimal places.", 400);
  }
  const key = typeof idempotencyKey === "string" ? idempotencyKey.trim() : "";
  if (!key || key.length > 191) {
    throw paymentError("A valid Idempotency-Key is required for khata payments.", 400);
  }
  return { amount: Math.round(numericAmount * 100) / 100, idempotencyKey: key };
}

function customerFromRow(row) {
  return row && {
    id: row.id,
    name: row.name,
    phone: row.phone,
    type: row.type,
    locality: row.locality,
    ltv: row.ltv == null ? row.ltv : Number(row.ltv),
    khata: row.khata == null ? row.khata : Number(row.khata),
    createdAt: row.created_at,
  };
}

function createKhataPaymentService(pool) {
  if (!pool?.connect || !pool?.query) throw new TypeError("A query-capable MySQL pool is required");

  async function findPayment({ orgId, workspaceId, customerId, idempotencyKey }) {
    const { rows } = await pool.query(
      `SELECT customer_id,amount,balance_after FROM khata_payments
        WHERE org_id=? AND workspace_id=? AND idempotency_key=? LIMIT 1`,
      [orgId, workspaceId, idempotencyKey]
    );
    const payment = rows?.[0];
    if (!payment) return null;
    if (payment.customer_id !== customerId) throw paymentError("Idempotency-Key was already used for another customer.", 409);
    return { amount: Number(payment.amount), balanceAfter: Number(payment.balance_after), replayed: true };
  }

  async function apply({ orgId, workspaceId, customerId, amount, idempotencyKey }) {
    const normalized = normalizePaymentInput({ amount, idempotencyKey });
    const existing = await findPayment({ orgId, workspaceId, customerId, idempotencyKey: normalized.idempotencyKey });
    if (existing) {
      if (Math.round(existing.amount * 100) !== Math.round(normalized.amount * 100)) {
        throw paymentError("Idempotency-Key was already used with a different amount.", 409);
      }
      return { ...existing, customer: null };
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Lock the customer row so simultaneous payments cannot overwrite each
      // other's balance. Workspace ownership is included in the lock query.
      const { rows } = await client.query(
        `SELECT id,name,phone,type,locality,ltv,khata,created_at FROM customers
          WHERE org_id=? AND (workspace_id=? OR (workspace_id IS NULL AND org_id=?)) AND id=?
          LIMIT 1 FOR UPDATE`,
        [orgId, workspaceId, workspaceId, customerId]
      );
      const customer = rows?.[0];
      if (!customer) throw paymentError("Customer not found.", 404);
      const balance = Math.round(Number(customer.khata || 0) * 100) / 100;
      if (!Number.isFinite(balance) || normalized.amount > balance) {
        throw paymentError("Payment amount exceeds the outstanding khata balance.", 409);
      }
      const balanceAfter = Math.round((balance - normalized.amount) * 100) / 100;
      await client.query(
        `UPDATE customers SET khata=? WHERE org_id=? AND
          (workspace_id=? OR (workspace_id IS NULL AND org_id=?)) AND id=?`,
        [balanceAfter, orgId, workspaceId, workspaceId, customerId]
      );
      await client.query(
        `INSERT INTO khata_payments (id,org_id,workspace_id,customer_id,idempotency_key,amount,balance_after,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [crypto.randomUUID(), orgId, workspaceId, customerId, normalized.idempotencyKey,
          normalized.amount, balanceAfter, new Date().toISOString()]
      );
      await client.query("COMMIT");
      return { amount: normalized.amount, balanceAfter, replayed: false,
        customer: customerFromRow({ ...customer, khata: balanceAfter }) };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      // A concurrent request with this key may have committed while our
      // customer lock was held. Return that receipt only if its parameters match.
      if (error?.code === "ER_DUP_ENTRY" || error?.code === "SQLITE_CONSTRAINT_UNIQUE") {
        const duplicate = await findPayment({ orgId, workspaceId, customerId, idempotencyKey: normalized.idempotencyKey });
        if (duplicate && Math.round(duplicate.amount * 100) === Math.round(normalized.amount * 100)) {
          return { ...duplicate, customer: null };
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return { apply };
}

module.exports = { createKhataPaymentService, normalizePaymentInput };
