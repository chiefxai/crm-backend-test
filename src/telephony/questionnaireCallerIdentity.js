const NAME_QUESTION_RE = /\b(full\s*name|your\s*name|name\s*please|know\s+your\s+name|caller'?s?\s*name|peru|payer\s*name)\b/i;
const NOMINEE_QUESTION_RE = /\bnominee\b/i;

const NON_ANSWER_ACK_RE = /^(ready to talk|pesla|pesalam|pesalama|py-?\s*salam|pysalam|hello|hi|hey|yes\??|ok|okay|aama|illa|haan|nahi|vanakkam|speak|talk|sure|fine|go ahead)\s*$/i;

const PLACEHOLDER_ANSWER_RE = /^(not\s*applicable|n\/?a|na|none|unknown|unclear|no\s*response|not\s*provided|skip|skipped|nil|-|—|\[no\s*response\])$/i;

const YES_NO_ONLY_ANSWER_RE = /^(yes|no|yeah|yep|nope|yup|nah|aama|illa|haan|nahi|correct|incorrect|right|wrong)\s*$/i;

const YES_NO_QUESTION_RE = /\b(yes\s*or\s*no|male\s*or\s*female|can\s+(i|we)\s+|may\s+i\s+|shall\s+i\s+|ippo\s*pesalama|pesalama|ready\s*to\s*talk|speak\s*now|talk\s*now|is\s+that\s+(ok|okay|fine)|do\s+you\s+have\s+a\s+policy)\b/i;

function normalizeAckToken(text) {
  return String(text || "").trim().toLowerCase().replace(/[^a-z]/g, "");
}

function looksLikeQuestionnaireAck(text) {
  const raw = String(text || "").trim();
  if (!raw) return true;
  if (NON_ANSWER_ACK_RE.test(raw)) return true;
  const compact = normalizeAckToken(raw);
  return /^(pesla|pesalam|pesalama|pysalam|readytotalk|pyalam)$/.test(compact);
}

function looksLikePlaceholderAnswer(answer) {
  const raw = String(answer ?? "").trim();
  if (!raw) return true;
  return PLACEHOLDER_ANSWER_RE.test(raw);
}

function looksLikeNameQuestion(entry) {
  if (!entry) return false;
  const text = `${entry.label || ""} ${entry.question || ""}`;
  return NAME_QUESTION_RE.test(text);
}

function looksLikeNomineeQuestion(entry) {
  if (!entry) return false;
  const text = `${entry.label || ""} ${entry.question || ""}`;
  return NOMINEE_QUESTION_RE.test(text);
}

function looksLikeYesNoQuestion(entry) {
  if (!entry) return false;
  const text = `${entry.label || ""} ${entry.question || ""}`;
  return YES_NO_QUESTION_RE.test(text);
}

function questionnaireProgressMeta(questionsList, savedQuestionTexts = []) {
  const saved = new Set(savedQuestionTexts.filter(Boolean));
  const list = questionsList || [];
  const remaining = list.filter((q) => !saved.has(q.question));
  const next = remaining[0] || null;
  return {
    savedQuestionTexts: [...saved],
    remainingQuestionTexts: remaining.map((q) => q.question),
    nextQuestion: next ? next.question : null,
    allQuestionsAnswered: remaining.length === 0 && list.length > 0,
  };
}

function withQuestionnaireProgress(result, questionsList, savedQuestionTexts) {
  const progress = questionnaireProgressMeta(questionsList, savedQuestionTexts);
  const instruction = progress.allQuestionsAnswered
    ? "All questionnaire items are saved. Do not ask any questionnaire question again. Thank the caller and continue or close politely."
    : progress.nextQuestion
      ? `Do NOT repeat any question already saved. Ask ONLY this next question once, then wait for their answer: "${progress.nextQuestion}"`
      : "Continue the questionnaire per the script.";
  return { ...result, questionnaireProgress: progress, instruction };
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

  const looksLikeAck = !rawAnswer || looksLikeQuestionnaireAck(rawAnswer);

  const isYesNoQ = match ? looksLikeYesNoQuestion(match) : looksLikeYesNoQuestion({ question });

  if (!isName && !isYesNoQ && YES_NO_ONLY_ANSWER_RE.test(rawAnswer)) {
    return {
      ok: false,
      error: 'A bare "Yes" or "No" is not a valid answer for this question (e.g. age, income, name). Ask the question again and save only the specific fact they said.',
    };
  }

  if (looksLikeAck) {
    if (isName && knownName && !/^(yes|no)\s*$/i.test(rawAnswer)) {
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

  const isNominee = match ? looksLikeNomineeQuestion(match) : looksLikeNomineeQuestion({ question });
  if (
    knownName
    && !isName
    && !isNominee
    && normalizeNameToken(rawAnswer) === normalizeNameToken(knownName)
  ) {
    return {
      ok: false,
      error: `The answer must be what the caller said for this question — not their CRM contact name "${knownName}". Do not use the contact name as a placeholder for income, age, gender, yes/no, medical, premium, or other facts. Ask the question again and save only their real answer.`,
    };
  }

  if (!isName && looksLikePlaceholderAnswer(rawAnswer)) {
    return {
      ok: false,
      error: 'Do not save placeholders like "Not applicable", "N/A", or "unknown". Ask this question out loud, wait for the caller\'s real answer, then save exactly what they said.',
    };
  }

  return { ok: true, answer: rawAnswer };
}

module.exports = {
  looksLikeNameQuestion,
  looksLikeNomineeQuestion,
  looksLikeYesNoQuestion,
  looksLikeQuestionnaireAck,
  looksLikePlaceholderAnswer,
  questionnaireProgressMeta,
  withQuestionnaireProgress,
  partitionQuestionsForKnownCaller,
  prepareQuestionnaireSave,
};
