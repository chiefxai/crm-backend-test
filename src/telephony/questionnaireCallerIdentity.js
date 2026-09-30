const NAME_QUESTION_RE = /\b(full\s*name|your\s*name|name\s*please|know\s+your\s+name|caller'?s?\s*name|peru|payer\s*name)\b/i;

const NON_ANSWER_ACK_RE = /^(ready to talk|pesla|pesalam|pesalama|hello|hi|hey|yes\??|ok|okay|aama|illa|haan|nahi|vanakkam|speak|talk|sure|fine|go ahead)\s*$/i;

function looksLikeNameQuestion(entry) {
  if (!entry) return false;
  const text = `${entry.label || ""} ${entry.question || ""}`;
  return NAME_QUESTION_RE.test(text);
}

function partitionQuestionsForKnownCaller(normalizedQuestions, callerContactName) {
  const name = String(callerContactName || "").trim();
  if (!name) {
    return { toAsk: normalizedQuestions || [], preAnsweredName: [] };
  }
  const toAsk = [];
  const preAnsweredName = [];
  for (const q of normalizedQuestions || []) {
    if (looksLikeNameQuestion(q)) preAnsweredName.push(q);
    else toAsk.push(q);
  }
  return { toAsk, preAnsweredName };
}

function normalizeNameToken(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function prepareQuestionnaireSave({ question, answer, questionsList = [], callerContactName = null }) {
  const rawAnswer = String(answer ?? "").trim();
  const match = questionsList.find((q) => q.question === question);
  const isName = match ? looksLikeNameQuestion(match) : looksLikeNameQuestion({ question });
  const knownName = String(callerContactName || "").trim();

  const looksLikeAck = !rawAnswer
    || NON_ANSWER_ACK_RE.test(rawAnswer)
    || /^ready to talk$/i.test(rawAnswer);

  if (looksLikeAck) {
    if (isName && knownName) {
      return {
        ok: true,
        answer: knownName,
        coerced: true,
        note: `Caller only acknowledged (not their name). Saved CRM contact name "${knownName}".`,
      };
    }
    return {
      ok: false,
      error: "That reply is only an acknowledgment (e.g. ready to talk / pesalam), not an answer to this question. Do not call save_question_response — ask the question again and wait for a real answer.",
    };
  }

  if (isName && knownName) {
    if (normalizeNameToken(rawAnswer) !== normalizeNameToken(knownName)) {
      return {
        ok: true,
        answer: knownName,
        coerced: true,
        note: `Name answer adjusted to saved contact "${knownName}" (do not use a different name when speaking).`,
      };
    }
  }

  return { ok: true, answer: rawAnswer };
}

module.exports = {
  looksLikeNameQuestion,
  partitionQuestionsForKnownCaller,
  prepareQuestionnaireSave,
};
