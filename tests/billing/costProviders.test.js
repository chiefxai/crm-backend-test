jest.mock("../../src/platform/settings", () => ({
  getSetting: jest.fn(async () => null),
  setSetting: jest.fn(async () => null),
}));
jest.mock("../../src/platform/auditLog", () => ({ record: jest.fn() }));

const { KNOWN_PROVIDERS, computeAiCostFromProvider } = require("../../src/platform/costProviders");

describe("costProviders defaults", () => {
  test("known AI providers default to time-based pricing", () => {
    const gemini = KNOWN_PROVIDERS.find((p) => p.key === "gemini");
    const post = KNOWN_PROVIDERS.find((p) => p.key === "gemini-postcall");
    expect(gemini.defaults.pricingMode).toBe("time");
    expect(gemini.defaults.timeRateAmount).toBe(5);
    expect(post.defaults.pricingMode).toBe("time");
    expect(post.defaults.timeRateAmount).toBe(1);
  });

  test("computeAiCostFromProvider uses time mode without charging tokens", () => {
    const provider = {
      key: "gemini",
      label: "Gemini",
      active: true,
      pricingMode: "time",
      timeRateAmount: 5,
      timeUnit: "minute",
      taxPercent: 0,
      pricingVersion: "2026-09-26-v1",
    };
    const result = computeAiCostFromProvider(provider, { durationSeconds: 120, totalTokens: 9999 });
    expect(result.totalCost).toBe(10);
    expect(result.pricingMode).toBe("time");
    expect(result.pricingVersion).toBe("2026-09-26-v1");
  });
});
