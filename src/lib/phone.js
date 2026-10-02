// Phone number normalization — E.164 storage, readable display.
// Handles Indian numbers (the primary use-case) and falls back gracefully
// for any other format so nothing is lost. The canonical stored identity is
// E.164 (+91XXXXXXXXXX for Indian mobile numbers).

/**
 * Normalize to E.164. Examples:
 *   9876543210      → +919876543210
 *   09876543210     → +919876543210
 *   919876543210    → +919876543210
 *   +919876543210   → +919876543210  (already correct)
 *   +14155552671    → +14155552671   (non-Indian, returned as-is after stripping spaces)
 */
const DEFAULT_PHONE_COUNTRY = String(process.env.DEFAULT_PHONE_COUNTRY || "IN").toUpperCase();
const COUNTRY_CODES = {
  IN: "+91",
  US: "+1",
  CA: "+1",
  GB: "+44",
  AE: "+971",
};

function getDefaultCountryCode(country = DEFAULT_PHONE_COUNTRY) {
  return COUNTRY_CODES[String(country || DEFAULT_PHONE_COUNTRY).toUpperCase()] || "+91";
}

function normalizePhone(raw, options = {}) {
  if (!raw) return raw;
  let n = String(raw).replace(/[\s\-\(\)]/g, '');

  // Already valid E.164
  if (/^\+\d{7,15}$/.test(n)) return n;

  // Indian: 10-digit mobile starting with 6-9
  if (/^[6-9]\d{9}$/.test(n)) return '+91' + n;

  // Indian with leading 0: 09876543210
  if (/^0([6-9]\d{9})$/.test(n)) return '+91' + n.slice(1);

  // Indian without +: 919876543210
  if (/^91([6-9]\d{9})$/.test(n)) return '+' + n;

  // Return cleaned but unknown format as-is
  return n;
}

/**
 * Format for display. Examples:
 *   +919876543210  → +91 98765 43210
 *   +14155552671   → +1 415 555 2671  (US-style grouping)
 *   anything else  → returned as-is
 */
/**
 * Normalize a user-input phone field while preserving the distinction between
 * an empty/incomplete number and a real E.164 phone identity.
 * For now India is the default; set DEFAULT_PHONE_COUNTRY when expanding.
 */
function normalizePhoneInput(raw, options = {}) {
  const countryCode = getDefaultCountryCode(options.country || DEFAULT_PHONE_COUNTRY);
  if (!raw || !String(raw).trim()) return countryCode;
  const value = normalizePhone(raw, options);
  return value || countryCode;
}

function isCompletePhone(raw) {
  if (!raw) return false;
  const n = String(raw).trim();
  return /^\+\d{7,15}$/.test(n) && n.length > 3;
}

function formatPhone(raw) {
  if (!raw) return raw;
  const n = normalizePhone(raw);

  // Indian E.164: +91 + 10 digits
  const ind = n.match(/^\+91([6-9]\d{4})(\d{5})$/);
  if (ind) return `+91 ${ind[1]} ${ind[2]}`;

  // US/CA E.164: +1 + 10 digits
  const us = n.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (us) return `+1 ${us[1]} ${us[2]} ${us[3]}`;

  return n;
}

/**
 * True when `raw` looks like an actual phone number rather than a
 * placeholder the AI wrote in because a field asked for one and it had
 * nothing real to put there ("Unknown", "N/A", "not provided", ""...).
 * Used before trusting an LLM tool-call argument as a real phone value.
 */
function looksLikePhone(raw) {
  if (!raw) return false;
  const digits = String(raw).replace(/\D/g, '');
  return digits.length >= 7;
}

// Same idea as looksLikePhone, for a `name` argument — the AI sometimes
// writes in a placeholder ("Unknown", "N/A", "Unknown Caller", "caller")
// instead of leaving the field blank when it never actually learned the
// caller's name. Used before trusting an LLM tool-call's name argument,
// or before overwriting an existing contact's real saved name with it.
const NAME_PLACEHOLDERS = new Set([
  "unknown", "unknown caller", "n/a", "na", "none", "not provided",
  "not given", "no name", "caller", "unnamed", "unnamed contact",
]);
function looksLikeRealName(raw) {
  if (!raw) return false;
  const trimmed = String(raw).trim();
  if (!trimmed) return false;
  return !NAME_PLACEHOLDERS.has(trimmed.toLowerCase());
}

module.exports = { normalizePhone, normalizePhoneInput, getDefaultCountryCode, isCompletePhone, formatPhone, looksLikePhone, looksLikeRealName };
