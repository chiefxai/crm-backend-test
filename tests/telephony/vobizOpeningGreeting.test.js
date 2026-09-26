const {
  buildOpeningGreetingText,
  buildGreetingCacheKey,
  agentConfigFingerprint,
  _clearGreetingCacheForTests,
} = require("../../src/telephony/vobizOpeningGreeting");

describe("vobizOpeningGreeting", () => {
  beforeEach(() => _clearGreetingCacheForTests());

  test("builds English outbound greeting with agent and company", () => {
    const text = buildOpeningGreetingText({
      direction: "outbound",
      orgName: "ABC Insurance",
      agentName: "Ram",
      campaignLabel: "Life Insurance Follow-up",
      language: "english",
    });
    expect(text).toContain("Ram");
    expect(text).toContain("ABC Insurance");
    expect(text).toMatch(/good time to talk/i);
  });

  test("includes caller name in greeting and cache key", () => {
    const text = buildOpeningGreetingText({
      direction: "outbound",
      orgName: "XYZ Finance",
      agentName: "Priya",
      campaignLabel: "Loan",
      callerContactName: "Kumar",
      language: "english",
    });
    expect(text).toContain("Kumar");

    const keyWithCaller = buildGreetingCacheKey({
      orgId: "org1",
      agentId: "a1",
      agentConfigFingerprint: "fp",
      campaignLabel: "Loan",
      voiceName: "Sulafat",
      language: "english",
      callerContactName: "Kumar",
    });
    const keyWithout = buildGreetingCacheKey({
      orgId: "org1",
      agentId: "a1",
      agentConfigFingerprint: "fp",
      campaignLabel: "Loan",
      voiceName: "Sulafat",
      language: "english",
    });
    expect(keyWithCaller).not.toBe(keyWithout);
  });

  test("cache key isolates voice and campaign", () => {
    const base = {
      orgId: "org1",
      agentId: "a1",
      agentConfigFingerprint: agentConfigFingerprint({ name: "Ram", activeVoice: "Arjun", systemPrompt: "x" }),
      campaignLabel: "Insurance",
      language: "english",
    };
    const k1 = buildGreetingCacheKey({ ...base, voiceName: "Achird" });
    const k2 = buildGreetingCacheKey({ ...base, voiceName: "Sulafat" });
    const k3 = buildGreetingCacheKey({ ...base, voiceName: "Achird", campaignLabel: "Loan" });
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
  });

  test("Tamil outbound greeting uses agent and org", () => {
    const text = buildOpeningGreetingText({
      direction: "outbound",
      orgName: "ABC Insurance",
      agentName: "Ram",
      campaignLabel: "Insurance",
      language: "tamil",
    });
    expect(text).toMatch(/Vanakkam/i);
    expect(text).toContain("Ram");
    expect(text).toContain("ABC Insurance");
  });
});
