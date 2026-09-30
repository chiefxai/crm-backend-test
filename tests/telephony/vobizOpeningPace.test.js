const {
  buildOpeningTtsPrompt,
  normalizeOpeningPcmForAgent,
} = require("../../src/telephony/vobizOpeningGreeting");
const {
  pcmToTelephony16k,
  parsePcmSampleRateFromMime,
  adjustPcm16PlaybackRate,
} = require("../../src/utils/audioConverter");
const { openingPlaybackFactorFromSpeed } = require("../../src/config/agentConfig");

describe("vobiz opening pace", () => {
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

  test("adjustPcm16PlaybackRate speeds up audio when factor > 1", () => {
    const pcm = Buffer.alloc(3200);
    const faster = adjustPcm16PlaybackRate(pcm, 1.2);
    expect(faster.length).toBeLessThan(pcm.length);
  });

  test("buildOpeningTtsPrompt reflects agent speed tiers", () => {
    const fast = buildOpeningTtsPrompt("Hello", { speed: 80 });
    const slow = buildOpeningTtsPrompt("Hello", { speed: 20 });
    expect(fast).toMatch(/quick|energetic/i);
    expect(slow).toMatch(/slower|deliberate/i);
  });

  test("openingPlaybackFactorFromSpeed increases with slider", () => {
    expect(openingPlaybackFactorFromSpeed(80)).toBeGreaterThan(openingPlaybackFactorFromSpeed(40));
    expect(openingPlaybackFactorFromSpeed(52)).toBeGreaterThan(1.15);
  });

  test("normalizeOpeningPcmForAgent shortens buffer for faster agent speed", () => {
    const pcm = Buffer.alloc(6400);
    const fast = normalizeOpeningPcmForAgent(pcm, { speed: 85 });
    const slow = normalizeOpeningPcmForAgent(pcm, { speed: 25 });
    expect(fast.length).toBeLessThan(slow.length);
  });
});
