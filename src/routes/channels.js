// ============================================================
// services/channelsRoutes.js
//
// Authenticated REST API for the Unified Inbox: connecting channels
// (WhatsApp/Instagram credentials) and reading/replying to
// conversations. Mounted at /api/channels and /api/conversations in
// server.js.
// ============================================================

const { safeErrorMessage } = require("../observability/safeError");
const express = require("express");
const channelsEngine = require("../channels/engine");
const whatsapp = require("../channels/whatsapp");
const instagram = require("../channels/instagram");
const db = require("../db/repository");
const conversationIntelligence = require("../ai/conversationIntelligence");
const auditLog = require("../platform/auditLog");
const { requireAuth, requireRole, ADMIN_ROLES } = require("../middleware/auth");
const { getLogger } = require("../observability/logger");
const log = getLogger("routes.channels");
const telephony = require("../telephony/registry");

const channelsRouter = express.Router();
const conversationsRouter = express.Router();

function handleEngineError(err, res) {
  const status = err.statusCode || 500;
  if (status >= 500) log.error("❌ channelsRoutes:", err.message);
  res.status(status).json({ error: safeErrorMessage(err) });
}

// ------------------------------------------------------------
// Channel connection management — admin-level, same bar as org
// settings/team management (these hold real API credentials).
// ------------------------------------------------------------

channelsRouter.get("/", requireAuth, async (req, res) => {
  try {
    res.json(await channelsEngine.listChannels(req.orgId));
  } catch (err) {
    handleEngineError(err, res);
  }
});

// body: { phoneNumberId, accessToken, aiAutoReply? }
channelsRouter.post("/whatsapp", requireAuth, requireRole(ADMIN_ROLES), async (req, res) => {
  try {
    const { phoneNumberId, accessToken, aiAutoReply } = req.body || {};
    if (!phoneNumberId || !accessToken) {
      return res.status(400).json({ error: "phoneNumberId and accessToken are required" });
    }
    const channel = await channelsEngine.upsertChannel(req.orgId, "whatsapp", phoneNumberId, {
      phoneNumberId, accessToken, aiAutoReply: !!aiAutoReply
    });
    // Never log the access token itself, only which number was connected.
    auditLog.record(req.orgId, req, "channel.connect", "channel", channel.id, { type: "whatsapp", phoneNumberId, aiAutoReply: !!aiAutoReply });
    res.status(201).json(channel);
  } catch (err) {
    handleEngineError(err, res);
  }
});

// body: { igBusinessAccountId, accessToken, aiAutoReply? }
channelsRouter.post("/instagram", requireAuth, requireRole(ADMIN_ROLES), async (req, res) => {
  try {
    const { igBusinessAccountId, accessToken, aiAutoReply } = req.body || {};
    if (!igBusinessAccountId || !accessToken) {
      return res.status(400).json({ error: "igBusinessAccountId and accessToken are required" });
    }
    const channel = await channelsEngine.upsertChannel(req.orgId, "instagram", igBusinessAccountId, {
      igBusinessAccountId, accessToken, aiAutoReply: !!aiAutoReply
    });
    auditLog.record(req.orgId, req, "channel.connect", "channel", channel.id, { type: "instagram", igBusinessAccountId, aiAutoReply: !!aiAutoReply });
    res.status(201).json(channel);
  } catch (err) {
    handleEngineError(err, res);
  }
});

// body: { authId, authToken, phoneNumber } — same as above, for Vobiz.ai.
channelsRouter.post("/vobiz", requireAuth, requireRole(ADMIN_ROLES), async (req, res) => {
  try {
    const { authId, authToken, phoneNumber } = req.body || {};
    if (!authId || !authToken || !phoneNumber) {
      return res.status(400).json({ error: "authId, authToken, and phoneNumber are required" });
    }
    if (!(await db.isNumberAvailable(phoneNumber, req.orgId))) {
      return res.status(409).json({ error: "This number is already assigned to another organization." });
    }
    const channel = await channelsEngine.upsertChannel(req.orgId, "vobiz", phoneNumber, { authId, authToken, phoneNumber });
    await db.ensureVirtualNumberForPhone(req.orgId, phoneNumber, {
      provider: "Vobiz.ai",
      friendlyName: `${phoneNumber} (Vobiz)`,
    }).catch((err) => log.warn(`⚠️ Could not ensure virtual_numbers row for ${phoneNumber}: ${err.message}`));
    try {
      const provider = telephony.findConnector("vobiz"); if (!provider?.provisionInboundNumber) throw new Error("Vobiz provider is not registered."); await provider.provisionInboundNumber(authId, authToken, phoneNumber);
    } catch (err) {
      log.warn(`⚠️ Vobiz inbound Answer URL sync failed (configure manually if needed): ${err.message}`);
    }
    auditLog.record(req.orgId, req, "channel.connect", "channel", channel.id, { type: "vobiz", phoneNumber });
    res.status(201).json(channel);
  } catch (err) {
    handleEngineError(err, res);
  }
});

// Disconnects the org's own account for this channel type — the row in
// virtual_numbers is just a display/routing entry; this is the actual
// credential connection that outbound calls fall back to, so both need
// their own delete path (see channelsEngine.removeChannel's comment).
channelsRouter.delete("/:type", requireAuth, requireRole(ADMIN_ROLES), async (req, res) => {
  try {
    await channelsEngine.removeChannel(req.orgId, req.params.type);
    auditLog.record(req.orgId, req, "channel.disconnect", "channel", req.params.type, { type: req.params.type });
    res.json({ success: true });
  } catch (err) {
    handleEngineError(err, res);
  }
});

// ------------------------------------------------------------
// Unified inbox
// ------------------------------------------------------------

conversationsRouter.get("/", requireAuth, async (req, res) => {
  try {
    res.json(await channelsEngine.listConversations(req.orgId));
  } catch (err) {
    handleEngineError(err, res);
  }
});

conversationsRouter.get("/:id/messages", requireAuth, async (req, res) => {
  try {
    res.json(await channelsEngine.listMessages(req.orgId, req.params.id));
  } catch (err) {
    handleEngineError(err, res);
  }
});

// Human agent reply from the dashboard. body: { text }
conversationsRouter.post("/:id/messages", requireAuth, async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: "text is required" });

    if (!db.supabase) {
      const err = new Error("Omnichannel messaging requires the MySQL database to be configured.");
      err.statusCode = 503;
      throw err;
    }

    const { data: conversation, error } = await db.supabase
      .from("conversations")
      .select("*")
      .eq("id", req.params.id)
      .eq("org_id", req.orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });

    const channel = await channelsEngine.getChannel(req.orgId, conversation.channel_type);
    if (!channel) return res.status(404).json({ error: "Channel not connected" });

    if (conversation.channel_type === "whatsapp") {
      await whatsapp.sendTextMessage(channel, conversation.contact_external_id, text);
    } else if (conversation.channel_type === "instagram") {
      await instagram.sendTextMessage(channel, conversation.contact_external_id, text);
    }

    const message = await channelsEngine.addMessage(req.orgId, conversation.id, {
      direction: "outbound",
      sender: "human",
      body: text,
      messageType: "text"
    });
    res.status(201).json(message);
  } catch (err) {
    handleEngineError(err, res);
  }
});

// Generates (and persists) an AI summary/sentiment/next-action for this
// conversation thread.
conversationsRouter.post("/:id/analyze", requireAuth, async (req, res) => {
  try {
    const result = await conversationIntelligence.analyzeConversation(req.orgId, req.params.id);
    res.json(result);
  } catch (err) {
    handleEngineError(err, res);
  }
});

module.exports = { channelsRouter, conversationsRouter };
