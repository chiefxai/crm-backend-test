const { broadcastLog, logClients, addLogClient, removeLogClient } = require("../src/shared");
const { runWithScope, runWithoutScope } = require("../src/workspaces/scope");

describe("scoped activity broadcasts", () => {
  afterEach(() => {
    for (const client of [...logClients]) removeLogClient(client);
  });

  test("derives organization and workspace from the authenticated async scope", () => {
    const writes = [];
    const client = { orgId: "org-1", workspaceId: "ws-1", res: { write: value => writes.push(value) } };
    addLogClient(client);
    runWithScope({ orgId: "org-1", workspaceId: "ws-1" }, () => broadcastLog("Lead created", { type: "lead" }));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0].slice(6)).orgId).toBe("org-1");
    expect(JSON.parse(writes[0].slice(6)).workspaceId).toBe("ws-1");
  });

  test("drops events without a trusted explicit or async organization", () => {
    const writes = [];
    const client = { orgId: "org-1", workspaceId: "ws-1", res: { write: value => writes.push(value) } };
    addLogClient(client);
    runWithoutScope(() => broadcastLog("Unscoped event", { type: "system" }));
    expect(writes).toHaveLength(0);
  });

  test("rejects a supplied organization that conflicts with the active scope", () => {
    const writes = [];
    const client = { orgId: "org-1", workspaceId: "ws-1", res: { write: value => writes.push(value) } };
    addLogClient(client);
    runWithScope({ orgId: "org-1", workspaceId: "ws-1" }, () => broadcastLog("Wrong org", { orgId: "org-2" }));
    expect(writes).toHaveLength(0);
  });
});
