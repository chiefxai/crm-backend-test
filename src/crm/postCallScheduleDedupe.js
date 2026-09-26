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

function campaignTaskId(row) {
  const id = row?.retryContext?.taskId;
  return id ? String(id) : null;
}

function scheduleDedupeKey(row) {
  const phone = phoneDedupeKey(row?.callerNumber);
  const taskId = campaignTaskId(row);
  if (phone && taskId) return `phone:${phone}:task:${taskId}`;
  if (phone) return `phone:${phone}`;
  if (row?.providerCallSid) return `sid:${row.providerCallSid}`;
  return `id:${row?.id}`;
}

function pendingScheduleRowsConflict(a, b) {
  if (!a || !b) return false;
  if (a.providerCallSid && b.providerCallSid && a.providerCallSid === b.providerCallSid) return true;
  const pa = phoneDedupeKey(a.callerNumber);
  const pb = phoneDedupeKey(b.callerNumber);
  if (!pa || !pb || pa !== pb) return false;
  const ta = campaignTaskId(a);
  const tb = campaignTaskId(b);
  // Same number in two different campaigns → separate pending callbacks.
  if (ta && tb && ta !== tb) return false;
  // Same campaign, or hangup-race row missing taskId vs outbound row that has it.
  return true;
}

function pickPreferredScheduleRow(existing, row) {
  const rankNew = SCHEDULE_STATUS_RANK[row.status] || 0;
  const rankOld = SCHEDULE_STATUS_RANK[existing.status] || 0;
  if (rankNew > rankOld) return row;
  if (rankNew < rankOld) return existing;
  return String(row.createdAt || "") > String(existing.createdAt || "") ? row : existing;
}

function dedupePendingScheduleRows(rows) {
  const winners = [];
  for (const row of rows) {
    const conflictIdx = winners.findIndex((w) => pendingScheduleRowsConflict(w, row));
    if (conflictIdx === -1) {
      winners.push(row);
      continue;
    }
    winners[conflictIdx] = pickPreferredScheduleRow(winners[conflictIdx], row);
  }
  return winners;
}

module.exports = {
  SCHEDULE_STATUS_RANK,
  campaignTaskId,
  scheduleDedupeKey,
  pendingScheduleRowsConflict,
  dedupePendingScheduleRows,
};
