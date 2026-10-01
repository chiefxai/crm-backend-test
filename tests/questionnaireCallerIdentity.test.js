const {
  looksLikeYesNoQuestion,
  prepareQuestionnaireSave,
} = require("../src/telephony/questionnaireCallerIdentity");

describe("questionnaire answer validation", () => {
  test("recognizes natural yes/no questions such as tobacco use", () => {
    expect(looksLikeYesNoQuestion({
      question: "Do you smoke or use any tobacco products?",
    })).toBe(true);
  });

  test("accepts a bare No for a natural yes/no question", () => {
    const result = prepareQuestionnaireSave({
      question: "Do you smoke or use any tobacco products?",
      answer: "No",
      questionsList: [{
        label: "Tobacco",
        question: "Do you smoke or use any tobacco products?",
      }],
    });
    expect(result).toEqual({ ok: true, answer: "No" });
  });

  test("still rejects bare No for a non-yes/no fact question", () => {
    const result = prepareQuestionnaireSave({
      question: "What is your approximate annual income?",
      answer: "No",
      questionsList: [{
        label: "Income",
        question: "What is your approximate annual income?",
      }],
    });
    expect(result.ok).toBe(false);
  });
});
