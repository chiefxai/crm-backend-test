jest.mock("../../src/platform/costProviders", () => ({}));
jest.mock("../../src/platform/billingSettings", () => ({
  getGlobalAiDefaults: jest.fn(),
}));

const { mergeAiOverride } = require("../../src/billing/pricingResolver");

describe("billing.pricingResolver", () => {
  const globalAi = {
    pricingMode: "time",
    voice: { timeRateAmount: 5, timeUnit: "minute" },
    postCall: { timeRateAmount: 1, timeUnit: "minute" },
  };

  test("defaults to global TIME_BASED pricing", () => {
    const { config, source } = mergeAiOverride(globalAi, null);
    expect(source).toBe("global_default");
    expect(config.pricingMode).toBe("time");
    expect(config.voice.timeRateAmount).toBe(5);
  });

  test("organization override replaces global defaults", () => {
    const { config, source } = mergeAiOverride(globalAi, {
      useGlobalDefault: false,
      pricingMode: "token",
      voice: { inputTokenRate: 2 },
    });
    expect(source).toBe("organization_override");
    expect(config.pricingMode).toBe("token");
  });
});
