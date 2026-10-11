// Match legacy email-only invitations as normalized addresses, never as SQL
// patterns. Keeping this pure also makes the wildcard edge cases testable.
function matchMembershipsByNormalizedEmail(rows, email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return [];
  return (rows || []).filter((row) =>
    typeof row.email === "string" && row.email.trim().toLowerCase() === normalizedEmail
  );
}

module.exports = { matchMembershipsByNormalizedEmail };
