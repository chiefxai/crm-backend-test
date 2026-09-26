const {
  isAdvisorHumanCallbackQuestion,
  resolveAdvisorCallbackIsoHeuristic,
  shouldSuppressDialerCallbackForAdvisorPreference,
} = require("../src/lib/advisorCallbackTime");

describe("advisorCallbackTime", () => {
  test("detects human advisor callback questionnaire wording", () => {
    expect(
      isAdvisorHumanCallbackQuestion({
        question: "What is the best time for our advisor to call you back with a quote?",
      })
    ).toBe(true);
    expect(
      isAdvisorHumanCallbackQuestion({
        question: "No problem. What time would be better for me to call you back?",
      })
    ).toBe(false);
  });

  test("parses relative and clock times in caller timezone heuristically", () => {
    const inFive = resolveAdvisorCallbackIsoHeuristic("in 30 minutes", "+919876543210");
    expect(inFive).toBeTruthy();
    expect(new Date(inFive).getTime()).toBeGreaterThan(Date.now());

    const tomorrow = resolveAdvisorCallbackIsoHeuristic("tomorrow 10 am", "+919876543210");
    expect(tomorrow).toBeTruthy();
  });

  test("suppresses dialer callback when only advisor timing was collected", () => {
    const transcript = [
      "Agent: What is the best time for our advisor to call you?",
      "Caller: Tomorrow at 10 AM",
    ].join("\n");
    expect(shouldSuppressDialerCallbackForAdvisorPreference(transcript, true)).toBe(true);
    expect(
      shouldSuppressDialerCallbackForAdvisorPreference(
        "Caller: I'm busy, call me back in an hour\nAgent: Sure",
        true
      )
    ).toBe(false);
  });

});
