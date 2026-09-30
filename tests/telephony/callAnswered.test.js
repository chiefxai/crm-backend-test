const {
  resolveCallAnswered,
  countMeaningfulCallerWords,
} = require("../../src/ai/postCallAgents/decisionEngine");
describe("resolveCallAnswered", () => {
  test("caller words in transcript count as answered", () => {
    const merged = [{ role: "user", text: "Py-SALAM" }];
    expect(resolveCallAnswered({ mergedTranscriptLines: merged, direction: "outbound" })).toBe(true);
  });

  test("saved questionnaire answers count when STT missed speech", () => {
    expect(
      resolveCallAnswered({
        mergedTranscriptLines: [],
        direction: "outbound",
        savedAnswerCount: 2,
      })
    ).toBe(true);
  });

  test("sustained inbound audio on a connected outbound call counts", () => {
    expect(
      resolveCallAnswered({
        mergedTranscriptLines: [],
        direction: "outbound",
        durationSeconds: 30,
        totalInboundAudioBytes: 64_000,
      })
    ).toBe(true);
  });

  test("short silent outbound is not answered", () => {
    expect(
      resolveCallAnswered({
        mergedTranscriptLines: [],
        direction: "outbound",
        durationSeconds: 2,
        totalInboundAudioBytes: 0,
      })
    ).toBe(false);
  });

  test("countMeaningfulCallerWords ignores background tags", () => {
    const merged = [
      { role: "user", text: "{background}" },
      { role: "user", text: "yes" },
    ];
    expect(countMeaningfulCallerWords(merged)).toBe(1);
  });
});
