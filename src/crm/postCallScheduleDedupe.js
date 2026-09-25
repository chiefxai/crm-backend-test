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
  if (row?.providerCallSid) return `sid:${row.providerCallSid}`;
  const phone = phoneDedupeKey(row?.callerNumber);
  const leadId = row?.retryContext?.leadId || "";
  const taskId = row?.retryContext?.taskId || "";
  if (phone) return `phone:${phone}:${taskId}:${leadId}`;
  return `id:${row?.id}`;
}

function pendingScheduleRowsConflict(a, b) {
  if (!a || !b) return false;
  if (a.providerCallSid && b.providerCallSid && a.providerCallSid === b.providerCallSid) return true;
  const pa = phoneDedupeKey(a.callerNumber);
  const pb = phoneDedupeKey(b.callerNumber);
  if (!pa || pa !== pb) return false;
  const sameLead = String(a.retryContext?.leadId || "") === String(b.retryContext?.leadId || "");
  const sameTask = String(a.retryContext?.taskId || "") === String(b.retryContext?.taskId || "");
  return sameLead && sameTask;
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
  const merged = Array.from(byKey.values());
  const winners = [];
  for (const row of merged) {
    const conflictIdx = winners.findIndex((w) => pendingScheduleRowsConflict(w, row));
    if (conflictIdx === -1) {
      winners.push(row);
      continue;
    }
    const existing = winners[conflictIdx];
    const rankNew = SCHEDULE_STATUS_RANK[row.status] || 0;
    const rankOld = SCHEDULE_STATUS_RANK[existing.status] || 0;
    if (rankNew > rankOld) winners[conflictIdx] = row;
    else if (rankNew === rankOld && String(row.createdAt || "") > String(existing.createdAt || "")) {
      winners[conflictIdx] = row;
    }
  }
  return winners;
}

module.exports = {
  SCHEDULE_STATUS_RANK,
  scheduleDedupeKey,
  pendingScheduleRowsConflict,
  dedupePendingScheduleRows,
};
