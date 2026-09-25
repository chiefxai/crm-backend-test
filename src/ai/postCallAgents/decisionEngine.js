// Deterministic transcript signals used to validate post-call AI decisions.
// The transcript, not sentiment/summary, is the source of truth for caller intent.

const MEANINGLESS_CALLER_PATTERNS = [
  /^\{?\s*background\s*\}?$/i,
  /^\[?\s*(background|noise|silence|music|inaudible|unintelligible|static)\s*\]?$/i,
  /^<\s*(background|noise|silence)\s*>$/i,
];

const TAMIL_MINUTE_WORDS = {
  ஒரு: 1,
  இரு: 2,
  ரெண்டு: 2,
  மூன்று: 3,
  நான்கு: 4,
  ஐந்து: 5,
  அஞ்சு: 5,
  ஆறு: 6,
  ஏழு: 7,
  எட்டு: 8,
  பத்து: 10,
  இப்பத்தி: 20,
};

function isMeaningfulCallerUtterance(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (MEANINGLESS_CALLER_PATTERNS.some((re) => re.test(t))) return false;
  if (/^\{[^}]{1,48}\}$/.test(t)) return false;
  return true;
}

function splitTranscriptLines(transcript) {
  return String(transcript || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function callerTurns(transcript) {
  return splitTranscriptLines(transcript)
    .filter((line) => /^Caller\s*:/i.test(line))
    .map((line) => line.replace(/^Caller\s*:\s*/i, "").trim())
    .filter(isMeaningfulCallerUtterance);
}

function agentTurns(transcript) {
  return splitTranscriptLines(transcript)
    .filter((line) => /^Agent\s*:/i.test(line))
    .map((line) => line.replace(/^Agent\s*:\s*/i, "").trim())
    .filter(Boolean);
}

function extractRelativeMinutesFromText(text) {
  const t = String(text || "");
  const inMinutes = t.match(/\b(?:in\s+)?(\d{1,4})\s*(?:minutes?|mins?)\b/i);
  if (inMinutes) return clampMinutes(Number(inMinutes[1]));
  const later = t.match(/\b(\d{1,4})\s*(?:minutes?|mins?)\s+(?:later|from\s+now)\b/i);
  if (later) return clampMinutes(Number(later[1]));
  const hours = t.match(/\b(?:in\s+)?(\d{1,2})\s*(?:hours?|hrs?)\b/i);
  if (hours) return clampMinutes(Number(hours[1]) * 60);
  const tamil = t.match(
    /(\d+|ஒரு|இரு|ரெண்டு|மூன்று|நான்கு|ஐந்து|அஞ்சு|ஆறு|ஏழு|எட்டு|பத்து|இப்பத்தி)\s*(?:நிமிஷம்?|minute?s?)/i
  );
  if (tamil) {
    const raw = tamil[1];
    const n = /^\d+$/.test(raw) ? Number(raw) : TAMIL_MINUTE_WORDS[raw];
    if (n > 0) return clampMinutes(n);
  }
  return null;
}

function clampMinutes(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(7 * 24 * 60, Math.round(n));
}

function hasClockTime(text) {
  return /\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:at\s+)\d{1,2}:\d{2}\b/i.test(text);
}

function hasExplicitRelativeTime(text) {
  return /\b(?:in\s+\d+\s*(?:minutes?|mins?|hours?|hrs?)|\d+\s*(?:minutes?|mins?|hours?|hrs?)\s+(?:later|from\s+now))\b/i.test(text)
    || extractRelativeMinutesFromText(text) != null;
}

function callerSuppliedTimeInText(callerText) {
  return hasExplicitRelativeTime(callerText) || hasClockTime(callerText)
    || /\b(?:today|tomorrow)\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i.test(callerText);
}

function deriveTranscriptSignals(transcript) {
  const turns = callerTurns(transcript);
  const callerText = turns.join(" ");
  const callerSpoke = turns.length > 0 && callerText.split(/\s+/).filter(Boolean).length > 0;

  const explicitCallback = /\b(?:call(?:\s+me)?\s+back|callback|call again|ring me|contact me later|speak later|call me again|talk later|reach me later|திரும்ப\s+கால்|மீண்டும்\s+கால்)\b/i.test(callerText);
  const busyRequest = /\b(?:i['’]?m|i am|we are|we're|currently)?\s*busy\b|\bnot a good time\b|\bcan(?:not|'t) talk\b|\bunable to talk\b|\bcan't speak\b|\bcannot speak\b|\bபிஸி\b|\bநேரம்\s+இல்ல\b/i.test(callerText);

  const callerRelativeMinutes = extractRelativeMinutesFromText(callerText);
  const callerSuppliedTime = callerSuppliedTimeInText(callerText) || callerRelativeMinutes != null;

  return {
    turns,
    callerText,
    callerSpoke,
    explicitCallback,
    busyRequest,
    callerSuppliedTime,
    callerRelativeMinutes,
  };
}

function deriveAgentSchedulingSignals(transcript) {
  const turns = agentTurns(transcript);
  const agentText = turns.join(" ");
  const agentRelativeMinutes = extractRelativeMinutesFromText(agentText);
  const agentOfferedCallback =
    /\b(call\s+(?:you\s+)?back|ring\s+you|reach\s+you|contact\s+you)\b/i.test(agentText)
    || /கால்|திரும்ப\s*கால்/.test(agentText);
  const agentSuppliedTime = agentRelativeMinutes != null || hasClockTime(agentText) || hasExplicitRelativeTime(agentText);

  return {
    agentText,
    agentOfferedCallback,
    agentRelativeMinutes,
    agentSuppliedTime,
  };
}

module.exports = {
  callerTurns,
  agentTurns,
  isMeaningfulCallerUtterance,
  extractRelativeMinutesFromText,
  deriveTranscriptSignals,
  deriveAgentSchedulingSignals,
};
