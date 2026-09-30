const {
  looksLikeNameQuestion,
  partitionQuestionsForKnownCaller,
  prepareQuestionnaireSave,
} = require("../../src/telephony/questionnaireCallerIdentity");

describe("questionnaire caller name guards", () => {
  const questions = [
    { label: "full_name", question: "May I know your full name please?" },
    { label: "age", question: "How old are you currently?" },
  ];

  test("detects English name questions", () => {
    expect(looksLikeNameQuestion(questions[0])).toBe(true);
    expect(looksLikeNameQuestion(questions[1])).toBe(false);
  });

  test("partitions name questions when CRM name is known", () => {
    const { toAsk, preAnsweredName } = partitionQuestionsForKnownCaller(questions, "sanjay");
    expect(preAnsweredName).toHaveLength(1);
    expect(preAnsweredName[0].question).toMatch(/full name/i);
    expect(toAsk).toHaveLength(1);
    expect(toAsk[0].question).toMatch(/How old/i);
  });

  test("rejects pesla/ready-to-talk as a non-name answer", () => {
    const result = prepareQuestionnaireSave({
      question: "How old are you currently?",
      answer: "ready to talk",
      questionsList: questions,
      callerContactName: "sanjay",
    });
    expect(result.ok).toBe(false);
  });

  test("coerces name answer to CRM contact when caller only acknowledges", () => {
    const result = prepareQuestionnaireSave({
      question: "May I know your full name please?",
      answer: "pesla",
      questionsList: questions,
      callerContactName: "sanjay",
    });
    expect(result.ok).toBe(true);
    expect(result.answer).toBe("sanjay");
    expect(result.coerced).toBe(true);
  });

  test("coerces mismatched name save to CRM contact", () => {
    const result = prepareQuestionnaireSave({
      question: "May I know your full name please?",
      answer: "Santhosh",
      questionsList: questions,
      callerContactName: "sanjay",
    });
    expect(result.ok).toBe(true);
    expect(result.answer).toBe("sanjay");
    expect(result.coerced).toBe(true);
  });
});
