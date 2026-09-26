const { getConfig, buildRuntimePrompt } = require("../config/agentConfig");
const { buildCustomObjectTools } = require("../utils/objectToolBuilder");
const knowledgeBase = require("../ai/knowledgeBase");
const featureFlags = require("../platform/featureFlags");
const postCallAgents = require("../ai/postCallAgents");
const questionnaire = require("./questionnaire");
const { GET_STARHEALTH_QUOTE_TOOL } = require("./vobizStarhealthTool");
const { getCallerTimezone } = require("../lib/callerTimezone");
const { nowInTimezone } = require("../lib/timezoneConvert");

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
}) {
  const customObjects = setup.customObjects || [];
  let orgHasKnowledgeBase = setup.orgHasKnowledgeBase;
  let kbMode = setup.kbMode;
  let kbDocumentIds = setup.kbDocumentIds;
  let companyInfoPrompt = setup.companyInfoPrompt || "";
  let knowledgeBaseSearchEnabled = setup.knowledgeBaseSearchEnabled;
  const activeConfig = setup.activeConfig || getConfig();
  const preloadedQuestions = setup.questionsList || genericFallbackQuestions;

  const { functionDeclarations: customToolDeclarations, promptSection: customObjectsPrompt } = buildCustomObjectTools(customObjects);
  let knowledgeBasePrompt = "";

  if (orgHasKnowledgeBase && knowledgeBaseSearchEnabled) {
    let inlineKnowledge = setup.inlineKnowledge;
    if (inlineKnowledge === undefined && resolvedOrgId) {
      try {
        inlineKnowledge = await knowledgeBase.getAllContent(resolvedOrgId, kbDocumentIds);
      } catch {
        inlineKnowledge = null;
      }
    }
    if (inlineKnowledge) {
      knowledgeBasePrompt = `
──────────
KNOWLEDGE BASE
──────────
Here is everything you know about this business — its products, services, pricing, and policies. Answer directly from this, instantly, with no tool call and no pause to "look it up" — you already have the facts:

${inlineKnowledge}

Keep the spoken answer short — one or two sentences, the direct answer only, not a full lecture. If the caller asks something not covered here, say you don't have that detail rather than guessing.
`;
    } else {
      customToolDeclarations.push({
        name: "search_knowledge_base",
        description: "Search this business's knowledge base for facts, policies, or answers to the caller's question. Use this whenever the caller asks something you're not certain about rather than guessing.",
        parameters: { type: "OBJECT", properties: { query: { type: "STRING", description: "Search terms describing what to look up" } }, required: ["query"] },
      });
      knowledgeBasePrompt = `
──────────
KNOWLEDGE BASE
──────────
If the caller asks anything about this business, its products, services, pricing, or policies, call the 'search_knowledge_base' tool with their question to get the exact facts before answering. Do not make up or guess details — use the retrieved text to explain. Keep the spoken answer short — one or two sentences, the direct answer only, not a full lecture. Long explanations add real delay before you start speaking; the caller can always ask a follow-up if they want more.
`;
    }
  }

  let activeQuestions = preloadedQuestions;
  let hasCustomTaskQuestions = false;
  if (customQuestions && Array.isArray(customQuestions) && customQuestions.length > 0) {
    activeQuestions = customQuestions;
    hasCustomTaskQuestions = true;
  }

  const normalizedQuestions = postCallAgents.normalizeQuestions(activeQuestions);

  const dynamicQuestionnairePrompt = `
──────────
MANDATORY QUESTIONNAIRE PROTOCOL
──────────
You MUST ask the caller the following questions ONE BY ONE, to understand what they need — do not describe yourself as being in any particular industry beyond what's already been established above. Do NOT ask them all at once. Wait for their response for each question:
${questionnaire.formatQuestionnaireList(normalizedQuestions)}

When the user answers a question, you must immediately call the tool 'save_question_response' with the exact question you asked and the answer they gave, and then move to the next question.

Before asking any question, check whether the caller has already told you the answer earlier in this same conversation (either volunteered on their own, or answered while responding to a different question). If so, do NOT ask it again — immediately call 'save_question_response' with that question and what they already told you, and move straight to the next question they have not answered yet.

If the caller's reply is not a plain answer to what you asked — for example they ask "how does that work", "explain", "tell me more", or respond with a question of their own instead of answering — do NOT log it as a Yes/No answer and do NOT move to the next question yet. First use the 'search_policy_knowledge_base' tool to find the real answer and explain it to them in your own words, in the same language they're using — keep it to one or two short sentences, not a full lecture, since long explanations add real delay before you start speaking. Only call 'save_question_response' and move to the next question once they have actually answered what you asked.

Be extra careful with Yes/No answers specifically — "yes" and "no" (and their Tamil/Hindi/English equivalents: aama/illa, haan/nahi, correct/not correct) sound similar over a phone line and are easy to log backwards. Getting this one word wrong sends the rest of the conversation down the wrong branch — for example asking "how many policies do you have" after mishearing a "No" as a "Yes" to "do you have a policy". If you are not fully confident which one the caller said, quickly confirm before saving it (e.g. "So that's a No, right?") rather than guessing.

Never call 'save_question_response' unless the caller has actually, verbally answered that specific question earlier in THIS call. Do not guess, assume, or pre-fill an answer (e.g. assuming "Yes" just because you're calling to offer something, or because a caller sounds friendly). If you have not yet asked a question and gotten a real reply to it, it has no answer to save yet.
`;

  const genericQuestionnairePrompt = `
──────────
MANDATORY QUESTIONNAIRE PROTOCOL
──────────
This is an outbound call — you called them, ask question 1 first, right after your opening greeting, before anything else. Do not skip ahead to a later question or start general small talk first.
${questionnaire.formatQuestionnaireList(normalizedQuestions)}

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
    ? `\n━━━ CALLER IDENTITY ━━━\nThis caller is already a saved contact named "${callerContactName}". Address them by this name naturally during the call. Do NOT ask "what is your name?" — you already know it.\n`
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

  let finalPrompt = customObjects.length > 0
    ? buildRuntimePrompt(activeConfig) + "\n" + customObjectsPrompt + companyInfoPrompt + callerIdentityPrompt + callerClockPrompt + (hasCustomTaskQuestions ? "\n" + genericQuestionnairePrompt : "") + knowledgeBasePrompt + endCallPrompt
    : buildRuntimePrompt(activeConfig) + "\n" + dynamicQuestionnairePrompt + companyInfoPrompt + callerIdentityPrompt + callerClockPrompt + knowledgeBasePrompt + endCallPrompt;
  if (starhealthPrompt) finalPrompt += "\n" + starhealthPrompt;

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
