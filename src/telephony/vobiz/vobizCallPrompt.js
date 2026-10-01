const { getConfig, buildRuntimePrompt } = require("../../config/agentConfig");
const knowledgeBase = require("../../ai/knowledgeBase");
const featureFlags = require("../../platform/featureFlags");
const postCallAgents = require("../../ai/postCallAgents");
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

  // Live calls are intentionally read-only. Only knowledge-base retrieval is
  // exposed to Gemini Live; persistence is deferred to post-call agents.
  const customToolDeclarations = [];
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

The live call is conversation-only. Do NOT call any CRM/database write tool. Do not save questionnaire answers during the call. The complete recording and transcript are handed to the post-call agents after hangup; those agents extract answers and perform persistence/actions.

If the caller asks a business or policy question, use the read-only search_knowledge_base tool when needed, then answer naturally and continue the current question when appropriate.
`;
  const outboundQuestionnaireLead = callerContactName
    ? `This is an outbound call — you called them. After your opening greeting, wait until they confirm they can talk (e.g. "yes", "pesalam", "pesla"). That confirmation is NOT an answer to any questionnaire item — never save it with save_question_response. Then follow the KNOWN CONTACT — NAME ALREADY ON FILE section (if present) and ask the first numbered question below out loud.`
    : "This is an outbound call — you called them, ask question 1 first, right after your opening greeting, before anything else. Do not skip ahead to a later question or start general small talk first.";

  const genericQuestionnairePrompt = `
──────────
MANDATORY QUESTIONNAIRE PROTOCOL
──────────
${outboundQuestionnaireLead}
${questionnaire.formatQuestionnaireList(questionnaireQuestionsForPrompt)}

Ask these ONE BY ONE, in this exact order. Wait for the caller's actual answer to the current question before moving to the next one.

Do NOT call the 'save_question_response' tool at all unless the caller has actually given a real, on-topic answer to that specific question. This means: if their reply is unclear, off-topic, silent, or just a greeting/acknowledgment ("hello", "yes?", "who is this") — do not call the tool AT ALL. Do not call it with a placeholder value like "[No response]", "unclear", "N/A", or anything similar either — that is still calling the tool without a real answer, which is exactly what this rule forbids. Simply re-ask the same question again instead, out loud, and wait.

If you re-ask a question 2-3 times with no real answer, move on and mention at the end of the call that this question couldn't be answered — do not keep looping on it forever, and do not fabricate an answer to escape the loop.

Only when the caller gives an actual real answer, call 'save_question_response' with the exact question you asked and the real answer they gave, then move to the next question.
`;

  const endCallPrompt = `
──────────
ENDING THE CALL
──────────
Once the conversation has naturally wrapped up — the caller's questions are answered, they say goodbye, or they have nothing further to add — say a brief warm goodbye, then call the 'end_call' tool. Do not call it mid-conversation or before saying goodbye.`;

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
The caller's IANA timezone is ${callerTimezone}. On their clock right now it is ${callerNow} (format YYYY-MM-DDTHH:mm:ss, 24-hour).

Interpret "today", "tomorrow", "this evening", and times like "10 AM" relative to THIS clock — not server UTC.

If a questionnaire question asks when a human advisor, specialist, or team member should call or speak with them, capture their answer with save_question_response. That is a human follow-up preference on their contact record — it does NOT schedule another AI outbound call.

If the caller is busy and wants YOU (this AI) to call them back later, that is different — follow your callback / ending-call instructions for an AI redial.
`;
  }

  let starhealthPrompt = "";
  if (taskConfig?.starhealthEnabled && (await featureFlags.isEnabled("starhealth_quote"))) {
    customToolDeclarations.push(GET_STARHEALTH_QUOTE_TOOL);
    starhealthPrompt = `
──────────
STAR HEALTH QUOTE PROTOCOL
──────────
This is a Star Health insurance outbound call. After your opening greeting, collect the following, ONE AT A TIME, waiting for the caller's real answer each time:
1. Their 6-digit pincode.
2. Who needs to be covered — parents, adults (self/spouse), and/or children — and each person's age.
3. Whether they or anyone being covered has a Pre-Existing Disease (PED) — Yes/No.
4. Any specific Star Health product they already have in mind (optional — if they don't know, proceed without one).

Once you have the pincode, every member's age, and the PED answer, call the 'get_starhealth_quote' tool with everything collected so far. Do not call it before those are known.

If the tool result includes 'plans', read out up to 3 plan names and prices naturally, as options — do not read raw JSON.
If the tool result has 'deferred: true', tell the caller their personalized quote will be sent to them shortly (e.g. via WhatsApp) instead of reading a quote now — do not say you already sent it.
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
