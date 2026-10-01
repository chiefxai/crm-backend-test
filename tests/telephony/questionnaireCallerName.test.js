const {
  looksLikeNameQuestion,
  looksLikeQuestionnaireAck,
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

  test("rejects CRM contact name as answer to non-name questions", () => {
    const insuranceQuestions = [
      { label: "gender", question: "What is your gender — Male or Female?" },
      { label: "income", question: "What is your approximate annual income in rupees?" },
    ];
    for (const q of insuranceQuestions) {
      const result = prepareQuestionnaireSave({
        question: q.question,
        answer: "sanjay",
        questionsList: insuranceQuestions,
        callerContactName: "sanjay",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/CRM contact name/i);
    }
  });

  test("treats py-salam style transcripts as acknowledgments", () => {
    expect(looksLikeQuestionnaireAck("Py-SALAM")).toBe(true);
    expect(looksLikeQuestionnaireAck("pesalam")).toBe(true);
  });

  test("rejects Not applicable placeholder answers", () => {
    const result = prepareQuestionnaireSave({
      question: "How old are you currently?",
      answer: "Not applicable",
      questionsList: [{ label: "age", question: "How old are you currently?" }],
      callerContactName: "sanjay",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/placeholder/i);
  });

  test("rejects bare Yes as answer to age question", () => {
    const result = prepareQuestionnaireSave({
      question: "How old are you currently?",
      answer: "Yes",
      questionsList: questions,
      callerContactName: "sanjay",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Yes.*No/i);
  });

  test("does not coerce bare Yes on name question to CRM contact", () => {
    const result = prepareQuestionnaireSave({
      question: "May I know your full name please?",
      answer: "Yes",
      questionsList: questions,
      callerContactName: "sanjay",
    });
    expect(result.ok).toBe(false);
  });

  test("allows CRM contact name as nominee when question asks for nominee", () => {
    const result = prepareQuestionnaireSave({
      question: "Who would you like to name as the nominee for this policy?",
      answer: "sanjay",
      questionsList: [{ label: "nominee", question: "Who would you like to name as the nominee for this policy?" }],
      callerContactName: "sanjay",
    });
    expect(result.ok).toBe(true);
    expect(result.answer).toBe("sanjay");
  });
});
