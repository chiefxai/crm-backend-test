// src/telephony/questionnaire.js
//
// Shared "framework" piece for the per-call questionnaire feature — every
// telephony provider (Twilio, Vobiz, Piopiy, the Gemini browser session)
// used to hand-roll its own copy of "turn the question list into prompt
// text" and "save a live-captured answer to the DB with its label". A
// provider should only ever need to supply what's actually
// provider-specific (which questions apply to this call, and the
// orgId/callId/phone for this session) — this module handles the rest.
//
// Providers still each build their own surrounding prompt wording/
// instructions (those are genuinely tuned per provider) — only the
// numbered-list rendering and the DB write are shared here.

const db = require("../db/repository");
const { getLogger } = require("../observability/logger");
const log = getLogger("telephony.questionnaire");
const callerIdentity = require("./questionnaireCallerIdentity");

// Renders a normalized { label, question }[] (see postCallAgents.normalizeQuestions)
// as the numbered list every provider's questionnaire prompt embeds. The AI
// only ever sees/speaks `.question` — labels never reach the prompt.
function formatQuestionnaireList(normalizedQuestions) {
  return (normalizedQuestions || []).map((q, i) => `${i + 1}. ${q.question}`).join("\n");
}

// Called every time the AI's 'save_question_response' tool fires during a
// live call. The AI only ever echoes back the question text it just asked —
// match it against this call's normalized question list to recover the
// short label (falls back to the question text itself when no match/label),
// then persist it.
async function saveQuestionResponse({ orgId, callId, phone, question, answer, questionsList = [], callerContactName = null }) {
  try {
    if (!orgId) throw new Error("orgId is required to save a questionnaire response");
    const prepared = callerIdentity.prepareQuestionnaireSave({ question, answer, questionsList, callerContactName });
    if (!prepared.ok) {
      return { success: false, saved: false, error: prepared.error };
    }
    const match = questionsList.find((q) => q.question === question);
    await db.create("leadresponses", orgId, {
      callId,
      policyholderPhone: phone || "Unknown",
      question,
      answer: prepared.answer,
      label: match ? match.label : question,
    });
    log.info(`✅ Questionnaire: Saved response for "${question}" ➔ "${prepared.answer}"`);
    const result = { success: true, saved: true };
    if (prepared.note) result.note = prepared.note;
    if (prepared.coerced) result.coercedFromContact = true;
    return result;
  } catch (err) {
    log.error("❌ Questionnaire save failed:", err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  formatQuestionnaireList,
  saveQuestionResponse,
  questionnaireProgressMeta: callerIdentity.questionnaireProgressMeta,
  withQuestionnaireProgress: callerIdentity.withQuestionnaireProgress,
  looksLikeNameQuestion: callerIdentity.looksLikeNameQuestion,
  partitionQuestionsForKnownCaller: callerIdentity.partitionQuestionsForKnownCaller,
  prepareQuestionnaireSave: callerIdentity.prepareQuestionnaireSave,
};
