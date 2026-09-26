const crypto = require("crypto");
const db = require("../db/repository");

async function appendLedgerEntry(orgId, entry) {
  if (!orgId) return null;
  const id = entry.id || crypto.randomUUID();
  const row = await db.create("billingledgerentries", orgId, {
    id,
    type: entry.type,
    amountInr: entry.amountInr ?? 0,
    balanceAfterInr: entry.balanceAfterInr ?? null,
    referenceType: entry.referenceType || null,
    referenceId: entry.referenceId || null,
    description: entry.description || null,
    metadata: entry.metadata || null,
    actorUserId: entry.actorUserId || null,
    actorEmail: entry.actorEmail || null,
    createdAt: entry.createdAt || new Date().toISOString(),
  });
  return row;
}

module.exports = {
  appendLedgerEntry,
};
