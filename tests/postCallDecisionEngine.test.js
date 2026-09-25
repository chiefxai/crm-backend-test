const {
  isMeaningfulCallerUtterance,
  deriveTranscriptSignals,
  deriveAgentSchedulingSignals,
  extractRelativeMinutesFromText,
} = require("../src/ai/postCallAgents/decisionEngine");

describe("post-call decisionEngine", () => {
  test("ignores Gemini background placeholders as caller speech", () => {
    expect(isMeaningfulCallerUtterance("{background}")).toBe(false);
    const signals = deriveTranscriptSignals("Caller: {background}\nAgent: Hello");
    expect(signals.callerSpoke).toBe(false);
  });

  test("detects Tamil relative minutes on agent turns", () => {
    const minutes = extractRelativeMinutesFromText("ஒரு அஞ்சு நிமிஷம் கழிச்சு கால் பண்றேன்");
    expect(minutes).toBe(5);
    const agent = deriveAgentSchedulingSignals(
      "Agent: சரி, ஒரு அஞ்சு நிமிஷம் கழிச்சு கால் பண்றேன்"
    );
    expect(agent.agentRelativeMinutes).toBe(5);
    expect(agent.agentOfferedCallback).toBe(true);
  });

  test("busy caller text is not treated as no-answer when meaningful", () => {
    const signals = deriveTranscriptSignals("Caller: I am busy, call me in 10 minutes");
    expect(signals.callerSpoke).toBe(true);
    expect(signals.busyRequest).toBe(true);
    expect(signals.callerRelativeMinutes).toBe(10);
  });
});
