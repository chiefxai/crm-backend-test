const { dedupePendingScheduleRows } = require("../src/crm/postCallScheduleDedupe");

describe("postCallScheduleDedupe", () => {
  test("prefers callback scheduled over no answer for the same provider call", () => {
    const rows = dedupePendingScheduleRows([
      {
        id: "a",
        status: "No Answer",
        providerCallSid: "uuid-1",
        callerNumber: "+919876543210",
        createdAt: "2026-09-25T10:00:00.000Z",
      },
      {
        id: "b",
        status: "Callback Scheduled",
        providerCallSid: "uuid-1",
        callerNumber: "+919876543210",
        createdAt: "2026-09-25T10:00:01.000Z",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("b");
    expect(rows[0].status).toBe("Callback Scheduled");
  });

  test("collapses callback and no-answer duplicates that only share the same phone", () => {
    const rows = dedupePendingScheduleRows([
      {
        id: "fallback",
        status: "No Answer",
        providerCallSid: "vobiz-uuid",
        callerNumber: "+919876543210",
        retryContext: {},
        createdAt: "2026-09-25T10:00:00.000Z",
      },
      {
        id: "real",
        status: "Callback Scheduled",
        providerCallSid: "call_vobiz_internal_1",
        callerNumber: "+919876543210",
        retryContext: { taskId: "T-1", leadId: "L-1" },
        createdAt: "2026-09-25T10:00:02.000Z",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("real");
  });

  test("keeps separate pending callbacks for the same phone in different campaigns", () => {
    const rows = dedupePendingScheduleRows([
      {
        id: "cb-a",
        status: "Callback Scheduled",
        callerNumber: "+919876543210",
        retryContext: { taskId: "campaign-a", leadId: "L-1" },
        createdAt: "2026-09-25T10:00:00.000Z",
      },
      {
        id: "cb-b",
        status: "Callback Scheduled",
        callerNumber: "+919876543210",
        retryContext: { taskId: "campaign-b", leadId: "L-1" },
        createdAt: "2026-09-25T10:05:00.000Z",
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual(["cb-a", "cb-b"]);
  });
});
