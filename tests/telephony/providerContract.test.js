const {
  capabilitiesOf,
  normalizeCredentialSchema,
  providerDefinitionOf,
  validateConnector,
} = require("../../src/telephony/base");

function adapter(overrides = {}) {
  return {
    name: "contract-test-provider",
    label: "Contract Test Provider",
    wsPaths: [],
    handleUpgrade() {},
    getRouter() {},
    ...overrides,
  };
}

describe("provider-independent telephony adapter contract", () => {
  test("keeps the existing minimal adapter contract valid", () => {
    const connector = adapter({ triggerOutboundCall() {} });

    expect(validateConnector(connector)).toBe(connector);
    expect(capabilitiesOf(connector)).toMatchObject({
      inbound: false,
      outbound: true,
      streaming: false,
      numberDiscovery: false,
      numberPurchase: false,
    });
    expect(providerDefinitionOf(connector)).toMatchObject({
      providerKey: "contract-test-provider",
      name: "contract-test-provider",
      credentialSchema: [],
    });
  });

  test("exposes provider metadata and capabilities without account-specific data", () => {
    const connector = adapter({
      name: "generic-voice",
      providerKey: "generic-voice",
      credentialSchema: [
        { key: "accountId", label: "Account ID", type: "text" },
        { key: "apiSecret", label: "API Secret", type: "secret" },
      ],
      capabilities: { inbound: true, outbound: true, numberDiscovery: true },
      listNumbers() {},
    });

    expect(providerDefinitionOf(connector)).toEqual({
      providerKey: "generic-voice",
      name: "generic-voice",
      label: "Contract Test Provider",
      credentialSchema: [
        { key: "accountId", label: "Account ID", type: "text", required: true },
        { key: "apiSecret", label: "API Secret", type: "secret", required: true },
      ],
      capabilities: expect.objectContaining({
        inbound: true,
        outbound: true,
        numberDiscovery: true,
      }),
    });
    expect(JSON.stringify(providerDefinitionOf(connector))).not.toContain("accountIdValue");
  });

  test("validates provider credential schema while leaving credentials out of metadata", () => {
    expect(() => normalizeCredentialSchema("apiToken", "sample")).toThrow(/must be an array/);
    expect(() => validateConnector(adapter({ credentialSchema: [{ label: "Missing key" }] }))).toThrow(/requires a key/);
    expect(() => validateConnector(adapter({ credentialSchema: [{ key: "token", type: "object" }] }))).toThrow(/unsupported type/);
  });

  test("Vobiz definition exposes its credential field metadata without credential values", () => {
    jest.resetModules();
    jest.doMock("../../src/shared", () => ({ incrementSessions() {}, decrementSessions() {}, getActiveSessionsCount() { return 0; } }));
    jest.doMock("../../src/workspaces/scope", () => ({ runWithScope(_scope, fn) { return fn(); } }));
    jest.doMock("../../src/db/repositories/workspaceRepository", () => ({ getActive: jest.fn() }));
    jest.doMock("../../src/telephony/vobiz", () => ({}));
    jest.doMock("../../src/observability/logger", () => ({ getLogger: () => ({ info() {}, error() {} }) }));
    jest.doMock("ws", () => ({ WebSocketServer: class { on() {} } }));

    const vobiz = require("../../src/telephony/connectors/vobiz");
    const definition = providerDefinitionOf(vobiz);
    expect(definition.credentialSchema).toEqual([
      { key: "authId", label: "Auth ID", type: "text", required: true },
      { key: "authToken", label: "Auth Token", type: "secret", required: true },
    ]);
    expect(definition).not.toHaveProperty("credentials");
    expect(JSON.stringify(definition)).not.toMatch(/authTokenValue|secretValue/);
  });

  test("registry returns generic provider definitions for adapters", () => {
    jest.resetModules();
    jest.doMock("../../src/telephony/connectors/gemini", () => adapter({ name: "gemini" }));
    jest.doMock("../../src/telephony/connectors/vobiz", () => adapter({ name: "vobiz" }));
    const registry = require("../../src/telephony/registry");
    const name = `contract-test-${Date.now()}`;
    registry.register(adapter({ name, label: "Test Adapter", credentialSchema: [{ key: "token", type: "secret" }] }));

    const definition = registry.listProviderDefinitions().find((item) => item.name === name);
    expect(definition).toMatchObject({
      providerKey: name,
      label: "Test Adapter",
      credentialSchema: [{ key: "token", label: "token", type: "secret", required: true }],
    });
    expect(definition).not.toHaveProperty("credentials");
  });
});
