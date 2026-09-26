const db = require("../db/repository");
const genai = require("../ai/googleAiClient");
const { getLogger } = require("../observability/logger");
const { buildVobizSessionPrompt } = require("./vobizCallPrompt");
const {
  buildOpeningGreetingText,
  buildGreetingCacheKey,
  agentConfigFingerprint,
  getOrGenerateOpeningGreetingAudio,
} = require("./vobizOpeningGreeting");

const log = getLogger("telephony.vobizOutboundPrewarm");

async function loadCampaignLabel(orgId, taskId) {
  if (!orgId || !taskId) return null;
  try {
    const tasks = await db.list("dialertasks", orgId);
    const task = tasks.find((t) => String(t.id) === String(taskId));
    return task?.name || null;
  } catch (err) {
    log.warn(`⚠️ Could not load dialer task name for prewarm: ${err.message}`);
    return null;
  }
}

async function generateOpeningAudio({
  orgId,
  agentId,
  activeConfig,
  campaignLabel,
  voiceName,
  openingGreetingText,
  callerContactName,
  language,
  metrics,
}) {
  if (!voiceName || !openingGreetingText) return null;
  const cacheKey = buildGreetingCacheKey({
    orgId,
    agentId,
    agentConfigFingerprint: agentConfigFingerprint(activeConfig),
    campaignLabel,
    voiceName,
    language,
    callerContactName,
  });
  const client = await genai.getClientForOrg(orgId).catch(() => null);
  if (!client) {
    if (metrics) metrics.greetingError = "no_gemini_client";
    return null;
  }
  const ttsT0 = Date.now();
  try {
    const { audio, cacheHit } = await getOrGenerateOpeningGreetingAudio({
      geminiClient: client,
      voiceName,
      greetingText: openingGreetingText,
      cacheKey,
      allowCache: !callerContactName,
    });
    if (metrics) {
      metrics.greetingCacheHit = cacheHit;
      metrics.greetingGenerateMs = Date.now() - ttsT0;
      metrics.greetingAudioReady = Date.now();
    }
    return audio;
  } catch (err) {
    if (metrics) metrics.greetingError = err.message;
    log.error("❌ Opening greeting TTS prewarm failed (will fall back to Live greeting):", err.message);
    return null;
  }
}

/**
 * Full outbound prewarm during ringing: setup, full prompt, opening greeting TTS.
 * resolveVobizCallSetup must be passed in to avoid circular imports with vobizProxy.
 */
async function runOutboundPrewarm({
  orgId,
  phoneNumber,
  agentId,
  questions,
  taskConfig,
  taskId,
  resolveVobizCallSetup,
  genericFallbackQuestions,
}) {
  const prewarmStarted = Date.now();
  const metrics = {
    prewarmStarted,
    prewarmCompleted: null,
    greetingPrepared: null,
    greetingAudioReady: null,
    greetingGenerateMs: null,
    promptBuildMs: null,
    finalPromptLength: null,
    kbInlineLength: null,
    greetingCacheHit: false,
    greetingError: null,
  };

  const [setup, campaignLabel] = await Promise.all([
    resolveVobizCallSetup(orgId, phoneNumber, null, "outbound", agentId || null, genericFallbackQuestions),
    loadCampaignLabel(orgId, taskId),
  ]);

  const callerContactName = setup.callerContactName || null;
  const orgName = setup.orgName || "our team";
  const activeConfig = setup.activeConfig;
  const voiceName = setup.voiceName;

  const openingGreetingText = buildOpeningGreetingText({
    direction: "outbound",
    orgName,
    agentName: (activeConfig && activeConfig.name) || "",
    campaignLabel,
    callerContactName,
    language: taskConfig?.language,
  });
  metrics.greetingPrepared = Date.now();

  const promptT0 = Date.now();
  const [promptBundle, openingGreetingAudio] = await Promise.all([
    buildVobizSessionPrompt({
      resolvedOrgId: orgId,
      setup,
      customQuestions: questions,
      taskConfig,
      genericFallbackQuestions,
      callerContactName,
      orgName,
    }),
    generateOpeningAudio({
      orgId,
      agentId,
      activeConfig,
      campaignLabel,
      voiceName,
      openingGreetingText,
      callerContactName,
      language: taskConfig?.language,
      metrics,
    }),
  ]);
  metrics.promptBuildMs = Date.now() - promptT0;
  metrics.finalPromptLength = promptBundle.finalPromptLength;
  metrics.kbInlineLength = promptBundle.kbInlineLength;

  metrics.prewarmCompleted = Date.now();
  metrics.prewarm_duration_ms = metrics.prewarmCompleted - prewarmStarted;

  return {
    setup,
    ...promptBundle,
    openingGreetingText,
    openingGreetingAudio,
    voiceName,
    activeConfig,
    orgName,
    callerContactName,
    campaignLabel,
    metrics,
  };
}

module.exports = {
  runOutboundPrewarm,
  loadCampaignLabel,
  generateOpeningAudio,
};
