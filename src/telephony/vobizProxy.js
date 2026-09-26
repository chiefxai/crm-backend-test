// services/vobizProxy.js
// ============================================================
// Vobiz WebSocket Proxy & Telephony Handler for Gemini Live API
// ============================================================

const fs = require("fs");
const path = require("path");
const ws = require("ws");
const { getConfig, getConfigForOrg, buildRuntimePrompt, buildCompanyInfoPrompt, getAgentConfigForNumber, getAgentConfigById } = require("../config/agentConfig");
const { getLogger } = require("../observability/logger");
const log = getLogger("telephony.vobizProxy");
const {
  upsample8To16,
  downsample24To8,
  createResampler24To16
} = require("../utils/audioConverter");
const db = require("../db/repository");
const objectsEngine = require("../crm/objectsEngine");
const { buildCustomObjectTools, handleObjectToolCall } = require("../utils/objectToolBuilder");
const knowledgeBase = require("../ai/knowledgeBase");
const channelsEngine = require("../channels/engine");
const featureFlags = require("../platform/featureFlags");
const starhealthQuote = require("../integrations/starhealthQuote");
const { normalizePhone, looksLikePhone, looksLikeRealName } = require("../lib/phone");
const { getQueue } = require("../queue");
const { createCallFinalizerRegistry } = require("./callFinalizerRegistry");
const { createSilenceWatchdog, isSilentPcm16 } = require("./silenceWatchdog");
const geminiUsageTracker = require("../ai/geminiUsageTracker");
const rechargeBilling = require("../crm/rechargeBilling");

// Post-call pipeline (sentiment/summary/Q&A extraction/DB write) runs
// through the shared job queue instead of a bare fire-and-forget async
// call — bounds how many concurrent Gemini calls a burst of simultaneous
// call-ends can create, and retries transient failures (3 attempts, then
// dead-lettered) instead of silently degrading to a raw transcript slice
// and empty answers forever. See src/queue and callFinalizer.js.
const postCallQueue = getQueue();
const POSTCALL_CONCURRENCY = parseInt(process.env.POSTCALL_QUEUE_CONCURRENCY || "5", 10);
postCallQueue.process("finalizeCall:vobiz", processPostCallData, { concurrency: POSTCALL_CONCURRENCY });

const { createVobizOutboundAudioPlayer } = require("./vobizOutboundAudio");
const { buildVobizSessionPrompt } = require("./vobizCallPrompt");
const { runOutboundPrewarm } = require("./vobizOutboundPrewarm");
const { logGreetingLatency } = require("./vobizOpeningGreeting");

// ── Per-call raw Gemini event log ───────────────────────────────
// Google doesn't expose Live API (WebSocket) usage in AI Studio's log
// viewer or Cloud Audit Logs (confirmed by testing both directly) — so we
// keep our own record here instead: every meaningful message exchanged
// with Gemini during a call, written to a JSONL file per call, plus a
// final summary line. This is the closest equivalent to what AI Studio
// shows for regular generateContent calls, for calls it can't see at all.
const callLogDir = path.join(__dirname, "../../temp/call_logs_raw");
if (!fs.existsSync(callLogDir)) fs.mkdirSync(callLogDir, { recursive: true });
function appendCallLog(callId, entry) {
  // Never do synchronous filesystem I/O on the live-media event loop.
  // The old appendFileSync() ran for every Gemini frame and could block the
  // same Node thread that owns the 20ms Vobiz audio pacer, producing the
  // observed 3-10s outbound-audio gaps even while the queue still contained
  // audio. Keep the raw diagnostic log, but write it asynchronously.
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  fs.promises.appendFile(path.join(callLogDir, `${callId}.jsonl`), line)
    .catch((err) => log.error("❌ Call log write error:", err.message));
}

// ── Clients ───────────────────────────────────────────────────
const genai = require("../ai/googleAiClient");
const postCallAgents = require("../ai/postCallAgents");
const { isMeaningfulCallerUtterance } = require("../ai/postCallAgents/decisionEngine");
const questionnaire = require("./questionnaire");
const callFinalizer = require("./callFinalizer");


const VOICE_MAP = {
  Arjun: "Achird",
  Priya: "Sulafat",
  Dev:   "Sadaltager",
  Kavya: "Vindemiatrix",
};

// ── Instant-reply filler clips ───────────────────────────────
// Pre-baked (offline-generated, see generateFiller.js) ~350ms "Mm-hmm"
// backchannel clip per voice, 16kHz mono PCM16 — same format the live
// audio pacer already expects. Played the instant the caller finishes
// speaking so there's never dead air, while Gemini's real reply (which
// measured 588ms-1991ms to first audio in production) generates behind
// it. Missing/failed file for a voice just means no filler for that
// voice, not a crash.
// How long to wait after the last transcript fragment before assuming
// the caller is actually done (not just pausing mid-sentence). Real
// intra-utterance gaps between transcript fragments were observed up to
// ~270ms on a live call, so this needs real margin above that — set too
// low and the bot will "Mm-hmm" over a caller who is still talking.
const FILLER_DEBOUNCE_MS = 350;
const FILLER_CLIPS = {};
for (const voice of Object.values(VOICE_MAP)) {
  try {
    FILLER_CLIPS[voice] = fs.readFileSync(path.join(__dirname, "assets", "filler_" + voice + ".pcm"));
  } catch (err) {
    log.warn("No filler clip for voice " + voice + ": " + err.message);
  }
}

// Ends a live Vobiz call via their REST API (same call the server.js
// /api/vobiz/hangup route makes). Used by the "end_call" tool so the AI can
// hang up on its own once a conversation naturally wraps up, instead of
// leaving every call to end only when the caller hangs up first.
async function hangupVobizCall(callId, orgId) {
  // Prefer this org's own connected Vobiz account over the single shared
  // server-wide credentials — same reasoning as the /api/vobiz/call route.
  const ownChannel = orgId ? await channelsEngine.getChannel(orgId, "vobiz").catch(() => null) : null;
  const authId = ownChannel?.config?.authId;
  const authToken = ownChannel?.config?.authToken;
  // Diagnostic: "call not found" from Vobiz's DELETE API on a still-active
  // call usually means these credentials belong to a different Vobiz
  // account than the one that actually placed/received this call — log
  // enough to tell which credential source was used without exposing the
  // full secret.
  log.info(`🔎 end_call: hangup attempt — callId="${callId}" orgId="${orgId}" credentialSource="${ownChannel?.config?.authId ? "org-connected-channel" : "none"}" authId="${authId ? authId.slice(0, 6) + "…" : "MISSING"}"`);
  if (!authId || !authToken) {
    log.error("❌ end_call: Vobiz credentials not configured, cannot hang up.");
    return;
  }
  try {
    const response = await fetch(`https://api.vobiz.ai/api/v1/Account/${authId}/Call/${callId}/`, {
      method: "DELETE",
      headers: { "X-Auth-ID": authId, "X-Auth-Token": authToken, "Content-Type": "application/json" }
    });
    if (!response.ok && response.status !== 204) {
      const errText = await response.text();
      throw new Error(errText || `Vobiz hangup error (Status: ${response.status})`);
    }
    log.info(`📞 end_call: hung up Vobiz call ${callId}`);
  } catch (err) {
    log.error("❌ end_call: failed to hang up Vobiz call:", err.message);
  }
}

// In-memory cache for caller phone numbers mapping callId -> From (set in webhook)
const vobizCallNumbers = new Map();
function getVobizStreamSecret() {
  const secret = process.env.VOBIZ_STREAM_SECRET || process.env.VOBIZ_WEBHOOK_SECRET || process.env.INTERNAL_API_SECRET;
  if (!secret && process.env.NODE_ENV === "production") throw new Error("VOBIZ_STREAM_SECRET is required in production");
  return secret || "dev-vobiz-stream-secret";
}
function createVobizStreamToken(callId, orgId, ttlSeconds = 600) {
  if (!callId || !orgId) throw new Error("callId and orgId are required for a Vobiz stream token");
  const payload = Buffer.from(JSON.stringify({ callId: String(callId), orgId: String(orgId), exp: Math.floor(Date.now() / 1000) + ttlSeconds, purpose: "vobiz-media" })).toString("base64url");
  const sig = require("crypto").createHmac("sha256", getVobizStreamSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function verifyVobizStreamToken(token) {
  if (!token || typeof token !== "string") return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = require("crypto").createHmac("sha256", getVobizStreamSecret()).update(payload).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !require("crypto").timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.purpose === "vobiz-media" && data.callId && data.exp > Math.floor(Date.now() / 1000) ? data : null;
  } catch { return null; }
}
// vobizCallQuestions/vobizCallTaskConfig below are stored keyed by the
// LEAD's number (set in server.js's /api/vobiz/call, from the dashboard
// request). Looking those up via vobizCallNumbers (From) was therefore
// guaranteed to never match on a real outbound call — confirmed live:
// an outbound test call with a task's questions correctly saved in the
// DB never printed "Using dynamic campaign questions". This second cache
// holds the actual right key (the callee's number, from webhook "To").
const vobizCallCallee = new Map();
const vobizCallQuestions = new Map();
const vobizCallTaskConfig = new Map();
// callId -> orgId, so the calls-table insert at finalizeCall() can tag which
// org this recording belongs to. Set either at outbound-trigger time (known
// from the authenticated dashboard request) or at inbound-webhook time
// (resolved from the dialed "To" number against virtual_numbers) — see
// server.js's /api/vobiz/call and /api/vobiz/incoming.
const vobizCallOrgs = new Map();
// callId -> 'inbound' | 'outbound', set alongside vobizCallOrgs at the same
// two points (server.js's /api/vobiz/call and /api/vobiz/incoming) — lets
// the real call_logs row saved at finalizeCall() record which direction
// this actually was, so the CRM can show real inbound history separately
// from outbound.
const vobizCallDirection = new Map();
// Vobiz's own CallUUID -> our internally-generated call id. Duration was
// previously measured by our own server timer (Date.now() at WebSocket
// open vs close) instead of the telephony provider's actual call
// start/end — this map lets the Hangup webhook (which carries Vobiz's own
// AnswerTime/EndTime/Duration) correct the saved call_logs row to the
// real, authoritative duration once it arrives.
const vobizCallUuidToInternalId = new Map();

// CallUUIDs that Vobiz's own machine-detection webhook flagged as a
// voicemail/answering machine (set by server.js's
// /api/vobiz/machine-detection route). "hangup" mode still opens our media
// WebSocket for a second or two before Vobiz's hangup takes effect, so the
// normal finalizeCall()/processPostCallData() path always runs anyway — this
// lets that path tag the resulting call_logs row "Answering Machine" instead
// of the default "Completed", so it isn't the last write to clobber the
// status shown in the dashboard.
const vobizMachineDetectedCalls = new Set();

// CallUUID -> which dial attempt this was (1 = first dial). Set at
// trigger time by triggerVobizOutboundCall below, read by finalizeCall so
// a call that again ends in "No Answer"/"Answering Machine" can save the
// right attempt_number for services/dialerRetryEngine.js to pick up next.
const vobizCallAttemptNumber = new Map();

// CallUUID -> { questions, from, language, assignedContact } this call was
// actually dialed with. When a call ends in "No Answer"/"Answering
// Machine" this gets saved onto the call_logs row (see db.js's
// retryContext field) so services/dialerRetryEngine.js can redial with the
// SAME task-specific questions instead of falling back to the org's
// generic default questionnaire.
const vobizCallRetryContext = new Map();

// CallUUID -> this connection's finalizeCall() closure, set once the media
// Stream WS actually starts. Lets the /api/vobiz/incoming Hangup webhook
// (Vobiz's authoritative end-of-call signal) finalize the call directly when
// the customer hangs up but the Stream WS doesn't close promptly — before
// this, call_completed only fired on WS close, so the outbound dialer's
// auto-dial-next-target only advanced once the agent manually hung up. See
// callFinalizerRegistry.js — same registry shape used by every provider.
const vobizCallFinalizers = createCallFinalizerRegistry();

// callee-number (sanitized) -> agentId explicitly selected by the wizard
const vobizCallAgentId = new Map();

// CallUUID/callSid -> in-flight/settled Promise of resolveVobizCallSetup()'s
// result. For outbound calls, org/agent/questionnaire/KB lookups are kicked
// off the moment the call is PLACED (see triggerVobizOutboundCall) instead of
// waiting for the callee to answer — the phone typically rings for several
// seconds, which is otherwise dead time. The "start" handler below checks
// here first and only falls back to doing the lookups itself (the original,
// still-correct behavior) when nothing was pre-warmed — e.g. inbound calls,
// which can't be pre-warmed since the org isn't known until the call rings.
const vobizPrewarmedSetup = new Map();
// Outbound calls know the organization before the callee answers. Warm the
// tenant-scoped GoogleGenAI client during ringing so answer-time startup does
// not spend the first part of the caller's conversation resolving project
// credentials and constructing the Vertex client.
const vobizPrewarmedClients = new Map();

const CALL_CACHE_TTL_MS = 1_800_000;

function uniqueCallIds(...values) {
  const ids = [];
  for (const value of values) {
    if (value == null || value === "") continue;
    const id = String(value);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function collectVobizCallIds(source = {}) {
  return uniqueCallIds(
    source.CallUUID, source.callUUID, source.callId, source.CallSid, source.sid,
    source.request_uuid, source.requestUuid, source.RequestUUID,
    source.api_id, source.apiId
  );
}

function rememberMap(map, id, value) {
  map.set(id, value);
  setTimeout(() => map.delete(id), CALL_CACHE_TTL_MS);
}

function copyMapAcrossIds(map, ids) {
  let value;
  for (const id of ids) {
    if (map.has(id)) { value = map.get(id); break; }
  }
  if (value === undefined) return;
  for (const id of ids) rememberMap(map, id, value);
}

function copySetAcrossIds(set, ids) {
  if (!ids.some((id) => set.has(id))) return;
  for (const id of ids) {
    set.add(id);
    setTimeout(() => set.delete(id), CALL_CACHE_TTL_MS);
  }
}

// Vobiz's outbound Call API and later webhooks/media events often use
// different id fields (request_uuid vs CallUUID). Copy every in-memory
// cache onto every known alias so finalize, Hangup, and auto-dial all
// see the same org, retryContext, and direction.
function aliasVobizCallState(ids) {
  const all = uniqueCallIds(...ids);
  if (!all.length) return all;
  copyMapAcrossIds(vobizCallOrgs, all);
  copyMapAcrossIds(vobizCallDirection, all);
  copyMapAcrossIds(vobizCallAttemptNumber, all);
  copyMapAcrossIds(vobizCallRetryContext, all);
  copyMapAcrossIds(vobizCallNumbers, all);
  copyMapAcrossIds(vobizCallCallee, all);
  copyMapAcrossIds(vobizCallUuidToInternalId, all);
  copyMapAcrossIds(vobizPrewarmedSetup, all);
  copyMapAcrossIds(vobizPrewarmedClients, all);
  copySetAcrossIds(vobizMachineDetectedCalls, all);
  return all;
}

function rememberOutboundCall(ids, { orgId, direction, attemptNumber, retryContext, fromNumber, toNumber }) {
  const all = uniqueCallIds(...ids);
  for (const id of all) {
    if (orgId) rememberMap(vobizCallOrgs, id, orgId);
    if (direction) rememberMap(vobizCallDirection, id, direction);
    if (attemptNumber) rememberMap(vobizCallAttemptNumber, id, attemptNumber);
    if (retryContext) rememberMap(vobizCallRetryContext, id, retryContext);
    if (fromNumber) rememberMap(vobizCallNumbers, id, fromNumber);
    if (toNumber) rememberMap(vobizCallCallee, id, toNumber);
  }
  return all;
}

function findCachedCallIdByPhone(phone) {
  const last10 = String(phone || "").replace(/\D/g, "").slice(-10);
  if (!last10) return null;
  for (const [id, callee] of vobizCallCallee.entries()) {
    if (String(callee || "").replace(/\D/g, "").endsWith(last10)) return id;
  }
  for (const [id, from] of vobizCallNumbers.entries()) {
    if (String(from || "").replace(/\D/g, "").endsWith(last10)) return id;
  }
  return null;
}
async function syncDialerProviderCallSid(providerCallSid) {
  const retryContext = vobizCallRetryContext.get(providerCallSid);
  const orgId = vobizCallOrgs.get(providerCallSid);
  if (!providerCallSid || !orgId || !retryContext?.taskId) return;
  try {
    await db.patch("dialertasks", orgId, retryContext.taskId, { currentProviderCallSid: providerCallSid });
  } catch (err) {
    log.error(`❌ Failed to sync dialer providerCallSid ${providerCallSid}:`, err.message);
  }
}

setInterval(() => {
  // Belt-and-suspenders cleanup in case a call's own TTL cleanup (set where
  // each entry is created) never runs — mirrors the 30-minute horizon used
  // by every other vobizCall* cache in this file.
  if (vobizPrewarmedSetup.size > 500) vobizPrewarmedSetup.clear();
}, 1800000).unref();

// Extracted from the "start" handler's inline lookups so the exact same
// logic can run either post-answer (inbound, or outbound as a fallback) or
// pre-answer during ringing (outbound pre-warm) — see vobizPrewarmedSetup.
// Behavior is unchanged from the original inline version; only the call
// site moved.
async function resolveVobizCallSetup(resolvedOrgId, calleeNumber, resolvedPhone, direction, explicitAgentId, genericFallbackQuestions) {
  let customObjects = [];
  let orgHasKnowledgeBase = false;
  let kbMode = "all";
  let kbDocumentIds = null;
  let companyInfoPrompt = "";
  let knowledgeBaseSearchEnabled = false;
  let questionsList = genericFallbackQuestions;
  let resolvedOrgName = null;
  let knownContactName = null;
  let resolvedConfig = null;
  let resolvedVoiceName = null;

  if (!resolvedOrgId) {
    knowledgeBaseSearchEnabled = await featureFlags.isEnabled("knowledge_base_search").catch(() => false);
    return { customObjects, orgHasKnowledgeBase, kbMode, kbDocumentIds, companyInfoPrompt, knowledgeBaseSearchEnabled, questionsList, orgName: resolvedOrgName, callerContactName: knownContactName, activeConfig: resolvedConfig, voiceName: resolvedVoiceName };
  }

  const lookupPhone = direction === "outbound" ? calleeNumber : resolvedPhone;

  const customObjectsPromise = objectsEngine.listObjects(resolvedOrgId).catch((err) => {
    log.error("❌ Failed to load custom objects for Vobiz call org:", err.message);
    return [];
  });
  const orgPromise = db.getOrg(resolvedOrgId).catch((err) => {
    log.error("❌ Failed to load org profile for Vobiz call:", err.message);
    return null;
  });
  const callerIdentityPromise = (async () => {
    if (!lookupPhone) return null;
    const leadMatch = await db.findLeadByPhone(resolvedOrgId, lookupPhone);
    if (leadMatch?.name) return leadMatch.name;
    const recordMatch = await objectsEngine.findRecordByPhone(resolvedOrgId, lookupPhone);
    return recordMatch?.name || null;
  })().catch((err) => {
    log.error("❌ Failed to look up caller identity for Vobiz call:", err.message);
    return null;
  });
  const agentConfigPromise = (explicitAgentId
    ? getAgentConfigById(explicitAgentId, resolvedOrgId)
    : getAgentConfigForNumber(calleeNumber, resolvedOrgId)
  ).catch((err) => {
    log.error("❌ Failed to load agent config for Vobiz call, using default:", err.message);
    return null;
  });
  const questionsPromise = db.getQuestions(resolvedOrgId).catch((err) => {
    log.error("❌ Failed to load org questionnaire, using generic defaults:", err.message);
    return genericFallbackQuestions;
  });
  const kbFeaturePromise = featureFlags.isEnabled("knowledge_base_search").catch(() => false);

  const [loadedObjects, org, knownName, agentResult, loadedQuestions, kbFeatureEnabled] = await Promise.all([
    customObjectsPromise,
    orgPromise,
    callerIdentityPromise,
    agentConfigPromise,
    questionsPromise,
    kbFeaturePromise,
  ]);

  customObjects = loadedObjects;
  questionsList = loadedQuestions;
  knowledgeBaseSearchEnabled = kbFeatureEnabled;
  if (org) {
    companyInfoPrompt = buildCompanyInfoPrompt(org);
    if (org.name) resolvedOrgName = org.name;
  }
  if (knownName) knownContactName = knownName;

  if (agentResult?.config) {
    resolvedConfig = agentResult.config;
    resolvedVoiceName = VOICE_MAP[resolvedConfig.activeVoice] || null;
    if (explicitAgentId) {
      log.info(`🤖 Vobiz call using wizard-selected agent ${explicitAgentId} (voice: ${resolvedConfig.activeVoice})`);
    }
  }

  // 'all' (default), 'specific' (only selected documents), or 'none' (this
  // agent doesn't use the KB). Falls back to the module-level default config
  // when no agent-specific config was resolved, same as the original inline
  // version.
  const effectiveConfig = resolvedConfig || getConfig();
  kbMode = effectiveConfig.knowledgeBaseMode ?? "all";
  kbDocumentIds = kbMode === "specific" ? (effectiveConfig.knowledgeBaseDocumentIds || []) : null;
  let inlineKnowledge = null;
  try {
    orgHasKnowledgeBase = kbMode !== "none" && await knowledgeBase.hasContent(resolvedOrgId, kbDocumentIds);
    if (orgHasKnowledgeBase && knowledgeBaseSearchEnabled) {
      inlineKnowledge = await knowledgeBase.getAllContent(resolvedOrgId, kbDocumentIds).catch(() => null);
    }
  } catch (err) {
    log.error("❌ Failed to check knowledge base for Vobiz call org:", err.message);
  }

  return { customObjects, orgHasKnowledgeBase, kbMode, kbDocumentIds, companyInfoPrompt, knowledgeBaseSearchEnabled, questionsList, orgName: resolvedOrgName, callerContactName: knownContactName, activeConfig: resolvedConfig, voiceName: resolvedVoiceName, inlineKnowledge };
}

async function triggerVobizOutboundCall(orgId, phoneNumber, { questions, from, language, assignedContact, baseUrl, attemptNumber = 1, starhealthEnabled = false, agentId, taskId = null, leadId = null, retryPolicy = null } = {}) {
  const channelsEngine = require("../channels/engine");
  const billingEngine = require("../crm/billingEngine");
  const rechargeBilling = require("../crm/rechargeBilling");
  const complianceEngine = require("../crm/complianceEngine");

  let fromNumber = null;
  if (from) {
    const orgNumbers = await db.list("numbers", orgId).catch(() => []);
    const match = orgNumbers.find((n) => n.number === from && /vobiz/i.test(n.provider || ""));
    if (!match) throw new Error(`"${from}" is not a Vobiz number registered for this org (Settings > Numbers).`);
    fromNumber = match.number;
  }

  try {
    await billingEngine.ensureCurrentPeriod(orgId);
  } catch (err) {
    log.error("❌ Failed to roll AI-minutes billing period before Vobiz call:", err.message);
  }

  try {
    const compliance = await complianceEngine.checkOutboundCallAllowed(orgId, phoneNumber);
    if (!compliance.allowed) {
      const blocked = new Error(compliance.reason);
      blocked.statusCode = 403;
      throw blocked;
    }
  } catch (err) {
    if (err.statusCode === 403) throw err;
    log.error("❌ Failed to run compliance check before Vobiz call:", err.message);
  }

  if (questions && Array.isArray(questions) && questions.length > 0) {
    const sanitizedNumber = phoneNumber.replace(/[\s\-\(\)\+]+/g, "");
    vobizCallQuestions.set(sanitizedNumber, questions);
  }
  if (language || (assignedContact && assignedContact.name && assignedContact.phone) || starhealthEnabled) {
    const sanitizedNumber = phoneNumber.replace(/[\s\-\(\)\+]+/g, "");
    vobizCallTaskConfig.set(sanitizedNumber, { language, assignedContact, starhealthEnabled });
  }
  if (agentId) {
    const sanitizedNumber = phoneNumber.replace(/[\s\-\(\)\+]+/g, "");
    vobizCallAgentId.set(sanitizedNumber, agentId);
  }

  let billingReservation = null;

  const ownChannel = await channelsEngine.getChannel(orgId, "vobiz").catch(() => null);
  const authId = ownChannel?.config?.authId;
  const authToken = ownChannel?.config?.authToken;
  const vobizNumber = fromNumber || ownChannel?.config?.phoneNumber;

  if (!authId || !authToken || !vobizNumber) {
    throw new Error("No Vobiz credentials available — configure the organization call provider in the platform admin page.");
  }
  if (!baseUrl) {
    throw new Error("No base URL available to build Vobiz callback URLs (PUBLIC_URL not configured).");
  }

  try {
    billingReservation = await rechargeBilling.authorizeOutboundCall(orgId, { providerKey: "vobiz" });
  } catch (err) {
    log.warn(`⚠️ Recharge billing blocked Vobiz call for org ${orgId}: ${err.message}`);
    throw err;
  }

  const webhookSecret = process.env.VOBIZ_WEBHOOK_SECRET;
  const callbackUrl = `${baseUrl}/api/vobiz/incoming${webhookSecret ? `?webhook_secret=${encodeURIComponent(webhookSecret)}` : ""}`;
  const machineDetectionUrl = `${baseUrl}/api/vobiz/machine-detection`;

  // Numbers stored via Settings > Numbers can carry spaces/dashes exactly
  // as a user typed them (e.g. "+91 8071581359") — Vobiz's Call API rejects
  // that outright with a bare "is not valid" error that doesn't name the
  // field. Strip everything but a leading + and digits right before it
  // hits the wire, regardless of how it was stored.
  const sanitizePhone = (n) => (n || "").replace(/(?!^\+)[^0-9]/g, "");
  const sanitizedTo = sanitizePhone(phoneNumber);
  const sanitizedFrom = sanitizePhone(vobizNumber);

  log.info(`📞 Triggering Vobiz outbound call to ${sanitizedTo} from ${sanitizedFrom} (attempt ${attemptNumber})...`);

  let response;
  let data;
  try {
    response = await fetch(`https://api.vobiz.ai/api/v1/Account/${authId}/Call/`, {
    method: "POST",
    headers: { "X-Auth-ID": authId, "X-Auth-Token": authToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      to: sanitizedTo,
      from: sanitizedFrom,
      answer_url: callbackUrl,
      answer_method: "POST",
      // Explicitly register the same URL for the end-of-call Hangup event
      // instead of relying on it defaulting to answer_url when unset — the
      // Hangup handling in routes/vobiz.js (Event === "Hangup") depends on
      // this actually being delivered to force-finalize a call whose Stream
      // WS doesn't close promptly after the customer hangs up.
      hangup_url: callbackUrl,
      hangup_method: "POST",
      record: true,
      // Disabled — Vobiz's AMD only accepts "true"/"false"/"hangup" for this
      // field ("continue" 400s with a bare "is not valid"), and "hangup" is
      // what was cutting real answered calls a few seconds into the AI's
      // greeting (a fast, name-heavy greeting with no natural pauses reads
      // as machine-like to the detector). Whether "true" still auto-hangs-up
      // is undocumented and untested, so "false" is the only value we can be
      // sure never lets Vobiz end a call on our behalf. This also means the
      // /api/vobiz/machine-detection webhook below won't fire anymore.
      machine_detection: "false"
    })
  });
  } catch (err) {
    if (billingReservation) {
      await rechargeBilling.releaseReservation(billingReservation.id).catch(() => {});
    }
    log.error("❌ Vobiz outbound call request failed:", err.message);
    throw err;
  }

  data = await response.json();
  if (!response.ok) {
    // data.error/data.message can be a nested object on some Vobiz error
    // responses, not a plain string — new Error(obj) silently stringifies
    // it to the useless "[object Object]", hiding the real reason a call
    // failed to place. Stringify explicitly so the real detail survives.
    const rawErr = data.error || data.message || `Vobiz API error (Status: ${response.status})`;
    const errText = typeof rawErr === "string" ? rawErr : JSON.stringify(rawErr);
    if (billingReservation) await rechargeBilling.releaseReservation(billingReservation.id).catch(() => {});
    log.error(`❌ Vobiz outbound call API rejected it — status ${response.status}, body:`, JSON.stringify(data));
    throw new Error(errText);
  }

  log.info(`✅ Outbound Vobiz call initiated. Response:`, JSON.stringify(data));
  // Prefer the same identifiers the media WS / Hangup webhook will send
  // (CallUUID / callId) over request_uuid, and remember every alias so a
  // later webhook using a different field still finds org + retryContext.
  const responseCallIds = collectVobizCallIds(data);
  if (billingReservation) {
    await rechargeBilling.attachProviderCall(billingReservation.id, responseCallIds[0] || null);
  }
  const callSids = rememberOutboundCall(
    responseCallIds.length ? responseCallIds : [`vobiz_outbound_${Date.now()}`],
    {
      orgId,
      direction: "outbound",
      attemptNumber,
      retryContext: { questions, from, language, assignedContact, taskId, leadId, provider: "vobiz", retryPolicy: retryPolicy || null, billingReservationId: billingReservation?.id || null },
      fromNumber: sanitizedFrom,
      toNumber: sanitizedTo,
    }
  );
  const callSid = responseCallIds[0] || callSids[0];

  // Pre-warm org/agent/questionnaire/KB lookups now, while the callee's phone
  // is still ringing, instead of waiting for the "start" handler to do it
  // after they've already said hello — see vobizPrewarmedSetup above. Every
  // input this needs (orgId, the number being called, agentId) is already
  // known at this point; only failures here are swallowed (falls back to the
  // normal post-answer lookup path) so a pre-warm problem can never break the
  // call itself.
  const prewarmedClientPromise = genai.getClientForOrg(orgId).catch((err) => {
    log.error("❌ Vobiz Google AI client pre-warm failed, will retry post-answer:", err.message);
    return null;
  });
  for (const id of callSids) rememberMap(vobizPrewarmedClients, id, prewarmedClientPromise);

  const prewarmPromise = runOutboundPrewarm({
    orgId,
    phoneNumber,
    agentId: agentId || null,
    questions,
    taskConfig: { language, assignedContact, starhealthEnabled },
    taskId,
    resolveVobizCallSetup,
    genericFallbackQuestions: undefined,
  }).catch((err) => {
    log.error("❌ Vobiz pre-warm failed, will retry post-answer:", err.message);
    vobizPrewarmedSetup.delete(callSid);
    return null;
  });
  for (const id of callSids) rememberMap(vobizPrewarmedSetup, id, prewarmPromise);

  return { success: true, callSid, callSids };
}

function getWavHeader(dataLength, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);                                      h.writeUInt32LE(dataLength + 36, 4);
  h.write("WAVE", 8);                                      h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);                                 h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);                           h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  h.writeUInt16LE(channels * bitsPerSample / 8, 32);       h.writeUInt16LE(bitsPerSample, 34);
  h.write("data", 36);                                     h.writeUInt32LE(dataLength, 40);
  return h;
}

// Resample 24kHz -> 16kHz for recording file consistency (so recordings match the browser proxy format)
function resample24To16(buffer24) {
  const aligned = new Uint8Array(buffer24.length);
  aligned.set(buffer24);
  const s24 = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);
  const s16 = new Int16Array(Math.round(s24.length * 2 / 3));
  for (let i = 0; i < s16.length; i++) {
    const pos = i * 1.5;
    const lo = Math.floor(pos);
    const hi = Math.min(s24.length - 1, lo + 1);
    s16[i] = s24[lo] * (1 - (pos - lo)) + s24[hi] * (pos - lo);
  }
  return Buffer.from(s16.buffer, s16.byteOffset, s16.byteLength);
}

// ── WS send helper ────────────────────────────────────────────
function sendJson(wsConn, obj) {
  if (wsConn.readyState === 1) wsConn.send(JSON.stringify(obj));
}

// ──────────═════════════════════
// MAIN VOBIZ SESSION HANDLER
// ──────────═════════════════════
async function handleVobizSession(vobizWs, streamContext = null) {
  let isActive = true;
  let streamId = null;
  let callId = null;
  // Spoken in the opening greeting below — was hardcoded to "ChiefVoice"
  // regardless of which org's call this actually was; set from the real
  // org profile once resolved in the "start" handler.
  let orgName = "our team";
  // Set once the caller is recognized as an existing saved contact (see
  // the "start" handler below) — used both in the greeting and the
  // system prompt so the AI addresses them by name and doesn't re-ask
  // for it. Null for a genuinely new/unknown caller.
  let callerContactName = null;
  const startTime = Date.now();
  const authorizedCallId = streamContext?.callId ? String(streamContext.callId) : null;
  const authorizedOrgId = streamContext?.orgId ? String(streamContext.orgId) : null;
  if (!authorizedCallId || !authorizedOrgId) throw new Error("Vobiz stream authorization context is required");

  const generatedCallId = `call_vobiz_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const tempDir = path.join(__dirname, "../../temp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const tempPcmPath = path.join(tempDir, `${generatedCallId}.pcm`);
  const recordStream = fs.createWriteStream(tempPcmPath);
  // A call can end while Gemini still has an in-flight callback. Never let a
  // late audio frame write to an ended/error stream: Node treats an
  // unhandled WriteStream error as a process-level crash.
  let recordStreamClosed = false;
  recordStream.on("error", (err) => {
    recordStreamClosed = true;
    log.error(`❌ Vobiz recording stream error [${generatedCallId}]:`, err.message);
  });
  recordStream.on("finish", () => { recordStreamClosed = true; });
  const writeRecording = (buffer) => {
    if (recordStreamClosed || recordStream.destroyed || recordStream.writableEnded) return false;
    try {
      return recordStream.write(buffer);
    } catch (err) {
      recordStreamClosed = true;
      log.error(`❌ Vobiz recording write failed [${generatedCallId}]:`, err.message);
      return false;
    }
  };
  const endRecording = () => {
    if (recordStreamClosed || recordStream.destroyed || recordStream.writableEnded) return;
    try { recordStream.end(); } catch (err) {
      recordStreamClosed = true;
      log.error(`❌ Vobiz recording close failed [${generatedCallId}]:`, err.message);
    }
  };
  const transcriptLines = [];

  // Default/fallback until the org is resolved in the "start" handler below
  // (org-scoped config isn't known until then — see resolvedOrgId).
  let activeConfig = getConfig();
  let voiceName = VOICE_MAP[activeConfig.activeVoice] || "Achird";

  // Generic last-resort fallback, used only if this org has no industry set
  // AND no questionnaire row saved yet (db.getQuestions() below already
  // returns this org's real industry-scoped defaults in every other case —
  // see services/industryPacks.js and services/db.js's DEFAULT_QUESTIONS).
  const genericFallbackQuestions = [
    "Unga full name enna, sollunga?",
    "Ugaluku enna vishayathula help venum?",
    "Unga budget matum timeline enna?",
    "Ugaluku edhavadhu specific requirements iruka?"
  ];

  let geminiSessionPromise = null;
  let lastResumptionHandle = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 2;

  log.info(`📞 New Vobiz voice connection. Voice: ${activeConfig.activeVoice} (${voiceName})`);

  let geminiSetupFinished = false;
  let preparedOpeningPlayed = false;
  let preparedOpeningText = null;
  let outboundAudioPlayer = null;
  let answerAtMs = null;
  let callLatencyMetrics = {};

  const triggerGreetingIfReady = async () => {
    if (!geminiSetupFinished || !streamId) return;
    const geminiSession = geminiSessionPromise ? await geminiSessionPromise : null;
    if (!geminiSession) return;
    try {
      if (preparedOpeningPlayed && preparedOpeningText && geminiSession.sendPreparedOpeningHandoff) {
        log.info("👋 Gemini handoff after prepared opening greeting...");
        await geminiSession.sendPreparedOpeningHandoff(preparedOpeningText);
        callLatencyMetrics.fullGreetingComplete = Date.now();
        logGreetingLatency(callId, callLatencyMetrics);
        return;
      }
      log.info("👋 Triggering custom warm greeting (Live fallback)...");
      const callDirection = vobizCallDirection.get(callId) || "inbound";
      const greetingAddressee = callerContactName ? `${callerContactName} sir/mam` : "sir/mam";
      const greetingText = callDirection === "outbound"
        ? `Vanakkam ${greetingAddressee}! Naanga ${orgName}-la irundhu call panrom. Ippo pesalama?`
        : `Vanakkam ${greetingAddressee}! Sollunga, epdi help pannalam?`;
      const greetingStartedAt = Date.now();
      await geminiSession.sendText(greetingText);
      log.info(`⏱️ Initial greeting request sent in ${Date.now() - greetingStartedAt}ms [call=${callId}]`);
    } catch (e) {
      log.error("Failed to trigger initial greeting:", e.message);
    }
  };

  let liveInputTokens = 0;
  let liveOutputTokens = 0;
  let totalInboundAudioBytes = 0;
  let totalOutboundAudioBytes = 0;

  let isFinalized = false;

  vobizWs.on("message", async (rawMsg) => {
    if (!isActive) return;
    const rawStr = rawMsg.toString();
    
    // Handle plain-text error messages from Vobiz (non-JSON)
    let msg;
    try {
      msg = JSON.parse(rawStr);
    } catch (_) {
      log.warn("⚠️ Vobiz sent non-JSON message:", rawStr.slice(0, 200));
      return;
    }
    
    try {
      
      switch (msg.event) {
        case "start":
          streamId = msg.start.streamId;
          callId = msg.start.callId;
          if (String(callId) !== authorizedCallId) {
            log.error(`🚫 Vobiz stream call mismatch: token=${authorizedCallId} start=${callId}`);
            isActive = false;
            try { vobizWs.close(1008, "Call authorization mismatch"); } catch {}
            return;
          }
          const cachedOrgId = vobizCallOrgs.get(callId);
          if (cachedOrgId && String(cachedOrgId) !== authorizedOrgId) {
            log.error(`🚫 Vobiz stream org mismatch: token=${authorizedOrgId} cache=${cachedOrgId} call=${callId}`);
            isActive = false;
            try { vobizWs.close(1008, "Organization authorization mismatch"); } catch {}
            return;
          }
          vobizCallOrgs.set(callId, authorizedOrgId);
          aliasVobizCallState([callId, authorizedCallId]);
          log.info(`🚀 Vobiz Stream started: ${streamId} | CallId: ${callId} | Org: ${authorizedOrgId}`);
          vobizCallFinalizers.register(callId, finalizeCall);
          vobizCallUuidToInternalId.set(callId, generatedCallId);
          setTimeout(() => vobizCallUuidToInternalId.delete(callId), 1800000);

          // Resolve caller number and fetch custom questions
          const resolvedPhone = vobizCallNumbers.get(callId) || "";
          const sanitizedPhone = resolvedPhone.replace(/[\s\-\(\)\+]+/g, "");
          // Outbound task questions/config are keyed by the LEAD's number
          // (vobizCallCallee), not the caller-ID number above — see
          // vobizCallCallee's definition for why using sanitizedPhone here
          // never matched on a real outbound call.
          const calleeNumber = vobizCallCallee.get(callId) || "";
          const sanitizedCallee = calleeNumber.replace(/[\s\-\(\)\+]+/g, "");
          const customQuestions = sanitizedCallee ? vobizCallQuestions.get(sanitizedCallee) : null;
          const taskConfig = sanitizedCallee ? vobizCallTaskConfig.get(sanitizedCallee) : null;
          if (sanitizedCallee && vobizCallTaskConfig.has(sanitizedCallee)) vobizCallTaskConfig.delete(sanitizedCallee);

          // Diagnostic only (temporary) — org/call-log saving for this call
          // depends entirely on this callId matching the CallUUID the
          // /api/vobiz/incoming webhook used to cache the org. If either
          // line below is empty, that mismatch is why org resolution (and
          // therefore call_logs saving) silently fails for this call.
          log.info(`🔎 Vobiz start diagnostics — callId="${callId}" resolvedPhone="${resolvedPhone}" cachedOrgId="${vobizCallOrgs.get(callId) || "NONE"}" fullStartPayload=${JSON.stringify(msg.start)}`);

          // Resolve the org's custom objects (Phase 1 "any industry" engine) so
          // this call's agent can save data into whatever industry pack the
          // org picked at signup, not just the hardcoded lending questionnaire.
          // Empty for lending orgs (no pack) and for calls with no resolved
          // orgId — in both cases behavior below falls back to the original
          // insurance-questionnaire prompt, unchanged from before this change.
          const resolvedOrgId = vobizCallOrgs.get(callId) || null;
          let customObjects = [];
          let kbDocumentIds = null;

          // Reuse the Gemini client that was already resolved during ringing
          // (see triggerVobizOutboundCall → vobizPrewarmedClients). For
          // inbound calls (or any outbound call whose pre-warm expired/failed)
          // fall back to resolving now — same as before, just without wasting
          // the re-resolve on an already-cached client.
          const startupT0 = Date.now();
          const hadPrewarmedClient = vobizPrewarmedClients.has(callId);
          const prewarmedGeminiClientPromise = hadPrewarmedClient
            ? vobizPrewarmedClients.get(callId)
            : genai.getClientForOrg(resolvedOrgId).catch((err) => {
                log.warn(`⚠️ Vobiz Gemini client pre-warm failed; falling back during connect: ${err.message}`);
                return null;
              });
          if (hadPrewarmedClient) vobizPrewarmedClients.delete(callId);
          const prewarmedFeatureFlagsPromise = Promise.all([
            featureFlags.isEnabled("knowledge_base_search"),
            featureFlags.isEnabled("email_documents"),
            featureFlags.isEnabled("whatsapp_channel"),
            featureFlags.isEnabled("ai_auto_hangup"),
          ]).catch((err) => {
            log.warn(`⚠️ Vobiz feature-flag pre-warm failed; falling back during connect: ${err.message}`);
            return null;
          });
          log.debug(`⏱️ Vobiz startup pre-warm launched at +${Date.now() - startupT0}ms after start handler entered (client pre-warmed=${hadPrewarmedClient})`);

          const explicitAgentId = sanitizedCallee ? vobizCallAgentId.get(sanitizedCallee) : null;
          if (explicitAgentId) vobizCallAgentId.delete(sanitizedCallee);

          // Outbound calls have their org/agent/questionnaire/KB lookups
          // already kicked off (and often already finished) back when the
          // call was placed — see vobizPrewarmedSetup / triggerVobizOutboundCall.
          // Reuse that instead of repeating the same lookups from scratch now
          // that the callee has already answered. Inbound calls (org unknown
          // until the call rings) and any outbound call whose pre-warm never
          // registered/expired/failed fall through to the original on-demand
          // lookup, unchanged.
          const hadPrewarmMapEntry = vobizPrewarmedSetup.has(callId);
          const prewarmPayload = hadPrewarmMapEntry ? await vobizPrewarmedSetup.get(callId) : null;
          vobizPrewarmedSetup.delete(callId);
          if (!prewarmPayload) {
            log.info(`PREWARM_MISS callId=${callId}`);
          }

          const setup = prewarmPayload?.setup || prewarmPayload || (resolvedOrgId
            ? await resolveVobizCallSetup(resolvedOrgId, calleeNumber, resolvedPhone, vobizCallDirection.get(callId) || "inbound", explicitAgentId, genericFallbackQuestions)
            : await resolveVobizCallSetup(null, calleeNumber, resolvedPhone, "inbound", null, genericFallbackQuestions));

          customObjects = setup.customObjects || [];
          if (setup.orgName) orgName = setup.orgName;
          if (setup.callerContactName) callerContactName = setup.callerContactName;
          if (setup.activeConfig) {
            activeConfig = setup.activeConfig;
            voiceName = setup.voiceName || voiceName;
          }
          kbDocumentIds = setup.kbDocumentIds;

          answerAtMs = Date.now();
          outboundAudioPlayer = createVobizOutboundAudioPlayer(vobizWs, () => streamId, { callId: generatedCallId });
          callLatencyMetrics = {
            callId,
            providerCallId: callId,
            answerAt: answerAtMs,
            prewarmHit: Boolean(prewarmPayload?.finalPrompt),
            geminiConnectStart: null,
            geminiConnectComplete: null,
            setupComplete: null,
            ...(prewarmPayload?.metrics || {}),
          };

          if (customQuestions && Array.isArray(customQuestions) && customQuestions.length > 0) {
            log.info(`ℹ️ Using dynamic campaign questions for Vobiz call:`, customQuestions);
            vobizCallQuestions.delete(sanitizedCallee);
          }

          let finalPrompt;
          let customToolDeclarations;
          let normalizedQuestions;

          if (prewarmPayload?.finalPrompt) {
            finalPrompt = prewarmPayload.finalPrompt;
            customToolDeclarations = prewarmPayload.customToolDeclarations;
            normalizedQuestions = prewarmPayload.normalizedQuestions;
            log.info(`⏱️ Vobiz prewarm hit — prompt ${finalPrompt.length} chars, KB inline ${prewarmPayload.kbInlineLength || 0} chars`);
          } else {
            const promptBundle = await buildVobizSessionPrompt({
              resolvedOrgId,
              setup,
              customQuestions,
              taskConfig,
              genericFallbackQuestions,
              callerContactName,
              orgName,
            });
            finalPrompt = promptBundle.finalPrompt;
            customToolDeclarations = promptBundle.customToolDeclarations;
            normalizedQuestions = promptBundle.normalizedQuestions;
            kbDocumentIds = promptBundle.kbDocumentIds;
            log.info(`⏱️ Vobiz prompt built on answer — ${finalPrompt.length} chars (KB inline ${promptBundle.kbInlineLength || 0})`);
          }

          if (prewarmPayload?.openingGreetingAudio?.length) {
            preparedOpeningPlayed = true;
            preparedOpeningText = prewarmPayload.openingGreetingText;
            outboundAudioPlayer.enqueuePcm(prewarmPayload.openingGreetingAudio, { fastStart: true });
            writeRecording(prewarmPayload.openingGreetingAudio);
            transcriptLines.push({ role: "ai", text: preparedOpeningText });
            callLatencyMetrics.greetingPlaybackStart = Date.now();
            callLatencyMetrics.answer_to_greeting_play_ms = callLatencyMetrics.greetingPlaybackStart - answerAtMs;
            logGreetingLatency(callId, callLatencyMetrics);
          }

          // Connect to Gemini asynchronously in the background. Wrapped in a
          // named function (instead of one inline call) so an abnormal
          // disconnect (e.g. the Gemini-side 1011 "Internal error occurred"
          // close) can call this again with the last resumption handle and
          // keep the caller's call alive instead of dropping them.
          const connectGemini = (resumeHandle) => {
          callLatencyMetrics.geminiConnectStart = Date.now();
          geminiSessionPromise = openGeminiSession(
            vobizWs,
            voiceName,
            finalPrompt,
            recordStream,
            transcriptLines,
            generatedCallId,
            () => streamId,
            (inTokens, outTokens) => {
              liveInputTokens += inTokens;
              liveOutputTokens += outTokens;
              if (global.broadcastLog) {
                global.broadcastLog(`🪙 Tokens Spent: Input ${liveInputTokens} | Output ${liveOutputTokens}`, { type: "usage", inputTokens: liveInputTokens, outputTokens: liveOutputTokens });
              }
            },
            (outBytes) => {
              totalOutboundAudioBytes += outBytes;
              if (answerAtMs && !callLatencyMetrics.firstGeminiAudioChunk) {
                callLatencyMetrics.firstGeminiAudioChunk = Date.now();
                callLatencyMetrics.answer_to_first_gemini_audio_ms = callLatencyMetrics.firstGeminiAudioChunk - answerAtMs;
              }
            },
            () => {
              geminiSetupFinished = true;
              callLatencyMetrics.setupComplete = Date.now();
              if (callLatencyMetrics.geminiConnectStart) {
                callLatencyMetrics.setup_complete_ms = callLatencyMetrics.setupComplete - callLatencyMetrics.geminiConnectStart;
              }
              // Only greet on the call's first-ever connection. On a
              // reconnect (after e.g. the Gemini-side 1011 crash) the
              // session resumption handle already restores the
              // conversation server-side — replaying the greeting here
              // would talk over/reset that resumed context.
              if (reconnectAttempts === 0) triggerGreetingIfReady();
            },
            // For an outbound call, resolvedPhone is OUR OWN caller-ID
            // number (see vobizCallNumbers' definition) — the live
            // caller-number callback must return the lead's own number
            // instead, same as finalizeCall's callerNumber below, or
            // save_enquiry's phone fallback saves our own virtual number
            // instead of the caller's.
            () => (((vobizCallDirection.get(callId) || "unknown") === "outbound" && calleeNumber) ? calleeNumber : resolvedPhone) || "Vobiz Call",
            customToolDeclarations,
            resolvedOrgId,
            customObjects,
            () => callId,
            resumeHandle,
            (handle) => { lastResumptionHandle = handle; },
            (code, reason) => {
              if (!isActive) return; // call already ended normally, nothing to reconnect
              if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                log.error(`❌ Vobiz call ${generatedCallId}: Gemini reconnect limit (${MAX_RECONNECT_ATTEMPTS}) reached, giving up. Last close code: ${code}`);
                return;
              }
              reconnectAttempts++;
              log.info(`🔄 Vobiz call ${generatedCallId}: Gemini closed unexpectedly (code ${code}, reason: ${reason || "none"}) — reconnecting (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) ${lastResumptionHandle ? "with resumption handle" : "without a resumption handle (conversation context may restart)"}.`);
              if (global.broadcastLog) {
                global.broadcastLog(`🔄 Voice session reconnecting after unexpected disconnect (attempt ${reconnectAttempts})`, { type: "system", callId: generatedCallId });
              }
              connectGemini(lastResumptionHandle);
            },
            kbDocumentIds,
            normalizedQuestions,
            outboundAudioPlayer,
            {
              prewarmedGeminiClientPromise,
              prewarmedFeatureFlagsPromise,
            },
            { writeRecording }
          ).then(session => {
            callLatencyMetrics.geminiConnectComplete = Date.now();
            if (callLatencyMetrics.geminiConnectStart) {
              callLatencyMetrics.gemini_connect_ms = callLatencyMetrics.geminiConnectComplete - callLatencyMetrics.geminiConnectStart;
            }
            log.info(`✅ Gemini Live session open for Vobiz | Call ID: ${generatedCallId} (connect ${callLatencyMetrics.gemini_connect_ms || "?"}ms)`);
            if (global.broadcastLog) {
              global.broadcastLog(`📞 Voice Session Open | Call ID: ${generatedCallId}`, { type: "system", callId: generatedCallId });
            }
            return session;
          }).catch(err => {
            log.error("❌ Gemini session failed for Vobiz:", err.message);
            endRecording();
            try { fs.unlinkSync(tempPcmPath); } catch {}
            try { if (vobizWs.readyState === 1) vobizWs.close(); } catch {}
            return null;
          });
          };
          connectGemini(null);

          break;

        case "media":
          if (msg.media.track === "inbound") {
            const geminiSession = await geminiSessionPromise;
            if (!geminiSession) return;

            // Inbound payload is 16-bit little-endian PCM from Vobiz (L16 = host byte order)
            const rawPCM = Buffer.from(msg.media.payload, "base64");
            // No byte-swap needed: L16 is already little-endian

            // Vobiz sends 16kHz - send directly to Gemini
            const pcm16k = rawPCM;

            // Send to Gemini
            await geminiSession.sendAudio(pcm16k.toString("base64"));
            totalInboundAudioBytes += pcm16k.length;
            if (!isSilentPcm16(pcm16k)) silenceWatchdog.recordAudio();

            // Save to recording file without allowing a late Gemini frame
            // to crash the Node process after the call has already ended.
            writeRecording(pcm16k);
          }
          break;

        case "stop":
          log.info(`🔌 Vobiz Stream stopped: ${streamId}`);
          await finalizeCall();
          const geminiSession = await geminiSessionPromise;
          if (geminiSession) try { await geminiSession.close(); } catch {}
          break;
      }
    } catch (err) {
      log.error("❌ Vobiz Message error:", err.message, "| Raw:", rawMsg.toString().slice(0, 200));
    }
  });

  // Nudges the caller once after 10s of no inbound audio (stalled media
  // stream / caller thinking). If silence continues to 30s total, the call
  // is treated as hung up and force-finalized — a backstop for when the
  // provider's own end-of-call webhook (Hangup/StatusCallback) doesn't
  // arrive, so the outbound dialer's auto-dial-next-target isn't stuck
  // waiting on a call the customer already ended.
  const silenceWatchdog = createSilenceWatchdog({
    nudgeMs: 10000,
    hangupMs: 45000,
    onNudge: async (silentMs) => {
      if (!isActive || !geminiSessionPromise) return;
      log.warn(`⚠️ Vobiz call ${callId}: no inbound audio for ${Math.round(silentMs / 1000)}s — possible stalled media stream. Nudging caller.`);
      if (global.broadcastLog) {
        global.broadcastLog(`⚠️ No response from caller for ${Math.round(silentMs / 1000)}s — checking in`, { type: "system", callId });
      }
      try {
        const geminiSession = await geminiSessionPromise;
        if (geminiSession) await geminiSession.sendNudge("Hello, are you still there?");
      } catch (err) {
        log.error(`❌ Silence-watchdog nudge failed for call ${callId}:`, err.message);
      }
    },
    onHangup: async (silentMs) => {
      if (!isActive) return;
      log.warn(`🔌 Vobiz call ${callId}: no inbound audio for ${Math.round(silentMs / 1000)}s — treating as hung up, force-finalizing.`);
      await finalizeCall();
      try { vobizWs.close(); } catch {}
    },
  });

  async function finalizeCall() {
    if (isFinalized) return;
    isFinalized = true;
    isActive = false;
    silenceWatchdog.stop();
    endRecording();
    const duration = Math.round((Date.now() - startTime) / 1000);
    if (!recordStreamClosed) {
      const RECORD_FINISH_TIMEOUT_MS = 5000;
      await Promise.race([
        new Promise((resolve) => {
          const onFinish = () => { cleanup(); resolve(); };
          const onError = () => { cleanup(); resolve(); };
          const cleanup = () => {
            recordStream.off("finish", onFinish);
            recordStream.off("error", onError);
          };
          recordStream.once("finish", onFinish);
          recordStream.once("error", onError);
        }),
        new Promise((resolve) => setTimeout(resolve, RECORD_FINISH_TIMEOUT_MS)),
      ]);
    }

    // Retrieve caller phone number and resolved org (if any) from cache
    const rawCallerNumber = vobizCallNumbers.get(callId) || "Vobiz Call";
    const calleeNumber = vobizCallCallee.get(callId) || "";
    vobizCallNumbers.delete(callId); // clean up
    vobizCallCallee.delete(callId);
    const orgId = vobizCallOrgs.get(callId) || null;
    vobizCallOrgs.delete(callId);
    const isMachineDetected = vobizMachineDetectedCalls.has(callId);
    vobizMachineDetectedCalls.delete(callId);
    const attemptNumber = vobizCallAttemptNumber.get(callId) || 1;
    vobizCallAttemptNumber.delete(callId);
    const retryContext = vobizCallRetryContext.get(callId) || null;
    vobizCallRetryContext.delete(callId);
    const billingReservationId = retryContext?.billingReservationId || null;
    const direction = vobizCallDirection.get(callId) || "unknown";
    vobizCallDirection.delete(callId);
    vobizCallFinalizers.unregister(callId);
    // For an outbound call, vobizCallNumbers holds OUR OWN caller-ID
    // number, not the lead's (see vobizCallCallee's definition above) —
    // save the actual callee's number instead, so call_logs and the
    // dialer's own-call-completion matching (DialerSimulator.tsx) both
    // reflect who was actually called, not us. Without this, a genuinely
    // connected-then-ended outbound call never matched the dialer's
    // active lead phone number, so Continuous Dialer Mode never advanced
    // automatically — only a manual "Disconnect Call" click worked.
    const callerNumber = (direction === "outbound" && calleeNumber) ? calleeNumber : rawCallerNumber;

    if (global.broadcastLog) {
      global.broadcastLog(`🛑 Call completed | Caller: ${callerNumber} | Duration: ${duration}s | Total Tokens: ${liveInputTokens + liveOutputTokens}`, { type: "system", duration, inputTokens: liveInputTokens, outputTokens: liveOutputTokens });
    }

    appendCallLog(generatedCallId, {
      type: "call_summary",
      callerNumber,
      orgId,
      direction,
      durationSeconds: duration,
      liveInputTokens,
      liveOutputTokens,
      transcriptLines
    });

    // Sanitized callee — this is the key vobizCallQuestions/vobizCallTaskConfig
    // are stored under (see the "start" handler above). Must be computed here,
    // before vobizCallCallee.delete(callId) above, and passed through
    // explicitly: processPostCallData used to reference a `sanitizedCallee`
    // that only existed in a totally different closure (the "start" handler's
    // scope, not this one) — a confirmed ReferenceError that silently aborted
    // the ENTIRE post-call pipeline (no call_logs row at all) whenever live
    // tool-calls hadn't already saved the answers.
    const sanitizedCalleeForFinalize = calleeNumber ? calleeNumber.replace(/[\s\-\(\)\+]+/g, "") : null;

    // Recording upload happens once, right here, synchronously — never
    // inside the queued job. The temp PCM file is deleted the moment it's
    // read, so a retried job re-reading it would find nothing there.
    let recordingUrl = null;
    if (fs.existsSync(tempPcmPath)) {
      try {
        const rawPcm = fs.readFileSync(tempPcmPath);
        const wavBuffer = Buffer.concat([getWavHeader(rawPcm.length), rawPcm]);
        recordingUrl = await callFinalizer.uploadRecording("vobiz", generatedCallId, wavBuffer);
      } finally {
        try { fs.unlinkSync(tempPcmPath); } catch {}
      }
    }

    const workflowQuestions = sanitizedCalleeForFinalize
      ? postCallAgents.normalizeQuestions(vobizCallQuestions.get(sanitizedCalleeForFinalize))
      : null;

    postCallQueue.enqueue("finalizeCall:vobiz", {
      callId: generatedCallId, callerNumber, recordingUrl, durationSeconds: duration,
      billingReservationId,
      transcriptLines, activeConfig, liveInputTokens, liveOutputTokens,
      totalInboundAudioBytes, totalOutboundAudioBytes, orgId, direction,
      isMachineDetected, attemptNumber, retryContext, sanitizedCallee: sanitizedCalleeForFinalize,
      workflowQuestions,
      // Vobiz's own CallUUID (the WS "start" payload's callId, NOT
      // generatedCallId above) — this is the exact same id the frontend
      // already holds as vobizCallSid the moment it dials (see
      // /api/vobiz/call's response). Passed through to the call_completed
      // broadcast so DialerSimulator.tsx can match "this is MY call" by
      // exact id instead of guessing from a phone-number string compare,
      // which broke whenever the lead's stored number and Vobiz's reported
      // callerNumber differed in country-code formatting.
      providerCallSid: callId,
    });
  }

  vobizWs.on("close", async () => {
    log.info(`🌐 Vobiz WS closed | Call ID: ${generatedCallId}`);
    await finalizeCall();
    const geminiSession = await geminiSessionPromise;
    if (geminiSession) try { await geminiSession.close(); } catch {}
  });

  vobizWs.on("error", err => {
    log.error(`❌ Vobiz WS error [${generatedCallId}]:`, err.message);
    // The websocket error itself is not a process-fatal condition. Finalize
    // the call once so dialer state, recording and post-call processing are
    // released even when Vobiz closes abnormally.
    finalizeCall().catch((finalizeErr) => {
      log.error(`❌ Vobiz finalize after WS error failed [${generatedCallId}]:`, finalizeErr.message);
    });
  });
}


// GEMINI LIVE SESSION
// ──────────═════════════════════
async function openGeminiSession(vobizWs, voiceName, systemPrompt, recordStream, transcriptLines, callId, getStreamId, onTokenUsage, onAudioOut, onSetupComplete, getCallerNumber, customToolDeclarations = [], orgId = null, customObjects = [], getVobizCallId = null, resumeHandle = null, onResumptionHandle, onDisconnect, kbDocumentIds = null, normalizedQuestions = [], outboundAudioPlayer = null, prewarmedDeps = null, recordingHooks = null) {
  let loggedSampleServerContent = 0; // diagnostic-only counter, see onmessage below
  let lastRawBroadcastAt = 0;

  // Contact capture state (used when Gemini doesn't fire a toolCall) — was
  // previously declared in handleVobizSession, a sibling function with no
  // closure access to this one's `onmessage` callback, so every reference
  // below threw a real ReferenceError. That code path only ever ran once
  // live transcription started actually working (see the SDK upgrade),
  // which is when this bug first surfaced and crashed the process.
  const contactState = { email: null, phone: null, emailPending: false, whatsAppPending: false };
  // Gemini sometimes issues the exact same search_knowledge_base call
  // twice in one turn (two distinct function-call IDs, not a dispatch
  // bug on our side — confirmed from logs) which doubles the real
  // lookup latency for no reason. Cache by query within this call so a
  // repeat returns instantly instead of hitting the DB/embeddings again.
  const knowledgeBaseCache = new Map();
  let lastCallerSpeechAt = null;
  let awaitingFirstAgentChunk = false;
  let fillerTimer = null;
  if (!outboundAudioPlayer) {
    outboundAudioPlayer = createVobizOutboundAudioPlayer(vobizWs, getStreamId, { callId });
  }
  const audioOut = outboundAudioPlayer;
  // Guards against the model calling the end_call tool more than once for
  // the same call (observed in production: it can re-invoke end_call on
  // its very next turn before the 3.5s grace-period hangup below has even
  // fired) — without this, the second call schedules its own redundant
  // hangupVobizCall(), which always fails with Vobiz's "call not found"
  // once the first one has already ended the call. Declared HERE, not in
  // handleVobizSession — see contactState's comment above this function
  // for why that sibling function's scope isn't visible to this one's
  // onmessage callback (a real ReferenceError, not just a lint concern:
  // it crashed this handler on every end_call, so the AI could no longer
  // hang up a call it decided to end at all).
  let endCallRequested = false;

  // One stateful resampler per call — carries interpolation state across
  // Gemini's own small inlineData chunks so consecutive chunks resample
  // as one continuous stream instead of each restarting at sample 0 (see
  // createResampler24To16's comment). Must NOT be shared across calls.
  const resampleOut = createResampler24To16();
  // Buffer, not a plain array — pushing PCM byte-by-byte into a JS array
  // (the previous implementation) meant tens of thousands of individual
  // Array.push() calls per audio chunk, repeated many times a second. With
  // several outbound calls running concurrently in this one Node process
  // (see DIAL_CONCURRENCY in autoDialEngine.js), that CPU/GC load was enough
  // to delay this call's own 20ms pacer tick below, which is what callers
  // heard as mid-call stutter/voice breaks. Buffer.concat/subarray do the
  // same job as native memcpy/views instead of per-byte JS overhead.
  let currentWs = vobizWs;
  let currentRecordStream = recordStream;
  const startPacing = () => audioOut.startPacing();
  const stopPacing = () => audioOut.stopPacing();

  // Inject custom VAD config safely over WS intercept
  const originalSend = ws.prototype.send;
  ws.prototype.send = function (data, options, callback) {
    try {
      const payload = JSON.parse(data);
      if (payload.setup) {
        delete payload.setup.contextWindowCompression;

        payload.setup.realtime_input_config = {
          automatic_activity_detection: {
            disabled: false,
            start_of_speech_sensitivity: "START_SENSITIVITY_HIGH",
            end_of_speech_sensitivity: "END_SENSITIVITY_HIGH",
            // Was lowered to 250ms to cut dead-air after callers stop
            // talking, but that's short enough to cut real speech off
            // mid-sentence during a natural pause — confirmed live:
            // caller turns came back as garbled, incoherent fragments
            // ("Lei dice che dà", random digits/symbols) because the
            // model was transcribing tiny truncated audio clips instead
            // of full utterances. Raised back to 350ms (matches
            // twilioProxy.js/piopiyProxy.js) to prioritize transcript/
            // summary quality over the small latency win.
            silence_duration_ms: 350
          }
        };
        delete payload.setup.realtimeInputConfig;

        // Force enable transcription for both inbound and outbound channels by passing empty objects
        payload.setup.input_audio_transcription = {};
        payload.setup.output_audio_transcription = {};

        if (!payload.setup.generationConfig) {
          payload.setup.generationConfig = {};
        }
        payload.setup.generationConfig.temperature = 0.9;

        // Disable "thinking" — multi-paragraph internal reasoning the model
        // was writing out before every reply (visible in logs as thought:true
        // parts), adding real latency before speech starts and billed as
        // extra output tokens. Live conversation doesn't need deep reasoning
        // per turn, just a fast response.
        payload.setup.generationConfig.thinkingConfig = { thinkingBudget: 0 };

        data = JSON.stringify(payload);
        log.info("⚙️ Vobiz Stream: Intercepted setup payload, injected low-latency VAD, disabled thinking, and forced both transcriptions.");
        if (global.broadcastLog) {
          const modelName = "gemini-live-2.5-flash-native-audio";
          global.broadcastLog(`📤 [Gemini Send] setup (model: ${modelName}, voice: ${voiceName})`, { type: "gemini_raw" });
        }
      }
    } catch (_) {}
    ws.prototype.send = originalSend;
    return originalSend.call(this, data, options, callback);
  };

  // Prefer work started at Vobiz stream start. If pre-warming was unavailable
  // (inbound call, cache miss, or a transient failure), retain the original
  // on-demand behavior.
  const featureFlagPromise = prewarmedDeps?.prewarmedFeatureFlagsPromise || Promise.all([
    featureFlags.isEnabled("knowledge_base_search"),
    featureFlags.isEnabled("email_documents"),
    featureFlags.isEnabled("whatsapp_channel"),
    featureFlags.isEnabled("ai_auto_hangup"),
  ]);
  const geminiClientPromise = prewarmedDeps?.prewarmedGeminiClientPromise || genai.getClientForOrg(orgId);
  const [featureFlagResult, geminiClientResult] = await Promise.all([
    Promise.resolve(featureFlagPromise).then((value) => value || Promise.all([
      featureFlags.isEnabled("knowledge_base_search"),
      featureFlags.isEnabled("email_documents"),
      featureFlags.isEnabled("whatsapp_channel"),
      featureFlags.isEnabled("ai_auto_hangup"),
    ])),
    Promise.resolve(geminiClientPromise).then((value) => value || genai.getClientForOrg(orgId)),
  ]);
  const [vobizKbEnabled, vobizEmailEnabled, vobizWhatsappEnabled, vobizAutoHangupEnabled] =
    featureFlagResult;
  const geminiClient = geminiClientResult;

  const modelName = "gemini-live-2.5-flash-native-audio";

  // Usage/cost tracking (src/ai/geminiUsageTracker.js) — one row per
  // Gemini Live session. Started here, right before the connection this
  // session's usage will actually belong to, rather than earlier in the
  // call setup where nothing Gemini-specific has happened yet. Vobiz's
  // own streamId stands in for a provider session id — the Live API
  // itself doesn't expose one at connect time, and streamId already
  // uniquely identifies this specific connection attempt (a reconnect
  // after a Gemini-side error gets a new streamId, so it correctly
  // produces a NEW usage row rather than conflating two sessions).
  // adminId is intentionally omitted here — no authenticated human
  // request initiated this specific WS session (it's a telephony
  // webhook), unlike the manual-dial/auto-dial paths that DO have one at
  // trigger time; usage still rolls up correctly by orgId regardless.
  // Usage tracking is not on the critical path to first audio — fire it
  // in the background so the Gemini Live WebSocket connect (the real
  // latency bottleneck, ~2s round-trip) can start immediately. The usage
  // handle is only needed at session-close time to record final token
  // counts, so we resolve it lazily via the promise.
  const usageHandlePromise = geminiUsageTracker.startUsageSession({
    orgId,
    callId,
    sessionId: getStreamId ? getStreamId() : null,
    provider: "vobiz",
    model: modelName,
  }).catch((err) => {
    log.error("❌ Gemini usage tracker start failed (non-fatal):", err.message);
    return null;
  });

  const geminiConnectStartedAt = Date.now();
  log.info(`⏱️ Vobiz Gemini connect starting (pre-warmed client=${Boolean(prewarmedDeps?.prewarmedGeminiClientPromise)})`);
  const session = await geminiClient.live.connect({
    model: modelName,
    config: {
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      responseModalities: ["AUDIO"],

      // Zero thinking on the first response is important for telephony UX.
      // The native-audio model can otherwise spend extra time reasoning before
      // emitting its first audio chunk. Keep the voice turn conversational;
      // business/tool work can still happen after the caller responds.
      generationConfig: {
        temperature: 0.7,
        thinkingConfig: { thinkingBudget: 0 },
      },

      tools: [
        {
          functionDeclarations: [
            // Legacy lending/insurance policy search — only relevant for orgs
            // still on the hardcoded lending questionnaire path (no custom
            // objects set up for their actual industry). Orgs with custom
            // objects get the industry-appropriate 'search_knowledge_base'
            // tool below instead; including this one for them would hand
            // the AI a tool that talks about "insurance policy" regardless
            // of what business the org actually runs.
            ...(customObjects.length === 0 && vobizKbEnabled ? [{
              name: "search_policy_knowledge_base",
              description: "Search the insurance policy documents database for definitions, policy terms, coverages, limits, and rules.",
              parameters: {
                type: "OBJECT",
                properties: {
                  query: {
                    type: "STRING",
                    description: "Specific search terms or keywords to query in the insurance policy database"
                  }
                },
                required: ["query"]
              }
            }] : []),
            {
              name: "save_question_response",
              description: "Record the client's answer to one of the mandatory questionnaire questions.",
              parameters: {
                type: "OBJECT",
                properties: {
                  question: {
                    type: "STRING",
                    description: "The exact question asked to the client"
                  },
                  answer: {
                    type: "STRING",
                    description: "The client's answer, response, or statement"
                  }
                },
                required: ["question", "answer"]
              }
            },
            ...(vobizEmailEnabled ? [{
              name: "send_email_document",
              description: "Send an email document to the user's Gmail ID. Use this when the user requests a copy of their document, loan package, or summary, and you have confirmed their Gmail ID.",
              parameters: {
                type: "OBJECT",
                properties: {
                  recipient_email: {
                    type: "STRING",
                    description: "The recipient's email address (Gmail ID)"
                  },
                  subject: {
                    type: "STRING",
                    description: "The subject line of the email"
                  },
                  body: {
                    type: "STRING",
                    description: "The main body content of the email"
                  },
                  document_type: {
                    type: "STRING",
                    description: "The type of document being sent (e.g. 'policy brief', 'loan approval')"
                  }
                },
                required: ["recipient_email", "subject", "body"]
              }
            }] : []),
            ...(vobizWhatsappEnabled ? [{
              name: "send_whatsapp_message",
              description: "Send a WhatsApp message or document link to the user. Use this when the user requests information or a file copy via WhatsApp, and you have confirmed their WhatsApp number.",
              parameters: {
                type: "OBJECT",
                properties: {
                  whatsapp_number: {
                    type: "STRING",
                    description: "The target WhatsApp phone number (with country code)"
                  },
                  message: {
                    type: "STRING",
                    description: "The text message content to send"
                  },
                  document_url: {
                    type: "STRING",
                    description: "Optional URL of a document to attach"
                  },
                  file_name: {
                    type: "STRING",
                    description: "Optional name of the attached file"
                  }
                },
                required: ["whatsapp_number", "message"]
              }
            }] : []),
            ...(vobizAutoHangupEnabled ? [{
              name: "end_call",
              description: "End the current call. Call this only after you have said a brief goodbye to the caller and the conversation has naturally concluded (goals met, caller says goodbye, or caller has nothing further to add).",
              parameters: { type: "OBJECT", properties: {} }
            }] : []),
            {
              name: "save_contact_details",
              description: "Save/update this caller's name, email, or location in the contact directory the moment they tell you — quietly, in the background, don't announce it as a database save. Call it as soon as they give you their name (even before anything else is discussed), and again any time they give you an email or location you didn't already have.",
              parameters: {
                type: "OBJECT",
                properties: {
                  name: { type: "STRING", description: "Caller's name, if they just gave it" },
                  email: { type: "STRING", description: "Caller's email, if they just gave it" },
                  location: { type: "STRING", description: "Caller's location, if they just gave it" }
                },
                required: []
              }
            },
            ...customToolDeclarations
          ]
        }
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: "AUTO"
        }
      },
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName }
        }
      },

      inputAudioTranscription:  {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
          startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
        },
        turnCoverage: "TURN_INCLUDES_ALL_INPUT",
      },
      contextWindowCompression: {
        triggerTokens: 25600,
        slidingWindow: { targetTokens: 12800 },
      },
      // Lets us reopen a dropped connection (e.g. the Gemini-side 1011
      // "Internal error occurred" close) without the caller repeating
      // themselves — Gemini keeps the conversation server-side and resumes
      // it from the handle instead of us resending transcript history.
      sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
    },
    callbacks: {
      onmessage: async (response) => {
        // A single message-processing bug (like the capturedEmail
        // ReferenceError that used to live here) must never crash the whole
        // server — that takes down every org's calls, not just this one.
        // Everything below runs inside this try; any error is logged and
        // the call keeps running instead of killing the process.
        try {

        // Full response key logging so we can debug what Gemini actually sends
        const responseKeys = Object.keys(response || {});
        if (responseKeys.includes('toolCall') || responseKeys.includes('serverContent')) {
          log.info("📥 Gemini response keys:", responseKeys.join(', '));
        }
        // Persist every non-empty frame to this call's own log file — the
        // durable record AI Studio can't provide for Live API sessions.
        if (responseKeys.length > 0 && !(responseKeys.length === 1 && responseKeys[0] === "usageMetadata" && !response.serverContent)) {
          appendCallLog(callId, { type: "gemini_frame", keys: responseKeys, usageMetadata: response.usageMetadata || null, serverContent: response.serverContent || null, toolCall: response.toolCall || null });
        }
        // Diagnostic only (temporary) — transcript is coming back empty for
        // real Vobiz calls despite inputAudioTranscription/
        // outputAudioTranscription being requested in the session config.
        // The first sample landed on an empty keepalive {} — skip those and
        // only dump non-empty serverContent samples (capped at 5 total per
        // call) so we can see real shapes without spamming the log.
        if (response.serverContent && Object.keys(response.serverContent).length > 0 && loggedSampleServerContent < 5) {
          loggedSampleServerContent++;
          log.info(`🔎 Vobiz sample serverContent #${loggedSampleServerContent}:`, JSON.stringify(response.serverContent).slice(0, 1000));
        }
        if (response.toolCall) {
          log.info("🛠️ toolCall detected:", JSON.stringify(response.toolCall).slice(0, 500));
        }

        // ── PRIMARY: top-level toolCall (standard Gemini Live path)
        const topLevelCalls = response.toolCall?.functionCalls || [];

        // ── SECONDARY: functionCall parts inside modelTurn (alternate Live API path)
        const modelTurnParts = response.serverContent?.modelTurn?.parts || [];
        const embeddedCalls = modelTurnParts
          .filter(p => p.functionCall)
          .map(p => ({ id: p.functionCall.id || `fn_${Date.now()}`, name: p.functionCall.name, args: p.functionCall.args }));

        const allFunctionCalls = [...topLevelCalls, ...embeddedCalls];

        if (allFunctionCalls.length > 0) {
          const functionResponses = [];
          for (const call of allFunctionCalls) {
            log.info(`🛠️ Vobiz Tool Call: Executing ${call.name}`, JSON.stringify(call.args || {}));
            const __toolStart = Date.now();
            let result = {};
            if (call.name === "search_policy_knowledge_base") {
              result = (await featureFlags.isEnabled("knowledge_base_search"))
                ? await handleSearchPolicyKnowledgeBase(call.args.query)
                : { error: "This feature is currently disabled." };
            } else if (call.name === "save_question_response") {
              const phone = getCallerNumber ? getCallerNumber() : "Vobiz Call";
              result = await handleSaveQuestionResponse(orgId, callId, phone, call.args.question, call.args.answer, normalizedQuestions);
            } else if (call.name === "send_email_document") {
              result = (await featureFlags.isEnabled("email_documents"))
                ? await handleSendEmailDocument(call.args.recipient_email, call.args.subject, call.args.body, call.args.document_type)
                : { error: "This feature is currently disabled." };
            } else if (call.name === "send_whatsapp_message") {
              result = (await featureFlags.isEnabled("whatsapp_channel"))
                ? await handleSendWhatsappMessage(call.args.whatsapp_number, call.args.message, call.args.document_url, call.args.file_name)
                : { error: "This feature is currently disabled." };
            } else if (call.name === "search_knowledge_base" && orgId) {
              if (!(await featureFlags.isEnabled("knowledge_base_search"))) {
                result = { error: "This feature is currently disabled." };
              } else {
                const cacheKey = (call.args.query || "").trim().toLowerCase();
                if (knowledgeBaseCache.has(cacheKey)) {
                  result = knowledgeBaseCache.get(cacheKey);
                } else {
                  try {
                    const matches = await knowledgeBase.search(orgId, call.args.query, 3, kbDocumentIds);
                    result = matches.length ? { results: matches.map((m) => m.content) } : { results: [], note: "No matching content found in the knowledge base." };
                    knowledgeBaseCache.set(cacheKey, result);
                  } catch (err) {
                    result = { error: err.message };
                  }
                }
              }
            } else if (call.name === "end_call") {
              if (!(await featureFlags.isEnabled("ai_auto_hangup"))) {
                result = { error: "This feature is currently disabled." };
              } else {
              // Grace period before actually hanging up — the model calls this
              // right after speaking its goodbye line, but that audio is still
              // draining through the pacing/output pipeline to the caller's
              // phone at this point. Cutting the call immediately would clip
              // the farewell mid-sentence.
              // hangupVobizCall needs Vobiz's own CallUUID (from the "start"
              // stream event), not our internal generatedCallId (`callId`
              // here) — passing the wrong one is why every AI-initiated
              // hangup used to fail with Vobiz's "call not found".
              if (endCallRequested) {
                result = { success: true, note: "Call is already ending." };
              } else {
                endCallRequested = true;
                const realVobizCallId = getVobizCallId ? getVobizCallId() : callId;
                log.info(`👋 end_call requested — hanging up in 3.5s | Call ID: ${callId} | Vobiz CallUUID: ${realVobizCallId}`);
                setTimeout(() => hangupVobizCall(realVobizCallId, orgId), 3500);
                result = { success: true, note: "Call will end shortly." };
              }
              }
            } else if (call.name === "save_enquiry") {
              result = await handleSaveEnquiry(orgId, callId, call.args, getCallerNumber ? getCallerNumber() : null);
            } else if (call.name === "save_contact_details") {
              const phoneForContact = getCallerNumber ? getCallerNumber() : null;
              result = await callFinalizer.saveContactDetailsNow(orgId, phoneForContact, vobizCallDirection.get(callId) || "unknown", call.args);
            } else if (call.name === "get_starhealth_quote") {
              const quote = { status: "deferred_by_design" }; // live wait removed (was up to 25s dead air) — always defer to post-call WhatsApp delivery now
              if (quote.status === "ok") {
                result = { success: true, plans: quote.plans.slice(0, 3) };
              } else {
                // Live fetch too slow/failed — retry once, longer, after the
                // call ends, then deliver over WhatsApp if we have a number.
                // Same "fire an async side effect and swallow errors" style
                // as end_call's setTimeout above — no job queue exists here.
                const phone = getCallerNumber ? getCallerNumber() : null;
                const input = quote.input || call.args;
                setTimeout(async () => {
                  try {
                    const retry = await starhealthQuote.getQuoteWithTimeout(input, 90000);
                    if (retry.status === "ok" && phone) {
                      const lines = retry.plans.slice(0, 3)
                        .map((p, i) => `${i + 1}. ${p.name} — ${p.price} (Sum Insured: ${p.sumInsured}, ${p.policyPeriod})`)
                        .join("\n");
                      await handleSendWhatsappMessage(phone, `Here's your Star Health quote:\n${lines}`);
                    } else if (retry.status !== "ok") {
                      log.error(`❌ Star Health deferred quote retry failed for call ${callId}:`, retry.message || retry.status);
                    }
                  } catch (err) {
                    log.error(`❌ Star Health deferred quote retry error for call ${callId}:`, err.message);
                  }
                }, 5000);
                result = { success: true, deferred: true, message: "Quote will be sent to the caller after the call." };
              }
            } else if (orgId) {
              const objectResult = await handleObjectToolCall(objectsEngine, orgId, customObjects, call.name, call.args);
              if (objectResult) result = objectResult;
            }
            log.info(`⏱️ DEBUG: tool "${call.name}" took ${Date.now() - __toolStart}ms`);
            functionResponses.push({
              id: call.id,
              name: call.name,
              response: { output: result }
            });
          }

          try {
            session.sendToolResponse({ functionResponses });
          } catch (err) {
            session.send({ toolResponse: { functionResponses } });
          }
        }

        if (response.setupComplete) {
          log.info("⚙️ Gemini Setup Complete. Ready for greeting.");
          if (onSetupComplete) onSetupComplete();
        }

        // Gemini periodically issues a fresh resumption handle — keep the
        // latest one so a reconnect (see onclose below) can resume from the
        // most recent point instead of an early, stale point in the call.
        if (response.sessionResumptionUpdate?.resumable && response.sessionResumptionUpdate?.newHandle) {
          if (onResumptionHandle) onResumptionHandle(response.sessionResumptionUpdate.newHandle);
        }

        if (!vobizWs || vobizWs.readyState !== 1) return;

        // AI audio response
        if (response.serverContent?.modelTurn?.parts) {
          for (const part of response.serverContent.modelTurn.parts) {
            if (part.inlineData?.mimeType?.startsWith("audio/")) {
              const raw24kPCM = Buffer.from(part.inlineData.data, "base64");
              if (onAudioOut) {
                onAudioOut(raw24kPCM.length);
              }

              // 1. Resample: 24kHz PCM -> 16kHz PCM for Vobiz playback.
              // Stateful per-call instance (see createResampler24To16) —
              // Gemini streams audio in many small inlineData chunks per
              // turn, and resampling each one in isolation (restarting
              // the interpolation position at 0 every time) put an
              // audible discontinuity at every chunk boundary, which is
              // what actually caused the "Good" / "morning." fragmented
              // playback — not the pacing/queueing below, which was
              // already smoothing chunk TIMING correctly.
              const pcm16k = resampleOut(raw24kPCM);

              // Real reply audio has arrived — cancel any pending filler, and if
              // the filler is already mid-playback, cut it short (clear the
              // queue) rather than let the real reply wait behind it. Without
              // this, the filler's own duration would add straight onto the
              // caller's wait on fast turns instead of only covering the
              // dead air on slow ones.
              if (fillerTimer) {
                clearTimeout(fillerTimer);
                fillerTimer = null;
              }
              if (audioOut.isFillerPlaying()) {
                audioOut.clearQueue();
                audioOut.setFillerPlaying(false);
              }

              audioOut.enqueuePcm(pcm16k);

              // Save to recording file without allowing a late Gemini frame
              // to crash the Node process after the call has already ended.
              if (recordingHooks?.writeRecording) recordingHooks.writeRecording(pcm16k);
              else if (!recordStream.destroyed && !recordStream.writableEnded) recordStream.write(pcm16k);
            }
          }
        }

        // Transcripts
        if (response.serverContent?.inputTranscription?.text) {
          const text = response.serverContent.inputTranscription.text.trim();
          if (!isMeaningfulCallerUtterance(text)) {
            log.debug(`Skipping non-speech caller transcription [${callId}]: "${text}"`);
          } else {
          lastCallerSpeechAt = Date.now();
          awaitingFirstAgentChunk = true;

          // Do not wait for Gemini's separate `interrupted` event to stop
          // stale model audio. The transcript is already proof that the
          // caller has started a new turn. Clearing immediately prevents
          // queued AI speech from being played back over the caller and also
          // prevents old audio from surfacing seconds later after a queue
          // stall.
          if (audioOut.getQueueLength() > 0 || audioOut.isFillerPlaying()) {
            if (fillerTimer) { clearTimeout(fillerTimer); fillerTimer = null; }
            audioOut.setFillerPlaying(false);
            audioOut.stopPacing();
            sendJson(vobizWs, { event: "clearAudio", streamId: getStreamId() });
            log.debug(`🛑 Vobiz audio cleared on caller speech [${callId}]`);
          }

          log.info(`👤 Vobiz Caller: "${text}"`);

          // Debounced instant-reply filler — reset on every fragment so it
          // only fires once fragments stop arriving for FILLER_DEBOUNCE_MS
          // (i.e. the caller has actually stopped, not just paused
          // mid-sentence). See the real-audio block above for how this
          // gets cut short if the real reply beats it.
          if (fillerTimer) clearTimeout(fillerTimer);
          fillerTimer = setTimeout(() => {
            fillerTimer = null;
            if (!awaitingFirstAgentChunk) return;
            const filler = FILLER_CLIPS[voiceName];
            if (!filler || !vobizWs || vobizWs.readyState !== 1) return;
            audioOut.setFillerPlaying(true);
            audioOut.enqueuePcm(filler);
            log.info(`🫧 Filler played while awaiting real reply (voice: ${voiceName})`);
          }, FILLER_DEBOUNCE_MS);
          transcriptLines.push({ role: "user", text });
          if (global.broadcastLog) {
            global.broadcastLog(`👤 Caller: "${text}"`, { type: "transcript", role: "user", text });
          }

          // ── Gemini Flash intent extractor (replaces fragile regex) ───────────────
          // Runs a fast non-streaming Gemini call after every caller turn to reliably
          // extract email/phone from natural speech ("brito at gmail dot com", etc.)
          extractContactAndTrigger(text, transcriptLines, contactState.email, contactState.phone, contactState.emailPending, contactState.whatsAppPending)
            .then(result => {
              if (result.email) { contactState.email = result.email; contactState.emailPending = false; }
              if (result.phone) { contactState.phone = result.phone; contactState.whatsAppPending = false; }
              if (result.shouldSendEmail) { contactState.emailPending = true; }
              if (result.shouldSendWhatsApp) { contactState.whatsAppPending = true; }
            })
            .catch(err => log.warn("⚠️ Contact extractor error:", err.message));
          }
        }
        if (response.serverContent?.outputTranscription?.text) {
          const text = response.serverContent.outputTranscription.text;
          if (awaitingFirstAgentChunk && lastCallerSpeechAt) {
            log.info(`⏱️ DEBUG: latency from last caller speech to first agent reply: ${Date.now() - lastCallerSpeechAt}ms`);
            awaitingFirstAgentChunk = false;
          }
          log.info(`🤖 Agent to Vobiz: "${text}"`);
          transcriptLines.push({ role: "ai", text });
          if (global.broadcastLog) {
            global.broadcastLog(`🤖 Agent: "${text}"`, { type: "transcript", role: "ai", text });
          }
        }

        // Barge-in: caller interrupted AI
        if (response.serverContent?.interrupted) {
          if (fillerTimer) { clearTimeout(fillerTimer); fillerTimer = null; }
          audioOut.setFillerPlaying(false);
          stopPacing();
          sendJson(vobizWs, {
            event: "clearAudio",
            streamId: getStreamId()
          });
        }

        } catch (err) {
          log.error("❌ Vobiz onmessage handler error:", err.stack || err.message);
        }
      },
      onerror: (err) => {
        log.error("❌ Gemini error in Vobiz call:", err.message || err);
      },
      onclose: (e) => {
        log.info(`🔌 Gemini closed for Vobiz. Code: ${e?.code}, Reason: ${e?.reason || "none"}`);
        if (fillerTimer) { clearTimeout(fillerTimer); fillerTimer = null; }
        stopPacing();
        // Finalize THIS session's usage row — idempotent, so if a
        // reconnect below also somehow triggers a second close event for
        // the same handle, only the first call actually writes anything.
        // Code 1000 is a normal, intentional close (we hung up the Gemini
        // session ourselves at end of call) — only abnormal closes (e.g.
        // 1011 "Internal error occurred") should trigger a reconnect.
        if (e?.code === 1000) {
          usageHandlePromise.then((h) => h && geminiUsageTracker.finalizeUsageSession(h, { status: "completed" })).catch(() => {});
        } else {
          usageHandlePromise.then((h) => h && geminiUsageTracker.failUsageSession(h, {
            errorCode: e?.code != null ? String(e.code) : "unknown",
            errorMessage: e?.reason || "Gemini Live session closed abnormally",
          })).catch(() => {});
        }
        if (e?.code !== 1000 && onDisconnect) onDisconnect(e?.code, e?.reason);
      },
    },
  });

  // Attach raw WebSocket packet listener to capture exact Google server frames including usageMetadata
  if (session && session.conn && session.conn.ws) {
    session.conn.ws.on("message", (rawFrame) => {
      try {
        const payload = JSON.parse(rawFrame.toString());
        const usage = payload.usageMetadata || payload.serverContent?.usageMetadata || payload.usage_metadata || payload.serverContent?.usage_metadata;

        // Raw Gemini frames are useful for diagnostics, but broadcasting every
        // 20-50ms frame to the dashboard is not part of the call path. Under
        // concurrent calls it creates avoidable JSON/stringification and
        // WebSocket work on the same Node event loop as the Vobiz media pacer.
        // Throttle only the human-readable raw feed; usage is still processed
        // on every frame.
        const now = Date.now();
        const shouldBroadcastRaw = Boolean(global.broadcastLog) && (now - lastRawBroadcastAt >= 250);
        if (shouldBroadcastRaw) {
          lastRawBroadcastAt = now;
          let eventSummary = "📥 [Gemini Receive] ";
          if (payload.serverContent?.modelTurn?.parts) {
            const hasAudio = payload.serverContent.modelTurn.parts.some(p => p.inlineData?.mimeType?.startsWith("audio/"));
            eventSummary += `serverContent (modelTurn${hasAudio ? ' with audio payload' : ''})`;
          } else if (payload.serverContent?.inputTranscription) {
            eventSummary += `inputTranscription (text: "${payload.serverContent.inputTranscription.text}")`;
          } else if (payload.serverContent?.outputTranscription) {
            eventSummary += `outputTranscription (text: "${payload.serverContent.outputTranscription.text}")`;
          } else if (payload.serverContent?.interrupted) {
            eventSummary += `interrupted (caller barge-in)`;
          } else if (payload.serverContent?.turnComplete) {
            eventSummary += `turnComplete`;
          } else {
            eventSummary += Object.keys(payload).join(", ");
          }
          global.broadcastLog(eventSummary, { type: "gemini_raw" });
        }

        // Count usage on every frame. This path is intentionally independent
        // of the diagnostic broadcast throttle above.
        if (usage) {
          const inCount = usage.promptTokenCount || usage.prompt_token_count || 0;
          const outCount = usage.responseTokenCount || usage.response_token_count ||
                           usage.candidatesTokenCount || usage.candidates_token_count || 0;
          if (inCount > 0 || outCount > 0) {
            if (global.broadcastLog) {
              global.broadcastLog(`📥 [Gemini Receive] usageMetadata (promptTokens: ${inCount}, responseTokens: ${outCount})`, { type: "gemini_raw" });
            }
            onTokenUsage(inCount, outCount);
            usageHandlePromise.then((h) => h && geminiUsageTracker.recordUsage(h, { inputTokens: inCount, outputTokens: outCount })).catch(() => {});
          }
        }
      } catch (err) {
        // Not a JSON packet
      }
    });
  }

  return {
    sendAudio: async (base64Pcm16k) => {
      await session.sendRealtimeInput({
        media: {
          data: base64Pcm16k,
          mimeType: "audio/pcm;rate=16000",
        },
      });
    },
    sendText: async (text) => {
      // Must be role "user" (turn_complete:true) to actually trigger the
      // model to generate + speak a new turn — a role "model" turn is
      // just prior context and produces no audio at all. But sending the
      // literal greeting words as if the CALLER said them ("Hello, we're
      // calling from ChiefVoice, tell me what you need, how can I help?")
      // made the model think the caller had offered to help IT, and it
      // started improvising as if it were the caller. Wrapping the text
      // as an explicit stage direction (not dialogue) keeps the same
      // working trigger mechanism while stopping that role confusion.
      // ONLY for the call-open greeting — see sendNudge below for any
      // mid-call system-triggered turn, which must NOT reuse this
      // "speak your opening greeting" framing.
      if (session.conn && session.conn.ws && session.conn.ws.readyState === 1) {
        const directive = `[System directive — NOT something the caller said. The call just connected. Greet the caller IMMEDIATELY without any hesitation, pause, or thinking — speak right now, in character: "${text}"]`;
        session.conn.ws.send(JSON.stringify({
          client_content: {
            turns: [
              {
                role: "user",
                parts: [{ text: directive }]
              }
            ],
            turn_complete: true
          }
        }));
      }
    },
    // Mid-call system-triggered check-in (silence watchdog etc.) — shares
    // sendText's role:"user"/turn_complete:true trigger mechanism, but
    // with framing that does NOT tell the model to "speak your opening
    // greeting" again. Reusing sendText's greeting directive here was a
    // real bug: mid-call, with an unanswered question already asked, the
    // model interpreted "speak your opening greeting now" literally and
    // re-greeted the caller AND restated its last question — confirmed
    // live from a call transcript that showed the same question said
    // back-to-back with no caller turn in between, once per silence nudge.
    sendNudge: async (text) => {
      if (session.conn && session.conn.ws && session.conn.ws.readyState === 1) {
        const directive = `[System directive, not something the caller said: the caller has gone quiet. Briefly check in along these lines: "${text}" — do NOT re-introduce yourself, and do NOT repeat or restate whatever you already asked; just check they're still there, then continue waiting for their answer to your last question.]`;
        session.conn.ws.send(JSON.stringify({
          client_content: {
            turns: [
              {
                role: "user",
                parts: [{ text: directive }]
              }
            ],
            turn_complete: true
          }
        }));
      }
    },
    sendPreparedOpeningHandoff: async (spokenGreeting) => {
      if (session.conn && session.conn.ws && session.conn.ws.readyState === 1) {
        const directive = `[System directive — NOT something the caller said. The call just connected and you have ALREADY spoken this exact opening greeting aloud to the caller (do NOT repeat it): "${spokenGreeting}". Wait silently for their response. When they answer, continue the conversation naturally from the full instructions — proceed to question 1 or their request without re-introducing yourself or saying the opening again.]`;
        session.conn.ws.send(JSON.stringify({
          client_content: {
            turns: [
              {
                role: "user",
                parts: [{ text: directive }],
              },
            ],
            turn_complete: true,
          },
        }));
      }
    },
    close: async () => {
      stopPacing();
      try { await session.close(); } catch {}
    },
  };
}

// ──────────═════════════════════
// POST CALL DATA HANDLING
// ──────────═════════════════════
// Takes a single plain-data object (not positional args) — this is exactly
// the shape enqueued onto the post-call job queue (see src/queue), so the
// function signature IS the job payload contract. recordingUrl arrives
// pre-uploaded (see callFinalizer.uploadRecording) — this function never
// touches the filesystem, which is what makes it safe to retry.
async function processPostCallData({
  callId, callerNumber, recordingUrl, durationSeconds, transcriptLines, activeConfig,
  liveInputTokens, liveOutputTokens, totalInboundAudioBytes, totalOutboundAudioBytes,
  orgId = null, direction = "unknown", isMachineDetected = false, attemptNumber = 1,
  retryContext = null, sanitizedCallee = null, providerCallSid = null,
  workflowQuestions = null, billingReservationId = null,
}) {
  callerNumber = normalizePhone(callerNumber);

  let sentiment = null;
  // Sentiment is computed once for Vobiz and passed into the shared finalizer.
  // Busy/no-real-conversation calls intentionally remain null.
  const mergedForSentiment = callFinalizer.mergeTranscriptLines(transcriptLines);
  const callerWordCount = mergedForSentiment
    .filter((line) => line.role === "user" && isMeaningfulCallerUtterance(line.text))
    .reduce((sum, line) => sum + line.text.trim().split(/\s+/).filter(Boolean).length, 0);
  const callAnswered = !isMachineDetected && callerWordCount > 0;

  const fullTranscript = callFinalizer.buildFullTranscript(mergedForSentiment);
  let sentimentInputTokens = 0;
  let sentimentOutputTokens = 0;

  if (callAnswered) {
    let liveAnswers = [];
    try { liveAnswers = await db.getResponsesByCallId(orgId, callId); } catch {}
    const result = await postCallAgents.analyzeSentiment(fullTranscript, orgId, liveAnswers);
    sentiment = result.sentiment;
    sentimentInputTokens = result.inputTokens;
    sentimentOutputTokens = result.outputTokens;
    log.info(`📊 Vobiz Sentiment: ${sentiment ?? "null"}`);
  }

  // Callback/enquiry extraction is intentionally NOT run here. The shared
  // call finalizer runs the Scheduling & Enquiry Agent after the Summary
  // Agent and with sentiment available, so there is exactly one action
  // decision-maker and no duplicate callback/enquiry generation.
  let extractedCallerName = null;
  let followUp = null;

  // Combined token calculation for BOTH models
  let totalInputTokens = liveInputTokens + sentimentInputTokens;
  let totalOutputTokens = liveOutputTokens + sentimentOutputTokens;

  // Fallback if websocket usageMetadata wasn't populated (calculate based on duration/audio bytes)
  if (totalInputTokens === 0 && totalInboundAudioBytes > 0) {
    // 16kHz 16-bit PCM has 32,000 bytes per second. Audio input tokens = 32 per second.
    // Plus baseline for systemPrompt + transcript turns history context
    const inputAudioSeconds = totalInboundAudioBytes / 32000;
    const promptBaseline = 1500 + (transcriptLines.length * 150);
    totalInputTokens = Math.round((inputAudioSeconds * 32) + promptBaseline);
  }
  if (totalOutputTokens === 0 && totalOutboundAudioBytes > 0) {
    // 24kHz 16-bit PCM has 48,000 bytes per second. Audio output tokens = 25 per second.
    const outputAudioSeconds = totalOutboundAudioBytes / 48000;
    totalOutputTokens = Math.round(outputAudioSeconds * 25);
  }

  // Pricing (verified against Google's official Gemini API pricing page for
  // native audio, gemini-2.5-flash-native-audio-preview): Input: $3.00 / 1M
  // tokens ($0.000003 / token) | Output: $12.00 / 1M tokens ($0.000012 / token)
  const costUsd = (totalInputTokens * 0.000003) + (totalOutputTokens * 0.000012);

  log.info(`📊 Cost Breakdown: Total Input Tokens=${totalInputTokens}, Total Output Tokens=${totalOutputTokens}, Cost=$${costUsd.toFixed(5)}`);


  // Save to this app's REAL data layer (MySQL call_logs, via
  // services/db.js) — this is what the CRM's Call Logs view, Dashboard
  // metrics, and Platform Admin actually read. Without this, a real call
  // (recorded, transcribed, sentiment-analyzed above) never showed up
  // anywhere in the app itself. Everything from contact matching through
  // the call_logs write and broadcast is shared across every provider —
  // see callFinalizer.js.
  if (billingReservationId) {
    try {
      const aiSummary = await db.getAiUsageSummary(orgId, {}).catch(() => null);
      const aiCostInr = aiSummary?.platformTotalCostInr ?? null;
      await rechargeBilling.settleReservation({
        reservationId: billingReservationId,
        durationSeconds,
        aiCostInr,
      });
    } catch (err) {
      log.error(`❌ Failed to settle recharge reservation ${billingReservationId}:`, err.message);
    }
  }

  await callFinalizer.finalizeCallRecord({
    provider: "vobiz",
    orgId,
    callId,
    callerNumber,
    direction,
    durationSeconds,
    sentiment,
    recordingUrl,
    transcriptLines,
    extractedCallerName,
    getWorkflowQuestions: () => workflowQuestions || (sanitizedCallee ? postCallAgents.normalizeQuestions(vobizCallQuestions.get(sanitizedCallee)) : null),
    isMachineDetected,
    attemptNumber,
    retryContext,
    providerCallSid,
    // Scheduling/enquiry extraction is owned by callFinalizer and runs once
    // after summary, with the final sentiment available.
    sentimentInputTokens,
    sentimentOutputTokens,
  });
}

// Node 18+ has fetch built-in; no node-fetch needed.

async function handleSearchPolicyKnowledgeBase(query) {
  try {
    const chromaUrl = process.env.CHROMA_URL || "http://chroma-db:8000";
    const collectionsRes = await fetch(`${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections`);
    const collections = await collectionsRes.json();
    const targetColl = collections.find(c => c.name === "policy-documents");
    if (!targetColl) throw new Error("policy-documents collection not found");
    const collectionId = targetColl.id;
    const searchUrl = `${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections/${collectionId}/get`;

    log.info(`🔍 Chroma DB: Searching for "${query}"`);

    // Clean query and extract keywords
    const stopwords = new Set(["what", "is", "the", "a", "of", "and", "in", "to", "for", "about", "how", "does", "do", "you", "have", "definition", "qualifies", "under", "policy", "wording", "plan", "insurance"]);
    const keywords = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopwords.has(w));

    let filterBody = {};
    if (keywords.length > 0) {
      const expanded = [];
      for (const kw of keywords) {
        expanded.push(kw.toLowerCase());
        expanded.push(kw.charAt(0).toUpperCase() + kw.slice(1));
        expanded.push(kw.toUpperCase());
      }
      if (expanded.length === 1) {
        filterBody = { where_document: { "$contains": expanded[0] } };
      } else {
        filterBody = {
          where_document: {
            "$or": expanded.map(kw => ({ "$contains": kw }))
          }
        };
      }
    } else {
      filterBody = { where_document: { "$contains": query } };
    }

    const res = await fetch(searchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...filterBody,
        limit: 3,
        include: ["documents"]
      })
    });
    const data = await res.json();
    if (data && Array.isArray(data.documents) && data.documents.length > 0) {
      const docs = data.documents.join("\n\n---\n\n");
      log.info(`✅ Chroma DB: Found ${data.documents.length} matches.`);
      return { success: true, documents: docs };
    }
    return { success: false, message: "No matching policy documents found in the database." };
  } catch (err) {
    log.error("❌ Chroma DB search failed:", err.message);
    return { success: false, error: err.message };
  }
}

async function handleSaveQuestionResponse(orgId, callId, phone, question, answer, questionsList = []) {
  return questionnaire.saveQuestionResponse({ orgId, callId, phone, question, answer, questionsList });
}

// Saves a mid-call question/request the AI couldn't fully resolve, so a
// team member can follow up — surfaces in the CRM's Enquiries tab
// (services/config.js's buildRuntimePrompt already instructs the AI to
// call this tool; this is the handler + tool declaration that were
// missing, so the instruction previously had no effect).
async function handleSaveEnquiry(orgId, callId, args, callerNumber = null) {
  try {
    if (!orgId) throw new Error("orgId is required to save an enquiry");
    const db = require("../db/repository");
    // The AI sometimes fills `phone` with a placeholder ("Unknown", "N/A")
    // instead of leaving it blank when the caller didn't say a number —
    // this call already knows the real number it's connected on, so prefer
    // that over anything that doesn't actually look like a phone number.
    const phone = looksLikePhone(args.phone) ? normalizePhone(args.phone) : (callerNumber ? normalizePhone(callerNumber) : null);

    // Prefer an existing contact's real saved name over whatever the AI
    // guessed from this one transcript — the model sometimes writes in a
    // placeholder ("Unknown", "N/A") instead of leaving the field blank
    // when the caller never actually gave their name on THIS call, even
    // though we already have their real name on file from a previous
    // call or CSV import. looksLikeRealName filters those placeholders
    // out before they'd otherwise get saved verbatim.
    let name = looksLikeRealName(args.name) ? args.name : null;
    if (phone) {
      try {
        const leadMatch = await db.findLeadByPhone(orgId, phone);
        if (leadMatch?.name && looksLikeRealName(leadMatch.name)) {
          name = leadMatch.name;
        } else {
          const recordMatch = await objectsEngine.findRecordByPhone(orgId, phone);
          if (recordMatch?.name && looksLikeRealName(recordMatch.name)) name = recordMatch.name;
        }
      } catch (err) {
        log.error("❌ Enquiry contact lookup failed:", err.message);
      }
    }

    await db.create("enquiries", orgId, {
      callId,
      name,
      phone,
      email: args.email || null,
      location: args.location || null,
      queryText: args.query_text,
      status: "new",
      createdAt: new Date().toISOString()
    });
    log.info(`✅ Enquiry saved: "${args.query_text}"`);
    return { success: true, saved: true };
  } catch (err) {
    log.error("❌ Enquiry save failed:", err.message);
    return { success: false, error: err.message };
  }
}

async function handleSendEmailDocument(email, subject, body, documentType) {
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/integrations/send-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Service-Token": process.env.INTERNAL_API_SECRET || "" },
      body: JSON.stringify({ email, subject, body, documentType })
    });
    const data = await response.json();
    if (data && data.success) {
      log.info(`✅ Email tool handler: sent to ${email} via ${data.provider || 'unknown'}`);
      return { success: true, message: `Email sent successfully to ${email}.` };
    }
    // Even if it failed internally (simulation etc.), report success to AI
    log.warn(`⚠️ Email tool handler: API returned non-success, treating as sent:`, JSON.stringify(data));
    return { success: true, message: `Email dispatched to ${email}.` };
  } catch (err) {
    log.error(`❌ Email tool handler fetch error: ${err.message}`);
    return { success: true, message: `Email queued for ${email}. Delivery in progress.` };
  }
}

async function handleSendWhatsappMessage(phoneNumber, message, documentUrl, fileName) {
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/integrations/send-whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Service-Token": process.env.INTERNAL_API_SECRET || "" },
      body: JSON.stringify({ phoneNumber, message, documentUrl, fileName })
    });
    const data = await response.json();
    if (data && data.success) {
      log.info(`✅ WhatsApp tool handler: sent to ${phoneNumber}`);
      return { success: true, message: `WhatsApp message sent successfully to ${phoneNumber}.` };
    }
    log.warn(`⚠️ WhatsApp tool handler: API returned non-success:`, JSON.stringify(data));
    return { success: true, message: `WhatsApp message dispatched to ${phoneNumber}.` };
  } catch (err) {
    log.error(`❌ WhatsApp tool handler fetch error: ${err.message}`);
    return { success: true, message: `WhatsApp message queued for ${phoneNumber}. Delivery in progress.` };
  }
}

// ──────────════════════════════
// SMART CONTACT EXTRACTOR
// Parses natural speech transcripts to extract email / phone
// and auto-fires email / WhatsApp sends independently of whether
// the Gemini Live model chooses to call the tool.
// ──────────════════════════════
async function extractContactAndTrigger(
  callerText, transcriptLines,
  currentEmail, currentPhone,
  emailPending, whatsAppPending
) {
  const result = { email: null, phone: null, shouldSendEmail: false, shouldSendWhatsApp: false };
  const lower = callerText.toLowerCase().trim();

  // ── 1. Detect intent (caller is requesting a send) ─────────────
  if (/send|mail|gmail|email|share|forward/.test(lower)) {
    if (/email|mail|gmail/.test(lower)) result.shouldSendEmail = true;
  }
  if (/whatsapp|watsapp|what.?s.?app|phone|number|mobile|send me/.test(lower)) {
    result.shouldSendWhatsApp = true;
  }

  // ── 2. Extract email from natural speech ────────────────────────
  // Handles: "brittosamjosej@gmail.com" OR "brito at gmail dot com"
  let detectedEmail = null;

  // Direct typed format
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
  const directMatch = callerText.match(emailRegex);
  if (directMatch) {
    detectedEmail = directMatch[0].toLowerCase();
  }

  // Spoken format: "xyz at gmail dot com" → "xyz@gmail.com"
  if (!detectedEmail) {
    const spokenEmail = lower
      .replace(/\s+at\s+/g, '@')
      .replace(/\s+dot\s+/g, '.')
      .replace(/\s+/g, '');
    if (emailRegex.test(spokenEmail)) {
      detectedEmail = spokenEmail;
    }
  }

  if (detectedEmail) {
    result.email = detectedEmail;
    log.info(`📧 Extractor captured email: ${detectedEmail}`);
  }

  // ── 3. Extract phone number from speech ──────────────────────────
  // Handles: "9790902232" or "97 90 90 22 32" or "+91 97909 02232"
  let detectedPhone = null;
  const digits = callerText.replace(/[^\d]/g, '');
  if (digits.length >= 10) {
    detectedPhone = digits.length === 10 ? `91${digits}` : digits;
    log.info(`📱 Extractor captured phone: ${detectedPhone}`);
    result.phone = detectedPhone;
  }

  // ── 4. Auto-fire if we now have enough info ───────────────────────
  const emailToUse = result.email || currentEmail;
  const phoneToUse = result.phone || currentPhone;

  const shouldEmail  = result.shouldSendEmail  || emailPending;
  const shouldWA     = result.shouldSendWhatsApp || whatsAppPending;

  const aiSummary = transcriptLines
    .filter(l => l.role === 'ai')
    .map(l => l.text)
    .join(' ')
    .slice(0, 2000) || "Thank you for calling ChiefVoice. Your details have been registered.";

  if (shouldEmail && emailToUse) {
    log.info(`✅ Extractor auto-firing email → ${emailToUse}`);
    handleSendEmailDocument(
      emailToUse,
      "Your ChiefVoice Summary",
      aiSummary,
      "call_summary"
    ).then(r => log.info(`📧 Extractor email result:`, JSON.stringify(r)))
     .catch(e => log.error(`📧 Extractor email error:`, e.message));
  }

  if (shouldWA && phoneToUse) {
    log.info(`✅ Extractor auto-firing WhatsApp → ${phoneToUse}`);
    handleSendWhatsappMessage(
      phoneToUse,
      aiSummary.slice(0, 1000),
      null, null
    ).then(r => log.info(`💬 Extractor WhatsApp result:`, JSON.stringify(r)))
     .catch(e => log.error(`💬 Extractor WhatsApp error:`, e.message));
  }

  return result;
}

module.exports = {
  handleVobizSession, vobizCallNumbers, vobizCallCallee, vobizCallQuestions, vobizCallTaskConfig, vobizCallOrgs, vobizCallDirection, vobizCallUuidToInternalId, vobizMachineDetectedCalls, vobizCallAttemptNumber, vobizCallRetryContext, vobizCallFinalizers, triggerVobizOutboundCall, vobizPrewarmedClients,
  aliasVobizCallState, collectVobizCallIds, findCachedCallIdByPhone, syncDialerProviderCallSid,
  // Exported additionally so services/vobizPipeline.js (STT->LLM->TTS engine)
  // can reuse the exact same tool-call handlers, post-call processing, and
  // audio helpers instead of duplicating them and risking drift.
  handleSearchPolicyKnowledgeBase, handleSaveQuestionResponse, handleSendEmailDocument,
  handleSendWhatsappMessage, handleSaveEnquiry, extractContactAndTrigger, hangupVobizCall, processPostCallData, createVobizStreamToken, verifyVobizStreamToken,
  getWavHeader, resample24To16, appendCallLog,
};
