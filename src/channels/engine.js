const { scopeForOrg, runWithScope } = require("../workspaces/scope");
// ============================================================
// services/channelsEngine.js
//
// Org-scoped conversations/messages engine shared by every channel
// adapter (WhatsApp, Instagram, and anything added later). See
// schema_part5_omnichannel.sql for table shapes.
//
// Like objectsEngine.js, talks to db.supabase (services/mysqlClient.js)
// directly with no JSON-fallback equivalent — db.supabase is always
// configured (MySQL is required at startup), so requireDb() below
// never actually throws; kept as a defensive guard in case that ever
// changes.
// ============================================================

const db = require("../db/repository");
const { encryptJson, decryptJson } = require("../security/channelCredentials");

function requireDb() {
  if (!db.supabase) {
    const err = new Error("Omnichannel messaging requires the database to be configured (MYSQL_URL).");
    err.statusCode = 503;
    throw err;
  }
}

// ------------------------------------------------------------
// Channels
// ------------------------------------------------------------

// Sensitive fields inside channels.config that must never be sent to the
// frontend as-is — masked the same way OrganizationSettings.apiKeys is.
const SECRET_CONFIG_KEYS = ["accessToken", "appSecret", "verifyToken", "authToken", "authId"];
const MASKED_FIELDS_BY_TYPE = {
  vobiz: ["authId", "authToken"],
  whatsapp: ["accessToken", "appSecret", "verifyToken"],
  instagram: ["accessToken", "appSecret", "verifyToken"]
};

function splitChannelConfig(config = {}) {
  const safeConfig = { ...config };
  const credentials = {};
  for (const key of SECRET_CONFIG_KEYS) {
    if (safeConfig[key] !== undefined && safeConfig[key] !== null && safeConfig[key] !== "") {
      credentials[key] = safeConfig[key];
      delete safeConfig[key];
    }
  }
  return { safeConfig, credentials };
}

function maskChannel(row) {
  const config = { ...(row.config || {}) };
  const fields = MASKED_FIELDS_BY_TYPE[row.type] || SECRET_CONFIG_KEYS;
  const hasLegacySecret = fields.some((key) => config[key] !== undefined && config[key] !== null && config[key] !== "");
  if (row.credentials_encrypted || hasLegacySecret) {
    // Do not decrypt credentials merely to display a masked value. This keeps
    // list/read APIs from unnecessarily materializing provider secrets.
    for (const key of fields) config[key] = "••••••••";
  }
  return {
    id: row.id,
    type: row.type,
    externalId: row.external_id,
    status: row.status,
    config,
    credentialsConfigured: !!row.credentials_encrypted,
    createdAt: row.created_at
  };
}

function hydrateChannel(row) {
  if (!row) return row;
  const config = { ...(row.config || {}) };
  let credentials = {};
  if (row.credentials_encrypted) {
    credentials = decryptJson(row.credentials_encrypted) || {};
  } else {
    // Legacy rows: keep runtime compatibility until the migration command has
    // encrypted them. Do not return this object directly from an API route.
    for (const key of SECRET_CONFIG_KEYS) {
      if (config[key] !== undefined) credentials[key] = config[key];
    }
  }
  return { ...row, config: { ...config, ...credentials } };
}

async function listChannels(orgId) {
  requireDb();
  const { data, error } = await db.supabase.from("channels").select("*").eq("org_id", orgId);
  if (error) throw new Error(`[channelsEngine.listChannels] ${error.message}`);
  return (data || []).map(maskChannel);
}

// Creates or updates the org's channel of this type. externalId is the
// WhatsApp phone_number_id, Instagram business account id, or Vobiz number.
// Secret credentials are encrypted before persistence and are never returned
// to browser clients in plaintext.
async function upsertChannel(orgId, type, externalId, config = {}) {
  requireDb();
  const { safeConfig, credentials } = splitChannelConfig(config);
  const credentialsEncrypted = Object.keys(credentials).length ? encryptJson(credentials) : null;
  // The DB constraint is UNIQUE(type, external_id), not org_id + type.
  // Always resolve the exact channel first. Otherwise a stale/existing Vobiz
  // row for this phone can pass the org-scoped lookup and the subsequent
  // INSERT will fail with a duplicate-key 500.
  const { data: exactChannel, error: exactErr } = await db.supabase
    .from("channels")
    .select("id, org_id, workspace_id")
    .systemReadOnly("Check global channel ownership")
    .eq("type", type)
    .eq("external_id", externalId)
    .maybeSingle();
  if (exactErr) throw new Error(`[channelsEngine.upsertChannel] ${exactErr.message}`);
  if (exactChannel && (exactChannel.org_id !== orgId || (exactChannel.workspace_id || exactChannel.org_id) !== scopeForOrg(orgId).workspaceId)) {
    const err = new Error("This channel number is already assigned to another organization.");
    err.statusCode = 409;
    throw err;
  }

  // Keep the existing org/type behavior for reconnecting an org's channel
  // with a new external id.
  const { data: existing, error: existingErr } = await db.supabase
    .from("channels")
    .select("id")
    .eq("org_id", orgId)
    .eq("type", type)
    .maybeSingle();
  if (existingErr) throw new Error(`[channelsEngine.upsertChannel] ${existingErr.message}`);

  const payload = {
    external_id: externalId,
    config: safeConfig,
    credentials_encrypted: credentialsEncrypted,
    status: "connected"
  };

  const rowToUpdate = exactChannel || existing;
  if (rowToUpdate) {
    const { data, error } = await db.supabase
      .from("channels")
      .update(payload)
      .eq("id", rowToUpdate.id)
      .select()
      .single();
    if (error) throw new Error(`[channelsEngine.upsertChannel] ${error.message}`);
    return maskChannel(data);
  }

  const { data, error } = await db.supabase
    .from("channels")
    .insert({ org_id: orgId, type, ...payload })
    .select()
    .single();
  if (error) throw new Error(`[channelsEngine.upsertChannel] ${error.message}`);
  return maskChannel(data);
}

// Internal-only accessor. It hydrates encrypted credentials in memory for the
// provider adapter. Never serialize this object into an API response.
async function getChannelByExternalId(externalId, type = null) {
  requireDb();
  if (!externalId) return null;
  let query = db.supabase.from("channels").select("*")
    .systemReadOnly("Resolve inbound provider callback to its configured channel")
    .eq("external_id", externalId);
  if (type) query = query.eq("type", type);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`[channelsEngine.getChannelByExternalId] ${error.message}`);
  return hydrateChannel(data || null);
}

async function getChannel(orgId, type) {
  requireDb();
  const { data, error } = await db.supabase.from("channels").select("*").eq("org_id", orgId).eq("type", type).maybeSingle();
  if (error) throw new Error(`[channelsEngine.getChannel] ${error.message}`);
  return hydrateChannel(data || null);
}

function phoneExternalIdVariants(phoneNumber) {
  const raw = String(phoneNumber || "").trim();
  const digits = raw.replace(/\D/g, "");
  const variants = new Set();
  if (raw) variants.add(raw);
  if (digits) {
    variants.add(digits);
    variants.add(`+${digits}`);
    if (digits.length === 10) variants.add(`+91${digits}`);
  }
  return [...variants];
}

/** Resolve a Vobiz channel row from a webhook To/From value. */
async function findVobizChannelByPhone(phoneNumber) {
  for (const externalId of phoneExternalIdVariants(phoneNumber)) {
    const channel = await getChannelByExternalId(externalId, "vobiz");
    if (channel?.config?.authToken) return channel;
  }
  return null;
}

/** Unique auth tokens for signature verification (webhook auth fallback). */
async function listVobizAuthTokens() {
  requireDb();
  const { data, error } = await db.supabase.from("channels").select("*")
    .systemReadOnly("Verify Vobiz webhook against registered channel credentials")
    .eq("type", "vobiz");
  if (error) throw new Error(`[channelsEngine.listVobizAuthTokens] ${error.message}`);
  const tokens = new Set();
  for (const row of data || []) {
    const hydrated = hydrateChannel(row);
    const token = hydrated?.config?.authToken;
    if (token) tokens.add(String(token));
  }
  return [...tokens];
}

function withChannelScope(channel, operation) {
  if (!channel?.org_id || typeof operation !== "function") throw new Error("A configured channel and operation are required");
  return runWithScope({ orgId: channel.org_id, workspaceId: channel.workspace_id || channel.org_id }, operation);
}

async function removeChannel(orgId, type) {
  requireDb();
  const { error } = await db.supabase.from("channels").delete().eq("org_id", orgId).eq("type", type);
  if (error) throw new Error(`[channelsEngine.removeChannel] ${error.message}`);
  return true;
}

// ------------------------------------------------------------
// Conversations + messages
// ------------------------------------------------------------

function conversationRowToApi(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    channelType: row.channel_type,
    contactExternalId: row.contact_external_id,
    contactName: row.contact_name,
    status: row.status,
    assignedTo: row.assigned_to,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    summary: row.summary ?? null,
    sentiment: row.sentiment ?? null,
    nextAction: row.next_action ?? null,
    analyzedAt: row.analyzed_at ?? null
  };
}

function messageRowToApi(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction,
    sender: row.sender,
    body: row.body,
    mediaUrl: row.media_url,
    messageType: row.message_type,
    createdAt: row.created_at
  };
}

async function listConversations(orgId) {
  requireDb();
  const { data, error } = await db.supabase
    .from("conversations")
    .select("*")
    .eq("org_id", orgId)
    .order("last_message_at", { ascending: false });
  if (error) throw new Error(`[channelsEngine.listConversations] ${error.message}`);
  return (data || []).map(conversationRowToApi);
}

async function listMessages(orgId, conversationId) {
  requireDb();
  const { data, error } = await db.supabase
    .from("messages")
    .select("*")
    .eq("org_id", orgId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`[channelsEngine.listMessages] ${error.message}`);
  return (data || []).map(messageRowToApi);
}

// Used by webhook handlers (no req.orgId available — resolved from the
// channel's external_id instead) to get-or-create the thread for an
// inbound message.
async function findOrCreateConversation(orgId, channel, contactExternalId, contactName) {
  requireDb();
  const { data: existing, error: findErr } = await db.supabase
    .from("conversations")
    .select("*")
    .eq("channel_id", channel.id)
    .eq("contact_external_id", contactExternalId)
    .maybeSingle();
  if (findErr) throw new Error(`[channelsEngine.findOrCreateConversation] ${findErr.message}`);
  if (existing) return conversationRowToApi(existing);

  const { data, error } = await db.supabase
    .from("conversations")
    .insert({
      org_id: orgId,
      channel_id: channel.id,
      channel_type: channel.type,
      contact_external_id: contactExternalId,
      contact_name: contactName || null
    })
    .select()
    .single();
  if (error) throw new Error(`[channelsEngine.findOrCreateConversation] ${error.message}`);
  return conversationRowToApi(data);
}

async function addMessage(orgId, conversationId, { direction, sender, body, mediaUrl, messageType, externalMessageId }) {
  requireDb();
  const { data, error } = await db.supabase
    .from("messages")
    .insert({
      org_id: orgId,
      conversation_id: conversationId,
      direction,
      sender: sender || "contact",
      body: body || null,
      media_url: mediaUrl || null,
      message_type: messageType || "text",
      external_message_id: externalMessageId || null
    })
    .select()
    .single();
  if (error) throw new Error(`[channelsEngine.addMessage] ${error.message}`);

  await db.supabase.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conversationId);

  return messageRowToApi(data);
}

module.exports = {
  listChannels,
  upsertChannel,
  getChannelByExternalId,
  getChannel,
  findVobizChannelByPhone,
  listVobizAuthTokens,
  withChannelScope,
  removeChannel,
  listConversations,
  listMessages,
  findOrCreateConversation,
  addMessage
};
