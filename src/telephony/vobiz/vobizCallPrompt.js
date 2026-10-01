const { getConfig, buildRuntimePrompt } = require("../../config/agentConfig");
const knowledgeBase = require("../../ai/knowledgeBase");
const postCallAgents = require("../../ai/postCallAgents");
const questionnaire = require("../questionnaire");
const { getCallerTimezone } = require("../../lib/callerTimezone");
const { nowInTimezone } = require("../../lib/timezoneConvert");

/**
 * Build the full Gemini Live system prompt and tool declarations for a Vobiz call.
 * Mirrors the logic previously inlined in handleVobizSession's "start" handler.
 */
async function buildVobizSessionPrompt({
  resolvedOrgId,
  setup,
  customQuestions,
  taskConfig,
  genericFallbackQuestions,
  callerContactName,
  orgName,
  callerPhone = null,
  /** When true, skip loading KB into the system prompt (tool search only) — faster Live connect. */
  deferInlineKnowledge = false,
}) {
  const customObjects = setup.customObjects || [];
  let orgHasKnowledgeBase = setup.orgHasKnowledgeBase;
  let kbMode = setup.kbMode;
  let kbDocumentIds = setup.kbDocumentIds;
  let companyInfoPrompt = setup.companyInfoPrompt || "";
  let knowledgeBaseSearchEnabled = setup.knowledgeBaseSearchEnabled;
  const activeConfig = setup.activeConfig || getConfig();
  const preloadedQuestions = setup.questionsList || genericFallbackQuestions;

  // Live calls are intentionally read-only for business/CRM data. The only
  // live side-effect tool is end_call, which is required to terminate the
  // telephony session when Gemini decides the conversation is complete.
  const customToolDeclarations = [{
    name: "end_call",
    description: "End the current phone call when the conversation is complete. Use this after the final goodbye; this is the only live tool that may change call state.",
    parameters: { type: "OBJECT", properties: {} }
  }];
  let knowledgeBasePrompt = "";

  if (knowledgeBaseSearchEnabled && resolvedOrgId && kbMode !== "none") {
    customToolDeclarations.push({
      name: "search_knowledge_base",
      description: "Search this business knowledge base for facts, policies, products, services, pricing, or other information needed to answer the caller. This tool is read-only and must never be used to save or modify data.",
      parameters: { type: "OBJECT", properties: {
        query: { type: "STRING", description: "Search terms describing what to look up" }
      }, required: ["query"] }
    });
    knowledgeBasePrompt = `
──────────
KNOWLEDGE BASE
──────────
Use the read-only search_knowledge_base tool when you need exact business, product, service, pricing, or policy facts. Never use a live tool to save questionnaire answers, contacts, enquiries, callbacks, quotes, messages, or other CRM data.
`;
  }
  let activeQuestions = preloadedQuestions;
  let hasCustomTaskQuestions = false;
  if (customQuestions && Array.isArray(customQuestions) && customQuestions.length > 0) {
    activeQuestions = customQuestions;
    hasCustomTaskQuestions = true;
  }

  const normalizedQuestions = postCallAgents.normalizeQuestions(activeQuestions);
  const { toAsk: questionnaireQuestionsForPrompt, preAnsweredName } = questionnaire.partitionQuestionsForKnownCaller(
    normalizedQuestions,
    callerContactName,
  );

  const knownNamePrefillPrompt = callerContactName && preAnsweredName.length
    ? `\nKNOWN CONTACT\nThe caller is already known as "${callerContactName}". Do not ask their name again.\n`
    : "";

  const dynamicQuestionnairePrompt = `
──────────
LIVE QUESTIONNAIRE PROTOCOL
──────────
Ask the assigned questions ONE BY ONE in the required order. Wait for the caller’s real answer before moving to the next question.

The live call is conversation-only for business/CRM data. Do NOT call any CRM/database write tool and do not save questionnaire answers during the call. The complete recording and transcript are handed to the post-call agents after hangup; those agents extract answers and perform persistence/actions.

If the caller asks a business or policy question, use the read-only search_knowledge_base tool when needed, then answer naturally and continue the current question when appropriate.

When the conversation is complete, say the final goodbye and call end_call to terminate the phone call. Do not rely on the caller hanging up. Do not continue asking questions after end_call is requested.
`;
  const callerIdentityPrompt = callerContactName
    ? `\n━━━ CALLER IDENTITY ━━━\nThis caller is already a saved contact named "${callerContactName}". Address them by this exact name (same spelling/pronunciation as in your greeting) for the entire call — in Tamil, English, or Tanglish. Do NOT ask "what is your name?" — you already know it. Do NOT substitute a different name (e.g. Santhosh / சந்தோஷ்) and do not use the Tamil word சந்தோஷம் ("great/glad") as if it were their name.\n`
    : "";

  let callerClockPrompt = "";
  if (callerPhone) {
    const callerTimezone = getCallerTimezone(callerPhone);
    const callerNow = nowInTimezone(callerTimezone);
    callerClockPrompt = `
──────────
CALLER LOCAL DATE & TIME
──────────
The caller's IANA timezone is ${callerTimezone}. Their local time is ${callerNow}. Interpret relative dates and times using this clock.
Do not schedule, save, or modify anything during the live call; post-call agents handle persistence and follow-up decisions.
`;
  }
  const finalPrompt = buildRuntimePrompt(activeConfig)
    + "\n" + dynamicQuestionnairePrompt
    + companyInfoPrompt
    + callerIdentityPrompt
    + knownNamePrefillPrompt
    + callerClockPrompt
    + knowledgeBasePrompt;
  const kbInlineLength = (setup.inlineKnowledge && typeof setup.inlineKnowledge === "string")
    ? setup.inlineKnowledge.length
    : (knowledgeBasePrompt.includes("Here is everything") ? knowledgeBasePrompt.length : 0);

  return {
    finalPrompt,
    customToolDeclarations,
    normalizedQuestions,
    kbDocumentIds,
    kbInlineLength,
    finalPromptLength: finalPrompt.length,
    questionnaireLength: normalizedQuestions.length,
  };
}

module.exports = { buildVobizSessionPrompt };
