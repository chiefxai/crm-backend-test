const { questionnaireProgressMeta, withQuestionnaireProgress } = require("../../src/telephony/questionnaireCallerIdentity");

describe("questionnaireProgressMeta", () => {
  const list = [
    { label: "name", question: "May I know your full name please?" },
    { label: "age", question: "How old are you currently?" },
  ];

  test("returns next unanswered question", () => {
    const meta = questionnaireProgressMeta(list, ["May I know your full name please?"]);
    expect(meta.nextQuestion).toBe("How old are you currently?");
    expect(meta.allQuestionsAnswered).toBe(false);
  });

  test("withQuestionnaireProgress adds instruction", () => {
    const out = withQuestionnaireProgress({ success: true, saved: true }, list, [list[0].question]);
    expect(out.instruction).toMatch(/How old are you currently/);
    expect(out.questionnaireProgress.remainingQuestionTexts).toHaveLength(1);
  });
});
