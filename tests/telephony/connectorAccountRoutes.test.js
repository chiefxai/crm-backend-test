"use strict";

jest.mock("../../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => { req.orgId = "org-test"; req.workspaceId = "workspace-test"; req.userId = "user-test"; next(); },
  requirePermission: permission => (req, res, next) => {
    req.checkedPermission = permission;
    return ["organization.manage", "workspace.call"].includes(permission) ? next() : res.status(403).json({ error: "forbidden" });
  },
}));
jest.mock("../../src/telephony/registry", () => ({
  listProviderDefinitions: () => [{ providerKey: "fake-voice", credentialSchema: [], capabilities: {} }],
}));
jest.mock("../../src/telephony/connectorAccountService", () => ({
  listSupportedProviders: jest.fn(() => [{ providerKey: "fake-voice", credentialSchema: [], capabilities: {} }]),
  listAccounts: jest.fn(async owner => [owner]),
  createAccount: jest.fn(async (owner, input) => ({ id: "created", owner, input, providerKey: input.providerKey })),
  updateAccount: jest.fn(async (id, owner, input) => ({ id, owner, input, providerKey: "fake-voice" })),
}));
jest.mock("../../src/platform/auditLog", () => ({ record: jest.fn(async () => {}) }));
jest.mock("../../src/telephony/connectorInventory", () => ({
  listAssignedNumbers: jest.fn(async () => [{ id: 'number-1', provider_key: 'vobiz', phone_number_e164: '+14155550123', connector_display_name: 'Main', owner_type: 'platform', assignment_id: 'assign-1' }]),
  listInventory: jest.fn(), registerExistingNumber: jest.fn(), assignNumber: jest.fn(), releaseNumber: jest.fn(), markNumberReady: jest.fn(),
}));

const routes = require("../../src/routes/telephonyConnectors");
const service = require("../../src/telephony/connectorAccountService");
const auditLog = require("../../src/platform/auditLog");
const inventory = require("../../src/telephony/connectorInventory");

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
  delete process.env.TELEPHONY_CONNECTOR_CALL_ROUTING_ENABLED;
  jest.clearAllMocks();
});

test("organization routes are default-off and reject requests before service access", async () => {
  const response = await invoke(routes.createOrgRouter(), "GET", "/connectors");
  expect(response.status).toBe(404);
  expect(service.listAccounts).not.toHaveBeenCalled();
});

test('returns only assigned ready caller IDs for the authenticated workspace when routing is enabled', async () => {
  process.env.TELEPHONY_CONNECTOR_ACCOUNTS_ENABLED = 'true';
  process.env.TELEPHONY_CONNECTOR_CALL_ROUTING_ENABLED = 'true';
  const response = await invoke(routes.createOrgRouter(), 'GET', '/assigned-numbers');
  expect(response.status).toBe(200);
  expect(inventory.listAssignedNumbers).toHaveBeenCalledWith({ orgId: 'org-test', workspaceId: 'workspace-test' });
  expect(response.body.numbers[0]).toEqual({ id: 'number-1', providerKey: 'vobiz', phoneNumberE164: '+14155550123', displayName: null, connectorDisplayName: 'Main', ownerType: 'platform', assignmentId: 'assign-1' });
});

test("organization connector routes scope the account to req.orgId and require organization management", async () => {
  process.env.TELEPHONY_CONNECTOR_ACCOUNTS_ENABLED = "true";
  const response = await invoke(routes.createOrgRouter(), "POST", "/connectors", { providerKey: "fake-voice", credentials: { token: "do-not-log" } });
  expect(response.status).toBe(201);
  expect(service.createAccount).toHaveBeenCalledWith(
    { ownerType: "organization", ownerOrgId: "org-test" },
    { providerKey: "fake-voice", credentials: { token: "do-not-log" } },
    "user-test",
  );
  expect(JSON.stringify(auditLog.record.mock.calls)).not.toContain("do-not-log");
});

test("platform routes use only platform ownership and can disable without a delete endpoint", async () => {
  process.env.TELEPHONY_CONNECTOR_ACCOUNTS_ENABLED = "true";
  const router = routes.createPlatformRouter();
  const response = await invoke(router, "POST", "/connectors/account-1/disable");
  expect(response.status).toBe(200);
  expect(service.updateAccount).toHaveBeenCalledWith(
    "account-1", { ownerType: "platform", ownerOrgId: null }, { status: "disabled" }, undefined,
  );
  expect((await invoke(router, "DELETE", "/connectors/account-1")).status).toBe(404);
});
