// src/ai/postCallAgents/summaryAgent.js
// ============================================================
// Post-call AI summary — the text shown in Call Logs, plus a structured
// outcome classification.
// ============================================================

const { z } = require("zod");
const { getEffectivePrompt } = require("../systemAgents");
const { generateStructured, formatWorkflowAnswers } = require("./shared");
const { getCallerTimezone } = require("../../lib/callerTimezone");
const { nowInTimezone } = require("../../lib/timezoneConvert");
const { deriveTranscriptSignals, deriveAgentSchedulingSignals } = require("./decisionEngine");

const SummarySchema = z.object({
  summary: z.string().min(1),
  keyPoints: z.array(z.string()).default([]),
  outcome: z.enum([
    "Interested", "Not Interested", "Callback Requested",
    "No Answer", "Wrong Number", "Incomplete",
  ]).default("Incomplete"),
  callerName: z.string().nullable().default(null),
});

async function generateCallSummary(transcript, orgId = null, workflowAnswers = [], onUsage, callerPhone = null) {
  if (!transcript?.trim()) return null;
  let template = await getEffectivePrompt(orgId, "call-summarizer");
  const timeZone = getCallerTimezone(callerPhone);
  if (!template.includes("{callerNow}")) {
    template += "\n\nCaller local date/time: {callerNow}";
  }
  const prompt = template
    .replace("{callerNow}", nowInTimezone(timeZone))
    .replace("{workflowAnswers}", formatWorkflowAnswers(workflowAnswers))
    .replace("{transcript}", transcript);

  const parsed = await generateStructured({
    label: "summary",
    orgId,
    prompt,
    schema: SummarySchema,
    fallback: null,
    onUsage,
  });
  if (!parsed) return null;

  // The Summary Agent is descriptive only. Its outcome is normalized against
  // deterministic transcript signals so a model can never turn a spoken
  // caller into "No Answer" or miss an explicit callback/busy request.
  const signals = deriveTranscriptSignals(transcript);
  const agentSignals = deriveAgentSchedulingSignals(transcript);
  let outcome = parsed.outcome;
  if (!signals.callerSpoke) {
    outcome = "No Answer";
  } else if (
    signals.explicitCallback ||
    signals.busyRequest ||
    (agentSignals.agentOfferedCallback && agentSignals.agentSuppliedTime)
  ) {
    outcome = "Callback Requested";
  } else if (outcome === "No Answer") {
    outcome = "Incomplete";
  }

  let text = parsed.summary;
  if (parsed.keyPoints.length) text += "\n\nKey Points:\n" + parsed.keyPoints.map(p => `• ${p}`).join("\n");
  text += `\n\nOutcome: ${outcome}`;

  return {
    ...parsed,
    outcome,
    text,
  };
}
module.exports = { generateCallSummary };
