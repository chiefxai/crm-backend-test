// src/ai/geminiUsageTracker.js
// ============================================================
// Per-Gemini-Live-session usage/cost tracking — the module every
// telephony provider file (vobizProxy.js, twilioProxy.js, piopiyProxy.js,
// geminiProxy.js) calls into around a Gemini Live session's lifecycle.
// Persists to the ai_session_usage table (see src/db/adapters/mysql.js
// TABLES.ai_session_usage and docs/ai-usage-tracking.md).
//
// Lifecycle:
//   startUsageSession()   — call once, right before opening the Gemini
//                            Live connection. Returns a handle
//                            { id, orgId } to pass to the other functions.
//   recordUsage()          — call on every usageMetadata event the SDK
//                            delivers during the session.
//   finalizeUsageSession() — call once the session ends normally.
//   failUsageSession()     — call if the session errors out instead.
//
// All four are safe to call with a null/undefined handle (e.g. no orgId
// available, dev/browser session) and never throw — a usage-tracking
// failure must never break an actual phone call. Errors are logged and
// swallowed.
// ============================================================

const db = require("../db/repository");
const { getGoogleCloudProjectProvider } = require("./googleCloudProjectProvider");
const { calculateGeminiCost } = require("./geminiCostCalculator");
const costProviders = require("../platform/costProviders");
const { getLogger } = require("../observability/logger");
const log = getLogger("ai.geminiUsageTracker");

/**
 * @param {Object} params
 * @param {string} params.orgId - resolved server-side (requireAuth's req.orgId, or the per-call orgId already flowing through the telephony proxies) — NEVER accept this from a client-supplied value
 * @param {string} [params.adminId] - resolved server-side (req.userId) — the human account that owns this org's session, not a per-request actor for AI-initiated calls
 * @param {string} params.callId - this app's own internal call id (the same id call_logs.id/vobizCallSid maps use)
 * @param {string} [params.sessionId] - the provider's own session/resumption id if the SDK exposes one at connect time; can also be set later via a resumption-handle update
 * @param {string} params.provider - "vobiz" | "twilio" | "piopiy" | "gemini-dev" | "post-call-agents"
 * @param {string} params.model - the exact Gemini model string being connected to
 * @param {string} [params.costProviderKey] - which platform/costProviders.js AI provider to price this session's tokens against at finalize time (defaults to "gemini", the Live-voice provider) — pass "gemini-postcall" for the text-completion post-call agents (summary/sentiment/workflow-answers/follow-up), which run a different, much cheaper model and should be shown as a separate cost line, not blended into voice-session cost.
 * @returns {Promise<{id: string, orgId: string, costProviderKey: string} | null>} a handle for the other functions, or null if tracking couldn't start (never throws)
 */
async function startUsageSession({ orgId, adminId = null, callId, sessionId = null, provider, model, costProviderKey = "gemini" }) {
  if (!orgId) {
    log.warn(`⚠️ [geminiUsageTracker] No orgId — skipping usage tracking for call ${callId} (${provider}). This is expected for dev/browser sessions with no org context.`);
    return null;
  }
  try {
    const project = await getGoogleCloudProjectProvider().resolveProject({ orgId, adminId });
    const row = await db.create("aisessionusage", orgId, {
      adminId,
      callId,
      sessionId,
      provider,
      model,
      gcpProjectId: project.projectId,
      gcpLocation: project.location,
      sessionStartedAt: new Date().toISOString(),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
      currency: "USD",
      status: "in_progress",
      metadata: { gcpProjectSource: project.source },
    });
    return { id: row.id, orgId, costProviderKey };
  } catch (err) {
    log.error(`❌ [geminiUsageTracker] Failed to start usage session for call ${callId} (${provider}):`, err.message);
    return null;
  }
}

/**
 * Call on every usageMetadata event the SDK delivers.
 *
 * IMPORTANT: the Gemini Live API reports usageMetadata as the running
 * total for the session SO FAR, not a per-event delta — confirmed by
 * this codebase's own existing behavior (see the note in
 * vobizProxy.js/twilioProxy.js/piopiyProxy.js's onTokenUsage callback,
 * which was already summing every raw event, a pre-existing risk of
 * over-counting this tracker deliberately does not repeat). Treating
 * each event as cumulative and keeping only the maximum seen so far
 * (never adding) is what makes this correct regardless of whether a
 * given SDK version reports strictly-increasing cumulative totals or
 * occasionally repeats/re-sends the same value — either way, summing
 * would double-count; taking the max never does.
 *
 * @param {{id: string, orgId: string}|null} handle - from startUsageSession()
 * @param {{inputTokens?: number, outputTokens?: number}} usage
 */
async function recordUsage(handle, { inputTokens, outputTokens } = {}) {
  if (!handle) return;
  try {
    const current = await db.getAiSessionUsage(handle.id, handle.orgId);
    // Already finalized (or the row vanished) — do nothing. This is what
    // makes a stray late usageMetadata event arriving after finalize()
    // already ran safe: it's ignored instead of reopening a closed record.
    if (!current || current.status !== "in_progress") return;

    const nextInput = Math.max(current.inputTokens || 0, Number(inputTokens) || 0);
    const nextOutput = Math.max(current.outputTokens || 0, Number(outputTokens) || 0);
    if (nextInput === (current.inputTokens || 0) && nextOutput === (current.outputTokens || 0)) return; // no change — skip the write

    await db.patch("aisessionusage", handle.orgId, handle.id, {
      inputTokens: nextInput,
      outputTokens: nextOutput,
      totalTokens: nextInput + nextOutput,
    });
  } catch (err) {
    log.error(`❌ [geminiUsageTracker] Failed to record usage for session ${handle.id}:`, err.message);
  }
}

// Lets a caller attach the provider's own session/resumption id once it
// becomes known — Gemini Live's session id (or a resumption handle) is
// often only available AFTER the connection's setup completes, not at
// the moment startUsageSession() has to be called (before the connection
// even opens), so this exists rather than requiring sessionId up front.
async function attachProviderSessionId(handle, sessionId) {
  if (!handle || !sessionId) return;
  try {
    await db.patch("aisessionusage", handle.orgId, handle.id, { sessionId });
  } catch (err) {
    log.error(`❌ [geminiUsageTracker] Failed to attach session id for ${handle.id}:`, err.message);
  }
}

/**
 * Call once the session ends (success or otherwise — pass status/error
 * for a failure instead of calling failUsageSession() separately, or use
 * the failUsageSession() convenience wrapper below).
 *
 * Idempotent: calling this twice on the same handle (e.g. both a
 * WebSocket "close" handler and an outer error handler both firing) only
 * finalizes once — the second call sees status is no longer "in_progress"
 * and returns the already-finalized row unchanged, so cost is never
 * double-calculated or double-persisted.
 *
 * @param {{id: string, orgId: string}|null} handle
 * @param {Object} [options]
 * @param {'completed'|'failed'} [options.status]
 * @param {string} [options.errorCode]
 * @param {string} [options.errorMessage]
 * @param {Object} [options.metadata] - merged into whatever metadata the session already had, not replacing it
 */
async function finalizeUsageSession(handle, { status = "completed", errorCode = null, errorMessage = null, metadata = {} } = {}) {
  if (!handle) return null;
  try {
    const current = await db.getAiSessionUsage(handle.id, handle.orgId);
    if (!current) {
      log.warn(`⚠️ [geminiUsageTracker] finalize called for missing session ${handle.id}`);
      return null;
    }
    if (current.status !== "in_progress") return current; // already finalized — idempotent no-op, not an error

    const endedAt = new Date();
    const startedAt = current.sessionStartedAt ? new Date(current.sessionStartedAt) : endedAt;
    const durationSeconds = Math.max(0, (endedAt.getTime() - startedAt.getTime()) / 1000);

    const totalTokens = (current.inputTokens || 0) + (current.outputTokens || 0);

    const cost = calculateGeminiCost({
      model: current.model,
      inputTokens: current.inputTokens || 0,
      outputTokens: current.outputTokens || 0,
    });

    // Platform-set (super admin Cost page) INR cost, locked in NOW using
    // whichever rate this session's AI cost provider (handle.costProviderKey
    // — "gemini" for Live voice, "gemini-postcall" for the text-completion
    // post-call agents, set at startUsageSession time) has active at this
    // exact moment — deliberately computed once here and persisted, not
    // recomputed later from raw tokens. If a super admin changes the rate
    // tomorrow, every session finalized before that change keeps the cost
    // it was actually billed at; only sessions finalized after the change
    // see the new rate. Never throws — a pricing lookup failure must not
    // block a session from finalizing.
    let platformCost = null;
    try {
      platformCost = await costProviders.computeAiCost({
        providerKey: handle.costProviderKey || "gemini",
        totalTokens,
        durationSeconds,
        orgId: handle.orgId,
      });
    } catch (err) {
      log.warn(`⚠️ [geminiUsageTracker] platform cost lookup failed for session ${handle.id}:`, err.message);
    }

    const updated = await db.patch("aisessionusage", handle.orgId, handle.id, {
      sessionEndedAt: endedAt.toISOString(),
      durationSeconds,
      totalTokens,
      inputCost: cost.inputCost,
      outputCost: cost.outputCost,
      totalCost: cost.totalCost,
      currency: cost.currency,
      pricingVersion: cost.pricingVersion,
      platformCostProviderKey: platformCost?.providerKey ?? null,
      platformPricingMode: platformCost?.pricingMode ?? null,
      platformRatePer1k: platformCost?.ratePer1kTokens ?? null,
      platformTokenUnit: platformCost?.tokenUnit ?? null,
      platformTimeRateAmount: platformCost?.timeRateAmount ?? null,
      platformTimeUnit: platformCost?.timeUnit ?? null,
      platformTaxPercent: platformCost?.taxPercent ?? null,
      platformBaseCostInr: platformCost?.baseCost ?? null,
      platformTaxAmountInr: platformCost?.taxAmount ?? null,
      platformTotalCostInr: platformCost?.totalCost ?? null,
      status,
      errorCode,
      errorMessage,
      metadata: { ...(current.metadata || {}), ...metadata },
    });
    return updated;
  } catch (err) {
    log.error(`❌ [geminiUsageTracker] Failed to finalize usage session ${handle.id}:`, err.message);
    return null;
  }
}

// Convenience wrapper — same idempotency guarantee as finalizeUsageSession
// (a session already finalized "completed" is never overwritten to "failed"
// by a late error handler firing after a clean close already ran).
async function failUsageSession(handle, { errorCode = null, errorMessage = null } = {}) {
  return finalizeUsageSession(handle, { status: "failed", errorCode, errorMessage });
}

module.exports = {
  startUsageSession,
  recordUsage,
  attachProviderSessionId,
  finalizeUsageSession,
  failUsageSession,
};
