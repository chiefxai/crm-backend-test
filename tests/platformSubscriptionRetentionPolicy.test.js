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
    includedSeats: 1,
    maxSeats: null,
    extraSeatMonthlyInr: 0,
    additionalIndustryMonthlyInr: 0,
    monthlySubscriptionCreditsInr: 0,
  },
});
const updatedPlans = (retentionPolicyId) => plans.DEFAULT_WORKSPACE_PLANS.plans.map(plan =>
  plan.id === "starter" ? newPlan(retentionPolicyId) : plan);

beforeEach(() => {
  jest.clearAllMocks();
  settings.getSetting.mockResolvedValue(null);
  settings.setSetting.mockImplementation(async (_key, value) => value);
  retention.getPolicyCatalog.mockResolvedValue(catalog);
});

test("workspace plan normalization preserves an explicitly assigned retention and backup policy", async () => {
  const updated = await plans.setWorkspacePlans({ userId: "admin" }, {
    expectedVersion: 1,
    plans: updatedPlans("extended"),
  });
  expect(updated.plans[0].retentionPolicyId).toBe("extended");
  expect(settings.setSetting).toHaveBeenCalledWith(
    plans.KEYS.workspacePlans,
    expect.objectContaining({ plans: expect.arrayContaining([expect.objectContaining({ retentionPolicyId: "extended" })]) }),
  );
});

test("plans without a policy reference inherit the current platform default when saved", async () => {
  const updated = await plans.setWorkspacePlans({ userId: "admin" }, {
    expectedVersion: 1,
    plans: updatedPlans(undefined),
  });
  expect(updated.plans[0].retentionPolicyId).toBe("platform-default");
});

test("an unknown policy is rejected before updating billing settings", async () => {
  await expect(plans.setWorkspacePlans(null, {
    expectedVersion: 1,
    plans: updatedPlans("deleted"),
  })).rejects.toMatchObject({ statusCode: 409 });
  expect(settings.setSetting).not.toHaveBeenCalled();
});

test("a concurrent plan change still requires reloading before assigning a policy", async () => {
  await expect(plans.setWorkspacePlans(null, {
    expectedVersion: 99,
    plans: updatedPlans("extended"),
  })).rejects.toMatchObject({ statusCode: 409, code: "VERSION_CONFLICT" });
  expect(settings.setSetting).not.toHaveBeenCalled();
});

const subscriptionTermsPolicy = {
  includedDistinctIndustries: 1,
  maxDistinctIndustries: null,
  taxes: [],
  postpaid: { eligible: false, workspaceModes: [], organizationExposureLimit: null },
  serviceAfterExpiry: { mode: "suspend", graceSeconds: 0 },
};

test("subscription billing terms provide conservative starter defaults until configured", async () => {
  const result = await plans.getSubscriptionTermsPolicy();
  expect(result).toMatchObject({
    configured: true, source: "system_default", version: 1,
    policy: { includedDistinctIndustries: 1, maxDistinctIndustries: null, taxes: [],
      postpaid: { eligible: false, workspaceModes: [], organizationExposureLimit: null },
      serviceAfterExpiry: { mode: "suspend", graceSeconds: 0 } },
  });
  const { mapWorkspacePlanToTerms } = require('../src/billing/modules/catalog/workspacePlanMapper');
  expect(mapWorkspacePlanToTerms({ id: 'enterprise', active: true, name: 'Enterprise', defaultMode: 'mixed_industry',
    pricing: { baseMonthlyInr: 3000, includedWorkspaces: 2, maxWorkspaces: 10, extraWorkspaceMonthlyInr: 0,
      includedSeats: 20, maxSeats: null, extraSeatMonthlyInr: 0, additionalIndustryMonthlyInr: 0,
      monthlySubscriptionCreditsInr: 0 } }, result.policy).structure.maxDistinctIndustries).toBeNull();
});

test("subscription billing policy uses an expected version and preserves explicit zero-tax configuration", async () => {
  const updated = await plans.setSubscriptionTermsPolicy({ userId: "admin" }, {
    expectedVersion: 1,
    policy: subscriptionTermsPolicy,
  });
  expect(updated).toMatchObject({ configured: true, version: 2, policy: subscriptionTermsPolicy, updatedBy: "admin" });
  expect(settings.setSetting).toHaveBeenCalledWith(plans.KEYS.subscriptionTermsPolicy, expect.objectContaining({
    version: 2, policy: subscriptionTermsPolicy,
  }));
});

test("subscription billing policy rejects stale versions and malformed tax rules", async () => {
  await expect(plans.setSubscriptionTermsPolicy(null, { expectedVersion: 0, policy: subscriptionTermsPolicy }))
    .rejects.toMatchObject({ statusCode: 409, code: "VERSION_CONFLICT" });
  await expect(plans.setSubscriptionTermsPolicy(null, { expectedVersion: 1, policy: { ...subscriptionTermsPolicy, taxes: [{ code: "GST", rateBps: 18000, appliesTo: ["subscription"], inclusive: true }] } }))
    .rejects.toMatchObject({ statusCode: 400 });
  expect(settings.setSetting).not.toHaveBeenCalled();
});
