const crypto = require("crypto");
const { getLogger } = require("../observability/logger");
const log = getLogger("telephony.vobizWebhookAuth");

function getExpectedVobizWebhookSecret() {
  return process.env.VOBIZ_WEBHOOK_SECRET || "";
}

/** Full URL to paste into Vobiz Answer / Hangup URL (includes shared secret query param). */
function buildVobizIncomingWebhookUrl(baseUrl) {
  const root = String(baseUrl || process.env.PUBLIC_URL || process.env.PUBLIC_API_BASE_URL || "")
    .trim()
    .replace(/\/$/, "");
  if (!root) return null;
  const secret = getExpectedVobizWebhookSecret();
  if (!secret) return `${root}/api/vobiz/incoming`;
  return `${root}/api/vobiz/incoming?webhook_secret=${encodeURIComponent(secret)}`;
}

function extractSuppliedVobizWebhookSecret(req) {
  const header = req.get("X-Vobiz-Webhook-Secret");
  if (header) return String(header).trim();
  if (req.query?.webhook_secret) return String(req.query.webhook_secret).trim();
  const body = req.body || {};
  if (body.webhook_secret) return String(body.webhook_secret).trim();
  if (body.webhookSecret) return String(body.webhookSecret).trim();
  return "";
}

function secretsMatch(expected, supplied) {
  if (!expected || !supplied) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(supplied));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireVobizWebhook(req, res, next) {
  const expected = getExpectedVobizWebhookSecret();
  if (!expected) {
    if (process.env.NODE_ENV === "production") {
      return res.status(503).json({ error: "Vobiz webhook authentication is not configured" });
    }
    return next();
  }

  const supplied = extractSuppliedVobizWebhookSecret(req);
  if (!secretsMatch(expected, supplied)) {
    log.warn("Vobiz webhook rejected — missing or invalid webhook secret. Configure the Vobiz Answer URL with ?webhook_secret=... (see GET /api/settings/vobiz-inbound-webhook).", {
      path: req.path,
      hasHeader: Boolean(req.get("X-Vobiz-Webhook-Secret")),
      hasQuerySecret: Boolean(req.query?.webhook_secret),
      hasBodySecret: Boolean(req.body?.webhook_secret || req.body?.webhookSecret),
    });
    return res.status(401).json({ error: "Invalid Vobiz webhook credentials" });
  }
  return next();
}

module.exports = {
  buildVobizIncomingWebhookUrl,
  requireVobizWebhook,
  extractSuppliedVobizWebhookSecret,
  getExpectedVobizWebhookSecret,
};
