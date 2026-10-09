jest.mock("../src/db/repository", () => ({
  getOrg: jest.fn(),
  updateOrg: jest.fn(),
}));
jest.mock("../src/db/repositories/workspaceRepository", () => ({}));
jest.mock("../src/workspaces/scope", () => ({ runWithScope: jest.fn() }));
jest.mock("../src/platform/settings", () => ({
  getSetting: jest.fn(),
  setSetting: jest.fn(),
}));
jest.mock("../src/storage", () => ({}));
jest.mock("../src/storage/client", () => ({ getClient: jest.fn() }));
jest.mock("../src/email/mailer", () => ({ sendMail: jest.fn() }));
jest.mock("../src/email/templates", () => ({}));
jest.mock("../src/platform/auditLog", () => ({ record: jest.fn() }));
jest.mock("../src/observability/logger", () => ({
  getLogger: () => ({ error: jest.fn(), warn: jest.fn() }),
}));

const settings = require("../src/platform/settings");
const db = require("../src/db/repository");
const retention = require("../src/platform/dataRetention");
const store = new Map();

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
  settings.getSetting.mockImplementation(async (key, fallback) =>
    store.has(key) ? store.get(key) : fallback);
  settings.setSetting.mockImplementation(async (key, value) => {
    store.set(key, value);
    return value;
  });
  db.getOrg.mockResolvedValue(null);
});

function template(id, backupEnabled = false) {
  return {
    id, name: id, description: "",
    retention: { ...retention.DEFAULT_POLICY },
    backup: { enabled: backupEnabled, frequency: "weekly", retentionDays: 90 },
  };
}

test("migrates legacy defaults into an initial combined default catalog", async () => {
  store.set("data_retention.defaults", { ...retention.DEFAULT_POLICY, transcripts: 90 });
  const result = await retention.getPolicyCatalog();
  expect(result.version).toBe(0);
  expect(result.defaultPolicyId).toBe("platform-default");
  expect(result.policies).toHaveLength(1);
  expect(result.policies[0].retention.transcripts).toBe(90);
  expect(result.policies[0].backup.enabled).toBe(false);
});

test("catalog saves multiple policies and reads the selected default for legacy organizations", async () => {
  const catalog = await retention.setPolicyCatalog({
    expectedVersion: 0,
    defaultPolicyId: "strict",
    policies: [template("platform-default"), {
      ...template("strict", true),
      retention: { ...retention.DEFAULT_POLICY, call_recordings: 30 },
    }],
  });
  expect(catalog.version).toBe(1);
  expect(catalog.policies).toHaveLength(2);
  expect(await retention.getPlatformDefaults()).toMatchObject({ call_recordings: 30 });
  expect(store.get("data_retention.defaults").call_recordings).toBe(30);
});

test("catalog validates unique names, default existence and optimistic version", async () => {
  const valid = {
    expectedVersion: 0, defaultPolicyId: "platform-default",
    policies: [template("platform-default")],
  };
  await expect(retention.setPolicyCatalog({ ...valid, expectedVersion: 2 }))
    .rejects.toMatchObject({ statusCode: 409 });
  await expect(retention.setPolicyCatalog({ ...valid, defaultPolicyId: "absent" }))
    .rejects.toMatchObject({ statusCode: 400 });
  await expect(retention.setPolicyCatalog({
    ...valid, policies: [template("platform-default"), { ...template("second"), name: "platform-default" }],
  })).rejects.toMatchObject({ statusCode: 400 });
});

test("backup-enabled templates require a per-org admin email", async () => {
  await retention.setPolicyCatalog({
    expectedVersion: 0, defaultPolicyId: "platform-default",
    policies: [template("platform-default", true)],
  });
  await expect(retention.resolveRetentionTemplate("platform-default", ""))
    .rejects.toThrow(/admin email/);
  const resolved = await retention.resolveRetentionTemplate("platform-default", "Admin@Example.org");
  expect(resolved).toMatchObject({
    policyId: "platform-default",
    backup: { enabled: true, email: "admin@example.org", frequency: "weekly", retentionDays: 90 },
  });
});

test("organization creation rejects a stale template revision", async () => {
  await retention.setPolicyCatalog({
    expectedVersion: 0, defaultPolicyId: "platform-default",
    policies: [template("platform-default")],
  });
  await expect(retention.resolveRetentionTemplate("platform-default", "admin@example.org", 0))
    .rejects.toMatchObject({ statusCode: 409 });
  await expect(retention.resolveRetentionTemplate("platform-default", "admin@example.org", 1))
    .resolves.toMatchObject({ policyId: "platform-default" });
});

test("organization snapshot overrides read from flattened repository settings", async () => {
  db.getOrg.mockResolvedValue({
    id: "org-one",
    dataRetention: {
      mode: "custom", policyId: "strict", policyName: "Strict",
      overrides: { ...retention.DEFAULT_POLICY, transcripts: 30 },
    },
    dataBackup: { enabled: true, frequency: "daily", retentionDays: 90, email: "org@example.org" },
  });
  const result = await retention.getOrgPolicy("org-one");
  expect(result.mode).toBe("custom");
  expect(result.policy.transcripts).toBe(30);
  expect(result.policyId).toBe("strict");
  expect(result.backup.email).toBe("org@example.org");
});

test("legacy default-mode organizations continue inheriting the active default", async () => {
  db.getOrg.mockResolvedValue({ id: "old-org", dataRetention: { mode: "default" } });
  await retention.setPolicyCatalog({
    expectedVersion: 0, defaultPolicyId: "platform-default",
    policies: [{ ...template("platform-default"), retention: { ...retention.DEFAULT_POLICY, audit_logs: 180 } }],
  });
  const resolved = await retention.getOrgPolicy("old-org");
  expect(resolved.mode).toBe("default");
  expect(resolved.policy.audit_logs).toBe(180);
});
