"use strict";

const mockRowsById = new Map();
const mockState = { activeRoutes: [] };

jest.mock("../../src/db/repository", () => ({
  pool: { query: jest.fn(async (sql, params) => {
    if (sql.includes("FROM telephony_call_routes")) return { rows: mockState.activeRoutes };
    if (sql.startsWith("INSERT INTO telephony_connector_accounts")) {
      const [id, providerKey, displayName, ownerType, ownerOrgId, providerAccountId, ciphertext, createdBy, updatedBy, createdAt, updatedAt] = params;
      mockRowsById.set(id, {
        id, provider_key: providerKey, display_name: displayName, owner_type: ownerType, owner_org_id: ownerOrgId,
        provider_account_id: providerAccountId, credential_ciphertext: ciphertext, credential_schema_version: 1, credential_version: 1,
        public_config_json: null, status: "active", created_by: createdBy, updated_by: updatedBy,
        created_at: createdAt, updated_at: updatedAt,
      });
      return { rows: [] };
    }
    if (sql.startsWith("SELECT")) {
      if (sql.includes("WHERE id=?")) {
        const [id, ownerType, firstOrgId] = params;
        const row = mockRowsById.get(id);
        return { rows: row && row.owner_type === ownerType && row.owner_org_id === firstOrgId ? [row] : [] };
      }
      const [ownerType, , firstOrgId] = params;
      return { rows: [...mockRowsById.values()].filter(row => row.owner_type === ownerType && row.owner_org_id === firstOrgId) };
    }
    if (sql.startsWith("UPDATE telephony_connector_accounts")) {
      const [displayName, providerAccountId, ciphertext, credentialVersion, status, updatedBy, updatedAt, id] = params;
      const row = mockRowsById.get(id);
      if (row) Object.assign(row, { display_name: displayName, provider_account_id: providerAccountId,
        credential_ciphertext: ciphertext, credential_version: credentialVersion, status, updated_by: updatedBy, updated_at: updatedAt });
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  }) }
}));
jest.mock("../../src/telephony/registry", () => ({
  listProviderDefinitions: () => [{
    providerKey: "fake-voice",
    credentialSchema: [
      { key: "accountId", required: true },
      { key: "authToken", required: true, type: "secret" },
      { key: "region", required: false },
    ],
  }],
}));
jest.mock("../../src/security/channelCredentials", () => ({
  encryptJson: value => `ciphertext:${JSON.stringify(value)}`,
  decryptJson: value => JSON.parse(value.slice("ciphertext:".length)),
}));

const service = require("../../src/telephony/connectorAccountService");
const db = require("../../src/db/repository");
db.pool.connect = jest.fn(async () => ({
  query: async (sql, params) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    return db.pool.query(sql, params);
  },
  release: jest.fn(),
}));

beforeEach(() => {
  mockRowsById.clear();
  mockState.activeRoutes = [];
  db.pool.query.mockClear();
});

test("creates multiple accounts for one provider and never exposes credential material", async () => {
  const owner = { ownerType: "platform", ownerOrgId: null };
  const first = await service.createAccount(owner, {
    providerKey: "fake-voice", displayName: "Main account", providerAccountId: "account-1",
    credentials: { accountId: "id-1", authToken: "secret-1" },
  }, "admin");
  const second = await service.createAccount(owner, {
    providerKey: "fake-voice", displayName: "Backup account", providerAccountId: "account-2",
    credentials: { accountId: "id-2", authToken: "secret-2" },
  }, "admin");

  expect((await service.listAccounts(owner)).map(row => row.id)).toEqual(expect.arrayContaining([second.id, first.id]));
  expect(first).toMatchObject({ ownerType: "platform", providerKey: "fake-voice", credentialFieldsConfigured: true });
  expect(JSON.stringify(first)).not.toContain("secret-1");
  expect(JSON.stringify(first)).not.toContain("ciphertext");
  expect(JSON.stringify(first)).not.toContain("credential_ciphertext");
});

test("credential rotation merges submitted values and retains omitted required secrets", async () => {
  const owner = { ownerType: "organization", ownerOrgId: "org-a" };
  const created = await service.createAccount(owner, {
    providerKey: "fake-voice", displayName: "Org account",
    credentials: { accountId: "id-a", authToken: "keep-this", region: "west" },
  }, "user-a");
  const updated = await service.updateAccount(created.id, owner, {
    credentials: { accountId: "id-a-rotated" },
  }, "user-a");
  const stored = mockRowsById.get(created.id);

  expect(updated.ownerOrgId).toBe("org-a");
  expect(updated.credentialVersion).toBe(2);
  expect(updated.credentialSchemaVersion).toBe(1);
  expect(require("../../src/security/channelCredentials").decryptJson(stored.credential_ciphertext)).toEqual({
    accountId: "id-a-rotated", authToken: "keep-this", region: "west",
  });
  expect(JSON.stringify(updated)).not.toContain("keep-this");
});

test("blocks credential rotation while a call route is active", async () => {
  const owner = { ownerType: "platform", ownerOrgId: null };
  const created = await service.createAccount(owner, {
    providerKey: "fake-voice", displayName: "In use", credentials: { accountId: "a", authToken: "old-secret" },
  });
  mockState.activeRoutes = [{ id: "route-active" }];
  await expect(service.updateAccount(created.id, owner, { credentials: { authToken: "new-secret" } }))
    .rejects.toMatchObject({ statusCode: 409, message: "Cannot rotate credentials while calls are active on this connector" });
  expect(mockRowsById.get(created.id).credential_version).toBe(1);
});

test("rejects unknown providers, undeclared fields, and cross-owner access", async () => {
  await expect(service.createAccount({ ownerType: "platform", ownerOrgId: null }, {
    providerKey: "Vobiz", displayName: "bad", credentials: { accountId: "x", authToken: "y" },
  })).rejects.toMatchObject({ statusCode: 400 });
  await expect(service.createAccount({ ownerType: "platform", ownerOrgId: null }, {
    providerKey: "fake-voice", displayName: "bad", credentials: { accountId: "x", authToken: "y", injected: "secret" },
  })).rejects.toMatchObject({ statusCode: 400 });
  const created = await service.createAccount({ ownerType: "organization", ownerOrgId: "org-a" }, {
    providerKey: "fake-voice", displayName: "Scoped", credentials: { accountId: "x", authToken: "y" },
  });
  await expect(service.updateAccount(created.id, { ownerType: "organization", ownerOrgId: "org-b" }, { displayName: "stolen" }))
    .rejects.toMatchObject({ statusCode: 404 });
});

test("disables an account without deleting its record or credential ciphertext", async () => {
  const owner = { ownerType: "platform", ownerOrgId: null };
  const created = await service.createAccount(owner, {
    providerKey: "fake-voice", displayName: "Disable me", credentials: { accountId: "x", authToken: "secret" },
  });
  const disabled = await service.updateAccount(created.id, owner, { status: "disabled" });
  expect(disabled.status).toBe("disabled");
  expect(mockRowsById.has(created.id)).toBe(true);
});
