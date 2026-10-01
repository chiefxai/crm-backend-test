const crypto = require("crypto");
const { getLogger } = require("../../observability/logger");
const {
  parsePcmSampleRateFromMime,
  pcmToTelephony16k,
} = require("../../utils/audioConverter");

const log = getLogger("telephony.vobizOpeningGreeting");

const TTS_MODEL = "gemini-2.5-flash-preview-tts";

/**
 * Opening greeting audio source for Vobiz telephony.
 * - "live" (default): Gemini Live speaks the opening — same native voice as the rest of the call.
 *   Outbound uses ring-time Live pre-connect when prewarm finishes before answer.
 * - "prepared": outbound-only preview-TTS PCM (faster first byte, different voice from Live).
 * Set VOBIZ_OPENING_GREETING_MODE=prepared only if you accept the voice mismatch.
 */
function isPreparedOpeningGreetingEnabled() {
  const mode = String(process.env.VOBIZ_OPENING_GREETING_MODE || "live").trim().toLowerCase();
  return mode === "prepared";
}

/**
 * Pre-rendered opening uses a separate TTS model (different timbre from Live).
 * Only outbound uses it when VOBIZ_OPENING_GREETING_MODE=prepared (default).
 * Inbound always opens with Gemini Live so the voice matches the rest of the call.
 */
function shouldUsePreparedOpeningGreeting(direction = "outbound") {
  if (!isPreparedOpeningGreetingEnabled()) return false;
  return String(direction || "").toLowerCase() === "outbound";
}
const GREETING_CONFIG_VERSION = 4;
const GREETING_CACHE_TTL_MS = 15 * 60 * 1000;
const GREETING_CACHE_MAX = 200;

/** @type {Map<string, { audio: Buffer, expiresAt: number }>} */
const greetingAudioCache = new Map();

function normalizeLanguage(language) {
  const l = String(language || "").toLowerCase();
  if (l === "ta" || l === "tamil" || l === "tanglish") return "tamil";
  if (l === "en" || l === "english") return "english";
  return l ? l : "tamil";
}

function campaignPurposePhrase(campaignLabel) {
  if (!campaignLabel || !String(campaignLabel).trim()) return "your enquiry";
  const label = String(campaignLabel).trim();
  if (/enquiry|inquiry|follow-?up|call/i.test(label)) return `your ${label.toLowerCase()}`;
  return `your ${label.toLowerCase()} enquiry`;
}

/**
 * Build spoken opening text from agent/company/campaign configuration.
 * Caller-specific names are included in the text and must be reflected in cache keys.
 */
function buildOpeningGreetingText({
  direction = "outbound",
  orgName = "our team",
  agentName = "",
  campaignLabel = null,
  callerContactName = null,
  language = null,
}) {
  const company = (orgName || "our team").trim();
  const agent = (agentName || "").trim();
  const purpose = campaignPurposePhrase(campaignLabel);
  const lang = normalizeLanguage(language);

  if (direction !== "outbound") {
    const addressee = callerContactName ? `${callerContactName} sir/mam` : "sir/mam";
    return lang === "english"
      ? `Hello ${addressee}! How can I help you today?`
      : `Vanakkam ${addressee}! Sollunga, epdi help pannalam?`;
  }

  const addressee = callerContactName ? `${callerContactName} sir/mam` : "sir/mam";

  if (lang === "english") {
    const who = agent ? `I'm ${agent} from ${company}.` : `I'm calling from ${company}.`;
    if (callerContactName) {
      return `Hi ${callerContactName}, this is ${agent || "calling"} from ${company}. I'm calling regarding ${purpose}. Is this a good time to talk?`;
    }
    return `Hi, ${who} I'm calling regarding ${purpose}. Is this a good time to talk?`;
  }

  const agentIntro = agent ? `Naan ${agent}, ${company}-la irundhu` : `Naanga ${company}-la irundhu`;
  const topic = campaignLabel ? `${String(campaignLabel).trim()} pathi` : "unga enquiry pathi";
  return `Vanakkam ${addressee}! ${agentIntro} call panrom — ${topic}. Ippo pesalama?`;
}

function buildGreetingCacheKey({
  orgId,
  agentId,
  agentConfigFingerprint,
  campaignLabel,
  voiceName,
  language,
  greetingConfigVersion = GREETING_CONFIG_VERSION,
  callerContactName = null,
}) {
  const parts = [
    String(greetingConfigVersion),
    String(orgId || ""),
    String(agentId || ""),
    String(agentConfigFingerprint || ""),
    String(campaignLabel || ""),
    String(voiceName || ""),
    String(language || ""),
  ];
  if (callerContactName) parts.push(`caller:${callerContactName}`);
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

function agentConfigFingerprint(activeConfig) {
  if (!activeConfig) return "";
  const name = activeConfig.name || "";
  const voice = activeConfig.activeVoice || "";
  const snippet = (activeConfig.systemPrompt || "").slice(0, 120);
  return crypto.createHash("sha256").update(`${name}|${voice}|${snippet}`).digest("hex").slice(0, 16);
}

function buildOpeningTtsPrompt(greetingText) {
  return `Read the following opening line aloud at a natural conversational pace. Do not add extra words or a second greeting:\n${greetingText}`;
}

function pruneGreetingCache() {
  const now = Date.now();
  for (const [key, entry] of greetingAudioCache.entries()) {
    if (entry.expiresAt <= now) greetingAudioCache.delete(key);
  }
  if (greetingAudioCache.size > GREETING_CACHE_MAX) {
    const keys = [...greetingAudioCache.keys()].slice(0, greetingAudioCache.size - GREETING_CACHE_MAX);
    for (const k of keys) greetingAudioCache.delete(k);
  }
}

async function synthesizeOpeningGreetingPcm(geminiClient, voiceName, text, activeConfig = null) {
  if (!geminiClient || !voiceName || !text) throw new Error("geminiClient, voiceName, and text are required for opening TTS");
  const ttsPrompt = buildOpeningTtsPrompt(text);
  const res = await geminiClient.models.generateContent({
    model: TTS_MODEL,
    contents: [{ role: "user", parts: [{ text: ttsPrompt }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    },
  });
  const audioPart = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.mimeType?.startsWith("audio/"));
  if (!audioPart) {
    throw new Error("Gemini TTS returned no audio for opening greeting");
  }
  const sourceRate = parsePcmSampleRateFromMime(audioPart.inlineData.mimeType, 24000);
  const rawPcm = Buffer.from(audioPart.inlineData.data, "base64");
  return pcmToTelephony16k(rawPcm, sourceRate);
}

async function getOrGenerateOpeningGreetingAudio({
  geminiClient,
  voiceName,
  greetingText,
  cacheKey,
  allowCache = true,
  activeConfig = null,
}) {
  pruneGreetingCache();
  if (allowCache && cacheKey && greetingAudioCache.has(cacheKey)) {
    const hit = greetingAudioCache.get(cacheKey);
    if (hit.expiresAt > Date.now()) return { audio: hit.audio, cacheHit: true };
    greetingAudioCache.delete(cacheKey);
  }
  const audio = await synthesizeOpeningGreetingPcm(geminiClient, voiceName, greetingText, activeConfig);
  if (allowCache && cacheKey && !cacheKey.includes("caller:")) {
    greetingAudioCache.set(cacheKey, { audio, expiresAt: Date.now() + GREETING_CACHE_TTL_MS });
  }
  return { audio, cacheHit: false };
}

function logGreetingLatency(callId, payload) {
  log.info(JSON.stringify({ event: "vobiz_call_latency", callId, ...payload }));
}

/** Appended to Gemini Live system prompt when opening audio is pre-rendered (TTS), not spoken by the model. */
const PREPARED_OPENING_SPOKEN_PROMPT = `
──────────
OPENING GREETING ALREADY DELIVERED
──────────
The phone system has ALREADY played your opening greeting aloud to the caller. Do NOT say hello, vanakkam, introduce yourself, or repeat any greeting. Remain silent until the caller speaks. When they answer, go directly to question 1 or their request — no second greeting.
`;

module.exports = {
  GREETING_CONFIG_VERSION,
  TTS_MODEL,
  isPreparedOpeningGreetingEnabled,
  shouldUsePreparedOpeningGreeting,
  buildOpeningGreetingText,
  buildGreetingCacheKey,
  agentConfigFingerprint,
  buildOpeningTtsPrompt,
  getOrGenerateOpeningGreetingAudio,
  synthesizeOpeningGreetingPcm,
  logGreetingLatency,
  PREPARED_OPENING_SPOKEN_PROMPT,
  _clearGreetingCacheForTests: () => greetingAudioCache.clear(),
};
