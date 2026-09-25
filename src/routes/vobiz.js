// ============================================================
// src/routes/vobiz.js — /api/vobiz/* endpoints
// ============================================================

const { safeErrorMessage } = require("../observability/safeError");
const router = require("express").Router();
const db = require("../db/repository");
const { requireAuth } = require("../middleware/auth");
const crypto = require("crypto");
function requireVobizWebhook(req, res, next) {
  const expected = process.env.VOBIZ_WEBHOOK_SECRET;
  if (!expected) return process.env.NODE_ENV === "production" ? res.status(503).json({ error: "Vobiz webhook authentication is not configured" }) : next();
  const supplied = req.get("X-Vobiz-Webhook-Secret") || req.query.webhook_secret || "";
  if (!supplied || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return res.status(401).json({ error: "Invalid Vobiz webhook credentials" });
  next();
}
const channelsEngine = require("../channels/engine");
const { getLogger } = require("../observability/logger");
const log = getLogger("routes.vobiz");
const {
  vobizCallNumbers, vobizCallCallee, vobizCallOrgs, vobizCallDirection,
  vobizCallUuidToInternalId, vobizMachineDetectedCalls,
  vobizCallAttemptNumber, vobizCallRetryContext, vobizCallFinalizers, createVobizStreamToken,
  aliasVobizCallState, collectVobizCallIds, findCachedCallIdByPhone, syncDialerProviderCallSid
} = require("../telephony/vobizProxy");

// Webhook fired for BOTH genuine inbound calls AND as the answer_url for
// our own outbound calls. Vobiz doesn't distinguish — org is pre-cached for
// outbound at trigger time (/api/vobiz/call), so the lookup here only runs
// when nothing is already set (inbound path).
router.post("/incoming", requireVobizWebhook, async (req, res) => {
  const From = req.body.From || req.query.From;
  const To = req.body.To || req.query.To;
  const CallUUID = req.body.CallUUID || req.query.CallUUID || req.body.callId || req.body.CallSid;

  log.info(`🔎 Vobiz /incoming webhook — CallUUID="${CallUUID}" From="${String(From || "").replace(/.(?=.{4})/g, "*")}" To="${String(To || "").replace(/.(?=.{4})/g, "*")}"`);

  const aliasedFromPhone = findCachedCallIdByPhone(To) || findCachedCallIdByPhone(From);
  aliasVobizCallState([CallUUID, aliasedFromPhone, ...collectVobizCallIds(req.body), ...collectVobizCallIds(req.query)]);
  if (CallUUID) {
    syncDialerProviderCallSid(CallUUID).catch((err) => log.error("❌ Failed to sync campaign CallUUID:", err.message));
  }

  if (CallUUID && From) {
    vobizCallNumbers.set(CallUUID, From);
    setTimeout(() => vobizCallNumbers.delete(CallUUID), 1800000);
  }
  if (CallUUID && To && !vobizCallCallee.has(CallUUID)) {
    vobizCallCallee.set(CallUUID, To);
    setTimeout(() => vobizCallCallee.delete(CallUUID), 1800000);
  }



  // Authoritative call-end signal from Vobiz. The media Stream WS's "start"
  // handler is what registers this call's finalizeCall() with
  // vobizCallFinalizers — normally driven by the WS closing, or (since the
  // earlier fix) by this webhook calling finalize() directly the moment
  // Vobiz reports Hangup, so the dialer's auto-dial-next-target doesn't
  // stall waiting on a WS that's slow to tear down. finalizeCall() itself
  // is idempotent (isFinalized guard), so calling it from both places is
  // harmless.
  //
  // finalize() returning false means NO finalizer was ever registered for
  // this CallUUID — our own stream session never got far enough to take
  // ownership of ending this call. Confirmed in production: this isn't
  // just the "never connected" case (busy/no-answer/declined, or an
  // answering machine Vobiz hung up on before media wired up) — a call
  // Vobiz itself reports CallStatus "completed" (it dialed, rang, and
  // answered) can ALSO reach here with no finalizer registered, e.g. a
  // call that connected but never carried any real audio: Vobiz's own
  // "start" control frame over the media WS either never arrived or
  // arrived too late relative to Hangup, so finalizeCall() was never
  // registered at all — leaving no call_logs row, no call_completed
  // broadcast, and the dialer UI stuck showing the call as active until
  // the agent manually disconnected. All three of these cases need the
  // exact same synthetic call_logs row, built from whatever Vobiz's own
  // webhook body tells us (real Duration/CallStatus/HangupCause), so
  // they're handled here in one place instead of split across separate
  // no-answer/AMD checks that could each miss a case the others don't
  // cover.
  const hangupOrgId = (req.body.Event === "Hangup" && CallUUID)
    ? (vobizCallOrgs.get(CallUUID) || null)
    : null;

  if (req.body.Event === "Hangup" && CallUUID) {
    // finalizeCall() cleans the in-memory org/call caches, so capture the
    // org before awaiting it. The captured value is also used by the
    // fallback and authoritative-duration paths below.
    vobizCallFinalizers.finalize(CallUUID)
      .then(async (finalized) => {
        if (!finalized) {
          // Media `start` can arrive a beat after Hangup. Give the stream
          // a short window to register and run the real recording + post-call
          // path before writing a recording-less fallback row.
          await new Promise((resolve) => setTimeout(resolve, 2500));
          finalized = await vobizCallFinalizers.finalize(CallUUID);
        }
        if (finalized) return; // finalizeCall() already handled this call for real
        if (!hangupOrgId) return; // not one of ours, or its cache entry expired

        const orgId = hangupOrgId;
        const internalCallId = vobizCallUuidToInternalId.get(CallUUID);
        const calleeForCheck = vobizCallCallee.get(CallUUID) || To;

        // Post-call finalizeCall() enqueues async work — the call_logs row may
        // not exist yet when Hangup arrives. Poll before writing a synthetic
        // No Answer row that would duplicate a Callback Scheduled entry.
        const waitUntil = Date.now() + Number(process.env.VOBIZ_HANGUP_FALLBACK_WAIT_MS || 15000);
        while (Date.now() < waitUntil) {
          if (await db.findCallLogByProviderCallSid(orgId, CallUUID)) {
            log.info(`⏭️ Vobiz Hangup fallback skipped — call log exists for CallUUID ${CallUUID}`);
            return;
          }
          if (internalCallId && await db.getCallLogById(orgId, internalCallId)) {
            log.info(`⏭️ Vobiz Hangup fallback skipped — call log exists for internal id ${internalCallId}`);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        const calleeNumber = calleeForCheck;
        const attemptNumber = vobizCallAttemptNumber.get(CallUUID) || 1;
        const retryContext = vobizCallRetryContext.get(CallUUID) || null;
        const isMachineDetected = vobizMachineDetectedCalls.has(CallUUID);
        const duration = parseInt(req.body.Duration, 10) || 0;
        // Never persist "Completed" without a media session: there is no
        // recording, transcript, busy-callback, or enquiry to attach, and
        // the campaign treats Completed as "this lead is done".
        const status = isMachineDetected ? "Answering Machine" : "No Answer";
        const fallbackId = `call_vobiz_fallback_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        db.create("calllogs", orgId, {
          id: fallbackId,
          leadName: calleeNumber,
          callerNumber: calleeNumber,
          duration,
          status,
          direction: "outbound",
          createdAt: new Date().toISOString(),
          providerCallSid: CallUUID,
          ...db.computeRetryFields(attemptNumber, retryContext?.retryPolicy || db.DEFAULT_RETRY_POLICY, calleeNumber),
          retryContext
        }).then((savedLog) => {
          global.broadcastLog(`📞 Vobiz call ended without a media session ever registering (${status}): ${calleeNumber}`, {
            type: "call_completed", orgId, callLog: savedLog, providerCallSid: CallUUID
          });
        }).catch((err) => log.error("❌ Failed to save Vobiz fallback call_logs row:", err.message));
      })
      .catch((err) => log.error("❌ Vobiz Hangup-webhook finalize failed:", err.message));
  }

  // Correct duration using Vobiz's authoritative telephony measurement once
  // the Hangup webhook confirms the call actually connected AND finalize()
  // above found a real finalizeCall() to run (so this call already has its
  // own call_logs row from that path, not the synthetic fallback above).
  if (req.body.Event === "Hangup" && CallUUID && req.body.CallStatus === "completed") {
    const internalCallId = vobizCallUuidToInternalId.get(CallUUID);
    const realDuration = parseInt(req.body.Duration, 10);
    if (internalCallId && !Number.isNaN(realDuration)) {
      const orgId = hangupOrgId;
      if (orgId) {
        const patchDuration = async (attempt = 1) => {
          try {
            await db.patch("calllogs", orgId, internalCallId, { duration: realDuration });
            log.info(`⏱️ Corrected call ${internalCallId} duration to ${realDuration}s`);
          } catch (err) {
            if (/no row returned/i.test(err.message) && attempt < 3) {
              setTimeout(() => patchDuration(attempt + 1), 3000 * attempt);
            } else {
              log.error(`❌ Failed to correct duration for call ${internalCallId}:`, err.message);
            }
          }
        };
        patchDuration();
      }
    }
  }

  // Genuine inbound calls only reach here (outbound answer callbacks already
  // have their orgId cached at trigger time), so gating here never affects
  // outbound. A number with no agent assigned should never connect.
  let rejectCall = false;
  if (CallUUID && To && !vobizCallOrgs.has(CallUUID)) {
    try {
      const orgId = await db.findOrgIdForNumber(To);
      if (!orgId) {
        rejectCall = true;
      } else {
        const agent = await db.getAgentForNumber(To);
        if (!agent) {
          rejectCall = true;
          log.warn(`⚠️ [vobiz] Rejecting inbound call to ${To} — no active agent assigned to this number.`);
        } else {
          vobizCallOrgs.set(CallUUID, orgId);
          setTimeout(() => vobizCallOrgs.delete(CallUUID), 1800000);
          vobizCallDirection.set(CallUUID, "inbound");
          setTimeout(() => vobizCallDirection.delete(CallUUID), 1800000);
          global.broadcastLog(`📞 Incoming call from ${From || "unknown number"}`, {
            type: "call_started", orgId, callerNumber: From || null, direction: "inbound", provider: "vobiz"
          });
        }
      }
    } catch (err) {
      log.error("❌ Vobiz inbound org lookup failed:", err.message);
    }
  }

  res.set("Content-Type", "text/xml");
  if (rejectCall) {
    // Per Vobiz XML docs: Hangup as the FIRST/only element in the Answer
    // XML rejects the call before it's answered (no billing) — reason
    // defaults to "rejected" but set it explicitly rather than relying on
    // the implicit default.
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup reason="rejected" />
</Response>`);
  }

  const testNumber = process.env.CASCADED_PIPELINE_TEST_NUMBER;
  const isCascadedTestCall = !!testNumber && (From === testNumber || To === testNumber);
  const streamPath = isCascadedTestCall ? "vobiz/stream-cascaded" : "vobiz/stream";
  if (!CallUUID) return res.status(400).send("Missing Vobiz CallUUID");
  const streamOrgId = vobizCallOrgs.get(CallUUID);
  if (!streamOrgId) return res.status(403).send("Unable to resolve organization for Vobiz media stream");
  let streamToken;
  try { streamToken = createVobizStreamToken(CallUUID, streamOrgId); }
  catch (err) { log.error("❌ Failed to create secure Vobiz stream token:", err.message); return res.status(503).send("Unable to initialize secure media stream"); }

  // Connect media stream directly without synthetic TTS playback so the agent's
  // greeting speaks cleanly without overlap or telling the user to "please wait".
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-l16;rate=16000">wss://${req.headers.host}/${streamPath}?stream_token=${encodeURIComponent(streamToken)}</Stream>
</Response>`);
});

// Machine-detection verdict webhook — sets a flag so the Hangup webhook
// above can save "Answering Machine" status without a race with finalizeCall().
router.post("/machine-detection", requireVobizWebhook, async (req, res) => {
  log.info(`🤖 Vobiz machine-detection webhook CallUUID="${req.body.CallUUID || req.body.RequestUUID || "unknown"}" result="${String(req.body.MachineDetection || req.body.Result || "").slice(0, 80)}"`);
  const CallUUID = req.body.CallUUID || req.body.RequestUUID;
  const isMachine = req.body.Machine === "true" || /machine|fax/i.test(req.body.MachineDetection || req.body.Result || "");
  if (CallUUID && isMachine) {
    vobizMachineDetectedCalls.add(CallUUID);
    setTimeout(() => vobizMachineDetectedCalls.delete(CallUUID), 1800000);
  }
  res.sendStatus(200);
});

// Initiate an outbound Vobiz call.
router.post("/call", requireAuth, async (req, res) => {
  const { phoneNumber, questions, from, language, assignedContact, starhealthEnabled, agentId, taskId, leadId, retryPolicy } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: "Missing phoneNumber in request body" });

  let baseUrl;
  if (process.env.PUBLIC_URL) {
    baseUrl = process.env.PUBLIC_URL;
  } else {
    const protocol = req.secure || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    baseUrl = `${protocol}://${req.headers.host}`;
  }

  try {
    const { triggerVobizOutboundCall } = require("../telephony/vobizProxy");
    let effectiveRetryPolicy = retryPolicy || null;
    if (taskId && !effectiveRetryPolicy) {
      const tasks = await db.list("dialertasks", req.orgId);
      const task = tasks.find((t) => t.id === taskId);
      effectiveRetryPolicy = task?.retryConfig || null;
    }
    const result = await triggerVobizOutboundCall(req.orgId, phoneNumber, {
      questions, from, language, assignedContact, baseUrl, starhealthEnabled: !!starhealthEnabled, agentId, taskId, leadId,
      retryPolicy: effectiveRetryPolicy,
    });
    res.json(result);
  } catch (err) {
    log.error("❌ Failed to initiate Vobiz outbound call:", err.message);
    res.status(err.statusCode || 500).json({ error: safeErrorMessage(err) });
  }
});

// Hang up an active Vobiz call via the Vobiz REST API.
router.post("/hangup", requireAuth, async (req, res) => {
  const { callSid } = req.body;
  if (!callSid) return res.status(400).json({ error: "Missing callSid in request body" });

  const callOrgId = vobizCallOrgs.get(callSid);
  if (callOrgId && callOrgId !== req.orgId) {
    return res.status(403).json({ error: "This call does not belong to your organization." });
  }

  // Same credential resolution as /api/vobiz/call and the AI's own end_call
  // tool (vobizProxy.js's hangupVobizCall) — this route previously only
  // checked the shared server-wide env vars, so an org that connected its
  // OWN Vobiz.ai account (Settings > Numbers) had this DELETE call go out
  // under the WRONG account's credentials: it would fail (401/403, or a
  // "call not found" since the call was never placed under that account),
  // get caught, and turn into a 500 the frontend just logged to console —
  // so clicking "Disconnect Call" on a real, connected call silently did
  // nothing for any org using its own channel instead of the shared env.
  const ownChannel = await channelsEngine.getChannel(req.orgId, "vobiz").catch(() => null);
  const authId = ownChannel?.config?.authId;
  const authToken = ownChannel?.config?.authToken;
  if (!authId || !authToken) return res.status(500).json({ error: "Vobiz credentials are not configured for this organization. Configure the call provider in the platform admin organization settings." });

  try {
    const response = await fetch(`https://api.vobiz.ai/api/v1/Account/${authId}/Call/${callSid}/`, {
      method: "DELETE",
      headers: { "X-Auth-ID": authId, "X-Auth-Token": authToken, "Content-Type": "application/json" }
    });
    if (!response.ok && response.status !== 204) {
      const errText = await response.text();
      throw new Error(errText || `Vobiz hangup error (Status: ${response.status})`);
    }
    res.json({ success: true });
  } catch (err) {
    log.error("❌ Failed to hang up Vobiz call:", err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
