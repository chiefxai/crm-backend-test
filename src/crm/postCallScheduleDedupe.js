const { normalizePhone } = require("../lib/phone");

const SCHEDULE_STATUS_RANK = {
  "Callback Scheduled": 3,
  "No Answer": 2,
  "Answering Machine": 1,
};

function phoneDedupeKey(callerNumber) {
  const normalized = normalizePhone(callerNumber || "");
  const digits = String(normalized || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function scheduleDedupeKey(row) {
  // One pending redial per dialed number — duplicate rows from the hangup
  // fallback race (No Answer) vs post-call finalize (Callback Scheduled)
  // often share a phone but differ in providerCallSid / retryContext.
  const phone = phoneDedupeKey(row?.callerNumber);
  if (phone) return `phone:${phone}`;
  if (row?.providerCallSid) return `sid:${row.providerCallSid}`;
  return `id:${row?.id}`;
}

function pendingScheduleRowsConflict(a, b) {
  if (!a || !b) return false;
  if (a.providerCallSid && b.providerCallSid && a.providerCallSid === b.providerCallSid) return true;
  const pa = phoneDedupeKey(a.callerNumber);
  const pb = phoneDedupeKey(b.callerNumber);
  if (pa && pb && pa === pb) return true;
  return false;
}

function dedupePendingScheduleRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = scheduleDedupeKey(row);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    const rankNew = SCHEDULE_STATUS_RANK[row.status] || 0;
    const rankOld = SCHEDULE_STATUS_RANK[existing.status] || 0;
    if (rankNew > rankOld) {
      byKey.set(key, row);
    } else if (rankNew === rankOld && String(row.createdAt || "") > String(existing.createdAt || "")) {
      byKey.set(key, row);
    }
  }
  return Array.from(byKey.values());
}

module.exports = {
  SCHEDULE_STATUS_RANK,
  scheduleDedupeKey,
  pendingScheduleRowsConflict,
  dedupePendingScheduleRows,
};
