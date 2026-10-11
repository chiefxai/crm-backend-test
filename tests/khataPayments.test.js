const { createKhataPaymentService, normalizePaymentInput } = require("../src/crm/khataPayments");

function fakePool() {
  const customer = { id: "customer-1", name: "Asha", phone: "+911234567890", khata: 1000, created_at: "2026-01-01" };
  const payments = new Map();
  let updates = 0;
  let lockSql = "";
  const query = async (sql, params = []) => {
    if (sql.includes("FROM khata_payments")) {
      const [, workspaceId, key] = params;
      const value = payments.get(`${workspaceId}:${key}`);
      return { rows: value ? [{ customer_id: value.customerId, amount: value.amount, balance_after: value.balanceAfter }] : [] };
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  };
  const pool = {
    query,
    async connect() {
      return {
        async query(sql, params = []) {
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], affectedRows: 0 };
          if (sql.includes("FROM customers")) { lockSql = sql; return { rows: customer.id === params[3] ? [{ ...customer }] : [] }; }
          if (sql.startsWith("UPDATE customers")) { customer.khata = params[0]; updates += 1; return { rows: [], affectedRows: 1 }; }
          if (sql.includes("INSERT INTO khata_payments")) {
            const [, orgId, workspaceId, customerId, key, amount, balanceAfter] = params;
            const id = `${workspaceId}:${key}`;
            if (payments.has(id)) throw Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" });
            payments.set(id, { orgId, workspaceId, customerId, amount, balanceAfter });
            return { rows: [], affectedRows: 1 };
          }
          throw new Error(`Unexpected connection query: ${sql}`);
        },
        release() {},
      };
    },
    customer,
    get updates() { return updates; },
    get lockSql() { return lockSql; },
    payments,
  };
  return pool;
}

describe("khata payments", () => {
  test("rejects non-positive, non-finite, fractional-paise, and missing idempotency inputs", () => {
    for (const amount of [0, -1, NaN, Infinity, "1.001"]) {
      expect(() => normalizePaymentInput({ amount, idempotencyKey: "key-1" })).toThrow();
    }
    expect(() => normalizePaymentInput({ amount: 1, idempotencyKey: "" })).toThrow(/Idempotency-Key/);
    expect(normalizePaymentInput({ amount: 0.29, idempotencyKey: "valid-paise" }).amount).toBe(0.29);
  });

  test("locks the customer, records payment once, and safely replays the same key", async () => {
    const pool = fakePool();
    const service = createKhataPaymentService(pool);
    const first = await service.apply({ orgId: "org-1", workspaceId: "ws-1", customerId: "customer-1", amount: 100, idempotencyKey: "pay-1" });
    const retry = await service.apply({ orgId: "org-1", workspaceId: "ws-1", customerId: "customer-1", amount: 100, idempotencyKey: "pay-1" });

    expect(first.balanceAfter).toBe(900);
    expect(first.replayed).toBe(false);
    expect(retry.balanceAfter).toBe(900);
    expect(retry.replayed).toBe(true);
    expect(pool.customer.khata).toBe(900);
    expect(pool.updates).toBe(1);
    expect(pool.lockSql).toMatch(/FOR UPDATE/);
    await expect(service.apply({ orgId: "org-1", workspaceId: "ws-1", customerId: "customer-1", amount: 101, idempotencyKey: "pay-1" }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  test("rejects overpayment instead of silently clamping the balance", async () => {
    const service = createKhataPaymentService(fakePool());
    await expect(service.apply({ orgId: "org-1", workspaceId: "ws-1", customerId: "customer-1", amount: 1001, idempotencyKey: "pay-2" }))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});
