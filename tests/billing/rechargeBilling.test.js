jest.mock("../../src/db/repository", () => ({
  getOrg: jest.fn(),
  pool: { connect: jest.fn() },
  supabase: { from: jest.fn() },
}));
jest.mock('../../src/db/repositories/workspaceRepository',()=>({getActive:jest.fn()}));

jest.mock("../../src/platform/costProviders", () => ({
  computeAiCost: jest.fn().mockResolvedValue({ totalCost: 1 }),
  computeCallCost: jest.fn().mockResolvedValue({ totalCost: 5 }),
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
const workspaces = require('../../src/db/repositories/workspaceRepository');
const { getEffectiveMinimumBalance } = require("../../src/billing/minimumBalance");
const { authorizeOutboundCall, estimateReservation } = require("../../src/crm/rechargeBilling");

describe("rechargeBilling.authorizeOutboundCall", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    workspaces.getActive.mockResolvedValue({id:'org-1',settings:{}});
    const query = jest.fn(async (sql) => {
      if (String(sql).includes("FOR UPDATE") && String(sql).includes("organizations")) {
        return { rows: [{ recharge_balance_inr: 50, recharge_reserved_inr: 0, billing_method: "recharge_based", charge_scope: "ai_only" }] };
      }
      if(String(sql).includes('FROM workspaces'))return {rows:[{settings:{}}]};
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
  test('expired addon workspaces cannot place calls even under pay-as-you-go billing',async()=>{
    workspaces.getActive.mockResolvedValue(null);
    db.getOrg.mockResolvedValue({id:'org-1',billingMethod:'pay_as_you_go'});
    await expect(authorizeOutboundCall('org-1')).rejects.toMatchObject({statusCode:403});
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('connector ownership snapshots control provider-cost estimates independently of legacy channels', async () => {
    const org = { id: 'org-1', billingMethod: 'recharge_based', chargeScope: 'ai_and_call_provider' };
    const organizationOwned = await estimateReservation('org-1', 'vobiz', org, { telephonyOwnerType: 'organization' });
    const platformOwned = await estimateReservation('org-1', 'vobiz', org, { telephonyOwnerType: 'platform' });
    expect(organizationOwned.amount).toBe(1);
    expect(organizationOwned.selfManaged).toBe(true);
    expect(platformOwned.amount).toBe(6);
    expect(platformOwned.selfManaged).toBe(false);
  });

  test('persists the connector owner type on the call reservation', async () => {
    const org = { id: 'org-1', billingMethod: 'recharge_based', chargeScope: 'ai_only', industry: 'lending' };
    db.getOrg.mockResolvedValue(org);
    let reservationInsert;
    db.pool.connect.mockResolvedValue({
      query: jest.fn(async (sql, values) => {
        if (String(sql).includes('FROM workspaces')) return { rows: [{ settings: {} }] };
        if (String(sql).includes('FROM organizations') && String(sql).includes('FOR UPDATE')) {
          return { rows: [{ recharge_balance_inr: 50, recharge_reserved_inr: 0 }] };
        }
        if (String(sql).includes('INSERT INTO recharge_billing_reservations')) reservationInsert = { sql, values };
        return { rows: [] };
      }),
      release: jest.fn(),
    });
    await authorizeOutboundCall('org-1', { providerKey: 'vobiz', telephonyOwnerType: 'platform' });
    expect(reservationInsert.sql).toContain('telephony_owner_type');
    expect(reservationInsert.values).toContain('platform');
    expect(reservationInsert.sql).toContain('telephony_charge_scope');
    expect(reservationInsert.values).toContain('ai_only');
  });
});
