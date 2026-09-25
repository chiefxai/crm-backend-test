// src/ai/postCallAgents/followUpAgent.js
// ============================================================
// Follow-up / caller-name safety net — re-reads the finished transcript to
// catch cases where the live agent promised a callback or learned the
// caller's name but never invoked its save_enquiry tool (live audio
// function-calling isn't 100% reliable).
// ============================================================

const { z } = require("zod");
const { getEffectivePrompt } = require("../systemAgents");
const { generateStructured } = require("./shared");
const { getCallerTimezone } = require("../../lib/callerTimezone");
const { nowInTimezone, zonedTimeToUtc } = require("../../lib/timezoneConvert");
const db = require("../../db/repository");
const {
  deriveTranscriptSignals,
  deriveAgentSchedulingSignals,
  extractRelativeMinutesFromText,
} = require("./decisionEngine");

const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

function hasClockTime(text) {
  return /\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:at\s+)\d{1,2}:\d{2}\b/i.test(text);
}

function resolveSpecificCallbackTime(localDateTime, timeZone, referenceText) {
  if (!LOCAL_DATETIME_RE.test(String(localDateTime || ""))) return null;

  let resolved = zonedTimeToUtc(localDateTime, timeZone);
  if (!resolved) return null;

  if (resolved.getTime() <= Date.now() && hasClockTime(referenceText)) {
    const parts = String(localDateTime).match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/
    );
    if (!parts) return null;
    const nextDayLocal = new Date(
      Date.UTC(
        Number(parts[1]),
        Number(parts[2]) - 1,
        Number(parts[3]) + 1,
        Number(parts[4]),
        Number(parts[5]),
        Number(parts[6])
      )
    );
    const yyyy = nextDayLocal.getUTCFullYear();
    const mm = String(nextDayLocal.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(nextDayLocal.getUTCDate()).padStart(2, "0");
    const hh = String(nextDayLocal.getUTCHours()).padStart(2, "0");
    const mi = String(nextDayLocal.getUTCMinutes()).padStart(2, "0");
    const ss = String(nextDayLocal.getUTCSeconds()).padStart(2, "0");
    resolved = zonedTimeToUtc(
      `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`,
      timeZone
    );
  }

  return resolved && resolved.getTime() > Date.now() ? resolved : null;
}

function clampModelMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(7 * 24 * 60, Math.round(n));
}

function policyCallbackTime(callerPhone, retryPolicy, attemptNumber) {
  const fields = db.computeRetryFields(
    attemptNumber,
    retryPolicy || db.DEFAULT_RETRY_POLICY,
    callerPhone
  );
  return fields.nextRetryAt || null;
}

const FollowUpSchema = z.object({
  callbackRequested: z.boolean().default(false),
  callbackTimeMentioned: z.boolean().default(false),
  callbackRelativeMinutes: z.number().nullable().default(null),
  callbackLocalDateTime: z.string().nullable().default(null),
  enquiryRequested: z.boolean().default(false),
  enquirySummary: z.string().nullable().default(null),
  callerName: z.string().nullable().default(null),
});

const DEFAULT_FOLLOW_UP = {
  callbackRequested: false,
  callbackTimeMentioned: false,
  callbackTime: null,
  callbackUsedPolicyFallback: false,
  enquiryRequested: false,
  enquirySummary: null,
  callerName: null,
};

async function extractFollowUp(
  transcript,
  orgId = null,
  callerPhone = null,
  onUsage,
  {
    sentiment = null,
    summary = null,
    callAnswered = true,
    retryPolicy = null,
    attemptNumber = 1,
  } = {}
) {
  if (!transcript?.trim() || !callAnswered) return { ...DEFAULT_FOLLOW_UP };

  const timeZone = getCallerTimezone(callerPhone);
  const template = await getEffectivePrompt(orgId, "follow-up-safety-net");
  const prompt = template
    .replace("{callerNow}", nowInTimezone(timeZone))
    .replace("{sentiment}", sentiment == null ? "null" : String(sentiment))
    .replace("{summary}", summary || "(No summary available.)")
    .replace("{transcript}", transcript)
    + `\n\nMANDATORY SCHEDULING POLICY (overrides legacy wording):\n- Read Caller AND Agent turns. If the Agent promises a callback time (including Tamil/regional phrasing) and the Caller engaged in the conversation, extract that time into callbackRelativeMinutes or callbackLocalDateTime.\n- Relative minutes ("in 5 minutes", Tamil "அஞ்சு நிமிஷம்") -> callbackRelativeMinutes only; application code computes UTC from the current instant.\n- Clock times -> callbackLocalDateTime as caller-local YYYY-MM-DDTHH:mm:ss with no timezone suffix.\n- If the Caller wants a callback or is busy but gives NO usable time, set callbackRequested=true and leave time fields null — the application will apply the org retry/callback policy schedule.\n- Never treat silence, placeholders like {background}, or no-answer calls as callbacks.\n- Enquiry only when the Caller asked something the Agent did not resolve in the transcript.\n\nCURRENT CALLER LOCAL TIME: ${nowInTimezone(timeZone)}\nCALLER TIMEZONE: ${timeZone}\nCURRENT SENTIMENT: ${sentiment == null ? "null" : sentiment}\nCURRENT SUMMARY: ${summary || "(none)"}`;

  const result = await generateStructured({
    label: "scheduling-enquiry",
    orgId,
    prompt,
    schema: FollowUpSchema,
    fallback: null,
    onUsage,
  });
  if (!result) return { ...DEFAULT_FOLLOW_UP };

  const signals = deriveTranscriptSignals(transcript);
  const agentSignals = deriveAgentSchedulingSignals(transcript);
  const { explicitCallback, busyRequest, callerSpoke, callerSuppliedTime, callerText } = signals;

  const modelCallbackIntent = !!result.callbackRequested;
  const agentCallbackOffer = agentSignals.agentOfferedCallback && agentSignals.agentSuppliedTime;
  const callbackIntent =
    explicitCallback || busyRequest || modelCallbackIntent || agentCallbackOffer;

  let callbackTime = null;
  let callbackUsedPolicyFallback = false;
  let callbackTimeMentioned = !!result.callbackTimeMentioned;

  if (callbackIntent && callAnswered && callerSpoke) {
    const modelMinutes = clampModelMinutes(result.callbackRelativeMinutes);
    const transcriptMinutes =
      signals.callerRelativeMinutes ??
      agentSignals.agentRelativeMinutes ??
      extractRelativeMinutesFromText(callerText) ??
      extractRelativeMinutesFromText(agentSignals.agentText);

    const relativeMinutes = modelMinutes ?? transcriptMinutes;

    if (relativeMinutes) {
      callbackTime = new Date(Date.now() + relativeMinutes * 60000).toISOString();
      callbackTimeMentioned = true;
    } else if (result.callbackLocalDateTime) {
      const resolved = resolveSpecificCallbackTime(
        result.callbackLocalDateTime,
        timeZone,
        `${callerText} ${agentSignals.agentText}`
      );
      if (resolved) {
        callbackTime = resolved.toISOString();
        callbackTimeMentioned = true;
      }
    }

    const wantsCallbackWithoutSpecificTime =
      (modelCallbackIntent || explicitCallback || busyRequest) &&
      !callbackTime &&
      !callerSuppliedTime &&
      !agentSignals.agentSuppliedTime &&
      !result.callbackTimeMentioned;

    if (!callbackTime && wantsCallbackWithoutSpecificTime) {
      const policyTime = policyCallbackTime(callerPhone, retryPolicy, attemptNumber);
      if (policyTime) {
        callbackTime = policyTime;
        callbackUsedPolicyFallback = true;
        callbackTimeMentioned = false;
      }
    }
  }

  const callbackRequested = !!callbackTime && callbackIntent && callerSpoke;

  return {
    callbackRequested,
    callbackTimeMentioned,
    callbackTime,
    callbackUsedPolicyFallback,
    enquiryRequested: !!result.enquiryRequested,
    enquirySummary: result.enquirySummary || null,
    callerName: result.callerName || null,
  };
}
module.exports = { extractFollowUp };
