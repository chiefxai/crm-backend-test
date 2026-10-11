const crypto = require("crypto");
const { getLogger } = require("../../observability/logger");
const { verifyVobizWebhookSignature } = require("./vobizSignature");

const log = getLogger("telephony.vobizWebhookAuth");

function getExpectedVobizWebhookSecret() {
  return process.env.VOBIZ_WEBHOOK_SECRET || "";
}

/** Full URL to paste into Vobiz Answer / Hangup URL (includes shared secret query param). */
function buildVobizIncomingWebhookUrl(baseUrl, { routeId = null, routeToken = null } = {}) {
  const root = String(baseUrl || process.env.PUBLIC_URL || process.env.PUBLIC_API_BASE_URL || "")
    .trim()
    .replace(/\/$/, "");
  if (!root) return null;
  const params = new URLSearchParams();
  const secret = getExpectedVobizWebhookSecret();
  if (secret) params.set('webhook_secret', secret);
  if (routeId && routeToken) {
    params.set('telephony_route_id', String(routeId));
    params.set('telephony_route_token', String(routeToken));
  }
  const query = params.toString();
  return `${root}/api/vobiz/incoming${query ? `?${query}` : ''}`;
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

function webhookSharedSecretOk(req) {
  const expected = getExpectedVobizWebhookSecret();
  if (!expected) return false;
  return secretsMatch(expected, extractSuppliedVobizWebhookSecret(req));
}

async function vobizSignatureOk(req) {
  const routeId = req.query?.telephony_route_id || req.body?.telephony_route_id;
  if (routeId) {
    const route = await require('../callRouteRepository').getCallRouteById(routeId);
    if (!route || route.providerKey !== 'vobiz') return false;
    const routeToken = req.query?.telephony_route_token || req.body?.telephony_route_token;
    if (!await require('../callRouteRepository').verifyCallRouteToken(routeId, routeToken)) return false;
    const owner = { ownerType: route.ownerType, ownerOrgId: route.ownerType === 'organization' ? route.orgId : null };
    const account = await require('../connectorAccountService').getAccount(route.connectorAccountId, owner).catch(() => null);
    if (!account?.credential_ciphertext) return false;
    const { decryptJson } = require('../../security/channelCredentials');
    const credentials = decryptJson(account.credential_ciphertext);
    if (!verifyVobizWebhookSignature(req, credentials?.authToken)) return false;
    req.telephonyCallRoute = route;
    return true;
  }
  const channelsEngine = require("../../channels/engine");
  const to = req.body?.To || req.query?.To;
  const from = req.body?.From || req.query?.From;
  const tokens = new Set();

  const primary = await channelsEngine.findVobizChannelByPhone(to)
    || await channelsEngine.findVobizChannelByPhone(from);
  if (primary?.config?.authToken) tokens.add(String(primary.config.authToken));

  if (!tokens.size) {
    for (const token of await channelsEngine.listVobizAuthTokens()) tokens.add(token);
  }

  for (const authToken of tokens) {
    if (verifyVobizWebhookSignature(req, authToken)) return true;
  }
  return false;
}

async function attachVobizCallRoute(req) {
  const routeId = req.query?.telephony_route_id || req.body?.telephony_route_id;
  if (!routeId) return true;
  const route = await require('../callRouteRepository').getCallRouteById(routeId);
  if (!route || route.providerKey !== 'vobiz') return false;
  const routeToken = req.query?.telephony_route_token || req.body?.telephony_route_token;
  if (!await require('../callRouteRepository').verifyCallRouteToken(routeId, routeToken)) return false;
  req.telephonyCallRoute = route;
  return true;
}

async function isVobizWebhookAuthorized(req) {
  if (webhookSharedSecretOk(req)) return attachVobizCallRoute(req);
  if (await vobizSignatureOk(req)) return true;
  return false;
}

async function requireVobizWebhook(req, res, next) {
  const expected = getExpectedVobizWebhookSecret();
  if (!expected && process.env.NODE_ENV !== "production") return next();

  try {
    if (await isVobizWebhookAuthorized(req)) return next();
  } catch (err) {
    log.error("Vobiz webhook auth error:", err.message);
    return res.status(500).json({ error: "Vobiz webhook authentication failed" });
  }

  if (!expected) return res.status(503).json({ error: "Vobiz webhook authentication is not configured" });

  const hasSig = Boolean(
    req.get("X-Vobiz-Signature-V3")
    || req.get("X-Vobiz-Signature-V2")
    || req.get("x-vobiz-signature-v3")
    || req.get("x-vobiz-signature-v2")
  );
  log.warn("Vobiz webhook rejected — invalid shared secret and signature verification failed. Sync inbound routing (POST /api/settings/vobiz-inbound-webhook/sync) or set Answer URL with ?webhook_secret=...", {
    path: req.path,
    hasHeaderSecret: Boolean(req.get("X-Vobiz-Webhook-Secret")),
    hasQueryParam: Boolean(req.query?.webhook_secret),
    hasBodyParam: Boolean(req.body?.webhook_secret || req.body?.webhookSecret),
    hasVobizSignature: hasSig,
  });
  return res.status(401).json({ error: "Invalid Vobiz webhook credentials" });
}

module.exports = {
  buildVobizIncomingWebhookUrl,
  requireVobizWebhook,
  extractSuppliedVobizWebhookSecret,
  getExpectedVobizWebhookSecret,
  isVobizWebhookAuthorized,
  attachVobizCallRoute,
};
