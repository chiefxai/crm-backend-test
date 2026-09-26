const crypto = require("crypto");
const { getLogger } = require("../observability/logger");
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

const log = getLogger("telephony.vobizOpeningGreeting");

const TTS_MODEL = "gemini-2.5-flash-preview-tts";
const GREETING_CONFIG_VERSION = 1;
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

async function synthesizeOpeningGreetingPcm(geminiClient, voiceName, text) {
  if (!geminiClient || !voiceName || !text) throw new Error("geminiClient, voiceName, and text are required for opening TTS");
  const res = await geminiClient.models.generateContent({
    model: TTS_MODEL,
    contents: [{ role: "user", parts: [{ text }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    },
  });
  const audioPart = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.mimeType?.startsWith("audio/"));
  if (!audioPart) {
    throw new Error("Gemini TTS returned no audio for opening greeting");
  }
  const raw24k = Buffer.from(audioPart.inlineData.data, "base64");
  return resample24To16(raw24k);
}

async function getOrGenerateOpeningGreetingAudio({
  geminiClient,
  voiceName,
  greetingText,
  cacheKey,
  allowCache = true,
}) {
  pruneGreetingCache();
  if (allowCache && cacheKey && greetingAudioCache.has(cacheKey)) {
    const hit = greetingAudioCache.get(cacheKey);
    if (hit.expiresAt > Date.now()) return { audio: hit.audio, cacheHit: true };
    greetingAudioCache.delete(cacheKey);
  }
  const audio = await synthesizeOpeningGreetingPcm(geminiClient, voiceName, greetingText);
  if (allowCache && cacheKey && !cacheKey.includes("caller:")) {
    greetingAudioCache.set(cacheKey, { audio, expiresAt: Date.now() + GREETING_CACHE_TTL_MS });
  }
  return { audio, cacheHit: false };
}

function logGreetingLatency(callId, payload) {
  log.info(JSON.stringify({ event: "vobiz_call_latency", callId, ...payload }));
}

module.exports = {
  GREETING_CONFIG_VERSION,
  TTS_MODEL,
  buildOpeningGreetingText,
  buildGreetingCacheKey,
  agentConfigFingerprint,
  getOrGenerateOpeningGreetingAudio,
  synthesizeOpeningGreetingPcm,
  logGreetingLatency,
  _clearGreetingCacheForTests: () => greetingAudioCache.clear(),
};
