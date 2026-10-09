jest.mock("../src/platform/settings", () => ({
  getSetting: jest.fn(),
  setSetting: jest.fn(),
}));
jest.mock("../src/platform/dataRetention", () => ({
  getPolicyCatalog: jest.fn(),
}));

const settings = require("../src/platform/settings");
const retention = require("../src/platform/dataRetention");
const plans = require("../src/platform/billingSettings");

const catalog = {
  version: 3,
  defaultPolicyId: "platform-default",
  policies: [
    { id: "platform-default", name: "Platform default" },
    { id: "extended", name: "Extended retention" },
  ],
};
const newPlan = (retentionPolicyId) => ({
  id: "starter",
  name: "Starter",
  active: true,
  defaultMode: "single",
  retentionPolicyId,
  pricing: {
    baseMonthlyInr: 10000,
    includedWorkspaces: 1,
    extraWorkspaceMonthlyInr: 0,
    additionalIndustryMonthlyInr: 0,
    monthlySubscriptionCreditsInr: 0,
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  settings.getSetting.mockResolvedValue(null);
  settings.setSetting.mockImplementation(async (_key, value) => value);
  retention.getPolicyCatalog.mockResolvedValue(catalog);
});

test("workspace plan normalization preserves an explicitly assigned retention and backup policy", async () => {
  const updated = await plans.setWorkspacePlans({ userId: "admin" }, {
    expectedVersion: 1,
    plans: [newPlan("extended")],
  });
  expect(updated.plans[0].retentionPolicyId).toBe("extended");
  expect(settings.setSetting).toHaveBeenCalledWith(
    plans.KEYS.workspacePlans,
    expect.objectContaining({ plans: [expect.objectContaining({ retentionPolicyId: "extended" })] }),
  );
});

test("plans without a policy reference inherit the current platform default when saved", async () => {
  const updated = await plans.setWorkspacePlans({ userId: "admin" }, {
    expectedVersion: 1,
    plans: [newPlan(undefined)],
  });
  expect(updated.plans[0].retentionPolicyId).toBe("platform-default");
});

test("an unknown policy is rejected before updating billing settings", async () => {
  await expect(plans.setWorkspacePlans(null, {
    expectedVersion: 1,
    plans: [newPlan("deleted")],
  })).rejects.toMatchObject({ statusCode: 409 });
  expect(settings.setSetting).not.toHaveBeenCalled();
});

test("a concurrent plan change still requires reloading before assigning a policy", async () => {
  await expect(plans.setWorkspacePlans(null, {
    expectedVersion: 99,
    plans: [newPlan("extended")],
  })).rejects.toMatchObject({ statusCode: 409, code: "VERSION_CONFLICT" });
  expect(settings.setSetting).not.toHaveBeenCalled();
});
