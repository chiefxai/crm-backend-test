"use strict";

jest.mock("../../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => { req.orgId = "org-authenticated"; req.userId = "user-authenticated"; req.userEmail = "user@example.test"; next(); },
  requirePermission: permission => (_req, res, next) => permission === "organization.manage"
    ? next() : res.status(403).json({ error: "forbidden" }),
}));
jest.mock("../../src/telephony/connectorAccountService", () => ({
  listSupportedProviders: jest.fn(() => []),
  listAccounts: jest.fn(async () => []),
  createAccount: jest.fn(),
  updateAccount: jest.fn(),
}));
jest.mock("../../src/telephony/connectorInventory", () => ({
  listInventory: jest.fn(async () => []),
  registerExistingNumber: jest.fn(async input => ({ id: "number-created", ...input })),
  assignNumber: jest.fn(async input => ({ id: "assignment-created", phoneNumberId: input.phoneNumberId,
    orgId: input.orgId, workspaceId: input.workspaceId })),
  releaseNumber: jest.fn(async input => ({ id: "assignment-released", phoneNumberId: input.phoneNumberId,
    orgId: input.orgId, releaseReason: input.reason })),
}));
jest.mock("../../src/platform/auditLog", () => ({ record: jest.fn(async () => {}) }));

const routes = require("../../src/routes/telephonyConnectors");
const inventory = require("../../src/telephony/connectorInventory");
const auditLog = require("../../src/platform/auditLog");

function invoke(router, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = { method, url: path, originalUrl: path, path, body, headers: {}, get: () => undefined };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(value) { resolve({ status: this.statusCode, body: value }); return this; },
    };
    router.handle(req, res, error => error ? reject(error) : resolve({ status: 404, body: null }));
  });
}

afterEach(() => {
  delete process.env.TELEPHONY_CONNECTOR_ACCOUNTS_ENABLED;
  jest.clearAllMocks();
});

test("inventory endpoints stay default-off for platform and organization routes", async () => {
  const platform = await invoke(routes.createPlatformRouter(), "GET", "/connectors/c-1/numbers");
  const organization = await invoke(routes.createOrgRouter(), "POST", "/numbers/n-1/assign", { workspaceId: "w-1" });
  expect(platform.status).toBe(404);
  expect(organization.status).toBe(404);
  expect(inventory.listInventory).not.toHaveBeenCalled();
  expect(inventory.assignNumber).not.toHaveBeenCalled();
});

test("platform inventory registration and assignment use platform scope and explicit assignment targets", async () => {
  process.env.TELEPHONY_CONNECTOR_ACCOUNTS_ENABLED = "true";
  const router = routes.createPlatformRouter();
  const registration = await invoke(router, "POST", "/connectors/connector-1/numbers", {
    phoneNumberE164: "+14155550123", ownerType: "organization", ownerOrgId: "spoofed-org", connectorAccountId: "spoofed-connector",
  });
  expect(registration.status).toBe(201);
  expect(inventory.registerExistingNumber).toHaveBeenCalledWith({
    actor: { type: "platform", orgId: null },
    connectorAccountId: "connector-1",
    phoneNumberE164: "+14155550123",
    providerNumberId: undefined,
    displayName: undefined,
  });

  await invoke(router, "POST", "/numbers/number-1/assign", { orgId: "target-org", workspaceId: "target-workspace" });
  expect(inventory.assignNumber).toHaveBeenCalledWith(expect.objectContaining({
    actor: { type: "platform", orgId: null }, phoneNumberId: "number-1", orgId: "target-org", workspaceId: "target-workspace",
  }));
  expect(JSON.stringify(auditLog.record.mock.calls)).not.toContain("+14155550123");
});

test("organization inventory derives ownership and assignment org only from authenticated context", async () => {
  process.env.TELEPHONY_CONNECTOR_ACCOUNTS_ENABLED = "true";
  const router = routes.createOrgRouter();
  await invoke(router, "GET", "/connectors/own-connector/numbers");
  expect(inventory.listInventory).toHaveBeenCalledWith({
    actor: { type: "organization", orgId: "org-authenticated" }, connectorAccountId: "own-connector",
  });

  await invoke(router, "POST", "/connectors/own-connector/numbers", {
    phoneNumberE164: "+14155550124", ownerType: "platform", ownerOrgId: "other-org", connectorAccountId: "other-connector",
  });
  expect(inventory.registerExistingNumber).toHaveBeenCalledWith({
    actor: { type: "organization", orgId: "org-authenticated" },
    connectorAccountId: "own-connector",
    phoneNumberE164: "+14155550124",
    providerNumberId: undefined,
    displayName: undefined,
  });

  await invoke(router, "POST", "/numbers/number-2/assign", { orgId: "spoofed-org", workspaceId: "workspace-authenticated" });
  expect(inventory.assignNumber).toHaveBeenCalledWith(expect.objectContaining({
    actor: { type: "organization", orgId: "org-authenticated" },
    phoneNumberId: "number-2", orgId: "org-authenticated", workspaceId: "workspace-authenticated",
  }));

  await invoke(router, "POST", "/numbers/number-2/release", { orgId: "spoofed-org", reason: "customer requested" });
  expect(inventory.releaseNumber).toHaveBeenCalledWith(expect.objectContaining({
    actor: { type: "organization", orgId: "org-authenticated" }, phoneNumberId: "number-2", orgId: "org-authenticated",
  }));
  expect(JSON.stringify(auditLog.record.mock.calls)).not.toContain("customer requested");
});
