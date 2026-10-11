// ============================================================
// services/webhookRoutes.js
//
// Public webhook endpoints for Meta (WhatsApp + Instagram). These are
// called by Meta's servers, not by the dashboard — no auth middleware.
// Mounted at /api/webhooks in server.js.
//
// Both platforms use the same verification handshake and event
// envelope shape (Meta's unified webhooks product), just different
// object/field names inside.
// ============================================================

const express = require("express");
const whatsapp = require("../channels/whatsapp");
const instagram = require("../channels/instagram");
const { getLogger } = require("../observability/logger");
const log = getLogger("routes.webhooks");
const crypto = require("crypto");

const router = express.Router();

// One verify token per deployment (set in Meta App Dashboard > Webhooks
// when subscribing, and here as an env var) — this is a shared app-level
// secret, NOT per-org. Per-org routing happens later, inside the POST
// handler, by matching the message's phone_number_id / IG business
// account id against the channels table.
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;

function requireMetaSignature(req, res, next) {
  const secret = process.env.META_APP_SECRET || process.env.META_FACEBOOK_APP_SECRET;
  if (!secret && process.env.NODE_ENV === "production") return res.status(503).json({ error: "Meta app secret is not configured" });
  if (!secret) return next();
  const signature = req.get("X-Hub-Signature-256") || "";
  if (!signature.startsWith("sha256=") || !req.rawBody) return res.status(401).json({ error: "Invalid Meta webhook signature" });
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
  const a=Buffer.from(signature), b=Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) return res.status(401).json({ error: "Invalid Meta webhook signature" });
  next();
}

function verifyHandshake(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    log.info("✅ Meta webhook verified");
    return res.status(200).send(challenge);
  }
  log.warn("⚠️ Meta webhook verification failed — check META_WEBHOOK_VERIFY_TOKEN");
  return res.sendStatus(403);
}

router.get("/whatsapp", verifyHandshake);
router.get("/instagram", verifyHandshake);

router.post("/whatsapp", requireMetaSignature, async (req, res) => {
  try {
    const messages = whatsapp.parseInboundWebhook(req.body);
    for (const msg of messages) {
      await whatsapp.handleIncomingMessage(msg);
    }
    // Acknowledge only after provider events have been stored/handled. A 5xx
    // leaves Meta able to retry if the database was unavailable.
    res.sendStatus(200);
  } catch (err) {
    log.error("❌ WhatsApp webhook processing error:", err.message);
    if (!res.headersSent) res.status(503).json({ error: "Webhook processing failed; please retry." });
  }
});

router.post("/instagram", requireMetaSignature, async (req, res) => {
  try {
    const messages = instagram.parseInboundWebhook(req.body);
    for (const msg of messages) {
      await instagram.handleIncomingMessage(msg);
    }
    res.sendStatus(200);
  } catch (err) {
    log.error("❌ Instagram webhook processing error:", err.message);
    if (!res.headersSent) res.status(503).json({ error: "Webhook processing failed; please retry." });
  }
});

module.exports = router;
