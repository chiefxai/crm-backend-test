// ============================================================
// services/instagramChannel.js
//
// Instagram Messaging (Graph API) adapter — DMs to/from an Instagram
// professional account connected to a Facebook Page. Same org-owns-
// their-own-credentials model as whatsappChannel.js.
//
// CAVEAT — flagged explicitly because I cannot test this against a
// real Instagram/Meta account in this environment: Meta has shipped
// several overlapping ways to send Instagram DMs over the years
// (Messenger-Platform-style "Instagram Messaging via Page", and the
// newer "Instagram API with Instagram Login" with IG-scoped endpoints)
// and the exact endpoint/payload shape has moved across API versions.
// The endpoint below (POST /{ig_business_account_id}/messages) matches
// the currently-documented Graph API pattern as of this writing, but
// verify it against your actual Meta App's API version and connection
// type before relying on it — this needs a live send test, not just a
// syntax-correct guess.
//
// Docs: https://developers.facebook.com/docs/messenger-platform/instagram
// ============================================================

const channelsEngine = require("./engine");
const aiTextReply = require("../ai/textReply");
const objectsEngine = require("../crm/objectsEngine");
const { buildCustomObjectTools } = require("../utils/objectToolBuilder");
const { getLogger } = require("../observability/logger");
const log = getLogger("channels.instagram");

const GRAPH_API_VERSION = "v20.0";

async function sendTextMessage(channel, recipientIgsid, text) {
  const { igBusinessAccountId, accessToken } = channel.config;
  if (!igBusinessAccountId || !accessToken) {
    throw new Error("Instagram channel is missing igBusinessAccountId/accessToken configuration");
  }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${igBusinessAccountId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      recipient: { id: recipientIgsid },
      message: { text }
    })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Instagram send failed (status ${res.status})`);
  }
  return data;
}

// Normalizes Meta's Instagram webhook payload (Messenger-Platform-style
// "messaging" envelope) into a flat list of inbound messages.
function parseInboundWebhook(body) {
  const messages = [];
  for (const entry of body.entry || []) {
    const igBusinessAccountId = entry.id; // the IG account the event is for
    for (const event of entry.messaging || []) {
      if (!event.message || event.message.is_echo) continue; // skip echoes of our own sends
      messages.push({
        igBusinessAccountId,
        from: event.sender?.id,
        messageId: event.message.mid,
        text: event.message.text || null,
        attachments: event.message.attachments || []
      });
    }
  }
  return messages;
}

async function handleIncomingMessage(parsedMessage) {
  const channel = await channelsEngine.getChannelByExternalId(parsedMessage.igBusinessAccountId);
  if (!channel) {
    log.warn(`⚠️ Instagram webhook: no channel registered for IG account ${parsedMessage.igBusinessAccountId}`);
    return;
  }

  return channelsEngine.withChannelScope(channel, async () => {
    const conversation = await channelsEngine.findOrCreateConversation(
      channel.org_id, channel, parsedMessage.from, null
    );

    await channelsEngine.addMessage(channel.org_id, conversation.id, {
      direction: "inbound",
      sender: "contact",
      body: parsedMessage.text,
      messageType: parsedMessage.attachments.length ? (parsedMessage.attachments[0].type || "image") : "text",
      externalMessageId: parsedMessage.messageId
    });

    if (!channel.config.aiAutoReply || !parsedMessage.text) return;

    try {
      const history = await channelsEngine.listMessages(channel.org_id, conversation.id);
      const customObjects = await objectsEngine.listObjects(channel.org_id).catch(() => []);
      const { promptSection } = buildCustomObjectTools(customObjects);
      const replyText = await aiTextReply.generateReply({
        orgId: channel.org_id,
        history: history.map((m) => ({ direction: m.direction, body: m.body })),
        customObjectsPromptSection: promptSection
      });
      if (!replyText) return;

      await sendTextMessage(channel, parsedMessage.from, replyText);
      await channelsEngine.addMessage(channel.org_id, conversation.id, {
        direction: "outbound",
        sender: "ai",
        body: replyText,
        messageType: "text"
      });
    } catch (err) {
      log.error("❌ Instagram AI auto-reply failed:", err.message);
    }
  });
}

module.exports = { sendTextMessage, parseInboundWebhook, handleIncomingMessage };
