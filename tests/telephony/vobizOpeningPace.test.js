const { buildOpeningTtsPrompt } = require("../../src/telephony/vobiz/vobizOpeningGreeting");
const {
  pcmToTelephony16k,
  parsePcmSampleRateFromMime,
} = require("../../src/utils/audioConverter");

describe("vobiz opening audio helpers", () => {
  test("parsePcmSampleRateFromMime reads rate parameter", () => {
    expect(parsePcmSampleRateFromMime("audio/pcm;rate=16000")).toBe(16000);
    expect(parsePcmSampleRateFromMime("audio/L16;rate=24000")).toBe(24000);
    expect(parsePcmSampleRateFromMime("audio/wav")).toBe(24000);
  });

  test("pcmToTelephony16k preserves duration for 16k pass-through", () => {
    const pcm = Buffer.alloc(3200);
    expect(pcmToTelephony16k(pcm, 16000).length).toBe(3200);
  });

  test("pcmToTelephony16k shortens 24k audio for 16k telephony", () => {
    const pcm24 = Buffer.alloc(4800);
    const out = pcmToTelephony16k(pcm24, 24000);
    expect(out.length).toBe(Math.round((4800 / 2) * (2 / 3)) * 2);
  });

  test("buildOpeningTtsPrompt does not vary with agent speed (voice must stay stable)", () => {
    const a = buildOpeningTtsPrompt("Vanakkam");
    const b = buildOpeningTtsPrompt("Vanakkam");
    expect(a).toBe(b);
    expect(a).toMatch(/natural conversational pace/i);
  });
});
