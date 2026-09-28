"use strict";

function isDuplicateKeyError(err) {
  const code = err?.code || err?.errno;
  if (code === "ER_DUP_ENTRY" || code === 23505 || code === 1062) return true;
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("duplicate entry") || msg.includes("duplicate key") || msg.includes("unique constraint");
}

module.exports = { isDuplicateKeyError };
