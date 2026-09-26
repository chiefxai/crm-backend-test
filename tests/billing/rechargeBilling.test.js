jest.mock("../../src/db/repository", () => ({
  getOrg: jest.fn(),
  pool: { connect: jest.fn() },
  supabase: { from: jest.fn() },
}));

jest.mock("../../src/platform/costProviders", () => ({
  computeAiCost: jest.fn().mockResolvedValue({ totalCost: 1 }),
  computeCallCost: jest.fn().mockResolvedValue(null),
}));

jest.mock("../../src/channels/engine", () => ({
  getChannel: jest.fn().mockResolvedValue(null),
}));

jest.mock("../../src/billing/minimumBalance", () => ({
  getEffectiveMinimumBalance: jest.fn().mockResolvedValue({
    effectiveMinimumBalanceInr: 20,
    effectiveReservationMinutes: 3,
  }),
}));

const db = require("../../src/db/repository");
const { getEffectiveMinimumBalance } = require("../../src/billing/minimumBalance");
const { authorizeOutboundCall } = require("../../src/crm/rechargeBilling");

describe("rechargeBilling.authorizeOutboundCall", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const query = jest.fn(async (sql) => {
      if (String(sql).includes("FOR UPDATE") && String(sql).includes("organizations")) {
        return { rows: [{ recharge_balance_inr: 50, recharge_reserved_inr: 0, billing_method: "recharge_based", charge_scope: "ai_only" }] };
      }
      if (String(sql).includes("INSERT INTO recharge_billing_reservations")) {
        return { rows: [] };
      }
      if (String(sql).includes("UPDATE organizations SET recharge_reserved_inr")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    db.pool.connect.mockResolvedValue({
      query,
      release: jest.fn(),
    });
  });

  test("passes estimate.org into minimum balance check (no ReferenceError)", async () => {
    const org = { id: "org-1", billingMethod: "recharge_based", chargeScope: "ai_only", industry: "lending" };
    db.getOrg.mockResolvedValue(org);

    const reservation = await authorizeOutboundCall("org-1", { providerKey: "vobiz" });

    expect(reservation).toMatchObject({ orgId: "org-1" });
    expect(getEffectiveMinimumBalance).toHaveBeenCalledWith(org);
  });
});
