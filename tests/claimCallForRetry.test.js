describe("db.claimCallForRetry", () => {
  const ORG_ID = "org-callback";
  const ROW_ID = "call_vobiz_test_1";

  let connections;

  function mockMakeConnection() {
    const conn = {
      query: jest.fn((sql) => {
        if (typeof sql === "string" && sql.includes("GET_LOCK")) {
          return Promise.resolve([[{ acquired: 1 }], undefined]);
        }
        if (typeof sql === "string" && sql.startsWith("UPDATE call_logs")) {
          return Promise.resolve([{ affectedRows: 1 }, undefined]);
        }
        if (typeof sql === "string" && sql.startsWith("SELECT * FROM call_logs")) {
          return Promise.resolve([[{ id: ROW_ID, org_id: ORG_ID, retry_status: "retrying" }], undefined]);
        }
        return Promise.resolve([[], undefined]);
      }),
      release: jest.fn(),
    };
    connections.push(conn);
    return conn;
  }

  function connectionFor(sqlFragment) {
    return connections.find((c) => c.query.mock.calls.some(([sql]) => sql.includes(sqlFragment)));
  }

  beforeEach(() => {
    jest.resetModules();
    process.env.MYSQL_URL = "mysql://test:test@localhost:3306/test";
    process.env.DB_ADAPTER = "mysql";
    connections = [];
    jest.mock("mysql2/promise", () => ({
      createPool: jest.fn(() => ({
        query: jest.fn().mockResolvedValue([[], undefined]),
        getConnection: jest.fn(() => Promise.resolve(mockMakeConnection())),
        end: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
      })),
    }));
  });

  test("uses a derived table so MySQL can update call_logs safely", async () => {
    const { claimCallForRetry } = require("../src/db/repository");
    const claimed = await claimCallForRetry(ORG_ID, ROW_ID);
    expect(claimed).toBeTruthy();
    expect(claimed.id).toBe(ROW_ID);

    const conn = connectionFor("UPDATE call_logs");
    expect(conn).toBeDefined();
    const updateCall = conn.query.mock.calls[0][0];
    expect(updateCall).toContain("AS newer_call_for_same_number");
    expect(updateCall).not.toMatch(/NOT EXISTS \(SELECT 1 FROM call_logs AS newer WHERE/);
  });
});
