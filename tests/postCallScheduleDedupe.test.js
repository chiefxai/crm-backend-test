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
});
