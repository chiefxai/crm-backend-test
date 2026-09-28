// Resolves the customer-facing app URL for emails and other outbound links.
// Prefer APP_URL in production; fall back to FRONTEND_URL or the first ALLOWED_ORIGINS entry.

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeOrigin(raw) {
  const trimmed = String(raw || "").trim().replace(/\/$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function getPublicAppUrl() {
  const explicit =
    process.env.APP_URL ||
    process.env.FRONTEND_URL ||
    process.env.PUBLIC_APP_URL ||
    "";
  const normalized = normalizeOrigin(explicit);
  if (normalized) return normalized;

  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (allowed.length) return normalizeOrigin(allowed[0]);

  if (process.env.NODE_ENV === "production") {
    return "https://crm.elvoryx.in";
  }
  return "http://localhost:5173";
}

module.exports = { getPublicAppUrl, normalizeOrigin, escapeHtml };
