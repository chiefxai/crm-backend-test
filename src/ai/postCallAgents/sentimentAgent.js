// src/ai/postCallAgents/sentimentAgent.js
// ============================================================
// Post-call sentiment classification — Positive/Neutral/Negative/null.
// null is intentional for busy/callback-only calls or calls with insufficient
// genuine caller interaction. The database sentiment field is nullable text,
// so no sentinel such as "Unknown" is required.
const { z } = require("zod");
const { getEffectivePrompt } = require("../systemAgents");
const { generateStructured, log, formatWorkflowAnswers } = require("./shared");

const SentimentSchema = z.object({
  sentiment: z.union([z.enum(["Positive", "Neutral", "Negative"]), z.null()]),
});

function deterministicSentimentFallback(transcript) {
  const text = String(transcript || "").toLowerCase();
  if (!text.trim()) return null;
  const positive = (text.match(/\\b(interested|yes|sure|great|good|happy|love|perfect|okay|ok|proceed|proceeding|thank you|thanks)\\b/g) || []).length;
  const negative = (text.match(/\\b(no|not interested|bad|angry|upset|hate|never|cancel|stop|complaint|problem|issue)\\b/g) || []).length;
  if (positive > negative + 1) return "Positive";
  if (negative > positive + 1) return "Negative";
  return "Neutral";
}

async function analyzeSentiment(transcript, orgId = null, workflowAnswers = []) {
  if (!transcript?.trim()) return { sentiment: null, inputTokens: 0, outputTokens: 0 };
  try {
    const template = await getEffectivePrompt(orgId, "sentiment-analyzer");
    const prompt = template
      .replace("{workflowAnswers}", formatWorkflowAnswers(workflowAnswers))
      .replace("{transcript}", transcript);
    let inputTokens = 0;
    let outputTokens = 0;
    const parsed = await generateStructured({
      label: "sentiment",
      orgId,
      prompt,
      schema: SentimentSchema,
      fallback: { sentiment: null },
      onUsage: ({ inputTokens: i, outputTokens: o }) => { inputTokens = i; outputTokens = o; },
    });
    const modelSentiment = parsed?.sentiment ?? null;
    if (modelSentiment) return { sentiment: modelSentiment, inputTokens, outputTokens };
    const fallback = deterministicSentimentFallback(transcript);
    log.warn(`⚠️ [postCallAgents:sentiment] Model returned no sentiment; using deterministic fallback: ${fallback ?? "null"}`);
    return { sentiment: fallback, inputTokens, outputTokens };
  } catch (err) {
    const fallback = deterministicSentimentFallback(transcript);
    log.error("❌ [postCallAgents:sentiment] error:", err.message);
    log.warn(`⚠️ [postCallAgents:sentiment] Using deterministic fallback after model failure: ${fallback ?? "null"}`);
    return { sentiment: fallback, inputTokens: 0, outputTokens: 0 };
  }
}

module.exports = { analyzeSentiment };
