// Advisor / human follow-up callback preferences collected during the
// questionnaire — distinct from "call me back later" AI redial scheduling.

const { getCallerTimezone } = require("./callerTimezone");
const { nowInTimezone, zonedTimeToUtc } = require("./timezoneConvert");
const { extractRelativeMinutesFromText } = require("../ai/postCallAgents/decisionEngine");

const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

const AI_REDIAL_QUESTION_RE =
  /\bwhat time would be better for me to call you back\b|\bwhen(?:'s| is) a good time for me to call you back\b/i;

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
    resolved = zonedTimeToUtc(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`, timeZone);
  }

  return resolved && resolved.getTime() > Date.now() ? resolved : null;
}

function parseHourMinute(text) {
  const t = String(text || "");
  const twelve = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (twelve) {
    let hour = Number(twelve[1]);
    const minute = twelve[2] ? Number(twelve[2]) : 0;
    const ap = twelve[3].toLowerCase();
    if (ap === "pm" && hour < 12) hour += 12;
    if (ap === "am" && hour === 12) hour = 0;
    return { hour, minute };
  }
  const twentyFour = t.match(/\b(?:at\s+)?(\d{1,2}):(\d{2})\b/);
  if (twentyFour) {
    return { hour: Number(twentyFour[1]), minute: Number(twentyFour[2]) };
  }
  return null;
}

function addDaysToLocalDate(datePart, days) {
  const [y, m, d] = String(datePart).split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function extractWallClockLocalDateTime(answer, timeZone) {
  const text = String(answer || "");
  if (!hasClockTime(text) && !/\b(tomorrow|today|evening|morning|afternoon)\b/i.test(text)) {
    return null;
  }
  const hm = parseHourMinute(text);
  if (!hm) return null;

  const nowLocal = nowInTimezone(timeZone);
  const [datePart] = nowLocal.split("T");
  let day = datePart;
  if (/\btomorrow\b/i.test(text)) day = addDaysToLocalDate(datePart, 1);
  else if (/\bday after tomorrow\b/i.test(text)) day = addDaysToLocalDate(datePart, 2);

  const hh = String(hm.hour).padStart(2, "0");
  const mi = String(hm.minute).padStart(2, "0");
  return `${day}T${hh}:${mi}:00`;
}

function isAdvisorHumanCallbackQuestion({ question, label, dataType } = {}) {
  const q = String(question || "").trim();
  const l = String(label || "").trim();
  const combined = `${q} ${l}`.toLowerCase();
  if (!q && !l) return false;
  if (AI_REDIAL_QUESTION_RE.test(q)) return false;

  if (dataType === "datetime" && /\b(callback|advisor|speak|appointment|visit|human)\b/i.test(combined)) {
    return true;
  }
  if (/\b(callback_?time|advisor_?callback|human_?callback|speak_?time|preferred_?time)\b/i.test(l)) {
    return true;
  }

  const mentionsHuman =
    /\b(advisor|adviser|human|specialist|expert|representative|sales\s*(person|rep|team)|our\s+team|consultant|doctor|manager|executive)\b/i.test(combined);
  const mentionsTiming =
    /\b(call\s*(you\s*)?back|callback|speak|talk|reach|contact|connect|visit|meet|appointment|available|free|convenient|best time|good time|preferred time|when can|what time)\b/i.test(combined);

  if (mentionsHuman && mentionsTiming) return true;
  if (mentionsTiming && /\b(for\s+(our|a|the)\s+(advisor|team|specialist|representative|human))\b/i.test(q)) {
    return true;
  }
  return false;
}

function findAdvisorCallbackResponse(callAnswers) {
  for (const row of callAnswers || []) {
    const answer = row?.answer == null ? "" : String(row.answer).trim();
    if (!answer) continue;
    if (isAdvisorHumanCallbackQuestion({ question: row.question, label: row.label, dataType: row.dataType })) {
      return row;
    }
  }
  return null;
}

function resolveAdvisorCallbackIsoHeuristic(answer, callerPhone) {
  const timeZone = getCallerTimezone(callerPhone);
  const relativeMinutes = extractRelativeMinutesFromText(answer);
  if (relativeMinutes) {
    const instant = new Date(Date.now() + relativeMinutes * 60000);
    if (instant.getTime() > Date.now()) return instant.toISOString();
  }
  const local = extractWallClockLocalDateTime(answer, timeZone);
  if (local) {
    const resolved = resolveSpecificCallbackTime(local, timeZone, answer);
    if (resolved) return resolved.toISOString();
  }
  return null;
}

async function resolveAdvisorCallbackIso({ answer, question, callerPhone, orgId, onUsage }) {
  const heuristic = resolveAdvisorCallbackIsoHeuristic(answer, callerPhone);
  if (heuristic) return heuristic;

  if (!orgId || !question) return null;
  const { extractFollowUp } = require("../ai/postCallAgents/followUpAgent");
  const followUp = await extractFollowUp(
    `Agent: ${question}\nCaller: ${answer}`,
    orgId,
    callerPhone,
    onUsage,
    {
      callAnswered: true,
      summary: "(Human advisor callback preference from questionnaire — not an AI redial request.)",
    }
  );
  if (followUp?.callbackTime && followUp.callbackTimeMentioned && !followUp.callbackUsedPolicyFallback) {
    return followUp.callbackTime;
  }
  return null;
}

function shouldSuppressDialerCallbackForAdvisorPreference(transcript, advisorResponsePresent) {
  if (!advisorResponsePresent) return false;
  const { deriveTranscriptSignals } = require("../ai/postCallAgents/decisionEngine");
  const signals = deriveTranscriptSignals(transcript);
  // Busy / "call me back later" for the AI agent still schedules a redial.
  return !signals.busyRequest;
}

module.exports = {
  isAdvisorHumanCallbackQuestion,
  findAdvisorCallbackResponse,
  resolveAdvisorCallbackIso,
  resolveAdvisorCallbackIsoHeuristic,
  shouldSuppressDialerCallbackForAdvisorPreference,
};
