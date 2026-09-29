const crypto = require("crypto");

/** Public callback URL path Vobiz signed (no query string). */
function vobizWebhookBaseUrl(req) {
  const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  const host = (req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim();
  const path = `${req.baseUrl || ""}${req.path || ""}`;
  return `${proto}://${host}${path}`;
}

function signaturesEqual(got, expected) {
  if (!got || !expected) return false;
  const a = Buffer.from(String(got));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyVobizSignatureV3(baseUrl, authToken, headers) {
  const signature = headers["x-vobiz-signature-v3"] || headers["x-vobiz-signature-ma-v3"];
  const nonce = headers["x-vobiz-signature-v3-nonce"] || headers["x-vobiz-signature-ma-v3-nonce"] || "";
  if (!signature || !authToken) return false;
  const expected = crypto.createHmac("sha256", authToken).update(`${baseUrl}.${nonce}`).digest("base64");
  return signaturesEqual(signature, expected);
}

function verifyVobizSignatureV2(baseUrl, authToken, headers) {
  const signature = headers["x-vobiz-signature-v2"] || headers["x-vobiz-signature-ma-v2"];
  const nonce = headers["x-vobiz-signature-v2-nonce"] || headers["x-vobiz-signature-ma-v2-nonce"] || "";
  if (!signature || !authToken) return false;
  const expected = crypto.createHmac("sha256", authToken).update(`${baseUrl}${nonce}`).digest("base64");
  return signaturesEqual(signature, expected);
}

function normalizeVobizWebhookHeaders(req) {
  const out = {};
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (value !== undefined && value !== null) out[String(key).toLowerCase()] = String(value);
  }
  const fromGetter = [
    ["x-vobiz-signature-v3", "X-Vobiz-Signature-V3"],
    ["x-vobiz-signature-v3-nonce", "X-Vobiz-Signature-V3-Nonce"],
    ["x-vobiz-signature-v2", "X-Vobiz-Signature-V2"],
    ["x-vobiz-signature-v2-nonce", "X-Vobiz-Signature-V2-Nonce"],
    ["x-vobiz-signature-ma-v3", "X-Vobiz-Signature-MA-V3"],
    ["x-vobiz-signature-ma-v3-nonce", "X-Vobiz-Signature-MA-V3-Nonce"],
    ["x-vobiz-signature-ma-v2", "X-Vobiz-Signature-MA-V2"],
    ["x-vobiz-signature-ma-v2-nonce", "X-Vobiz-Signature-MA-V2-Nonce"],
  ];
  if (typeof req.get === "function") {
    for (const [lower, header] of fromGetter) {
      const value = req.get(header);
      if (value) out[lower] = String(value);
    }
  }
  return out;
}

function verifyVobizWebhookSignature(req, authToken) {
  if (!authToken) return false;
  const headers = normalizeVobizWebhookHeaders(req);
  const baseUrl = vobizWebhookBaseUrl(req);
  if (verifyVobizSignatureV3(baseUrl, authToken, headers)) return true;
  if (verifyVobizSignatureV2(baseUrl, authToken, headers)) return true;
  return false;
}

module.exports = {
  vobizWebhookBaseUrl,
  verifyVobizWebhookSignature,
  verifyVobizSignatureV2,
  verifyVobizSignatureV3,
};
