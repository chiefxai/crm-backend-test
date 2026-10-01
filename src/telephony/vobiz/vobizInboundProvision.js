const { getLogger } = require("../../observability/logger");
const { buildVobizIncomingWebhookUrl } = require("./vobizWebhookAuth");

const log = getLogger("telephony.vobizInboundProvision");

const CHIEFVOICE_APP_NAME = "ChiefVoice_CRM_Inbound";

function vobizApiBase(authId) {
  return `https://api.vobiz.ai/api/v1/Account/${encodeURIComponent(authId)}`;
}

function vobizHeaders(authId, authToken) {
  return {
    "X-Auth-ID": authId,
    "X-Auth-Token": authToken,
    "Content-Type": "application/json",
  };
}

function encodeNumberForVobizPath(phoneNumber) {
  const raw = String(phoneNumber || "").trim();
  const digits = raw.replace(/\D/g, "");
  const e164 = raw.startsWith("+") ? raw : (digits ? `+${digits}` : raw);
  return encodeURIComponent(e164);
}

async function listApplications(authId, authToken) {
  const response = await fetch(`${vobizApiBase(authId)}/Application/`, {
    headers: vobizHeaders(authId, authToken),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Vobiz list applications failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const payload = await response.json();
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.objects)) return payload.objects;
  if (Array.isArray(payload?.applications)) return payload.applications;
  return [];
}

async function createApplication(authId, authToken, { answerUrl }) {
  const response = await fetch(`${vobizApiBase(authId)}/Application/`, {
    method: "POST",
    headers: vobizHeaders(authId, authToken),
    body: JSON.stringify({
      app_name: CHIEFVOICE_APP_NAME,
      answer_url: answerUrl,
      answer_method: "POST",
      hangup_url: answerUrl,
      hangup_method: "POST",
    }),
  });
  const text = await response.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch { /* ignore */ }
  if (!response.ok) {
    throw new Error(`Vobiz create application failed (${response.status}): ${text.slice(0, 200)}`);
  }
  return payload.app_id || payload.application?.app_id;
}

async function updateApplication(authId, authToken, appId, { answerUrl }) {
  const response = await fetch(`${vobizApiBase(authId)}/Application/${encodeURIComponent(appId)}/`, {
    method: "POST",
    headers: vobizHeaders(authId, authToken),
    body: JSON.stringify({
      answer_url: answerUrl,
      answer_method: "POST",
      hangup_url: answerUrl,
      hangup_method: "POST",
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Vobiz update application failed (${response.status}): ${text.slice(0, 200)}`);
  }
}

async function attachNumberToApplication(authId, authToken, phoneNumber, appId) {
  const numberPath = encodeNumberForVobizPath(phoneNumber);
  const response = await fetch(`${vobizApiBase(authId)}/numbers/${numberPath}/application`, {
    method: "POST",
    headers: vobizHeaders(authId, authToken),
    body: JSON.stringify({ application_id: String(appId) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Vobiz attach number failed (${response.status}): ${text.slice(0, 200)}`);
  }
}

/**
 * Point the Vobiz DID at our Answer URL (with webhook_secret) via Application API.
 * Safe to call on every channel connect / manual sync.
 */
async function ensureVobizInboundApplication(authId, authToken, phoneNumber) {
  const answerUrl = buildVobizIncomingWebhookUrl();
  if (!answerUrl) {
    throw new Error("PUBLIC_API_BASE_URL is not configured — cannot build Vobiz Answer URL.");
  }

  const apps = await listApplications(authId, authToken);
  let app = apps.find((row) => row.app_name === CHIEFVOICE_APP_NAME);
  if (!app) {
    app = apps.find((row) => String(row.answer_url || "").includes("/api/vobiz/incoming"));
  }

  let appId = app?.app_id;
  if (appId) {
    await updateApplication(authId, authToken, appId, { answerUrl });
  } else {
    appId = await createApplication(authId, authToken, { answerUrl });
  }
  if (!appId) throw new Error("Vobiz application provisioning did not return app_id");

  await attachNumberToApplication(authId, authToken, phoneNumber, appId);
  log.info(`✅ Vobiz inbound routing synced for ${String(phoneNumber).replace(/.(?=.{4})/g, "*")} → application ${appId}`);
  return { appId, answerUrl };
}

module.exports = {
  ensureVobizInboundApplication,
  CHIEFVOICE_APP_NAME,
};
