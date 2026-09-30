/**
 * Documents the outbound greeting coordination fix in vobizProxy.js:
 * defer Live Gemini greeting until prepared opening TTS plays or is skipped.
 */
describe("vobiz outbound greeting coordination", () => {
  test("vobizProxy defers Live greeting while prepared opening is pending", () => {
    const fs = require("fs");
    const source = fs.readFileSync(require.resolve("../../src/telephony/vobizProxy.js"), "utf8");
    expect(source).toContain("deferLiveGreetingForPreparedOpening");
    expect(source).toContain("sendPreparedOpeningHandoff");
    expect(source).toContain("Deferring Live greeting — prepared opening TTS still playing or pending");
    expect(source).toContain("releasePreparedOpeningDeferral");
    expect(source).toContain("livePlaybackGate");
    expect(source).toContain("dropGeminiAudioUntilCallerSpeaks");
    expect(source).toContain("PREPARED_OPENING_SPOKEN_PROMPT");
    expect(source).toContain("Gemini silent handoff after prepared opening (no Live greeting)");
    expect(source).toContain("startInboundPreparedOpening");
    expect(source).toMatch(/sendPreparedOpeningHandoff[\s\S]*turn_complete:\s*false/);
  });
});
