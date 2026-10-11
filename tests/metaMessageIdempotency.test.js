const { test, expect } = require("@jest/globals");
const metaMessageMigration = require("../src/db/migrations/2026100724-meta-message-deduplication");

const storedMessages = new Map();
let readCount = 0;
let releaseLookups;
const bothLookups = new Promise(resolve => { releaseLookups = resolve; });

function mockFakeSupabase() {
  return {
    from(table) {
      const query = { table, filters: [], row: null, operation: "read" };
      query.select = function () { this.operation = "read"; return this; };
      query.eq = function (column, value) { this.filters.push([column, value]); return this; };
      query.maybeSingle = async function () {
        readCount += 1;
        if (readCount === 2) releaseLookups();
        await bothLookups;
        const key = `${this.filters.find(([name]) => name === "org_id")?.[1]}:${this.filters.find(([name]) => name === "external_message_id")?.[1]}`;
        return { data: storedMessages.get(key) || null, error: null };
      };
      query.insert = function (row) { this.operation = "insert"; this.row = row; return this; };
      query.single = async function () {
        const row = this.row;
        const key = `${row.org_id}:${row.external_message_id}`;
        // Models the database unique constraint rejecting the second insert.
        if (storedMessages.has(key)) return { data: null, error: { code: "ER_DUP_ENTRY", message: "duplicate provider ID" } };
        storedMessages.set(key, row);
        return { data: row, error: null };
      };
      query.update = function () { this.operation = "update"; return this; };
      return query;
    },
  };
}

jest.mock("../src/db/repository", () => ({ supabase: mockFakeSupabase() }));
const channelsEngine = require("../src/channels/engine");

describe("Meta provider message idempotency", () => {
  test("migration bounds nullable external IDs and creates a scoped unique key", () => {
    expect(metaMessageMigration.steps.some(step => /external_message_id VARCHAR\(191\).*NULL/.test(step.sql))).toBe(true);
    expect(metaMessageMigration.steps.some(step => /CREATE UNIQUE INDEX uq_messages_provider_external_id ON messages \(org_id,external_message_id\)/.test(step.sql))).toBe(true);
    expect(metaMessageMigration.steps.some(step => /SET duplicate_row\.external_message_id=NULL/.test(step.sql))).toBe(true);
    expect(metaMessageMigration.steps.some(step => /COALESCE\(canonical_row\.created_at,''\)/.test(step.sql))).toBe(true);
  });

  test("concurrent retries converge on one row and only one is treated as new", async () => {
    const payload = {
      direction: "inbound", sender: "contact", body: "Hi", messageType: "text", externalMessageId: "wamid-unique",
    };
    const [first, retry] = await Promise.all([
      channelsEngine.addMessage("org-1", "conversation-1", payload),
      // Duplicate first-message retries can race into separate conversation
      // rows; the provider ID must still dedupe at the organization boundary.
      channelsEngine.addMessage("org-1", "conversation-2", payload),
    ]);

    expect(storedMessages.size).toBe(1);
    expect([first.duplicate, retry.duplicate].sort()).toEqual([false, true]);
  });
});
