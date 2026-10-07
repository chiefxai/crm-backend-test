// ============================================================
// services/whatsappChannel.js
//
// WhatsApp Cloud API adapter (official Meta API — replaces the
// unofficial WasenderAPI bridge used elsewhere in this codebase for
// the voice agent's send_whatsapp_message tool). Each org connects
// their OWN Meta app / phone number via Settings > Channels; there is
// no shared platform-level WhatsApp number.
//
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
// ============================================================

const channelsEngine = require("./engine");
const aiTextReply = require("../ai/textReply");
const objectsEngine = require("../crm/objectsEngine");
const { buildCustomObjectTools } = require("../utils/objectToolBuilder");
const { getLogger } = require("../observability/logger");
const log = getLogger("channels.whatsapp");

const GRAPH_API_VERSION = "v20.0";

async function sendTextMessage(channel, toNumber, text) {
  const { phoneNumberId, accessToken } = channel.config;
  if (!phoneNumberId || !accessToken) {
    throw new Error("WhatsApp channel is missing phoneNumberId/accessToken configuration");
  }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toNumber,
      type: "text",
      text: { body: text }
    })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `WhatsApp send failed (status ${res.status})`);
  }
  return data;
}

// Normalizes Meta's webhook payload into a flat list of inbound messages.
// See: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
function parseInboundWebhook(body) {
  const messages = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id;
      const contacts = value.contacts || [];
      for (const msg of value.messages || []) {
        const contact = contacts.find((c) => c.wa_id === msg.from);
        messages.push({
          phoneNumberId,
          from: msg.from,
          contactName: contact?.profile?.name || null,
          messageId: msg.id,
          type: msg.type,
          text: msg.type === "text" ? msg.text?.body : null,
          mediaId: msg.image?.id || msg.document?.id || msg.audio?.id || msg.video?.id || null
        });
      }
    }
  }
  return messages;
}

// Handles one parsed inbound message end-to-end: resolve org, store it,
// and (if the channel has AI auto-reply enabled) generate + send a reply.
async function handleIncomingMessage(parsedMessage) {
  const channel = await channelsEngine.getChannelByExternalId(parsedMessage.phoneNumberId);
  if (!channel) {
    log.warn(`⚠️ WhatsApp webhook: no channel registered for phone_number_id ${parsedMessage.phoneNumberId}`);
    return;
  }

  return channelsEngine.withChannelScope(channel, async () => {
    const conversation = await channelsEngine.findOrCreateConversation(
      channel.org_id, channel, parsedMessage.from, parsedMessage.contactName
    );

    await channelsEngine.addMessage(channel.org_id, conversation.id, {
      direction: "inbound",
      sender: "contact",
      body: parsedMessage.text,
      messageType: parsedMessage.type === "text" ? "text" : parsedMessage.type,
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
      log.error("❌ WhatsApp AI auto-reply failed:", err.message);
    }
  });
}

module.exports = { sendTextMessage, parseInboundWebhook, handleIncomingMessage };
